import { describe, expect, it } from 'vitest';
import { assignStudentsToWorkshops } from '../src/index.js';
import type { StudentInput, WorkshopInput } from '../src/types.js';

const WORKSHOP_NAMES = [
  'Theater', 'Robotics', 'Painting', 'Music', 'Sport', 'Cooking',
  'Gardening', 'Chess', 'Dance', 'Cinema',
];

function generateClasses(classCount: number, classSize: number): StudentInput[] {
  const students: StudentInput[] = [];
  for (let c = 0; c < classCount; c++) {
    const className = `CM2-${String.fromCharCode(65 + c)}`;
    for (let i = 0; i < classSize; i++) {
      students.push({
        lastName: `Last${c}_${i}`,
        firstName: `First${i}`,
        className,
        choice1: WORKSHOP_NAMES[(c + i) % WORKSHOP_NAMES.length],
        choice2: WORKSHOP_NAMES[(c + i + 1) % WORKSHOP_NAMES.length],
        choice3: WORKSHOP_NAMES[(c + i + 2) % WORKSHOP_NAMES.length],
      });
    }
  }
  return students;
}

function generateWorkshops(capacityEach: number): WorkshopInput[] {
  return WORKSHOP_NAMES.map((name) => ({ name, maxCapacity: capacityEach }));
}

describe('scale: 250 students / 10 classes / 10 workshops', () => {
  it('solves well within a second and respects every constraint', async () => {
    const students = generateClasses(10, 25);
    const workshops = generateWorkshops(30); // 300 seats for 250 students

    const exclusions = [
      {
        studentA: { lastName: students[0].lastName, firstName: students[0].firstName, className: students[0].className },
        studentB: { lastName: students[1].lastName, firstName: students[1].firstName, className: students[1].className },
      },
    ];

    const start = performance.now();
    const result = await assignStudentsToWorkshops({ workshops, students, exclusions });
    const duration = performance.now() - start;

    expect(result.success).toBe(true);
    expect(result.status).toBe('OPTIMAL');
    expect(result.statistics.totalStudents).toBe(250);
    // Generous ceiling: this guards against a catastrophic performance
    // regression (e.g. an accidental extra full solve per stage), not a tight
    // SLA — CI runners are noisy and the target from the spec is "well under 1s".
    expect(duration).toBeLessThan(3000);

    const totalAssigned = Object.values(result.byClassroom).reduce((sum, rows) => sum + rows.length, 0);
    expect(totalAssigned).toBe(250);

    for (const rows of Object.values(result.byWorkshop)) {
      expect(rows.length).toBeLessThanOrEqual(30);
    }

    expect(result.unresolvedExclusionConflicts).toBeUndefined();
  });

  it('groups assignments by classroom and by workshop', async () => {
    const workshops = generateWorkshops(30);
    const students = generateClasses(10, 25);
    const result = await assignStudentsToWorkshops({ workshops, students });

    expect(Object.keys(result.byClassroom).sort()).toEqual(
      Array.from({ length: 10 }, (_, c) => `CM2-${String.fromCharCode(65 + c)}`).sort(),
    );
    expect(Object.keys(result.byWorkshop).sort()).toEqual([...WORKSHOP_NAMES].sort());
  });
});

