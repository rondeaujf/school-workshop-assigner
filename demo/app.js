import { assignStudentsToWorkshops } from './vendor/school-workshop-assigner/index.js';
import { workshopsFromCsv, studentsFromCsv, exclusionsFromCsv } from './csv.js';

const el = (id) => document.getElementById(id);

const PRESETS = {
  fairness: {
    workshops: [
      { name: 'Popular', maxCapacity: 2 },
      { name: 'Robotics', maxCapacity: 1 },
      { name: 'Overflow', maxCapacity: 4 },
    ],
    students: [
      // Twins: same family name and class, disambiguated by first name.
      { lastName: 'Martin', firstName: 'Leo', className: 'CM2-A', choice1: 'Popular' },
      { lastName: 'Martin', firstName: 'Noe', className: 'CM2-A', choice1: 'Robotics' },
      { lastName: 'Dupont', firstName: 'Alice', className: 'CM2-A', choice1: 'Popular' },
      { lastName: 'Curie', firstName: 'Marie', className: 'CM2-B', choice1: 'Popular' },
      { lastName: 'Bernard', firstName: 'Paul', className: 'CM2-B', choice1: 'Popular' },
      { lastName: 'Lefevre', firstName: 'Julie', className: 'CM2-B', choice1: 'Popular' },
    ],
    exclusions: [],
  },
  conflict: {
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
  },
};

function loadPreset(preset) {
  el('workshops').value = JSON.stringify(preset.workshops, null, 2);
  el('students').value = JSON.stringify(preset.students, null, 2);
  el('exclusions').value = JSON.stringify(preset.exclusions, null, 2);
}

el('preset-fairness').addEventListener('click', () => loadPreset(PRESETS.fairness));
el('preset-conflict').addEventListener('click', () => loadPreset(PRESETS.conflict));

// --- CSV import --------------------------------------------------------------
// A "class" here is one uploaded CSV file's worth of students; loadedClasses
// tracks them so multiple class files can be merged, mirroring how a teacher
// would upload one CSV per class in a real app (see README "Input contract").
let loadedClasses = [];

function renderLoadedClasses() {
  const list = el('loaded-classes');
  list.innerHTML =
    loadedClasses
      .map(
        (c, i) =>
          `<li>${escapeHtml(c.label)} — ${c.students.length} student(s) <button data-index="${i}" class="remove-class" type="button">Remove</button></li>`,
      )
      .join('') || '<li class="empty-hint">No class loaded yet.</li>';

  list.querySelectorAll('.remove-class').forEach((button) => {
    button.addEventListener('click', () => {
      loadedClasses.splice(Number(button.dataset.index), 1);
      renderLoadedClasses();
    });
  });

  el('students').value = JSON.stringify(loadedClasses.flatMap((c) => c.students), null, 2);
}

function applyWorkshopsCsv(text) {
  el('workshops').value = JSON.stringify(workshopsFromCsv(text), null, 2);
}

function applyClassCsv(label, text) {
  loadedClasses.push({ label, students: studentsFromCsv(text) });
  renderLoadedClasses();
}

function applyExclusionsCsv(text) {
  el('exclusions').value = JSON.stringify(exclusionsFromCsv(text), null, 2);
}

function handleFileInput(inputId, apply) {
  el(inputId).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    apply(file, await file.text());
    event.target.value = ''; // allow re-selecting the same file later
  });
}

handleFileInput('workshops-csv', (_file, text) => applyWorkshopsCsv(text));
handleFileInput('class-csv', (file, text) => applyClassCsv(file.name, text));
handleFileInput('exclusions-csv', (_file, text) => applyExclusionsCsv(text));

el('clear-classes').addEventListener('click', () => {
  loadedClasses = [];
  renderLoadedClasses();
});

el('preset-solvay').addEventListener('click', async () => {
  loadedClasses = [];
  const [workshopsText, solvayText, franceText, exclusionsText] = await Promise.all([
    fetch('./samples/workshops.csv').then((r) => r.text()),
    fetch('./samples/students-solvay-1911.csv').then((r) => r.text()),
    fetch('./samples/students-france-98.csv').then((r) => r.text()),
    fetch('./samples/exclusions.csv').then((r) => r.text()),
  ]);
  applyWorkshopsCsv(workshopsText);
  applyClassCsv('students-solvay-1911.csv', solvayText);
  applyClassCsv('students-france-98.csv', franceText);
  applyExclusionsCsv(exclusionsText);
});

renderLoadedClasses();

