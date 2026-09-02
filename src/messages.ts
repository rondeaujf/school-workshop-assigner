import type { Warning, WarningCode } from './types.js';

// English default renderings for every warning code. Consumers that need other
// languages should switch on `warning.code` / `warning.params` and ignore
// `warning.message`; this catalog only guarantees the library is usable with no
// i18n layer wired at all.
const WARNING_TEMPLATES: Record<WarningCode, (p: Record<string, string | number>) => string> = {
  DUPLICATE_WORKSHOP_NAME: (p) =>
    `Duplicate workshop name "${p.name}": choices will only ever match the first one declared. ` +
    `Give each workshop a distinct name if they are meant to be separate.`,
  UNRECOGNIZED_CHOICE: (p) =>
    `Choice "${p.choice}" for student "${p.studentName}" (${p.className}) does not match any known workshop.`,
  STUDENT_NO_VALID_CHOICE: (p) => `Student "${p.studentName}" (${p.className}) has no valid recognized choice.`,
  EXCLUSION_STUDENT_NOT_FOUND: (p) =>
    `Exclusion ignored (student not found): "${p.studentA}" (${p.classNameA}) / "${p.studentB}" (${p.classNameB}).`,
  EXCLUSION_SELF_REFERENCE: (p) =>
    `Exclusion ignored (both sides refer to the same student): "${p.studentA}" (${p.classNameA}).`,
};

/** Builds a warning with its stable code, params, and English default message. */
export function warn(code: WarningCode, params: Record<string, string | number>): Warning {
  return { code, params, message: WARNING_TEMPLATES[code](params) };
}
