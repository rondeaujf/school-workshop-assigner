// ---------------------------------------------------------------------------
// Raw input (as parsed from one or more CSV files, potentially multi-class)
// ---------------------------------------------------------------------------

export interface WorkshopInput {
  /** Workshop name, e.g. "Theater". Must be unique after normalization (trim/case/accent-insensitive). */
  name: string;
  /** Maximum number of seats. Accepts a number or a numeric string (raw CSV cells are strings). */
  maxCapacity: number | string;
}

export interface StudentInput {
  /** Family name, e.g. "Smith". */
  lastName: string;
  /** Given name, e.g. "Alice". Required: family name alone cannot disambiguate twins/siblings in the same class. */
  firstName: string;
  className: string;
  /** Workshop name as typed by the student/teacher. Matched case/accent/space-insensitively against `WorkshopInput.name`. */
  choice1?: string;
  choice2?: string;
  choice3?: string;
}

/** Identifies a student by the same triplet used to build their internal ID. */
export interface StudentRef {
  lastName: string;
  firstName: string;
  className: string;
}

export interface ExclusionInput {
  studentA: StudentRef;
  studentB: StudentRef;
}

export interface AssignmentOptions {
  /**
   * Weights used only to compute the informational `totalScore` summary metric
   * (rank 1 / 2 / 3). They do NOT drive the optimization itself: fairness across
   * students takes priority over maximizing a weighted sum (see README "Fairness
   * model"). Default: [100, 40, 10].
   */
  choiceWeights?: number[];
  /**
   * If true (default), pairwise exclusions are hard constraints: two excluded
   * students can never share a workshop. When that is mathematically impossible
   * given capacities, the solver does NOT silently relax it — it returns
   * `status: 'NEEDS_CONFIRMATION'` with a preview of the unavoidable conflicts
   * instead. Set to false to skip that safety step entirely and always resolve
   * conflicts as soft penalties on the first call (useful for automated/CI
   * contexts where no human can confirm).
   */
  strictExclusions?: boolean;
  /**
   * Set to true only after a human has reviewed a prior `NEEDS_CONFIRMATION`
   * response and explicitly approved relaxing the unavoidable exclusion
   * conflicts it listed. Skips the confirmation step for this call and commits
   * directly to the best-effort result (`status: 'FEASIBLE_WITH_CONFLICTS'`).
   */
  confirmedExclusionRelaxation?: boolean;
  /**
   * Per-solve wall-clock limit passed to HiGHS, in seconds. The solver runs
   * several sequential solves (see "Fairness model"); this caps EACH of them.
   * When a solve hits the limit with a usable incumbent, the result is returned
   * with `timedOut: true` (status `TIMED_OUT` if nothing usable was found at
   * all). Undefined / <= 0 means no limit. Strongly recommended in a browser.
   */
  timeLimitSeconds?: number;
  /**
   * Safety ceiling on `students.length * workshops.length`. Above it,
   * `assignStudentsToWorkshops` throws a `CoherenceError`
   * (`code: 'PROBLEM_TOO_LARGE'`) instead of building a multi-megabyte model
   * string that could exhaust a client's memory. Default 250_000. Set to 0 to
   * disable the check.
   */
  maxProblemSize?: number;
}

export interface AssignmentInput {
  workshops: WorkshopInput[];
  students: StudentInput[];
  exclusions?: ExclusionInput[];
  options?: AssignmentOptions;
}

// ---------------------------------------------------------------------------
// Warnings & errors (i18n-friendly: a stable `code` + `params`, plus an
// English `message` as a ready-to-use default. Translate off `code`/`params`.)
// ---------------------------------------------------------------------------

export type WarningCode =
  | 'DUPLICATE_WORKSHOP_NAME'
  | 'UNRECOGNIZED_CHOICE'
  | 'STUDENT_NO_VALID_CHOICE'
  | 'EXCLUSION_STUDENT_NOT_FOUND'
  | 'EXCLUSION_SELF_REFERENCE';

export interface Warning {
  /** Stable machine-readable identifier — switch on this to localize. */
  code: WarningCode;
  /** Interpolation values for the localized message (names, counts, ...). */
  params: Record<string, string | number>;
  /** English rendering, safe to display as-is when no translation is wired. */
  message: string;
}

export type CoherenceErrorCode =
  | 'NO_WORKSHOPS'
  | 'INSUFFICIENT_CAPACITY'
  | 'PROBLEM_TOO_LARGE'
  | 'INVALID_CAPACITY';

// ---------------------------------------------------------------------------
// Normalized data (internal)
// ---------------------------------------------------------------------------

export interface NormalizedWorkshop {
  id: string;
  name: string;
  maxCapacity: number;
}

