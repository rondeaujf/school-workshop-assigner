import highsLoader from 'highs';
import type { AssignmentStatus, HighsLoaderOptions, NormalizedExclusion, NormalizedInput } from './types.js';

// The `highs` package's `types.d.ts` does not export its internal `Highs` /
// `HighsSolution` types (they're file-local declarations shadowed by the
// module boundary), so we derive them structurally from the loader's own
// signature instead of re-declaring them by hand. This is coupled to the
// package's actual runtime shape rather than a documented contract, which is
// why the dependency is pinned to an exact version in package.json — any
// upstream shape change is then an explicit, reviewed version bump instead of
// a silent drift.
type Highs = Awaited<ReturnType<typeof highsLoader>>;
type HighsSolution = ReturnType<Highs['solve']>;

function isInfeasible(status: string): boolean {
  return status.toLowerCase().includes('infeasible');
}

function sumExpr(names: string[]): string | null {
  return names.length > 0 ? names.join(' + ') : null;
}

// ---------------------------------------------------------------------------
// Model building
// ---------------------------------------------------------------------------

type ExclusionMode = 'none' | 'hard' | 'soft';

interface BaseModel {
  varX: (i: number, j: number) => string;
  allXNames: string[];
  constraints: string[];
  /** Per-student variable name satisfying choice rank 0/1/2 (index into choiceIds), or undefined. */
  rankVarNames: [string[], string[], string[]];
  /** Per student: their own (deduplicated) rank 0/1/2 variable names — used by the fairness stage. */
  matchedNamesByStudent: string[][];
  /** Extra `Bounds` lines (only used in 'soft' mode, for the conflict indicator variables). */
  bounds: string[];
  /** Conflict indicator variable names per exclusion pair, e.g. `allZByPair[p] = ['z_0_0', 'z_0_1', ...]`. */
  allZByPair: string[][];
  classGroups: Map<string, number[]>;
}

function buildBaseModel(data: NormalizedInput, mode: ExclusionMode): BaseModel {
  const { students, workshops, exclusions } = data;
  const varX = (i: number, j: number) => `x_${i}_${j}`;
  const varZ = (p: number, j: number) => `z_${p}_${j}`;

  const workshopIndexById = new Map(workshops.map((w, j) => [w.id, j]));
  const studentIndexById = new Map(students.map((s, i) => [s.id, i]));

  const allXNames: string[] = [];
  const constraints: string[] = [];
  const rankVarNames: [string[], string[], string[]] = [[], [], []];
  const matchedNamesByStudent: string[][] = students.map(() => []);

  students.forEach((student, i) => {
    workshops.forEach((_, j) => allXNames.push(varX(i, j)));

    const matchedForStudent = new Set<string>();
    student.choiceIds.forEach((workshopId, rank) => {
      if (!workshopId || rank > 2) return;
      const j = workshopIndexById.get(workshopId);
      if (j === undefined) return;
      const name = varX(i, j);
      rankVarNames[rank].push(name);
      matchedForStudent.add(name);
    });
    matchedNamesByStudent[i] = [...matchedForStudent];
  });

  // Uniqueness: every student is assigned to exactly one workshop.
  students.forEach((_, i) => {
    const names = workshops.map((__, j) => varX(i, j));
    constraints.push(`c_u_${i}: ${names.join(' + ')} = 1`);
  });

  // Capacity: every workshop respects its maximum headcount.
  workshops.forEach((workshop, j) => {
    const names = students.map((__, i) => varX(i, j));
    constraints.push(`c_c_${j}: ${names.join(' + ')} <= ${workshop.maxCapacity}`);
  });

  const bounds: string[] = [];
  const allZByPair: string[][] = [];

  if (mode !== 'none') {
    exclusions.forEach((exclusion, p) => {
      const i = studentIndexById.get(exclusion.studentAId);
      const k = studentIndexById.get(exclusion.studentBId);
      const zNames: string[] = [];
      if (i === undefined || k === undefined) {
        allZByPair.push(zNames);
        return;
      }

      workshops.forEach((_, j) => {
        if (mode === 'hard') {
          constraints.push(`c_e_${p}_${j}: ${varX(i, j)} + ${varX(k, j)} <= 1`);
        } else {
          const z = varZ(p, j);
          constraints.push(`c_z_${p}_${j}: ${z} - ${varX(i, j)} - ${varX(k, j)} >= -1`);
          bounds.push(`${z} <= 1`);
          zNames.push(z);
        }
      });
      allZByPair.push(zNames);
    });
  }

  const classGroups = new Map<string, number[]>();
  students.forEach((student, i) => {
    const group = classGroups.get(student.className) ?? [];
    group.push(i);
    classGroups.set(student.className, group);
  });

  return { varX, allXNames, constraints, rankVarNames, matchedNamesByStudent, bounds, allZByPair, classGroups };
}

