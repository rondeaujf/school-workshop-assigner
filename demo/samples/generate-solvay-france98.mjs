// Generates the sample CSV fixtures under demo/samples/: two "classes"
// (the 1911 Solvay Conference attendees, and France's 1998 World Cup squad),
// a workshop list, and a mechanically-derived exclusion list — one exclusion
// per pair of people whose family name starts with the same letter.
//
// Deliberately deterministic (seeded PRNG) so the sample data — including the
// "random" workshop choices — is stable across regenerations and reviewable
// in a diff. Re-run with `node demo/samples/generate-solvay-france98.mjs`
// after editing the rosters/workshops below.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.dirname(fileURLToPath(import.meta.url));

// --- Rosters ---------------------------------------------------------------
// Class 1: attendees of the first Solvay Conference (1911), from the famous
// group photograph (seated, then standing, left to right).
const solvay1911 = [
  ['Nernst', 'Walther'],
  ['Brillouin', 'Marcel'],
  ['Solvay', 'Ernest'],
  ['Lorentz', 'Hendrik'],
  ['Warburg', 'Emil'],
  ['Perrin', 'Jean'],
  ['Wien', 'Wilhelm'],
  ['Curie', 'Marie'],
  ['Poincaré', 'Henri'],
  ['Goldschmidt', 'Robert'],
  ['Planck', 'Max'],
  ['Rubens', 'Heinrich'],
  ['Sommerfeld', 'Arnold'],
  ['Lindemann', 'Frederick'],
  ['de Broglie', 'Maurice'],
  ['Knudsen', 'Martin'],
  ['Hasenöhrl', 'Friedrich'],
  ['Hostelet', 'Georges'],
  ['Herzen', 'Édouard'],
  ['Jeans', 'James'],
  ['Rutherford', 'Ernest'],
  ['Kamerlingh Onnes', 'Heike'],
  ['Einstein', 'Albert'],
  ['Langevin', 'Paul'],
];

// Class 2: France's 22-player squad, 1998 FIFA World Cup champions.
const france98 = [
  ['Lama', 'Bernard'],
  ['Barthez', 'Fabien'],
  ['Charbonnier', 'Lionel'],
  ['Blanc', 'Laurent'],
  ['Desailly', 'Marcel'],
  ['Lizarazu', 'Bixente'],
  ['Candela', 'Vincent'],
  ['Karembeu', 'Christian'],
  ['Thuram', 'Lilian'],
  ['Leboeuf', 'Frank'],
  ['Deschamps', 'Didier'],
  ['Petit', 'Emmanuel'],
  ['Zidane', 'Zinedine'],
  ['Djorkaeff', 'Youri'],
  ['Pirès', 'Robert'],
  ['Vieira', 'Patrick'],
  ['Boghossian', 'Alain'],
  ['Diomède', 'Bernard'],
  ["Guivarc'h", 'Stéphane'],
  ['Dugarry', 'Christophe'],
  ['Henry', 'Thierry'],
  ['Trezeguet', 'David'],
];

const classes = [
  { className: 'Solvay 1911', roster: solvay1911 },
  { className: 'France 98', roster: france98 },
];

// --- Workshops ---------------------------------------------------------------
// Capacities scaled down from an initial, too-generous draft (which summed to
// 129 seats for 46 students — barely any contention) to sum to exactly the
// total student count, so every seat matters and the exclusion/fairness
// machinery is actually put under pressure. Scaled proportionally from the
// original relative sizes (Football 22, Juggling 22, Fluid Mechanics 30,
// Field Theory 17, Organic Chemistry 12, Sliding Tackles 11, Refereeing 6,
// Third Half 9 — factor 46/129), then rounded.
const workshops = [
  { name: 'Football', maxCapacity: 8 },
  { name: 'Juggling', maxCapacity: 8 },
  { name: 'Fluid Mechanics', maxCapacity: 11 },
  { name: 'Field Theory', maxCapacity: 6 },
  { name: 'Organic Chemistry', maxCapacity: 4 },
  { name: 'Sliding Tackles', maxCapacity: 4 },
  { name: 'Refereeing', maxCapacity: 2 },
  { name: 'Third Half', maxCapacity: 3 },
];

// --- Deterministic PRNG (mulberry32) so "random" choices are reproducible ---
function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(1998);

function pickThreeDistinct(options, rand) {
  const pool = [...options];
  const picked = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const index = Math.floor(rand() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

// --- Build students, one CSV per class --------------------------------------
const workshopNames = workshops.map((w) => w.name);
const allPeople = []; // { className, lastName, firstName }

for (const { className, roster } of classes) {
  const rows = roster.map(([lastName, firstName]) => {
    const [choice1, choice2, choice3] = pickThreeDistinct(workshopNames, random);
    allPeople.push({ className, lastName, firstName });
    return { lastName, firstName, className, choice1, choice2, choice3 };
  });
  writeCsv(
    path.join(outDir, `students-${slug(className)}.csv`),
    ['lastName', 'firstName', 'className', 'choice1', 'choice2', 'choice3'],
    rows,
  );
}

// --- Workshops CSV -----------------------------------------------------------
writeCsv(path.join(outDir, 'workshops.csv'), ['name', 'maxCapacity'], workshops);

// --- Exclusions: every pair sharing the same first letter of last name -----
// (Taken literally on the lastName field as written, including any leading
// particle like "de" in "de Broglie" — a deliberate, simply-explainable rule
// rather than a language-specific alphabetization convention.)
const byLetter = new Map();
for (const person of allPeople) {
  const letter = person.lastName[0].toUpperCase();
  const group = byLetter.get(letter) ?? [];
  group.push(person);
  byLetter.set(letter, group);
}

const exclusionRows = [];
for (const group of byLetter.values()) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i];
      const b = group[j];
      exclusionRows.push({
        lastNameA: a.lastName,
        firstNameA: a.firstName,
        classNameA: a.className,
        lastNameB: b.lastName,
        firstNameB: b.firstName,
        classNameB: b.className,
      });
    }
  }
}

writeCsv(
  path.join(outDir, 'exclusions.csv'),
  ['lastNameA', 'firstNameA', 'classNameA', 'lastNameB', 'firstNameB', 'classNameB'],
  exclusionRows,
);

console.log(`Generated ${allPeople.length} students across ${classes.length} classes.`);
console.log(`Generated ${exclusionRows.length} exclusion pairs (same first letter of last name).`);

// --- helpers -----------------------------------------------------------------
function slug(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function csvField(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${filePath} (${rows.length} rows)`);
}
