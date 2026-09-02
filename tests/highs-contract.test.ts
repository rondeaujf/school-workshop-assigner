import { describe, expect, it } from 'vitest';
import highsLoader from 'highs';

// Canary for upstream shape drift. `src/highs-adapter.ts` is the only place that
// reads the runtime shape of HiGHS' `.solve()` output; this test asserts that
// exact shape *directly against the package* (not through the adapter), so a
// `highs` version bump that changes it fails here, loudly and localized,
// instead of surfacing as a confusing solver bug elsewhere. See the header of
// src/highs-adapter.ts for the upgrade procedure.

describe('highs package output contract', () => {
  it('solves a trivial MILP with the field shape src/highs-adapter.ts depends on', async () => {
    const highs = await highsLoader();

    const solution = highs.solve(
      ['Maximize', ' obj: x + y', 'Subject To', ' c1: x + y <= 1', 'Binaries', ' x', ' y', 'End'].join('\n'),
      { output_flag: false, log_to_console: false },
    );

    // Status: a string; "Optimal" for a solved model.
    expect(typeof solution.Status).toBe('string');
    expect(solution.Status).toBe('Optimal');

    // ObjectiveValue: a finite number.
    expect(typeof solution.ObjectiveValue).toBe('number');
    expect(solution.ObjectiveValue).toBeCloseTo(1);

    // Columns: an object keyed by variable name, each entry carrying a numeric
    // `Primal`.
    expect(solution.Columns).toBeTypeOf('object');
    expect(Object.keys(solution.Columns).sort()).toEqual(['x', 'y']);
    for (const name of ['x', 'y']) {
      const column = (solution.Columns as Record<string, { Primal: number }>)[name];
      expect(column).toBeDefined();
      expect(typeof column.Primal).toBe('number');
    }
    const total =
      (solution.Columns as Record<string, { Primal: number }>).x.Primal +
      (solution.Columns as Record<string, { Primal: number }>).y.Primal;
    expect(total).toBeCloseTo(1);
  });

  it('reports infeasibility with a status string the adapter can recognize', async () => {
    const highs = await highsLoader();

    const solution = highs.solve(
      ['Maximize', ' obj: x', 'Subject To', ' c1: x >= 2', ' c2: x <= 1', 'Binaries', ' x', 'End'].join('\n'),
      { output_flag: false, log_to_console: false },
    );

    expect(typeof solution.Status).toBe('string');
    expect(solution.Status.toLowerCase()).toContain('infeasible');
  });

  it('accepts a time_limit option without throwing', async () => {
    const highs = await highsLoader();
    const solution = highs.solve(
      ['Maximize', ' obj: x', 'Subject To', ' c1: x <= 1', 'Binaries', ' x', 'End'].join('\n'),
      { output_flag: false, log_to_console: false, time_limit: 10 },
    );
    expect(solution.Status).toBe('Optimal');
  });
});
