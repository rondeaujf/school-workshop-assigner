// Minimal RFC4180-ish CSV parser for the demo's file-import feature.
//
// The library itself deliberately does not parse CSV (see README "Input
// contract") — that is left to whatever app embeds it, since apps differ in
// how they collect files. This is that app-level parsing, kept dependency-free
// (no CDN library) to match the rest of this bundler-free demo.

/** Parses CSV text into an array of row arrays (raw strings, no header handling). */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parses CSV text into an array of objects keyed by the header row. */
export function parseCsvObjects(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) => {
    const obj = {};
    header.forEach((key, i) => {
      obj[key.trim()] = (row[i] ?? '').trim();
    });
    return obj;
  });
}

export function workshopsFromCsv(text) {
  return parseCsvObjects(text).map((row) => ({
    name: row.name,
    maxCapacity: row.maxCapacity,
  }));
}

export function studentsFromCsv(text) {
  return parseCsvObjects(text).map((row) => ({
    lastName: row.lastName,
    firstName: row.firstName,
    className: row.className,
    ...(row.choice1 ? { choice1: row.choice1 } : {}),
    ...(row.choice2 ? { choice2: row.choice2 } : {}),
    ...(row.choice3 ? { choice3: row.choice3 } : {}),
  }));
}

export function exclusionsFromCsv(text) {
  return parseCsvObjects(text).map((row) => ({
    studentA: { lastName: row.lastNameA, firstName: row.firstNameA, className: row.classNameA },
    studentB: { lastName: row.lastNameB, firstName: row.firstNameB, className: row.classNameB },
  }));
}
