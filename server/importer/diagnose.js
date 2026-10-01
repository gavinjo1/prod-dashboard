/**
 * Why a workbook produced nothing, in words the user can act on.
 */
import { GRADE_FIELDS, PRODUCTION_FIELDS, mapColumns } from './headers.js';
import { sheetRows } from './workbook.js';

/**
 * Why a workbook produced nothing. A generic "no sheet found" leaves the user
 * guessing, when almost always one column is simply spelled in a way the alias
 * list does not carry — so name the columns that were found, the ones that are
 * missing, and the headers actually seen.
 */
export const FIELD_LABEL = {
  tgl: 'TGL (date)', no_mc: 'NO MC (machine)', produksi: 'PRODUKSI (output)',
  mo: 'MO (order)', grade_a: 'A (grade A)'
};

export function diagnose(wb, only = null) {
  let best = null;
  for (const name of wb.SheetNames) {
    if (only && !only.includes(name)) continue;
    let rows;
    try { rows = sheetRows(wb.Sheets[name]); } catch { continue; }

    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      for (const [dataset, fields, required] of [
        ['production', PRODUCTION_FIELDS, ['tgl', 'no_mc', 'produksi']],
        ['grade', GRADE_FIELDS, ['tgl', 'mo', 'grade_a']]
      ]) {
        const map = mapColumns(rows[i], fields);
        const have = required.filter((f) => f in map);
        if (!have.length) continue;
        const score = have.length + Object.keys(map).length / 100;
        if (!best || score > best.score) {
          best = {
            score, sheet: name, dataset, have,
            missing: required.filter((f) => !(f in map)),
            headers: rows[i].filter((h) => h !== null && String(h).trim() !== '')
              .map((h) => String(h).trim()).slice(0, 25)
          };
        }
      }
    }
  }
  return best;
}
