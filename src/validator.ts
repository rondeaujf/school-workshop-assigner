import { CoherenceError, type NormalizedInput } from './types.js';

/**
 * Checks the overall coherence of normalized data before invoking the
 * solver. Throws a {@link CoherenceError} for blocking issues (insufficient
 * capacity, no workshops) and returns the non-blocking warnings accumulated
 * during normalization (unrecognized choices, etc).
 */
export function validateCoherence(data: NormalizedInput): string[] {
  if (data.workshops.length === 0) {
    throw new CoherenceError('No workshops provided.', { workshopCount: 0 });
  }

  const totalCapacity = data.workshops.reduce((sum, w) => sum + w.maxCapacity, 0);
  const studentCount = data.students.length;

  if (totalCapacity < studentCount) {
    throw new CoherenceError(
      `Insufficient total capacity: ${totalCapacity} seat(s) available for ${studentCount} student(s) ` +
        `(short by ${studentCount - totalCapacity}).`,
      { totalCapacity, studentCount, shortfall: studentCount - totalCapacity },
    );
  }

  return [...data.warnings];
}
