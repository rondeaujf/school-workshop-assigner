import { loadSolver, type SolveOutcome, type SolverEngine } from './highs-adapter.js';
import type { AssignmentStatus, NormalizedExclusion, NormalizedInput, SolverOptions } from './types.js';

function sumExpr(names: string[]): string | null {
  return names.length > 0 ? names.join(' + ') : null;
}

/** A usable solve is one that produced a primal assignment (optimal, or a
 * time-limited incumbent). Infeasible / errored / empty solves are not. */
function isUsable(outcome: SolveOutcome): boolean {
  return outcome.hasSolution && outcome.status !== 'infeasible';
}

// ---------------------------------------------------------------------------
// Candidate workshops per student
//
// The natural model has one binary x_ij for every (student, workshop) pair.
// Most of those are dead weight: a student only ever wants one of their (up to)
// 3 chosen workshops, and the cascade re-parses the whole model 4-5 times. We
// therefore try a REDUCED model first, where a student's variables are limited
// to their chosen workshops (students with no valid choice keep every workshop,
// since they can legitimately land anywhere). That can make the model
// infeasible when a student's chosen workshops are all full, so a single cheap
// feasibility probe decides: reduced if it admits a full assignment, otherwise
// fall back to the exact full model.
//
// This is only applied when there are NO exclusions. With exclusions, routing a
// student through an *unchosen* workshop can be exactly what honors a
// separation (or removes a conflict), so pruning to chosen-only workshops could
// produce a needlessly infeasible hard model — or a worse-than-necessary
// NEEDS_CONFIRMATION / conflict count. Not worth the risk on the machinery that
// is the whole point of the library.
// ---------------------------------------------------------------------------

type CandidateSets = number[][]; // student index -> ascending workshop indices

function fullCandidates(data: NormalizedInput): CandidateSets {
  const all = data.workshops.map((_, j) => j);
  return data.students.map(() => all);
}

function reducedCandidates(data: NormalizedInput): CandidateSets {
  const workshopIndexById = new Map(data.workshops.map((w, j) => [w.id, j]));
  const all = data.workshops.map((_, j) => j);
  return data.students.map((student) => {
    const chosen = new Set<number>();
    for (const workshopId of student.choiceIds) {
      if (!workshopId) continue;
      const j = workshopIndexById.get(workshopId);
      if (j !== undefined) chosen.add(j);
    }
    if (chosen.size === 0) return all; // no recognized choice -> may go anywhere
    return [...chosen].sort((a, b) => a - b);
  });
}

function assembleFeasibilityLp(data: NormalizedInput, candidates: CandidateSets): string {
  const constraints: string[] = [];
  const binaries: string[] = [];

  data.students.forEach((_, i) => {
    const names = candidates[i].map((j) => `x_${i}_${j}`);
    binaries.push(...names);
    constraints.push(`c_u_${i}: ${names.join(' + ')} = 1`);
  });

  const studentsByWorkshop: number[][] = data.workshops.map(() => []);
  candidates.forEach((js, i) => js.forEach((j) => studentsByWorkshop[j].push(i)));

  data.workshops.forEach((workshop, j) => {
    const names = studentsByWorkshop[j].map((i) => `x_${i}_${j}`);
    if (names.length > 0) {
      constraints.push(`c_c_${j}: ${names.join(' + ')} <= ${workshop.maxCapacity}`);
    }
  });

  return assembleLP({
    direction: 'Minimize',
    objectiveExpr: `0 ${binaries[0]}`,
    constraints,
    bounds: [],
    binaries,
  });
}

/** Picks the reduced candidate model when it admits a full assignment, else
 * the exact full model. Costs at most one extra (cheap) feasibility solve. */
function chooseCandidates(engine: SolverEngine, data: NormalizedInput): CandidateSets {
  const full = fullCandidates(data);
  const reduced = reducedCandidates(data);

  const alreadyFull = reduced.every((js) => js.length === data.workshops.length);
  if (alreadyFull) return full;

  const probe = engine.solve(assembleFeasibilityLp(data, reduced));
  return isUsable(probe) ? reduced : full;
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
  /** Class name -> student indices, in first-seen order. */
  classGroups: Map<string, number[]>;
}

