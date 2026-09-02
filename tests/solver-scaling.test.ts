import { describe, expect, it } from 'vitest';
import { assignStudentsToWorkshops } from '../src/index.js';
import type { ExclusionInput, StudentInput, WorkshopInput } from '../src/types.js';

const WORKSHOP_NAMES = [
  'Football', 'Juggling', 'Fluid Mechanics', 'Field Theory',
  'Organic Chemistry', 'Sliding Tackles', 'Refereeing', 'Third Half',
];

function workshops(capacityEach: number): WorkshopInput[] {
  return WORKSHOP_NAMES.map((name) => ({ name, maxCapacity: capacityEach }));
}

// Seeded pseudo-random so the stress test is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('model reduction with full-model fallback', () => {
  it('falls back to the full model when a student\'s only choices are all full, keeping everyone placed', async () => {
    // Reduced candidates are {A,B},{A,B},{B}; caps A=1,B=1,C=1 make that
    // infeasible, so the solver must fall back to the full model and place the
    // odd student out in C.
    const result = await assignStudentsToWorkshops({
      workshops: [
        { name: 'A', maxCapacity: 1 },
        { name: 'B', maxCapacity: 1 },
        { name: 'C', maxCapacity: 1 },
      ],
      students: [
        { lastName: 'S0', firstName: 'X', className: 'C1', choice1: 'A', choice2: 'B' },
        { lastName: 'S1', firstName: 'X', className: 'C1', choice1: 'A', choice2: 'B' },
        { lastName: 'S2', firstName: 'X', className: 'C1', choice1: 'B' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('OPTIMAL');
    const placed = Object.values(result.byClassroom).reduce((n, rows) => n + rows.length, 0);
    expect(placed).toBe(3);
    expect(result.statistics.choiceDistribution.choice1).toBe(2);
  });
});

describe('dense exclusions: realistic-scale stress test', () => {
  it('stays well within a generous time ceiling with ~40 students and every same-initial pair excluded', async () => {
    const random = mulberry32(1911);
    const surnames = [
      'Curie', 'Planck', 'Einstein', 'Lorentz', 'Bohr', 'Born', 'Brillouin', 'Bragg',
      'Compton', 'Debye', 'Dirac', 'Ehrenfest', 'Fowler', 'Heisenberg', 'Kramers',
      'Langevin', 'Pauli', 'Perrin', 'Richardson', 'Schrodinger', 'Wilson', 'Knudsen',
      'Deschamps', 'Desailly', 'Djorkaeff', 'Dugarry', 'Zidane', 'Barthez', 'Blanc',
      'Thuram', 'Lizarazu', 'Petit', 'Karembeu', 'Henry', 'Trezeguet', 'Pires',
      'Vieira', 'Boghossian', 'Charbonnier', 'Lama',
    ];

    const students: StudentInput[] = surnames.map((lastName, i) => {
      const shuffled = [...WORKSHOP_NAMES].sort(() => random() - 0.5);
      return {
        lastName,
        firstName: 'X',
        className: i % 2 === 0 ? 'Solvay' : 'France98',
        choice1: shuffled[0],
        choice2: shuffled[1],
        choice3: shuffled[2],
      };
    });

    // Every pair sharing a first letter is mutually excluded.
    const exclusions: ExclusionInput[] = [];
    for (let a = 0; a < students.length; a++) {
      for (let b = a + 1; b < students.length; b++) {
        if (students[a].lastName[0] === students[b].lastName[0]) {
          exclusions.push({
            studentA: { lastName: students[a].lastName, firstName: 'X', className: students[a].className },
            studentB: { lastName: students[b].lastName, firstName: 'X', className: students[b].className },
          });
        }
      }
    }
    expect(exclusions.length).toBeGreaterThan(20);

    const start = performance.now();
    const result = await assignStudentsToWorkshops(
      { workshops: workshops(8), students, exclusions },
      { timeLimitSeconds: 20 },
    );
    const duration = performance.now() - start;

    expect(['OPTIMAL', 'FEASIBLE_WITH_CONFLICTS', 'NEEDS_CONFIRMATION', 'TIMED_OUT']).toContain(result.status);
    const placed = Object.values(result.byClassroom).reduce((n, rows) => n + rows.length, 0);
    expect(placed).toBe(students.length);
    // Catastrophic-regression guard, not a tight SLA.
    expect(duration).toBeLessThan(15000);
  });
});

describe('options.maxProblemSize', () => {
  it('throws PROBLEM_TOO_LARGE before building the model when the variable count exceeds the ceiling', async () => {
    const students: StudentInput[] = Array.from({ length: 50 }, (_, i) => ({
      lastName: `S${i}`,
      firstName: 'X',
      className: 'C1',
    }));

    await expect(
      assignStudentsToWorkshops({
        workshops: workshops(80),
        students,
        options: { maxProblemSize: 100 },
      }),
    ).rejects.toMatchObject({
      name: 'CoherenceError',
      code: 'PROBLEM_TOO_LARGE',
      details: { problemSize: 400 },
    });
  });

  it('does not fire for a normal-sized problem and still solves', async () => {
    const result = await assignStudentsToWorkshops({
      workshops: workshops(10),
      students: [{ lastName: 'Solo', firstName: 'X', className: 'C1', choice1: 'Football' }],
      options: { maxProblemSize: 250_000 },
    });
    expect(result.status).toBe('OPTIMAL');
  });
});

describe('options.timeLimitSeconds', () => {
  it('is accepted and does not break an ordinary solve', async () => {
    const result = await assignStudentsToWorkshops(
      {
        workshops: workshops(4),
        students: [
          { lastName: 'A', firstName: 'X', className: 'C1', choice1: 'Football' },
          { lastName: 'B', firstName: 'X', className: 'C1', choice1: 'Juggling' },
        ],
      },
      { timeLimitSeconds: 30 },
    );
    expect(result.status).toBe('OPTIMAL');
    expect(result.timedOut).toBeUndefined();
  });
});
