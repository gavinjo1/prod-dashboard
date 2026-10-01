/**
 * The machine-type legend in the banded header of the daily sheets.
 */
import XLSX from 'xlsx';

/* ------------------------------------------------------------------ *
 * Machine-type legend
 *
 * The daily report sheets carry a banded header the data rows do not:
 *
 *   row N-1   AJL TOYOTA 1 . . . . . . . . . . . .   (band, merged)
 *   row N     E SHADE | E SHADE 190 | AJL MEKANICAL  (the mill's own name)
 *   row N+1   RUMUS | PICK RATA² | MC JLN | PROD
 *   row N+2   TOYOTA AJL E-SHD 1 | ... | AJL TOYOTA 1 LAMA   (TYPE MC code)
 *
 * Reading it gives every TYPE MC a human name, so the dashboard can show
 * "AJL 2 AIR TUCKER" instead of only "AJL TOYOTA CAM 2".
 * ------------------------------------------------------------------ */

/** Horizontal merges starting on `row`, as {startCol: width}. */
export function rowMerges(ws, row) {
  const out = new Map();
  for (const m of ws['!merges'] || []) {
    if (m.s.r === row && m.e.r === row && m.e.c > m.s.c) out.set(m.s.c, m.e.c - m.s.c + 1);
  }
  return out;
}

/** Value at a cell, following a merge back to the range's anchor. */
export function mergedValue(ws, r, c, merges) {
  const direct = ws[XLSX.utils.encode_cell({ r, c })];
  if (direct && direct.v !== undefined && direct.v !== '') return direct.v;
  for (const m of merges) {
    if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) {
      const anchor = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
      return anchor ? anchor.v : null;
    }
  }
  return null;
}

export const legendText = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // Reject numbers and stray one-character cells.
  return s.length >= 2 && s.length <= 60 && !/^[\d.,%-]+$/.test(s) ? s : null;
};

/**
 * The description row is the only one of the three that is merged — each name
 * spans the four columns of its band — and the TYPE MC code sits two rows below
 * the start of each merge. Requiring that merge is what separates this header
 * from ordinary rows that happen to hold text.
 */
export function readTypeLegend(ws) {
  const merges = ws['!merges'] || [];
  if (!merges.length) return [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const lastRow = Math.min(range.e.r, 14);
  let best = [];

  for (let r = 0; r + 2 <= lastRow; r++) {
    const spans = rowMerges(ws, r);
    if (spans.size < 4) continue;

    const found = [];
    for (const [c, width] of spans) {
      const description = legendText(ws[XLSX.utils.encode_cell({ r, c })]?.v);
      const type_mc = legendText(ws[XLSX.utils.encode_cell({ r: r + 2, c })]?.v);
      if (!description || !type_mc) continue;

      // The band merge above is not always aligned to the description merge —
      // it can start a column later — so scan across the whole span.
      let band = null;
      for (let bc = c; r > 0 && bc < c + width && !band; bc++) {
        band = legendText(mergedValue(ws, r - 1, bc, merges));
      }
      found.push({ type_mc, description, band, sort_order: c });
    }
    const distinct = new Set(found.map((f) => f.type_mc)).size;
    if (found.length >= 4 && distinct === found.length && found.length > best.length) best = found;
  }
  return best;
}

export async function upsertTypes(client, entries, sourceFile) {
  if (!entries.length) return 0;
  // Only keep codes that appear in the data. A workbook has many formatted
  // sheets, and this is what stops a lookalike header becoming a junk row.
  const { rows } = await client.query('SELECT DISTINCT type_mc FROM production WHERE type_mc IS NOT NULL');
  const known = new Set(rows.map((r) => r.type_mc));
  entries = entries.filter((e) => known.has(e.type_mc));
  if (!entries.length) return 0;
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(e.type_mc, e.description, e.band, e.sort_order, sourceFile);
    return `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`;
  });
  const res = await client.query(`
    INSERT INTO machine_type (type_mc, description, band, sort_order, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (type_mc) DO UPDATE SET
      description = EXCLUDED.description,
      band        = EXCLUDED.band,
      sort_order  = EXCLUDED.sort_order,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}