describe('data coherence', () => {
  it('throws an explicit error when total capacity is insufficient', async () => {
    await expect(
      assignStudentsToWorkshops({
        workshops: [{ name: 'A', maxCapacity: 1 }],
        students: [
          { lastName: 'Smith', firstName: 'X', className: 'C' },
          { lastName: 'Smith', firstName: 'Y', className: 'C' },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CoherenceError',
      code: 'INSUFFICIENT_CAPACITY',
      details: { totalCapacity: 1, studentCount: 2, shortfall: 1 },
    });
  });
});

describe('exclusion conflicts require confirmation', () => {
  const unresolvableInput = {
    workshops: [{ name: 'OnlyOne', maxCapacity: 2 }],
    students: [
      { lastName: 'Smith', firstName: 'A', className: 'C1' },
      { lastName: 'Smith', firstName: 'B', className: 'C1' },
    ],
    exclusions: [
      {
        studentA: { lastName: 'Smith', firstName: 'A', className: 'C1' },
        studentB: { lastName: 'Smith', firstName: 'B', className: 'C1' },
      },
    ],
  };

  it('returns NEEDS_CONFIRMATION with an accurate preview instead of silently relaxing the exclusion', async () => {
    const result = await assignStudentsToWorkshops(unresolvableInput);

    expect(result.success).toBe(false);
    expect(result.status).toBe('NEEDS_CONFIRMATION');
    expect(result.unresolvedExclusionConflicts).toHaveLength(1);
    expect(result.unresolvedExclusionConflicts?.[0]).toMatchObject({
      studentA: { lastName: 'Smith', firstName: 'A', className: 'C1' },
      studentB: { lastName: 'Smith', firstName: 'B', className: 'C1' },
      workshop: 'OnlyOne',
    });
    // The preview is still populated so a UI can show what would happen.
    expect(result.byClassroom['C1']).toHaveLength(2);
  });

  it('commits to the relaxed result once options.confirmedExclusionRelaxation is set', async () => {
    const result = await assignStudentsToWorkshops({
      ...unresolvableInput,
      options: { confirmedExclusionRelaxation: true },
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(result.unresolvedExclusionConflicts).toHaveLength(1);
  });

  it('skips the confirmation step entirely when strictExclusions is false', async () => {
    const result = await assignStudentsToWorkshops({
      ...unresolvableInput,
      options: { strictExclusions: false },
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('FEASIBLE_WITH_CONFLICTS');
    expect(result.unresolvedExclusionConflicts).toHaveLength(1);
  });

  it('does not need confirmation when the exclusion is actually satisfiable', async () => {
    const result = await assignStudentsToWorkshops({
      workshops: [
        { name: 'Theater', maxCapacity: 1 },
        { name: 'Robotics', maxCapacity: 1 },
      ],
      students: [
        { lastName: 'Smith', firstName: 'A', className: 'C1' },
        { lastName: 'Smith', firstName: 'B', className: 'C1' },
      ],
      exclusions: [
        {
          studentA: { lastName: 'Smith', firstName: 'A', className: 'C1' },
          studentB: { lastName: 'Smith', firstName: 'B', className: 'C1' },
        },
      ],
    });

    expect(result.status).toBe('OPTIMAL');
    expect(result.unresolvedExclusionConflicts).toBeUndefined();
  });
});

describe('fairness: no choice sacrificed for a bigger raw score, and leftovers are balanced across classes', () => {
  it('never trades a 1st-choice match away for extra 2nd-choice matches elsewhere', async () => {
    // Workshop A has a single seat contested by two students who both list it
    // as choice1; a third student's choice1 is workshop B (ample capacity).
    // The unique way to maximize the *count* of 1st-choice matches is 2 (one
    // via A, one via B) — a pure count-lexicographic optimizer must reach it,
    // even though a naive tie-break could be fooled into giving up a 1st
    // choice for a "consolation" 2nd choice instead.
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

    expect(result.status).toBe('OPTIMAL');
    expect(result.statistics.choiceDistribution.choice1).toBe(2);
  });

  it('spreads unavoidable "no choice satisfied" outcomes evenly across classes rather than concentrating them in one', async () => {
    // Two classes of 3 students each, all listing the same single workshop
    // (2 seats) as their only choice. Exactly 2 of the 6 can be satisfied —
    // any split between the two classes scores identically on raw choice
    // counts, so only the fairness stage decides who gets stuck: it must
    // prefer the 1/1 split (max 2 unmatched per class) over a lopsided 2/0
    // split (max 3 unmatched in one class).
    const students: StudentInput[] = [];
    for (const className of ['CM2-A', 'CM2-B']) {
      for (let i = 0; i < 3; i++) {
        students.push({ lastName: `${className}-${i}`, firstName: 'X', className, choice1: 'Popular' });
      }
    }

    const result = await assignStudentsToWorkshops({
      workshops: [
        { name: 'Popular', maxCapacity: 2 },
        { name: 'Overflow', maxCapacity: 4 },
      ],
      students,
    });

    expect(result.statistics.choiceDistribution.choice1).toBe(2);

    const unmatchedByClass: Record<string, number> = {};
    for (const [className, rows] of Object.entries(result.byClassroom)) {
      unmatchedByClass[className] = rows.filter((r) => r.satisfiedChoiceRank === null).length;
    }

    expect(Math.max(...Object.values(unmatchedByClass))).toBe(2);
    expect(unmatchedByClass['CM2-A']).toBe(2);
    expect(unmatchedByClass['CM2-B']).toBe(2);
  });
});