export interface NormalizedStudent {
  /** Unique composite ID: `st_<className>_<lastName>_<firstName>` (disambiguates twins). */
  id: string;
  lastName: string;
  firstName: string;
  className: string;
  /** Workshop IDs aligned with [choice1, choice2, choice3], `null` if absent or unrecognized. */
  choiceIds: Array<string | null>;
}

export interface NormalizedExclusion {
  studentAId: string;
  studentBId: string;
  studentA: StudentRef;
  studentB: StudentRef;
}

export interface NormalizedOptions {
  choiceWeights: number[];
  strictExclusions: boolean;
  confirmedExclusionRelaxation: boolean;
  timeLimitSeconds?: number;
  maxProblemSize: number;
}

export interface NormalizedInput {
  workshops: NormalizedWorkshop[];
  students: NormalizedStudent[];
  exclusions: NormalizedExclusion[];
  options: NormalizedOptions;
  warnings: Warning[];
}

/**
 * Thrown for structurally invalid input that the caller must fix before
 * retrying (e.g. insufficient total capacity, no workshops at all). This is a
 * programming/data error, not a solver outcome — unlike infeasibility or
 * exclusion conflicts, which are returned as a typed `AssignmentResult`
 * because they are legitimate business outcomes a UI needs to render.
 */
export class CoherenceError extends Error {
  /** Stable machine-readable identifier — switch on this to localize. */
  code: CoherenceErrorCode;
  details: Record<string, unknown>;

  constructor(code: CoherenceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CoherenceError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type AssignmentStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'FEASIBLE_WITH_CONFLICTS'
  | 'NEEDS_CONFIRMATION'
  | 'TIMED_OUT'
  | 'INFEASIBLE';

export interface ClassroomAssignment {
  /** Display name, e.g. "Smith Alice". */
  studentName: string;
  lastName: string;
  firstName: string;
  workshopName: string;
  /** 1, 2, 3, or `null` if the student did not get any of their declared choices. */
  satisfiedChoiceRank: number | null;
}

export interface WorkshopAssignment {
  studentName: string;
  lastName: string;
  firstName: string;
  className: string;
}

export interface ExclusionConflict {
  studentA: StudentRef;
  studentB: StudentRef;
  workshop: string;
}

export interface ChoiceDistribution {
  choice1: number;
  choice2: number;
  choice3: number;
  unmatched: number;
}

export interface AssignmentResult {
  /** False for INFEASIBLE and NEEDS_CONFIRMATION — neither is a final, actionable assignment. */
  success: boolean;
  status: AssignmentStatus;
  /** English rendering of `messageCode`, when present. */
  message?: string;
  /** Stable machine-readable counterpart of `message`, for i18n by the caller. */
  messageCode?: string;
  messageParams?: Record<string, string | number>;
  /**
   * True when at least one internal solve returned a time-limited result: the
   * assignment (if any) is usable but not proven optimal. See
   * `AssignmentOptions.timeLimitSeconds`.
   */
  timedOut?: boolean;
  /** Informational only (see `AssignmentOptions.choiceWeights`) — not the optimization objective. */
  totalScore: number;
  statistics: {
    totalStudents: number;
    choiceDistribution: ChoiceDistribution;
  };
  /** Assignments grouped by class, for UI display and CSV/PDF export. */
  byClassroom: Record<string, ClassroomAssignment[]>;
  /** Assignments grouped by workshop, for attendance sheets. */
  byWorkshop: Record<string, WorkshopAssignment[]>;
  /**
   * Present when `status` is `FEASIBLE_WITH_CONFLICTS` or `NEEDS_CONFIRMATION`:
   * the exclusion pairs that end up sharing a workshop in the (tentative, for
   * NEEDS_CONFIRMATION) best-effort solution.
   */
  unresolvedExclusionConflicts?: ExclusionConflict[];
  /** Non-blocking warnings (unrecognized choices, unmatched exclusion references, etc). */
  warnings?: Warning[];
}

/**
 * Options forwarded to the HiGHS WebAssembly solver.
 */
export interface SolverOptions {
  /** Locates the HiGHS `.wasm` asset (e.g. `(file) => \`/assets/${file}\``) for browser bundling. */
  locateFile?: (file: string) => string;
  /** Per-solve wall-clock limit in seconds. Mirrors `AssignmentOptions.timeLimitSeconds`. */
  timeLimitSeconds?: number;
  /** Fixed RNG seed for reproducible tie-breaking across runs. Default 0. */
  randomSeed?: number;
}

/** @deprecated Renamed to {@link SolverOptions}. */
export type HighsLoaderOptions = SolverOptions;
