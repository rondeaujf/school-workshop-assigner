# school-workshop-assigner

Fair, capacity- and exclusion-aware assignment of students to workshops, for a teacher-facing web app with **no backend**: all solving happens client-side via [HiGHS](https://highs.dev) compiled to WebAssembly ([`highs`](https://www.npmjs.com/package/highs) package). Designed for messy, multi-class CSV input (one file per class, merged before optimization).

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

In a browser, if the HiGHS `.wasm` asset isn't served next to your JS bundle, point to it via the second parameter:

```ts
await assignStudentsToWorkshops(input, {
  locateFile: (file) => `/assets/${file}`,
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

### Preconditions checked before solving
Before any solving happens, `assignStudentsToWorkshops` throws a `CoherenceError` (a data problem for the caller to fix, not a solver outcome) if:
- there are no workshops at all, or
- total capacity across all workshops is less than the number of students (`error.details` gives `{ totalCapacity, studentCount, shortfall }`).

Everything else — unrecognized choices, students with no valid choice, exclusions referencing unknown students, duplicate workshop names — is non-blocking and surfaces in the returned `warnings` array instead.

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
Chemistry, Sliding Tackles, Refereeing, Third Half), pseudo-random choices
(seeded, reproducible — see `demo/samples/generate-solvay-france98.mjs`), and
63 mechanically-generated exclusions: every pair of people whose family name
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
points the bare `"highs"` specifier (as written in the compiled `dist/solver.js`)
at that shim, so no build step is needed to resolve it.

## Error handling

Two deliberately different mechanisms:
- **Throws** (`CoherenceError`): structurally invalid input — the caller made a data mistake and must fix it before retrying. See "Preconditions checked before solving" above.
- **Returns** (`AssignmentResult` with `success: false`): legitimate solver outcomes that a UI needs to render to the end user — `INFEASIBLE` (no assignment exists even ignoring exclusions — should not happen once coherence has been validated, but reported defensively) and `NEEDS_CONFIRMATION` (see above).

## Structure

```
src/
  index.ts       # Public API (assignStudentsToWorkshops)
  normalizer.ts  # Cleanup, slugs, fuzzy matching, multi-class merging
  validator.ts   # Pre-solve integrity checks
  solver.ts      # LP model generation (CPLEX format) + lexicographic cascade over HiGHS
  types.ts       # TypeScript interfaces (input/output)
tests/
  assignment.test.ts    # End-to-end: scale, coherence, exclusion confirmation flow, fairness
  normalization.test.ts # Fuzzy matching, twins, exclusion resolution
demo/
  index.html         # Static page (import map wires the `highs` shim, no bundler)
  app.js             # Demo UI: CSV import, presets, run/confirm flow, result rendering
  csv.js             # Dependency-free CSV parser, demo-side only (see "Input contract")
  highs-shim.js      # Browser bridge for highs.js's classic-script build output
  samples/           # Sample CSV fixtures + the script that generated them
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

- **No backend, by design**: everything runs in the browser via WebAssembly. This does mean shipping the `highs` WASM binary (a few MB) to the client; if this module is ever used behind a backend, a native (non-WASM) HiGHS binding would avoid that cost.
- **`highs` is pinned to an exact version** (not a semver range) in `package.json`. Its `types.d.ts` doesn't export the shapes this module reads from `.solve()`, so those types are derived structurally rather than from a documented contract — pinning turns any upstream shape change into an explicit, reviewed version bump instead of silent drift.
- **Duplicate workshop names are not merged** (see "Input contract" above) — this is a deliberate choice to avoid silently combining capacities that might belong to two genuinely different sessions.
- **No cross-run fairness/history** — see "Fairness model" above.
