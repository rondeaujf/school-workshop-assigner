import { warn } from './messages.js';
import {
  CoherenceError,
  type AssignmentInput,
  type NormalizedExclusion,
  type NormalizedInput,
  type NormalizedStudent,
  type NormalizedWorkshop,
  type Warning,
} from './types.js';

const DEFAULT_CHOICE_WEIGHTS = [100, 40, 10];
const DEFAULT_MAX_PROBLEM_SIZE = 250_000;

/** Strips accents and turns a string into a compact ASCII snake_case identifier. */
export function slugify(value: string): string {
  const cleaned = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'x';
}

/** Comparison key, insensitive to case, accents, and repeated whitespace. */
function comparisonKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Generates a unique ID, appending `_2`, `_3`, ... on collision. */
function uniqueId(base: string, counters: Map<string, number>): string {
  const count = counters.get(base) ?? 0;
  counters.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
}

/**
 * Cleans and normalizes raw input (potentially assembled from several CSV
 * files / classes) into a model the solver can consume.
 */
export function normalizeInput(input: AssignmentInput): NormalizedInput {
  const warnings: Warning[] = [];

  // --- Workshops -----------------------------------------------------------
  const workshops: NormalizedWorkshop[] = [];
  const nameToWorkshopId = new Map<string, string>();
  const workshopCounters = new Map<string, number>();

  for (const raw of input.workshops) {
    const name = collapseWhitespace(raw.name);
    const maxCapacity = Number(raw.maxCapacity);
    if (!Number.isFinite(maxCapacity) || maxCapacity < 0) {
      throw new CoherenceError(
        'INVALID_CAPACITY',
        `Invalid capacity for workshop "${name}": ${JSON.stringify(raw.maxCapacity)}`,
        { workshop: name, maxCapacity: raw.maxCapacity },
      );
    }

    const id = uniqueId(`ws_${slugify(name)}`, workshopCounters);
    workshops.push({ id, name, maxCapacity });

    const key = comparisonKey(name);
    if (nameToWorkshopId.has(key)) {
      warnings.push(warn('DUPLICATE_WORKSHOP_NAME', { name }));
    } else {
      nameToWorkshopId.set(key, id);
    }
  }

  // --- Students --------------------------------------------------------------
  const students: NormalizedStudent[] = [];
  const studentCounters = new Map<string, number>();
  const studentLookup = new Map<string, string>(); // "classSlug::lastSlug::firstSlug" -> first id found

  for (const raw of input.students) {
    const lastName = collapseWhitespace(raw.lastName);
    const firstName = collapseWhitespace(raw.firstName);
    const className = collapseWhitespace(raw.className);
    const displayName = `${lastName} ${firstName}`.trim();

    // className + lastName + firstName: the family name alone cannot disambiguate twins.
    const id = uniqueId(
      `st_${slugify(className)}_${slugify(lastName)}_${slugify(firstName)}`,
      studentCounters,
    );

    const rawChoices = [raw.choice1, raw.choice2, raw.choice3];
    const choiceIds: Array<string | null> = rawChoices.map((choice) => {
      if (choice === undefined || choice === null || !collapseWhitespace(choice)) return null;
      const workshopId = nameToWorkshopId.get(comparisonKey(choice));
      if (!workshopId) {
        warnings.push(
          warn('UNRECOGNIZED_CHOICE', { choice: collapseWhitespace(choice), studentName: displayName, className }),
        );
        return null;
      }
      return workshopId;
    });

    if (choiceIds.every((c) => c === null)) {
      warnings.push(warn('STUDENT_NO_VALID_CHOICE', { studentName: displayName, className }));
    }

    students.push({ id, lastName, firstName, className, choiceIds });

    const lookupKey = `${slugify(className)}::${slugify(lastName)}::${slugify(firstName)}`;
    if (!studentLookup.has(lookupKey)) {
      studentLookup.set(lookupKey, id);
    }
  }

  // --- Exclusions ----------------------------------------------------------
  const exclusions: NormalizedExclusion[] = [];
  for (const raw of input.exclusions ?? []) {
    const keyA = `${slugify(raw.studentA.className)}::${slugify(raw.studentA.lastName)}::${slugify(raw.studentA.firstName)}`;
    const keyB = `${slugify(raw.studentB.className)}::${slugify(raw.studentB.lastName)}::${slugify(raw.studentB.firstName)}`;
    const idA = studentLookup.get(keyA);
    const idB = studentLookup.get(keyB);

    const nameA = `${raw.studentA.lastName} ${raw.studentA.firstName}`.trim();
    const nameB = `${raw.studentB.lastName} ${raw.studentB.firstName}`.trim();

    if (!idA || !idB) {
      warnings.push(
        warn('EXCLUSION_STUDENT_NOT_FOUND', {
          studentA: nameA,
          classNameA: raw.studentA.className,
          studentB: nameB,
          classNameB: raw.studentB.className,
        }),
      );
      continue;
    }
    if (idA === idB) {
      warnings.push(
        warn('EXCLUSION_SELF_REFERENCE', { studentA: nameA, classNameA: raw.studentA.className }),
      );
      continue;
    }

    exclusions.push({ studentAId: idA, studentBId: idB, studentA: raw.studentA, studentB: raw.studentB });
  }

  const choiceWeights = input.options?.choiceWeights ?? DEFAULT_CHOICE_WEIGHTS;
  const strictExclusions = input.options?.strictExclusions ?? true;
  const confirmedExclusionRelaxation = input.options?.confirmedExclusionRelaxation ?? false;
  const timeLimitSeconds =
    typeof input.options?.timeLimitSeconds === 'number' && input.options.timeLimitSeconds > 0
      ? input.options.timeLimitSeconds
      : undefined;
  const maxProblemSize =
    typeof input.options?.maxProblemSize === 'number' && input.options.maxProblemSize >= 0
      ? input.options.maxProblemSize
      : DEFAULT_MAX_PROBLEM_SIZE;

  return {
    workshops,
    students,
    exclusions,
    options: { choiceWeights, strictExclusions, confirmedExclusionRelaxation, timeLimitSeconds, maxProblemSize },
    warnings,
  };
}