function buildBaseModel(data: NormalizedInput, mode: ExclusionMode, candidates: CandidateSets): BaseModel {
  const { students, workshops, exclusions } = data;
  const varX = (i: number, j: number) => `x_${i}_${j}`;
  const varZ = (p: number, j: number) => `z_${p}_${j}`;

  const workshopIndexById = new Map(workshops.map((w, j) => [w.id, j]));
  const studentIndexById = new Map(students.map((s, i) => [s.id, i]));
  const candidateSets = candidates.map((js) => new Set(js));

  const allXNames: string[] = [];
  const constraints: string[] = [];
  const rankVarNames: [string[], string[], string[]] = [[], [], []];
  const matchedNamesByStudent: string[][] = students.map(() => []);

  students.forEach((student, i) => {
    candidates[i].forEach((j) => allXNames.push(varX(i, j)));

    const matchedForStudent = new Set<string>();
    student.choiceIds.forEach((workshopId, rank) => {
      if (!workshopId || rank > 2) return;
      const j = workshopIndexById.get(workshopId);
      if (j === undefined || !candidateSets[i].has(j)) return;
      const name = varX(i, j);
      rankVarNames[rank].push(name);
      matchedForStudent.add(name);
    });
    matchedNamesByStudent[i] = [...matchedForStudent];
  });

  // Uniqueness: every student is assigned to exactly one workshop.
  students.forEach((_, i) => {
    const names = candidates[i].map((j) => varX(i, j));
    constraints.push(`c_u_${i}: ${names.join(' + ')} = 1`);
  });

  // Capacity: every workshop respects its maximum headcount.
  const studentsByWorkshop: number[][] = workshops.map(() => []);
  candidates.forEach((js, i) => js.forEach((j) => studentsByWorkshop[j].push(i)));
  workshops.forEach((workshop, j) => {
    const names = studentsByWorkshop[j].map((i) => varX(i, j));
    if (names.length > 0) {
      constraints.push(`c_c_${j}: ${names.join(' + ')} <= ${workshop.maxCapacity}`);
    }
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

      // Only workshops both students can actually be assigned to can host a
      // conflict; if their candidate sets are disjoint the pair is already
      // structurally separated and needs no constraint at all.
      workshops.forEach((_, j) => {
        if (!candidateSets[i].has(j) || !candidateSets[k].has(j)) return;
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
  status: SolveOutcome['status'];
  finalOutcome: SolveOutcome;
  model: BaseModel;
  /** True when at least one stage returned a time-limited (not proven optimal) result. */
  timedOut: boolean;
}

function runCascade(
  engine: SolverEngine,
  model: BaseModel,
  seedConstraints: string[],
  conflictCap: number | null,
): CascadeResult {
  const constraints = [...model.constraints, ...seedConstraints];
  const extra: string[] = [];
  let timedOut = false;

  if (conflictCap !== null) {
    const allZ = model.allZByPair.flat();
    const expr = sumExpr(allZ);
    if (expr) extra.push(`c_conflict_cap: ${expr} <= ${conflictCap}`);
  }

  let lastOutcome: SolveOutcome | null = null;
  const rankExprs: Array<string | null> = [
    sumExpr(model.rankVarNames[0]),
    sumExpr([...model.rankVarNames[0], ...model.rankVarNames[1]]),
    sumExpr([...model.rankVarNames[0], ...model.rankVarNames[1], ...model.rankVarNames[2]]),
  ];

  // Consecutive ranks collapse to the same expression when no student adds a
  // choice at that rank — no point re-solving an identical model.
  let previousExpr: string | null = null;
  for (const expr of rankExprs) {
    if (!expr || expr === previousExpr) continue;
    previousExpr = expr;
    const lp = assembleLP({
      direction: 'Maximize',
      objectiveExpr: expr,
      constraints: [...constraints, ...extra],
      bounds: model.bounds,
      binaries: model.allXNames,
    });
    const outcome = engine.solve(lp);
    lastOutcome = outcome;
    if (!isUsable(outcome)) {
      return { status: outcome.status, finalOutcome: outcome, model, timedOut };
    }
    if (outcome.status === 'timeout') timedOut = true;
    // Floor this stage's achievement. When timed out this is the incumbent
    // value, which is still an achievable lower bound — safe to lock in.
    if (outcome.objectiveValue !== null) {
      extra.push(`c_floor_${extra.length}: ${expr} >= ${Math.round(outcome.objectiveValue)}`);
    }
  }

  // Fairness stage: minimize the largest per-class "unmatched" headcount.
  const matchedExpr = rankExprs[2];
  if (matchedExpr && model.classGroups.size > 0) {
    const fairnessConstraints: string[] = [];
    let classNumber = 0;
    for (const [, indices] of model.classGroups) {
      const namesInClass = indices.flatMap((i) => model.matchedNamesByStudent[i]);
      const classExpr = sumExpr(namesInClass);
      // Index the constraint name by position, not by a sanitized class name:
      // two distinct class names ("CM2-A", "CM2/A") can sanitize to the same
      // token and collide.
      if (classExpr) {
        fairnessConstraints.push(`c_fair_${classNumber}: M + ${classExpr} >= ${indices.length}`);
      }
      classNumber += 1;
    }
    if (fairnessConstraints.length > 0) {
      const lp = assembleLP({
        direction: 'Minimize',
        objectiveExpr: 'M',
        constraints: [...constraints, ...extra, ...fairnessConstraints],
        bounds: model.bounds,
        binaries: model.allXNames,
      });
      const outcome = engine.solve(lp);
      lastOutcome = outcome;
      if (!isUsable(outcome)) {
        return { status: outcome.status, finalOutcome: outcome, model, timedOut };
      }
      if (outcome.status === 'timeout') timedOut = true;
    }
  }

  if (!lastOutcome) {
    // No rank was ever optimizable (nobody has any recognized choice) — just
    // solve for any feasible assignment.
    const lp = assembleLP({
      direction: 'Minimize',
      objectiveExpr: `0 ${model.allXNames[0]}`,
      constraints,
      bounds: model.bounds,
      binaries: model.allXNames,
    });
    lastOutcome = engine.solve(lp);
    if (lastOutcome.status === 'timeout') timedOut = true;
  }

  return { status: lastOutcome.status, finalOutcome: lastOutcome, model, timedOut };
}

interface ConflictCount {
  value: number;
  timedOut: boolean;
}

function minimizeConflicts(engine: SolverEngine, model: BaseModel): ConflictCount {
  const allZ = model.allZByPair.flat();
  const expr = sumExpr(allZ);
  if (!expr) return { value: 0, timedOut: false };

  const lp = assembleLP({
    direction: 'Minimize',
    objectiveExpr: expr,
    constraints: model.constraints,
    bounds: model.bounds,
    binaries: model.allXNames,
  });
  const outcome = engine.solve(lp);
  if (!isUsable(outcome) || outcome.objectiveValue === null) {
    // Should not happen: the soft model (no hard <=1 exclusion constraints)
    // is only ever infeasible if capacity itself is insufficient, which
    // validateCoherence() already rules out before the solver runs.
    return { value: allZ.length, timedOut: outcome.status === 'timeout' };
  }
  return { value: Math.round(outcome.objectiveValue), timedOut: outcome.status === 'timeout' };
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
  /** Machine-readable counterpart of `message`, for i18n by the caller. */
  messageCode?: string;
  messageParams?: Record<string, string | number>;
  /** True when a solve stage returned a time-limited (not proven optimal) result. */
  timedOut?: boolean;
}

function extractAssignments(
  data: NormalizedInput,
  model: BaseModel,
  columns: Map<string, number>,
): Map<string, string> {
  const assignments = new Map<string, string>();

  data.students.forEach((student, i) => {
    data.workshops.forEach((workshop, j) => {
      if ((columns.get(model.varX(i, j)) ?? 0) > 0.5) {
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
  loaderOptions?: SolverOptions,
): Promise<SolverOutcome> {
  if (data.students.length === 0) {
    return { status: 'OPTIMAL', assignments: new Map(), conflicts: [] };
  }

  const engine = await loadSolver({
    locateFile: loaderOptions?.locateFile,
    timeLimitSeconds: loaderOptions?.timeLimitSeconds ?? data.options.timeLimitSeconds,
    randomSeed: loaderOptions?.randomSeed,
  });

  // Candidate reduction is only safe without exclusions (see chooseCandidates).
  const candidates = data.exclusions.length === 0 ? chooseCandidates(engine, data) : fullCandidates(data);

  if (data.exclusions.length === 0) {
    const model = buildBaseModel(data, 'none', candidates);
    const cascade = runCascade(engine, model, [], null);
    if (!isUsable(cascade.finalOutcome)) {
      return failure(cascade.timedOut, cascade.finalOutcome.rawStatus);
    }
    return {
      status: cascade.timedOut ? 'TIMED_OUT' : 'OPTIMAL',
      assignments: extractAssignments(data, model, cascade.finalOutcome.columns),
      conflicts: [],
      timedOut: cascade.timedOut || undefined,
      ...timeLimitMessage(cascade.timedOut),
    };
  }

  if (!data.options.strictExclusions) {
    return solveSoftAndCommit(engine, data, candidates);
  }

  // Strict mode: check whether all exclusions can be honored at all before
  // touching the confirmation flow.
  const hardModel = buildBaseModel(data, 'hard', candidates);
  const hardCascade = runCascade(engine, hardModel, [], null);

  if (isUsable(hardCascade.finalOutcome)) {
    return {
      status: hardCascade.timedOut ? 'TIMED_OUT' : 'OPTIMAL',
      assignments: extractAssignments(data, hardModel, hardCascade.finalOutcome.columns),
      conflicts: [],
      timedOut: hardCascade.timedOut || undefined,
      ...timeLimitMessage(hardCascade.timedOut),
    };
  }

  // Exclusions cannot all be honored. Compute the actual best-effort
  // resolution so any preview shown to a human is accurate, but only commit
  // to it if relaxation was already confirmed.
  const preview = solveSoft(engine, data, candidates);
  if (preview.assignments === null) return preview;

  if (data.options.confirmedExclusionRelaxation) {
    return { ...preview, status: 'FEASIBLE_WITH_CONFLICTS' };
  }

  return {
    ...preview,
    status: 'NEEDS_CONFIRMATION',
    message:
      `${preview.conflicts.length} exclusion pair(s) cannot be honored given current capacities. ` +
      `Review \`unresolvedExclusionConflicts\` and resubmit with options.confirmedExclusionRelaxation: true to proceed anyway.`,
    messageCode: 'EXCLUSION_RELAXATION_NEEDS_CONFIRMATION',
    messageParams: { conflictCount: preview.conflicts.length },
  };
}

function failure(timedOut: boolean, rawStatus: string): SolverOutcome {
  if (timedOut) {
    return {
      status: 'TIMED_OUT',
      assignments: null,
      conflicts: [],
      message: 'The solver hit its time limit before finding any assignment.',
      messageCode: 'SOLVER_TIME_LIMIT_NO_SOLUTION',
      timedOut: true,
    };
  }
  return {
    status: 'INFEASIBLE',
    assignments: null,
    conflicts: [],
    message: `No feasible assignment exists for this input (solver status: ${rawStatus}).`,
    messageCode: 'NO_FEASIBLE_ASSIGNMENT',
    messageParams: { solverStatus: rawStatus },
  };
}

function timeLimitMessage(timedOut: boolean): Pick<SolverOutcome, 'message' | 'messageCode'> {
  if (!timedOut) return {};
  return {
    message: 'The solver hit its time limit; the returned assignment is usable but not proven optimal.',
    messageCode: 'SOLVER_TIME_LIMIT',
  };
}

function solveSoft(engine: SolverEngine, data: NormalizedInput, candidates: CandidateSets): SolverOutcome {
  const model = buildBaseModel(data, 'soft', candidates);
  const conflictCount = minimizeConflicts(engine, model);
  const cascade = runCascade(engine, model, [], conflictCount.value);
  const timedOut = conflictCount.timedOut || cascade.timedOut;

  if (!isUsable(cascade.finalOutcome)) {
    return failure(timedOut, cascade.finalOutcome.rawStatus);
  }

  const assignments = extractAssignments(data, model, cascade.finalOutcome.columns);
  const conflicts = findConflicts(data, assignments);
  return {
    status: 'FEASIBLE_WITH_CONFLICTS',
    assignments,
    conflicts,
    timedOut: timedOut || undefined,
    ...timeLimitMessage(timedOut),
  };
}

function solveSoftAndCommit(
  engine: SolverEngine,
  data: NormalizedInput,
  candidates: CandidateSets,
): SolverOutcome {
  const result = solveSoft(engine, data, candidates);
  if (result.assignments === null) return result;
  return { ...result, status: result.conflicts.length > 0 ? 'FEASIBLE_WITH_CONFLICTS' : 'OPTIMAL' };
}