function assembleLP(options: {
  direction: 'Maximize' | 'Minimize';
  objectiveExpr: string;
  constraints: string[];
  bounds: string[];
  binaries: string[];
}): string {
  return [
    options.direction,
    ` obj: ${options.objectiveExpr}`,
    'Subject To',
    ...options.constraints.map((line) => ` ${line}`),
    ...(options.bounds.length > 0 ? ['Bounds', ...options.bounds.map((line) => ` ${line}`)] : []),
    'Binaries',
    ...options.binaries.map((line) => ` ${line}`),
    'End',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lexicographic cascade
//
// Fairness model: rather than maximizing one weighted sum (which can trade a
// student's 1st choice away for enough lower-ranked gains elsewhere), we
// optimize in strict priority order — each stage can never sacrifice what the
// previous stage already secured:
//   0. (only when exclusions must be relaxed) minimize the number of
//      exclusion pairs forced to share a workshop.
//   1. maximize the number of students who get their 1st choice.
//   2. ...then, keeping that, maximize the number who get their 1st OR 2nd.
//   3. ...then, keeping that, maximize the number who get any of their 3.
//   4. ...then, keeping all of that, minimize the largest number of
//      "unmatched" (no choice satisfied) students concentrated in any single
//      class, so leftover seats aren't systematically dumped on one class.
// ---------------------------------------------------------------------------

interface CascadeResult {
  status: string;
  finalSolution: HighsSolution;
  model: BaseModel;
}

async function runCascade(
  highs: Highs,
  model: BaseModel,
  seedConstraints: string[],
  conflictCap: number | null,
): Promise<CascadeResult> {
  const constraints = [...model.constraints, ...seedConstraints];
  const extra: string[] = [];

  if (conflictCap !== null) {
    const allZ = model.allZByPair.flat();
    const expr = sumExpr(allZ);
    if (expr) extra.push(`c_conflict_cap: ${expr} <= ${conflictCap}`);
  }

  let lastSolution: HighsSolution | null = null;
  const rankExprs: Array<string | null> = [
    sumExpr(model.rankVarNames[0]),
    sumExpr([...model.rankVarNames[0], ...model.rankVarNames[1]]),
    sumExpr([...model.rankVarNames[0], ...model.rankVarNames[1], ...model.rankVarNames[2]]),
  ];

  for (const expr of rankExprs) {
    if (!expr) continue; // no student has a valid choice at this rank at all; nothing to optimize
    const lp = assembleLP({
      direction: 'Maximize',
      objectiveExpr: expr,
      constraints: [...constraints, ...extra],
      bounds: model.bounds,
      binaries: model.allXNames,
    });
    const solution = highs.solve(lp);
    lastSolution = solution;
    if (isInfeasible(solution.Status) || !('Columns' in solution)) {
      return { status: solution.Status, finalSolution: solution, model };
    }
    const value = Math.round(solution.ObjectiveValue);
    extra.push(`c_floor_${extra.length}: ${expr} >= ${value}`);
  }

  // Fairness stage: minimize the largest per-class "unmatched" headcount.
  const matchedExpr = rankExprs[2];
  if (matchedExpr && model.classGroups.size > 0) {
    const fairnessConstraints: string[] = [];
    for (const [className, indices] of model.classGroups) {
      const namesInClass = indices.flatMap((i) => model.matchedNamesByStudent[i]);
      const classExpr = sumExpr(namesInClass);
      const clean = className.replace(/[^a-zA-Z0-9]+/g, '_');
      if (classExpr) {
        fairnessConstraints.push(`c_fair_${clean}: M + ${classExpr} >= ${indices.length}`);
      }
    }
    if (fairnessConstraints.length > 0) {
      const lp = assembleLP({
        direction: 'Minimize',
        objectiveExpr: 'M',
        constraints: [...constraints, ...extra, ...fairnessConstraints],
        bounds: model.bounds,
        binaries: model.allXNames,
      });
      const solution = highs.solve(lp);
      lastSolution = solution;
      if (isInfeasible(solution.Status) || !('Columns' in solution)) {
        return { status: solution.Status, finalSolution: solution, model };
      }
    }
  }

  if (!lastSolution) {
    // No rank was ever optimizable (nobody has any recognized choice) — just
    // solve for any feasible assignment.
    const lp = assembleLP({
      direction: 'Minimize',
      objectiveExpr: `0 ${model.allXNames[0]}`,
      constraints,
      bounds: model.bounds,
      binaries: model.allXNames,
    });
    lastSolution = highs.solve(lp);
  }

  return { status: lastSolution.Status, finalSolution: lastSolution, model };
}

async function minimizeConflicts(highs: Highs, model: BaseModel): Promise<number> {
  const allZ = model.allZByPair.flat();
  const expr = sumExpr(allZ);
  if (!expr) return 0;

  const lp = assembleLP({
    direction: 'Minimize',
    objectiveExpr: expr,
    constraints: model.constraints,
    bounds: model.bounds,
    binaries: model.allXNames,
  });
  const solution = highs.solve(lp);
  if (isInfeasible(solution.Status) || !('ObjectiveValue' in solution)) {
    // Should not happen: the soft model (no hard <=1 exclusion constraints)
    // is only ever infeasible if capacity itself is insufficient, which
    // validateCoherence() already rules out before the solver runs.
    return allZ.length;
  }
  return Math.round(solution.ObjectiveValue);
}

// ---------------------------------------------------------------------------
// Public solver entry point
// ---------------------------------------------------------------------------

export interface ConflictInternal {
  exclusion: NormalizedExclusion;
  workshopId: string;
}

export interface SolverOutcome {
  status: AssignmentStatus;
  /** studentId -> workshopId, or `null` when no usable solution exists. */
  assignments: Map<string, string> | null;
  conflicts: ConflictInternal[];
  message?: string;
}

function extractAssignments(
  data: NormalizedInput,
  model: BaseModel,
  solution: HighsSolution,
): Map<string, string> {
  const assignments = new Map<string, string>();
  if (!('Columns' in solution)) return assignments;

  data.students.forEach((student, i) => {
    data.workshops.forEach((workshop, j) => {
      const column = solution.Columns[model.varX(i, j)];
      if (column && 'Primal' in column && column.Primal > 0.5) {
        assignments.set(student.id, workshop.id);
      }
    });
  });
  return assignments;
}

function findConflicts(data: NormalizedInput, assignments: Map<string, string>): ConflictInternal[] {
  const conflicts: ConflictInternal[] = [];
  for (const exclusion of data.exclusions) {
    const workshopA = assignments.get(exclusion.studentAId);
    const workshopB = assignments.get(exclusion.studentBId);
    if (workshopA && workshopA === workshopB) {
      conflicts.push({ exclusion, workshopId: workshopA });
    }
  }
  return conflicts;
}

export async function solveAssignment(
  data: NormalizedInput,
  loaderOptions?: HighsLoaderOptions,
): Promise<SolverOutcome> {
  if (data.students.length === 0) {
    return { status: 'OPTIMAL', assignments: new Map(), conflicts: [] };
  }

  const highs = await highsLoader(loaderOptions);

  if (data.exclusions.length === 0) {
    const model = buildBaseModel(data, 'none');
    const { status, finalSolution } = await runCascade(highs, model, [], null);
    if (isInfeasible(status) || !('Columns' in finalSolution)) {
      return { status: 'INFEASIBLE', assignments: null, conflicts: [], message: `Solver status: ${status}.` };
    }
    return { status: 'OPTIMAL', assignments: extractAssignments(data, model, finalSolution), conflicts: [] };
  }

  if (!data.options.strictExclusions) {
    return solveSoftAndCommit(highs, data);
  }

  // Strict mode: check whether all exclusions can be honored at all before
  // touching the confirmation flow.
  const hardModel = buildBaseModel(data, 'hard');
  const hardCascade = await runCascade(highs, hardModel, [], null);

  if (!isInfeasible(hardCascade.status) && 'Columns' in hardCascade.finalSolution) {
    return {
      status: 'OPTIMAL',
      assignments: extractAssignments(data, hardModel, hardCascade.finalSolution),
      conflicts: [],
    };
  }

  // Exclusions cannot all be honored. Compute the actual best-effort
  // resolution so any preview shown to a human is accurate, but only commit
  // to it if relaxation was already confirmed.
  const preview = await solveSoft(highs, data);

  if (data.options.confirmedExclusionRelaxation) {
    return { ...preview, status: preview.status === 'INFEASIBLE' ? 'INFEASIBLE' : 'FEASIBLE_WITH_CONFLICTS' };
  }

  return {
    ...preview,
    status: preview.status === 'INFEASIBLE' ? 'INFEASIBLE' : 'NEEDS_CONFIRMATION',
    message:
      preview.status === 'INFEASIBLE'
        ? preview.message
        : `${preview.conflicts.length} exclusion pair(s) cannot be honored given current capacities. ` +
          `Review \`unresolvedExclusionConflicts\` and resubmit with options.confirmedExclusionRelaxation: true to proceed anyway.`,
  };
}

async function solveSoft(highs: Highs, data: NormalizedInput): Promise<SolverOutcome> {
  const model = buildBaseModel(data, 'soft');
  const conflictCap = await minimizeConflicts(highs, model);
  const cascade = await runCascade(highs, model, [], conflictCap);

  if (isInfeasible(cascade.status) || !('Columns' in cascade.finalSolution)) {
    return {
      status: 'INFEASIBLE',
      assignments: null,
      conflicts: [],
      message: `Solver status: ${cascade.status}.`,
    };
  }

  const assignments = extractAssignments(data, model, cascade.finalSolution);
  const conflicts = findConflicts(data, assignments);
  return { status: 'FEASIBLE_WITH_CONFLICTS', assignments, conflicts };
}

async function solveSoftAndCommit(highs: Highs, data: NormalizedInput): Promise<SolverOutcome> {
  const result = await solveSoft(highs, data);
  if (result.status === 'INFEASIBLE') return result;
  return { ...result, status: result.conflicts.length > 0 ? 'FEASIBLE_WITH_CONFLICTS' : 'OPTIMAL' };
}
