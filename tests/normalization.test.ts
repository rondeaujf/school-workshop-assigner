import { describe, expect, it } from 'vitest';
import { normalizeInput, slugify } from '../src/normalizer.js';
import { assignStudentsToWorkshops } from '../src/index.js';

describe('slugify', () => {
  it('strips accents and normalizes to ASCII snake_case', () => {
    expect(slugify('Théâtre')).toBe('theatre');
    expect(slugify('  Robotics  ')).toBe('robotics');
    expect(slugify('CM2-A')).toBe('cm2_a');
    expect(slugify("O'Brien")).toBe('o_brien');
  });
});

describe('normalizeInput — tolerance for heterogeneous CSV input', () => {
  it('matches choices despite different case, spacing, and accents', () => {
    const data = normalizeInput({
      workshops: [
        { name: 'Théâtre', maxCapacity: '25' },
        { name: '  Robotics', maxCapacity: 10 },
      ],
      students: [
        { lastName: 'Dupont', firstName: ' Alice ', className: 'CM2-A', choice1: 'théâtre ', choice2: 'ROBOTICS' },
        { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A', choice1: 'Théâtre' },
      ],
    });

    expect(data.workshops.map((w) => w.maxCapacity)).toEqual([25, 10]);
    expect(data.students[0].choiceIds[0]).toBe(data.workshops[0].id);
    expect(data.students[0].choiceIds[1]).toBe(data.workshops[1].id);
    expect(data.students[1].choiceIds[0]).toBe(data.workshops[0].id);
    expect(data.warnings).toHaveLength(0);
  });

  it('warns about an unrecognized choice without failing normalization', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 25 }],
      students: [{ lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A', choice1: 'Nonexistent Workshop' }],
    });

    expect(data.students[0].choiceIds[0]).toBeNull();
    const warning = data.warnings.find((w) => w.code === 'UNRECOGNIZED_CHOICE');
    expect(warning).toMatchObject({
      code: 'UNRECOGNIZED_CHOICE',
      params: { choice: 'Nonexistent Workshop', className: 'CM2-A' },
    });
    expect(warning?.message).toContain('Nonexistent Workshop');
  });

  it('warns when a student has no valid choice at all', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 25 }],
      students: [{ lastName: 'No', firstName: 'Choice', className: 'CM2-A' }],
    });

    expect(data.warnings.some((w) => w.code === 'STUDENT_NO_VALID_CHOICE')).toBe(true);
  });

  it('generates unique composite IDs per (className, lastName, firstName) and handles cross-class homonyms', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 50 }],
      students: [
        { lastName: 'Martin', firstName: 'Paul', className: 'CM2-A' },
        { lastName: 'Martin', firstName: 'Paul', className: 'CM2-B' },
      ],
    });

    const [a, b] = data.students;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('st_cm2_a_martin_paul');
    expect(b.id).toBe('st_cm2_b_martin_paul');
  });

  it('disambiguates twins (same family name, same class) via first name', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 50 }],
      students: [
        { lastName: 'Martin', firstName: 'Leo', className: 'CM2-A' },
        { lastName: 'Martin', firstName: 'Noe', className: 'CM2-A' },
      ],
    });

    const [leo, noe] = data.students;
    expect(leo.id).not.toBe(noe.id);
    expect(leo.id).toBe('st_cm2_a_martin_leo');
    expect(noe.id).toBe('st_cm2_a_martin_noe');
  });

  it('resolves exclusions via the (className, lastName, firstName) triplet regardless of case', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 50 }],
      students: [
        { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A' },
        { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A' },
      ],
      exclusions: [
        {
          studentA: { lastName: 'dupont', firstName: 'alice', className: 'cm2-a' },
          studentB: { lastName: 'MARTIN', firstName: 'BOB', className: 'CM2-A' },
        },
      ],
    });

    expect(data.exclusions).toHaveLength(1);
    expect(data.exclusions[0].studentAId).toBe(data.students[0].id);
    expect(data.exclusions[0].studentBId).toBe(data.students[1].id);
  });

  it('resolves an exclusion that targets one specific twin (same family name, different first names)', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 50 }],
      students: [
        { lastName: 'Martin', firstName: 'Leo', className: 'CM2-A' },
        { lastName: 'Martin', firstName: 'Noe', className: 'CM2-A' },
        { lastName: 'Curie', firstName: 'Marie', className: 'CM2-A' },
      ],
      exclusions: [
        {
          studentA: { lastName: 'Martin', firstName: 'Noe', className: 'CM2-A' },
          studentB: { lastName: 'Curie', firstName: 'Marie', className: 'CM2-A' },
        },
      ],
    });

    const leo = data.students.find((s) => s.firstName === 'Leo')!;
    const noe = data.students.find((s) => s.firstName === 'Noe')!;

    expect(data.exclusions).toHaveLength(1);
    expect(data.exclusions[0].studentAId).toBe(noe.id);
    expect(data.exclusions[0].studentAId).not.toBe(leo.id);
  });

  it('silently ignores (with a warning) an exclusion referencing an unknown student', () => {
    const data = normalizeInput({
      workshops: [{ name: 'Theater', maxCapacity: 50 }],
      students: [{ lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A' }],
      exclusions: [
        {
          studentA: { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A' },
          studentB: { lastName: 'Unknown', firstName: 'X', className: 'CM2-Z' },
        },
      ],
    });

    expect(data.exclusions).toHaveLength(0);
    expect(data.warnings.some((w) => w.code === 'EXCLUSION_STUDENT_NOT_FOUND')).toBe(true);
  });

  it('warns about duplicate workshop names instead of silently merging their capacities', () => {
    const data = normalizeInput({
      workshops: [
        { name: 'Theater', maxCapacity: 10 },
        { name: ' theater ', maxCapacity: 10 },
      ],
      students: [],
    });

    expect(data.workshops).toHaveLength(2);
    expect(data.warnings.some((w) => w.code === 'DUPLICATE_WORKSHOP_NAME')).toBe(true);
  });
});

describe('assignStudentsToWorkshops — end to end with heterogeneous CSV input', () => {
  it('assigns correctly despite messy choice spelling (case/space/accents)', async () => {
    const result = await assignStudentsToWorkshops({
      workshops: [
        { name: 'Théâtre', maxCapacity: '2' },
        { name: 'Robotics', maxCapacity: 2 },
      ],
      students: [
        { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A', choice1: '  théâtre' },
        { lastName: 'Martin', firstName: 'Bob', className: 'CM2-A', choice1: 'ROBOTICS  ' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('OPTIMAL');
    expect(result.statistics.choiceDistribution.choice1).toBe(2);
    expect(result.byClassroom['CM2-A']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lastName: 'Dupont', firstName: 'Alice', workshopName: 'Théâtre', satisfiedChoiceRank: 1 }),
        expect.objectContaining({ lastName: 'Martin', firstName: 'Bob', workshopName: 'Robotics', satisfiedChoiceRank: 1 }),
      ]),
    );
  });
});
