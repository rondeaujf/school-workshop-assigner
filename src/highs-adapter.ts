// ---------------------------------------------------------------------------
// HiGHS anti-corruption layer
//
// This is the ONLY module in the codebase that imports `highs` or touches the
// runtime shape of its `.solve()` output (`Status`, `Columns`, `.Primal`,
// `ObjectiveValue`). Everything else works against the typed `SolveOutcome` /
// `SolverEngine` surface defined here.
//
// Why this layer exists:
//   - The `highs` package's `types.d.ts` declares `Highs` / `HighsSolution`
//     file-locally and does NOT `export` them, so they cannot be imported. We
//     derive them structurally from the loader's own signature instead.
//   - The output keys we read (`Status`, `Columns[name].Primal`, ...) are the
//     package's actual runtime shape, not a documented contract. `package.json`
//     pins `highs` to an EXACT version so any upstream shape change is an
//     explicit, reviewed version bump; `tests/highs-contract.test.ts` asserts
//     that shape directly so a bump that breaks it fails loudly and locally,
//     instead of surfacing as a confusing solver bug three call sites away.
//
// Upgrade procedure for `highs`:
//   1. Bump the exact version in package.json.
//   2. `npm test` — `tests/highs-contract.test.ts` is the canary; if it fails,
//      the output shape changed and only THIS file needs to adapt.
//   3. Re-run the full suite and `npm run build:demo`.
// ---------------------------------------------------------------------------

import highsLoader from 'highs';

// Structural stand-ins for the package's non-exported internal types.
type Highs = Awaited<ReturnType<typeof highsLoader>>;
type RawSolution = ReturnType<Highs['solve']>;

/** Normalized solve status, decoupled from HiGHS' exact wording. */
export type SolveStatus = 'optimal' | 'infeasible' | 'timeout' | 'unbounded' | 'error';

export interface SolveOutcome {
  status: SolveStatus;
  /** HiGHS' own status string, kept verbatim for diagnostics/messages. */
  rawStatus: string;
  /** Objective value, or `null` when the solve produced no usable solution. */
  objectiveValue: number | null;
  /** Variable name -> primal value. Empty when there is no usable solution. */
  columns: Map<string, number>;
  /** True when `columns` carries a usable primal assignment. */
  hasSolution: boolean;
}

export interface SolverEngine {
  /** Solves a CPLEX-LP-format model string. Synchronous CPU work. */
  solve(lp: string): SolveOutcome;
}

export interface SolverLoadOptions {
  /** Locates the HiGHS `.wasm` asset (browser bundling). */
  locateFile?: (file: string) => string;
  /** Per-solve wall-clock limit in seconds. <= 0 or undefined means no limit. */
  timeLimitSeconds?: number;
  /** Fixed RNG seed for reproducible tie-breaking across runs. Default 0. */
  randomSeed?: number;
}

function mapStatus(raw: string): SolveStatus {
  const s = raw.toLowerCase();
  if (s.includes('infeasible')) return 'infeasible';
  if (s.includes('unbounded')) return 'unbounded';
  if (s.includes('time limit') || s.includes('iteration limit')) return 'timeout';
  if (s === 'optimal' || s.includes('objective reached') || s === 'empty') return 'optimal';
  return 'error';
}

function normalizeOutcome(raw: RawSolution): SolveOutcome {
  const rawStatus = String((raw as { Status?: unknown }).Status ?? 'Unknown');
  const status = mapStatus(rawStatus);

  const columns = new Map<string, number>();
  const rawColumns = (raw as { Columns?: Record<string, unknown> }).Columns;
  if (rawColumns && typeof rawColumns === 'object') {
    for (const [name, col] of Object.entries(rawColumns)) {
      if (col && typeof col === 'object' && 'Primal' in col) {
        const primal = (col as { Primal: unknown }).Primal;
        if (typeof primal === 'number' && Number.isFinite(primal)) {
          columns.set(name, primal);
        }
      }
    }
  }

  const rawObjective = (raw as { ObjectiveValue?: unknown }).ObjectiveValue;
  const objectiveValue = typeof rawObjective === 'number' && Number.isFinite(rawObjective) ? rawObjective : null;

  const hasSolution = status !== 'infeasible' && status !== 'error' && columns.size > 0;

  return { status, rawStatus, objectiveValue, columns, hasSolution };
}

// The `highs` WASM module is a few MB to fetch + compile. Instantiating it per
// `assignStudentsToWorkshops` call (and the confirm flow calls twice) is pure
// waste, so we memoize the loaded module keyed by the `locateFile` identity.
// Per-solve options (time limit, seed) are applied at `.solve()` time, so a
// cached module is safe to share across calls with different limits.
const moduleCache = new Map<unknown, Promise<Highs>>();

/** Resets the memoized HiGHS module(s). Test-only. */
export function _resetSolverCache(): void {
  moduleCache.clear();
}

export async function loadSolver(options: SolverLoadOptions = {}): Promise<SolverEngine> {
  const cacheKey = options.locateFile ?? '__default__';
  let modulePromise = moduleCache.get(cacheKey);
  if (!modulePromise) {
    modulePromise = highsLoader(options.locateFile ? { locateFile: options.locateFile } : undefined);
    moduleCache.set(cacheKey, modulePromise);
  }
  const highs = await modulePromise;

  const solveOptions: Record<string, unknown> = {
    // HiGHS logs to stdout/console on every solve by default — noisy in the
    // browser and in test output, and it buys us nothing.
    output_flag: false,
    log_to_console: false,
    random_seed: options.randomSeed ?? 0,
  };
  if (typeof options.timeLimitSeconds === 'number' && options.timeLimitSeconds > 0) {
    solveOptions.time_limit = options.timeLimitSeconds;
  }

  return {
    solve(lp: string): SolveOutcome {
      return normalizeOutcome(highs.solve(lp, solveOptions as Parameters<Highs['solve']>[1]));
    },
  };
}
