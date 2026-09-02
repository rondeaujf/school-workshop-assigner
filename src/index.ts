export * from './types.js';
export { normalizeInput, slugify } from './normalizer.js';
export { validateCoherence } from './validator.js';

import { normalizeInput } from './normalizer.js';
import { validateCoherence } from './validator.js';
import { solveAssignment } from './solver.js';
import type { AssignmentInput, AssignmentResult, SolverOptions } from './types.js';

const SUCCESS_STATUSES = new Set(['OPTIMAL', 'FEASIBLE', 'FEASIBLE_WITH_CONFLICTS', 'TIMED_OUT']);

/**
 * Assigns students to workshops under capacity and exclusion constraints.
 *
 * See the README's "Input contract" section for the exact shape and
 * tolerances expected of `input`. In short: `workshops`/`students` are plain
 * arrays merged from as many CSV sources as needed; names and choices are
 * matched case/accent/whitespace-insensitively; `exclusions` reference
 * students by `(className, lastName, firstName)`.
 *
 * Fairness: the solver never trades away a higher-priority outcome (more
 * 1st-choice matches) for a lower-priority one (more 2nd/3rd-choice matches),
 * and additionally balances "no choice satisfied" outcomes across classes.
 * See `src/solver.ts` for the exact lexicographic stages.
 *
 * Exclusion conflicts: when honoring every exclusion is impossible given
 * capacities, this does NOT silently pick which pair to violate. It returns
 * `status: 'NEEDS_CONFIRMATION'` with a preview (including which pairs would
 * be affected). Call again with `options.confirmedExclusionRelaxation: true`
 * to commit to that resolution. Set `options.strictExclusions: false` to skip
 * this safety step entirely (e.g. for unattended/CI usage).
 *
 * Time limit: pass `options.timeLimitSeconds` (recommended in a browser) to
 * cap each internal solve. A time-limited run still returns a usable
 * assignment when one was found, with `timedOut: true` (status `TIMED_OUT`
 * when nothing usable was found at all).
 *
 * i18n: `warnings`, `messageCode`/`messageParams`, `status`, and
 * `CoherenceError.code` are stable machine-readable values. Each `warning`
 * also carries a ready-to-use English `message`; translate off `code`/`params`.
 *
 * @throws {CoherenceError} for structurally invalid input (e.g. insufficient
 *   total capacity, no workshops, a model over `options.maxProblemSize`) — a
 *   data problem the caller must fix, as opposed to solver outcomes like
 *   infeasibility, which are returned.
 */
export async function assignStudentsToWorkshops(
  input: AssignmentInput,
  solverOptions?: SolverOptions,
): Promise<AssignmentResult> {
  const data = normalizeInput(input);
  const warnings = validateCoherence(data);

  const outcome = await solveAssignment(data, solverOptions);

  const emptyDistribution = { choice1: 0, choice2: 0, choice3: 0, unmatched: 0 };

  if (!outcome.assignments) {
    return {
      success: false,
      status: outcome.status,
      message: outcome.message ?? 'No feasible assignment exists for this input.',
      messageCode: outcome.messageCode,
      messageParams: outcome.messageParams,
      timedOut: outcome.timedOut,
      totalScore: 0,
      statistics: { totalStudents: data.students.length, choiceDistribution: emptyDistribution },
      byClassroom: {},
      byWorkshop: {},
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const workshopById = new Map(data.workshops.map((w) => [w.id, w]));

  const choiceDistribution = { ...emptyDistribution };
  let totalScore = 0;

  const byClassroom: AssignmentResult['byClassroom'] = {};
  const byWorkshop: AssignmentResult['byWorkshop'] = {};

  for (const student of data.students) {
    const workshopId = outcome.assignments.get(student.id);
    const workshop = workshopId ? workshopById.get(workshopId) : undefined;
    if (!workshop) continue;

    let satisfiedChoiceRank: number | null = null;
    const rankIndex = student.choiceIds.findIndex((choiceId) => choiceId === workshopId);
    if (rankIndex !== -1) {
      satisfiedChoiceRank = rankIndex + 1;
      totalScore += data.options.choiceWeights[rankIndex] ?? 0;
      if (rankIndex === 0) choiceDistribution.choice1 += 1;
      else if (rankIndex === 1) choiceDistribution.choice2 += 1;
      else if (rankIndex === 2) choiceDistribution.choice3 += 1;
    } else {
      choiceDistribution.unmatched += 1;
    }

    const studentName = `${student.lastName} ${student.firstName}`.trim();

    (byClassroom[student.className] ??= []).push({
      studentName,
      lastName: student.lastName,
      firstName: student.firstName,
      workshopName: workshop.name,
      satisfiedChoiceRank,
    });

    (byWorkshop[workshop.name] ??= []).push({
      studentName,
      lastName: student.lastName,
      firstName: student.firstName,
      className: student.className,
    });
  }

  const unresolvedExclusionConflicts =
    outcome.conflicts.length > 0
      ? outcome.conflicts.map((conflict) => ({
          studentA: conflict.exclusion.studentA,
          studentB: conflict.exclusion.studentB,
          workshop: workshopById.get(conflict.workshopId)?.name ?? conflict.workshopId,
        }))
      : undefined;

  return {
    success: SUCCESS_STATUSES.has(outcome.status),
    status: outcome.status,
    message: outcome.message,
    messageCode: outcome.messageCode,
    messageParams: outcome.messageParams,
    timedOut: outcome.timedOut,
    totalScore,
    statistics: { totalStudents: data.students.length, choiceDistribution },
    byClassroom,
    byWorkshop,
    unresolvedExclusionConflicts,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
