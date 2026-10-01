/**
 * The combined report sheet, LAPORAN PRODUKSI GABUNGAN.
 */
import { toDate, toNum } from './values.js';
import { sheetRows } from './workbook.js';

/* ------------------------------------------------------------------ *
 * Combined report — LAPORAN PRODUKSI GABUNGAN, all loom families
 *
 *   TGL | BS        | ACTUAL HASIL KAIN | PRODUKSI | PICK  | PICK MESIN/BULAN                        | PICK KAIN INSPECT/BULAN                        | PICK INSPECT
 *       | PJG | %   | METER | %         | 100%     | MESIN | SHUTTLE | RAPIER | AJL | PICK MC | ×PROD | SHUTTLE | RAPIER | AJL 1+2+3+4 | ×PROD      | PERHARI
 *
 * Two header rows: the group names, merged across their columns, then the
 * column names under them. SHUTTLE and RAPIER appear under both groups, so a
 * column is identified by its group and its name together, never position.
 * ------------------------------------------------------------------ */

/** Like normHeader, but keeps "%" — "%" and "100%" are real column names here. */
export const normGab = (h) => String(h ?? '').toUpperCase().replace(/%/g, 'PCT').replace(/[^A-Z0-9]/g, '');

export const GAB_COLUMNS = {
  bs_pjg:       (g, s) => g === 'BS' && s === 'PJG',
  actual_meter: (g, s) => g.startsWith('ACTUAL') && s === 'METER',
  prod100:      (g, s) => g === 'PRODUKSI',
  pm_shuttle:   (g, s) => g === 'PICKMESINBULAN' && s === 'SHUTTLE',
  pm_rapier:    (g, s) => g === 'PICKMESINBULAN' && s === 'RAPIER',
  pm_ajl:       (g, s) => g === 'PICKMESINBULAN' && s.startsWith('AJL'),
  pi_shuttle:   (g, s) => g.startsWith('PICKKAININSPECT') && s === 'SHUTTLE',
  pi_rapier:    (g, s) => g.startsWith('PICKKAININSPECT') && s === 'RAPIER',
  pi_ajl:       (g, s) => g.startsWith('PICKKAININSPECT') && s.startsWith('AJL')
};
export const GAB_FIELDS = Object.keys(GAB_COLUMNS);

export const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7, AUG: 8, AGU: 8, AGS: 8,
  SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DES: 12 };

/**
 * A date cell is normally a real date. If it was typed as text — "1-Sep" —
 * it has no year, so the year comes from the sheet's title.
 */
export function gabDate(v, year) {
  // Checked before toDate: JavaScript's own parser reads "1-Sep" as 2001.
  const m = typeof v === 'string' && /^\s*(\d{1,2})[\s\-/.]+([A-Za-z]{3})[A-Za-z]*\s*$/.exec(v);
  const month = m && MONTHS[m[2].toUpperCase()];
  if (month) return year ? `${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  return toDate(v);
}

export function readGabungan(ws) {
  const rows = sheetRows(ws);

  for (let r = 0; r + 1 < Math.min(rows.length, 20); r++) {
    const top = rows[r].map(normGab);
    if (top[0] !== 'TGL' || !top.includes('PICKMESINBULAN')) continue;

    // A merged group name sits in its first column only; carry it rightwards.
    const group = [];
    top.forEach((g, c) => { group[c] = g || group[c - 1] || ''; });
    const sub = rows[r + 1].map(normGab);

    const col = {};
    for (const [field, match] of Object.entries(GAB_COLUMNS)) {
      const c = group.findIndex((g, i) => i > 0 && match(g, sub[i] || ''));
      if (c !== -1) col[field] = c;
    }
    if (col.actual_meter === undefined || col.prod100 === undefined) continue;

    const title = rows.slice(0, r).flat().map((v) => String(v ?? '')).join(' ');
    const year = /\b(20\d{2})\b/.exec(title)?.[1];

    const out = [];
    for (let i = r + 2; i < rows.length; i++) {
      const tgl = gabDate(rows[i][0], year);
      if (!tgl) continue;   // the totals below the days carry a count, not a date
      const e = { tgl };
      for (const [field, c] of Object.entries(col)) e[field] = toNum(rows[i][c]);
      // Days the sheet has not been filled in yet are left out.
      if (!e.actual_meter && !e.prod100) continue;
      out.push(e);
    }
    if (out.length) return out;
  }
  return [];
}

export async function upsertGabungan(client, entries, sourceFile) {
  const cols = ['tgl', ...GAB_FIELDS];
  const n = cols.length + 1;
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(...cols.map((c) => e[c] ?? null), sourceFile);
    return `(${Array.from({ length: n }, (_, k) => `$${i * n + k + 1}`).join(',')})`;
  });
  const { rows } = await client.query(`
    INSERT INTO gabungan_harian (${cols.join(',')}, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (tgl) DO UPDATE SET
      ${GAB_FIELDS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
      source_file = EXCLUDED.source_file, imported_at = now()
    RETURNING (xmax = 0) AS inserted`, values);
  const inserted = rows.filter((x) => x.inserted).length;
  return { written: rows.length, inserted, updated: rows.length - inserted };
}
