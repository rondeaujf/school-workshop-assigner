# school-workshop-assigner

Fair, capacity- and exclusion-aware assignment of students to workshops, for a teacher-facing web app with **no backend**: all solving happens client-side via [HiGHS](https://highs.dev) compiled to WebAssembly ([`highs`](https://www.npmjs.com/package/highs) package). Designed for messy, multi-class CSV input (one file per class, merged before optimization).

- **Bounded client cost**: a `timeLimitSeconds` option caps each solve, a `maxProblemSize` guard rejects oversized inputs before a large model is ever built, and a [Web Worker entrypoint](#running-off-the-main-thread-web-worker) keeps the solve off the UI thread.
- **i18n-friendly**: `warnings`, result `messageCode`s, `status`, and `CoherenceError.code` are stable machine-readable values; each carries an English default string you can override. See [Warnings & internationalization](#warnings--internationalization).

> **Upgrading from 0.2.x?** `warnings` are now objects, `CoherenceError` takes a `code`, and a few names changed — see [Migrating from 0.2.x](#migrating-from-02x).

## Installation

```bash
npm install school-workshop-assigner
```

## Quick start

```ts
import { assignStudentsToWorkshops } from 'school-workshop-assigner';

const result = await assignStudentsToWorkshops({
  workshops: [
    { name: 'Theater', maxCapacity: 25 },
    { name: 'Robotics', maxCapacity: 20 },
  ],
  students: [
    { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A', choice1: 'Theater', choice2: 'Robotics' },
    { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A', choice1: 'Robotics' },
  ],
  exclusions: [
    {
      studentA: { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A' },
      studentB: { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A' },
    },
  ],
});

console.log(result.status, result.totalScore);
console.log(result.byClassroom);
console.log(result.byWorkshop);
```

The optional second parameter (`SolverOptions`) tunes the solver itself:

```ts
await assignStudentsToWorkshops(input, {
  // Point at the HiGHS `.wasm` asset if it isn't served next to your JS bundle.
  locateFile: (file) => `/assets/${file}`,
  // Cap each internal solve (recommended in a browser). Mirrors
  // options.timeLimitSeconds; whichever is set takes effect.
  timeLimitSeconds: 15,
  // Fixed RNG seed for reproducible tie-breaking. Default 0.
  randomSeed: 0,
});
```

## Input contract

This module does **not** parse CSV itself — it expects plain JS objects, however you assembled them (one `Papa.parse()` call per uploaded class file, then concatenated). Here is exactly what it expects and tolerates:

### `workshops: WorkshopInput[]`
- `name: string` — must be distinct after normalization (trimmed, case/accent-insensitive). Two workshops that normalize to the same name are **not** merged: both are kept as separate workshops with separate capacities, but any student choice referencing that name will only ever match the *first* one declared, and the module emits a warning. If you genuinely run two parallel sessions of the same activity, give them distinct names (e.g. "Theater (room 1)" / "Theater (room 2)").
- `maxCapacity: number | string` — a non-negative number, or a numeric string (raw CSV cells are strings; this module coerces them). A non-numeric value throws.

### `students: StudentInput[]`
- `lastName`, `firstName`, `className: string` — all three are required and together form the student's identity. **The family name alone is not treated as unique** — twins or siblings sharing a class and last name are only disambiguated because `firstName` is part of the internal composite ID (`st_<className>_<lastName>_<firstName>`). Leading/trailing spaces and repeated internal whitespace are trimmed; case and accents are ignored when *matching* names, but the original casing is preserved in the output.
- `choice1?`, `choice2?`, `choice3?: string` — the workshop name as typed by the student/teacher. Matched against `WorkshopInput.name` case/accent/whitespace-insensitively (`"théâtre "` matches `"Théâtre"`). A choice that doesn't match any known workshop is dropped with a warning (the student is simply not credited for that rank). A student with zero recognized choices is still assigned (to whichever workshop has room) and gets a warning plus `satisfiedChoiceRank: null`.

### `exclusions?: ExclusionInput[]`
- Each entry names two students via `{ lastName, firstName, className }` — the same triplet used to build student IDs. If either side doesn't match any known student, the exclusion is dropped with a warning (not an error), so a typo doesn't abort the whole run.
- An exclusion where both sides resolve to the same student is dropped with a warning.

### `options?: AssignmentOptions`
- `choiceWeights?: number[]` (default `[100, 40, 10]`) — used **only** to compute the informational `totalScore` summary; see "Fairness model" below for why it does not drive the actual optimization.
- `strictExclusions?: boolean` (default `true`) — see "Exclusion conflicts" below.
- `confirmedExclusionRelaxation?: boolean` (default `false`) — see "Exclusion conflicts" below.
- `timeLimitSeconds?: number` (default: none) — wall-clock cap passed to HiGHS for **each** of the several sequential solves the fairness cascade runs. On timeout with a usable incumbent, the result comes back with `timedOut: true` (`status: 'TIMED_OUT'` if nothing usable was found at all). Strongly recommended in a browser so a pathological input can't freeze the tab indefinitely. Also settable via `SolverOptions` (the second argument).
- `maxProblemSize?: number` (default `250_000`) — safety ceiling on `students.length * workshops.length` (the decision-variable count). Above it, `assignStudentsToWorkshops` throws a `CoherenceError` (`code: 'PROBLEM_TOO_LARGE'`) instead of building a multi-megabyte model string that could exhaust a client's memory. Set to `0` to disable.

### Preconditions checked before solving
Before any solving happens, `assignStudentsToWorkshops` throws a `CoherenceError` (a data problem for the caller to fix, not a solver outcome). Every `CoherenceError` carries a stable `error.code` plus an `error.details` object:
- `NO_WORKSHOPS` — no workshops at all.
- `INSUFFICIENT_CAPACITY` — total capacity is less than the student count (`details`: `{ totalCapacity, studentCount, shortfall }`).
- `PROBLEM_TOO_LARGE` — `students × workshops` exceeds `options.maxProblemSize` (`details`: `{ studentCount, workshopCount, problemSize, maxProblemSize }`).
- `INVALID_CAPACITY` — a workshop's `maxCapacity` is not a non-negative number (`details`: `{ workshop, maxCapacity }`).

Everything else — unrecognized choices, students with no valid choice, exclusions referencing unknown students, duplicate workshop names — is non-blocking and surfaces in the returned `warnings` array instead (see [Warnings & internationalization](#warnings--internationalization)).

## Fairness model

Maximizing a single weighted sum of satisfied choices can be gamed by the optimizer in ways a human wouldn't consider fair: it might fully sacrifice a handful of students (giving them none of their choices) to squeeze out a marginally higher total score elsewhere, or it might arbitrarily dump every unlucky "no choice available" student into a single class purely because the solver was indifferent between equally-scoring solutions.

To avoid that, this module optimizes in **strict priority order** (a lexicographic cascade — see `src/solver.ts` for the exact stages), never trading a higher-priority outcome for a lower-priority one:

1. Maximize the number of students who get their 1st choice.
2. ...then, without giving up any of that, maximize the number who get their 1st **or** 2nd choice.
3. ...then, without giving up any of that, maximize the number who get any of their 3 choices.
4. ...then, without giving up any of that, minimize the **largest number of "no choice satisfied" students concentrated in any single class** — so leftover seats aren't systematically dumped on one class over another.

`totalScore` (computed from `choiceWeights`) is reported purely as a human-readable summary of the final result — it is not what the solver optimizes for.

This is a per-run fairness model: it treats every run as a clean slate. If you re-run this tool regularly (e.g. once a term), consider tracking which students were left unmatched in previous runs and pre-processing the input to give them priority — this module currently has no notion of history across calls.

## Exclusion conflicts

By default (`strictExclusions: true`), an exclusion is a hard constraint: two excluded students can never end up in the same workshop. Two students being kept apart can be a mundane preference or something a lot more serious (a safety separation), so **this module never silently decides for you which pair to expose to a conflict** when honoring every exclusion is mathematically impossible given capacities.

Instead, the call returns:

```ts
{ success: false, status: 'NEEDS_CONFIRMATION', unresolvedExclusionConflicts: [...], byClassroom: {/* preview */}, ... }
```

`byClassroom`/`byWorkshop` are already populated with the actual best-effort resolution (fewest possible conflicts, then still fairness-optimized), so a UI can show "here's what would happen" before asking a human to confirm. Once approved, call again with the same input plus:

```ts
options: { confirmedExclusionRelaxation: true }
```

to commit to that exact result (`status: 'FEASIBLE_WITH_CONFLICTS'`).

If you have no human in the loop (e.g. a scheduled/CI run) and are fine resolving conflicts automatically, set `options: { strictExclusions: false }` to skip the confirmation step entirely and get the best-effort result on the first call.

## Running off the main thread (Web Worker)

`assignStudentsToWorkshops` runs several **synchronous** HiGHS solves back to back. On the browser's main thread that freezes the UI for the whole run (sub-second for a few hundred students, longer with dense exclusions or a tight `timeLimitSeconds`). Two extra entrypoints move it into a Worker:

```ts
// main thread
import { createAssigner } from 'school-workshop-assigner/worker-client';

const worker = new Worker(
  new URL('school-workshop-assigner/worker', import.meta.url),
  { type: 'module' },
);
const assigner = createAssigner(worker);

const result = await assigner.assign(input, { locateFile, timeLimitSeconds: 15 });
// ... assigner.terminate() when you're done (also rejects any in-flight call).
```

- `school-workshop-assigner/worker` is the module you load **into** the Worker; it wires `self.onmessage` to the solver. Your bundler resolves the specifier; without a bundler, point the `new URL(...)` at the built `dist/worker.js` and always pass `locateFile` so the Worker can find `highs.wasm` from its own context (a Worker does **not** inherit the document's import map).
- `createAssigner(worker)` runs on the main thread: it correlates requests/responses over `postMessage` and **revives a `CoherenceError`** thrown inside the Worker as a real `CoherenceError` on your side (structured-clone drops the prototype), so your `try/catch` + `error.code` keep working unchanged.
- `worker.terminate()` (via `assigner.terminate()`) is also your hard backstop: if HiGHS ever runs away on a pathological input, killing the Worker frees it without taking the page down.

`createAssigner` accepts any object with `postMessage` / `addEventListener('message')` / `terminate` — a real `Worker`, a `SharedWorker`'s port, or a stub in tests.

## Warnings & internationalization

The library ships **English strings**, but every user-facing string also has a stable machine-readable identifier so an app can localize without string-matching prose.

`warnings` is an array of:

```ts
interface Warning {
  code: 'DUPLICATE_WORKSHOP_NAME' | 'UNRECOGNIZED_CHOICE' | 'STUDENT_NO_VALID_CHOICE'
      | 'EXCLUSION_STUDENT_NOT_FOUND' | 'EXCLUSION_SELF_REFERENCE';
  params: Record<string, string | number>; // e.g. { choice, studentName, className }
  message: string;                          // English default, ready to display as-is
}
```

Localize by switching on `code` and interpolating `params`; fall back to `message` when you have no translation:

```ts
const t = {
  fr: {
    UNRECOGNIZED_CHOICE: (p) => `Le vœu « ${p.choice} » de ${p.studentName} (${p.className}) ne correspond à aucun atelier connu.`,
    // ...
  },
};
const render = (w) => t[locale]?.[w.code]?.(w.params) ?? w.message;
```

The same pattern applies elsewhere:
- **`result.messageCode`** / **`result.messageParams`** accompany `result.message` for `NEEDS_CONFIRMATION`, `TIMED_OUT`, and `INFEASIBLE`
  (`EXCLUSION_RELAXATION_NEEDS_CONFIRMATION`, `SOLVER_TIME_LIMIT`, `SOLVER_TIME_LIMIT_NO_SOLUTION`, `NO_FEASIBLE_ASSIGNMENT`).
- **`CoherenceError.code`** — see "Preconditions checked before solving".
- **`result.status`** is already an enum, safe to map to UI copy directly.

Policy: the library's job is `code` + `params` + an English default. Wiring an actual translation layer (and choosing name-display order, date/number formatting, etc.) is the app's responsibility — it does not pull `i18next` or a locale into this package. The GitHub docs staying English is deliberate and unrelated to this.

## Browser demo

A small, bundler-free static page under `demo/` exercises the module directly in a
browser — the same "no backend" environment the real app runs in — via
`assignStudentsToWorkshops` running entirely client-side (HiGHS WebAssembly included).

```bash
npm run demo
```

This builds the library, copies the demo's static dependencies (the compiled
`dist/` output and the `highs` WASM assets) into `demo/vendor/`, and serves the
`demo/` folder with [`serve`](https://www.npmjs.com/package/serve) — open the
printed `http://localhost:...` URL. Two JSON presets are provided: one showing
the fairness/twins behavior, and one showing the exclusion `NEEDS_CONFIRMATION`
→ confirm flow end to end.

### CSV import

The demo can import real CSV files — one file for workshops, one per class
(click "Add a class" repeatedly to merge several, mirroring how a teacher
would upload one file per class in a real app), and one for exclusions — using
the exact columns documented in the page itself. This exercises actual file
parsing (`demo/csv.js`, a small dependency-free CSV parser — the library
itself intentionally doesn't parse CSV, see "Input contract" above), not just
hand-typed JSON.

Sample fixtures are provided under `demo/samples/`: two "classes" —
attendees of the [1911 Solvay Conference](https://en.wikipedia.org/wiki/Solvay_Conference)
(24 physicists) and France's 1998 World Cup-winning squad (22 players) — 8
workshops (Football, Juggling, Fluid Mechanics, Field Theory, Organic
Chemistry, Sliding Tackles, Refereeing, Third Half), seeded pseudo-random
choices, and 63 mechanically-generated exclusions: every pair of people whose family name
starts with the same letter (e.g. all 6 of Desailly/Deschamps/Djorkaeff/
Diomède/Dugarry/de Broglie mutually excluded) — a deliberately dense,
realistic-scale stress test for the exclusion machinery. Click "Load sample:
Solvay 1911 vs France 98 (CSV)" to fetch and import all four files in one go,
or pick them individually via the file inputs (`demo/samples/*.csv`) to test
the import UI manually.

To just (re)build the demo assets without starting a server (e.g. to serve them
some other way, or with a specific `serve demo -l <port>`), run `npm run build:demo`.
`demo/vendor/` is generated output and is gitignored — it must be rebuilt after
pulling changes or editing `src/`.

Note: `node_modules/highs/build/highs.js` is Emscripten's classic UMD-style
output, not an ES module — it only exports via `module.exports` or `define()`.
Rather than pulling in a bundler for this static demo, `demo/highs-shim.js`
loads it as a plain classic `<script>` (which leaves a `Module` global) and
wraps that as the ES module `highs-shim.js` exports; `demo/index.html`'s
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)
points the bare `"highs"` specifier (as written in the compiled `dist/highs-adapter.js`)
at that shim, so no build step is needed to resolve it.

## Error handling

Two deliberately different mechanisms:
- **Throws** (`CoherenceError`, with a stable `.code`): structurally invalid input — the caller made a data mistake and must fix it before retrying. See "Preconditions checked before solving" above.
- **Returns** (`AssignmentResult` with `success: false`): legitimate solver outcomes that a UI needs to render to the end user — `INFEASIBLE` (no assignment exists even ignoring exclusions — should not happen once coherence has been validated, but reported defensively), `NEEDS_CONFIRMATION` (see above), and `TIMED_OUT` with no incumbent (the solver hit `timeLimitSeconds` before finding anything usable). A `TIMED_OUT` result that *does* carry an assignment has `success: true` and `timedOut: true` — usable, just not proven optimal.

## Structure

```
src/
  index.ts          # Public API (assignStudentsToWorkshops)
  normalizer.ts     # Cleanup, slugs, fuzzy matching, multi-class merging
  validator.ts      # Pre-solve integrity checks (capacity, problem-size ceiling)
  solver.ts         # LP model generation (CPLEX format) + lexicographic cascade
  highs-adapter.ts  # The ONLY module that imports `highs` / reads its output shape
  messages.ts       # English default renderings for each warning code
  types.ts          # TypeScript interfaces (input/output)
  worker.ts         # Web Worker entrypoint (loaded into the Worker)
  worker-client.ts  # Main-thread client: createAssigner(worker)
tests/
  assignment.test.ts     # End-to-end: scale, coherence, exclusion confirmation flow, fairness
  normalization.test.ts  # Fuzzy matching, twins, exclusion resolution, structured warnings
  solver-scaling.test.ts # Model-reduction fallback, dense-exclusion stress test, size/time options
  highs-contract.test.ts # Canary: asserts the `highs` .solve() output shape directly
  worker.test.ts         # Worker request/response envelope + CoherenceError revival
demo/
  index.html         # Static page (import map wires the `highs` shim, no bundler)
  app.js             # Demo UI: CSV import, presets, run/confirm flow, result rendering
  csv.js             # Dependency-free CSV parser, demo-side only (see "Input contract")
  highs-shim.js      # Browser bridge for highs.js's classic-script build output
  samples/           # Sample CSV fixtures
  vendor/            # Generated by `npm run build:demo` (gitignored): dist/ + highs WASM assets
```

## Development

```bash
npm install
npm run build      # compile src/ -> dist/
npm run typecheck
npm test           # vitest run
```

## Design notes / known limitations

- **No backend, by design**: everything runs in the browser via WebAssembly. This does mean shipping the `highs` WASM binary (a few MB) to the client; lazy-load the Worker + wasm only when a teacher actually runs an assignment. If this module is ever used behind a backend, a native (non-WASM) HiGHS binding would avoid that cost.
- **`highs` is pinned to an exact version** (not a semver range) in `package.json`. Its `types.d.ts` doesn't export the shapes this module reads from `.solve()`, so those types are derived structurally rather than from a documented contract. `src/highs-adapter.ts` is the single anti-corruption layer that touches that shape (everything else works against its typed `SolveOutcome`), and `tests/highs-contract.test.ts` asserts the shape directly — so a version bump that breaks it fails loudly and locally. The adapter's header documents the upgrade procedure.
- **Solver reproducibility**: HiGHS runs with a fixed `random_seed` (0) and the cascade locks each stage's objective, but the model does not pin *which* equally-ranked student gets *which* interchangeable seat. Results can therefore shift between `highs` versions (or if you change the seed) even on identical input; tests assert counts, not specific assignments.
- **Model reduction (no-exclusion runs only)**: with no exclusions, the solver first tries a reduced model where each student's variables are limited to their chosen workshops, and falls back to the full students×workshops model (one cheap feasibility probe decides). Correctness is identical; the win is smaller LP strings and faster re-solves. Runs *with* exclusions always use the full model, since routing a student through an unchosen workshop can be what honors a separation.
- **`maxProblemSize` is a blunt guard**: it counts `students × workshops` decision variables, not the (harder to predict) cost of dense exclusions. Pair it with `timeLimitSeconds` for pathological inputs.
- **Duplicate workshop names are not merged** (see "Input contract" above) — this is a deliberate choice to avoid silently combining capacities that might belong to two genuinely different sessions.
- **No cross-run fairness/history** — see "Fairness model" above.

## Migrating from 0.2.x

- **`warnings`** — was `string[]`, now `Warning[]` (`{ code, params, message }`). For the old behavior, read `warning.message`.
- **`CoherenceError`** — the constructor is now `new CoherenceError(code, message, details)`, and instances expose `error.code`. `error.message` / `error.details` are unchanged. The invalid-capacity case now throws `CoherenceError` (`code: 'INVALID_CAPACITY'`) instead of a plain `Error`.
- **`HighsLoaderOptions`** — renamed to `SolverOptions` (old name kept as a deprecated alias). It gained `timeLimitSeconds` and `randomSeed`.
- **New `AssignmentStatus` value** — `'TIMED_OUT'`. If you exhaustively `switch` on `status`, add a case.
- **New result fields** — `messageCode`, `messageParams`, `timedOut`.
- **New default** — `options.maxProblemSize` defaults to `250_000`; a very large input that used to (slowly) solve may now throw `PROBLEM_TOO_LARGE`. Set it to `0` to restore the old unbounded behavior.
- **No behavioral change** to `byClassroom` / `byWorkshop` / `statistics` / `status` semantics for existing cases.

## License

ISC — see [LICENSE](LICENSE).