function readInputFromForm() {
  const workshops = JSON.parse(el('workshops').value || '[]');
  const students = JSON.parse(el('students').value || '[]');
  const exclusionsText = el('exclusions').value.trim();
  const exclusions = exclusionsText ? JSON.parse(exclusionsText) : undefined;
  const strictExclusions = el('strictExclusions').checked;
  return { workshops, students, exclusions, options: { strictExclusions } };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderClassroomTable(byClassroom) {
  const rows = Object.entries(byClassroom).flatMap(([className, entries]) =>
    entries.map((entry) => ({ className, ...entry })),
  );
  if (rows.length === 0) return '<p class="empty-hint">No assignments.</p>';
  return `
    <table>
      <thead><tr><th>Class</th><th>Student</th><th>Workshop</th><th>Choice rank</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${escapeHtml(r.className)}</td>
              <td>${escapeHtml(r.studentName)}</td>
              <td>${escapeHtml(r.workshopName)}</td>
              <td class="${r.satisfiedChoiceRank === null ? 'rank-null' : ''}">${r.satisfiedChoiceRank ?? 'none'}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderWorkshopTable(byWorkshop) {
  const rows = Object.entries(byWorkshop).flatMap(([workshopName, entries]) =>
    entries.map((entry) => ({ workshopName, ...entry })),
  );
  if (rows.length === 0) return '<p class="empty-hint">No assignments.</p>';
  return `
    <table>
      <thead><tr><th>Workshop</th><th>Student</th><th>Class</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr><td>${escapeHtml(r.workshopName)}</td><td>${escapeHtml(r.studentName)}</td><td>${escapeHtml(r.className)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderResult(result, { onConfirm } = {}) {
  const d = result.statistics?.choiceDistribution;
  const distributionHtml = d
    ? `<p>Choice 1: <b>${d.choice1}</b> &nbsp; Choice 2: <b>${d.choice2}</b> &nbsp; Choice 3: <b>${d.choice3}</b> &nbsp; Unmatched: <b>${d.unmatched}</b></p>`
    : '';

  const warningsHtml =
    result.warnings && result.warnings.length > 0
      ? `<ul class="warnings">${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : '';

  const conflictsHtml =
    result.unresolvedExclusionConflicts && result.unresolvedExclusionConflicts.length > 0
      ? `<ul class="conflicts">${result.unresolvedExclusionConflicts
          .map(
            (c) =>
              `<li>${escapeHtml(c.studentA.lastName)} ${escapeHtml(c.studentA.firstName)} (${escapeHtml(c.studentA.className)}) `
              + `and ${escapeHtml(c.studentB.lastName)} ${escapeHtml(c.studentB.firstName)} (${escapeHtml(c.studentB.className)}) `
              + `would both end up in "${escapeHtml(c.workshop)}"</li>`,
          )
          .join('')}</ul>`
      : '';

  const confirmButtonHtml =
    result.status === 'NEEDS_CONFIRMATION'
      ? '<button class="confirm" id="confirm-relaxation">Confirm relaxation and apply best-effort result</button>'
      : '';

  el('result-panel').innerHTML = `
    <p><span class="status-badge status-${result.status}">${result.status}</span> ${result.message ? escapeHtml(result.message) : ''}</p>
    <p>Total score (informational only — see README "Fairness model"): <b>${result.totalScore}</b></p>
    ${distributionHtml}
    ${conflictsHtml ? `<h4>Exclusion conflicts</h4>${conflictsHtml}` : ''}
    ${confirmButtonHtml}
    ${warningsHtml ? `<h4>Warnings</h4>${warningsHtml}` : ''}
    <h4>By classroom</h4>
    ${renderClassroomTable(result.byClassroom)}
    <h4>By workshop</h4>
    ${renderWorkshopTable(result.byWorkshop)}
    <details>
      <summary>Raw result JSON</summary>
      <pre>${escapeHtml(JSON.stringify(result, (k, v) => v, 2))}</pre>
    </details>
  `;

  const confirmButton = el('confirm-relaxation');
  if (confirmButton && onConfirm) {
    confirmButton.addEventListener('click', onConfirm);
  }
}

function renderError(error) {
  const isCoherence = error && error.name === 'CoherenceError';
  el('result-panel').innerHTML = `
    <p><span class="status-badge status-ERROR">${isCoherence ? 'CoherenceError' : 'ERROR'}</span> ${escapeHtml(error.message)}</p>
    ${isCoherence ? `<pre>${escapeHtml(JSON.stringify(error.details, null, 2))}</pre>` : ''}
  `;
}

async function runAssignment(input) {
  el('run-status').textContent = 'Solving…';
  try {
    const result = await assignStudentsToWorkshops(input);
    el('run-status').textContent = '';
    renderResult(result, {
      onConfirm: () =>
        runAssignment({ ...input, options: { ...input.options, confirmedExclusionRelaxation: true } }),
    });
  } catch (error) {
    el('run-status').textContent = '';
    renderError(error);
  }
}

el('run').addEventListener('click', () => {
  let input;
  try {
    input = readInputFromForm();
  } catch (error) {
    renderError(new Error(`Invalid JSON in one of the input fields: ${error.message}`));
    return;
  }
  runAssignment(input);
});

// Start with a preset loaded so the page isn't empty on first load.
loadPreset(PRESETS.fairness);
