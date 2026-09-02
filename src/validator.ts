import { CoherenceError, type NormalizedInput, type Warning } from './types.js';

/**
 * Checks the overall coherence of normalized data before invoking the
 * solver. Throws a {@link CoherenceError} for blocking issues (insufficient
 * capacity, no workshops, a model too large to solve client-side) and returns
 * the non-blocking warnings accumulated during normalization (unrecognized
 * choices, etc).
 */
export function validateCoherence(data: NormalizedInput): Warning[] {
  if (data.workshops.length === 0) {
    throw new CoherenceError('NO_WORKSHOPS', 'No workshops provided.', { workshopCount: 0 });
  }

  const totalCapacity = data.workshops.reduce((sum, w) => sum + w.maxCapacity, 0);
  const studentCount = data.students.length;

  if (totalCapacity < studentCount) {
    throw new CoherenceError(
      'INSUFFICIENT_CAPACITY',
      `Insufficient total capacity: ${totalCapacity} seat(s) available for ${studentCount} student(s) ` +
        `(short by ${studentCount - totalCapacity}).`,
      { totalCapacity, studentCount, shortfall: studentCount - totalCapacity },
    );
  }

  const problemSize = studentCount * data.workshops.length;
  const { maxProblemSize } = data.options;
  if (maxProblemSize > 0 && problemSize > maxProblemSize) {
    throw new CoherenceError(
      'PROBLEM_TOO_LARGE',
      `Model too large for client-side solving: ${studentCount} student(s) x ${data.workshops.length} ` +
        `workshop(s) = ${problemSize} decision variables, over the ${maxProblemSize} ceiling. ` +
        `Split the run or raise options.maxProblemSize if you know the client can take it.`,
      { studentCount, workshopCount: data.workshops.length, problemSize, maxProblemSize },
    );
  }

  return [...data.warnings];
}
