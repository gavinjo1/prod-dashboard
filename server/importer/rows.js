/**
 * Turning recognised sheets into rows, and writing them.
 */
import { toDate, toNum, toText } from './values.js';

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export const PROD_COLS = ['family', 'tgl', 'shift', 'no_mc', 'mo', 'kode_kain', 'type_mc', 'kelompok_mesin',
  'jml_kain', 'rpm', 'rpm_target', 'hit_rpm', 'produksi', 'ketik_rpm', 'ketik_prod', 'ket_bb',
  'ketik', 'sodokan'];
export const PROD_NUM = new Set(['jml_kain', 'rpm', 'rpm_target', 'hit_rpm', 'produksi', 'ketik_rpm', 'ketik_prod',
  'ketik', 'sodokan']);

/**
 * The shuttle sheet prices every loom at 165 RPM, one width at a time:
 * PROD 100% = 165 × 60 × 24 × 2,54 ÷ (pick × 100) a day. Stored as RPM target
 * and widths, the dashboard's own target formula gives the same figure.
 */
export const SHUTTLE_RPM = 165;

export const GRADE_COLS = ['family', 'tgl', 'mo', 'kode_kain', 'grade_a', 'grade_b', 'bs', 'rk', 'total'];
export const GRADE_NUM = new Set(['grade_a', 'grade_b', 'bs', 'rk', 'total']);

/**
 * The shuttle DATA sheet as production rows. METER is the output; KETIK and
 * SODOKAN are kept beside it, and the loom width and line become its type and
 * group. `pick` rides along for the order list and is not a production column.
 */
function buildShuttleRows({ headerRow, map, rows }) {
  const out = [];
  let skipped = 0;
  const at = (raw, f) => (map[f] === undefined ? null : raw[map[f]]);
  for (let i = headerRow + 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.every((c) => c === null || c === '')) continue;
    const tgl = toDate(at(raw, 'tgl'));
    const no_mc = toText(at(raw, 'no_mc'));
    if (!tgl || !no_mc) { skipped++; continue; }
    const width = toNum(at(raw, 'width'));
    const line = toText(at(raw, 'line'));
    out.push({
      tgl, no_mc,
      shift: toText(at(raw, 'shift')) || '-',
      mo: toText(at(raw, 'mo')),
      kode_kain: toText(at(raw, 'kode_kain')),
      type_mc: width ? `SHUTTLE ${width}` : null,
      kelompok_mesin: line ? `LINE ${line}` : null,
      jml_kain: 1,
      rpm: null,
      rpm_target: SHUTTLE_RPM,
      hit_rpm: null,
      produksi: toNum(at(raw, 'produksi')),
      ketik_rpm: null,
      ketik_prod: null,
      ket_bb: toText(at(raw, 'ket_bb')),
      ketik: toNum(at(raw, 'counter')),
      sodokan: toNum(at(raw, 'sodokan')),
      pick: toNum(at(raw, 'pick'))
    });
  }
  return { records: out, saldo: [], skipped };
}

/**
 * Shifts whose SODOKAN converted to no METER — the fabric and loom width have
 * no line in the workbook's SODOKAN table, and Excel's lookup quietly returns
 * 0. Said out loud, grouped by what is missing, so the table can be completed.
 */
export function shuttleGaps(records) {
  const gaps = new Map();
  for (const r of records) {
    if (!(r.sodokan > 0) || r.produksi > 0) continue;
    const k = `${r.kode_kain ?? '?'} / ${r.type_mc?.replace('SHUTTLE ', 'MC ') ?? '?'}`;
    gaps.set(k, (gaps.get(k) ?? 0) + 1);
  }
  if (!gaps.size) return null;
  const n = [...gaps.values()].reduce((a, b) => a + b, 0);
  return `${n} shift ada sodokannya tapi METER 0 — tabel SODOKAN di Excel belum lengkap untuk: ` +
    [...gaps.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ') + '.';
}

export function buildRows(found) {
  if (found.dataset === 'shuttle') return buildShuttleRows(found);
  const { dataset, headerRow, map, rows } = found;
  const cols = dataset === 'production' ? PROD_COLS : GRADE_COLS;
  const nums = dataset === 'production' ? PROD_NUM : GRADE_NUM;
  const out = [];
  const saldo = [];
  let skipped = 0;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.every((c) => c === null || c === '')) continue;

    const rec = {};
    for (const col of cols) {
      const idx = map[col];
      const v = idx === undefined ? null : raw[idx];
      rec[col] = col === 'tgl' ? toDate(v) : nums.has(col) ? toNum(v) : toText(v);
    }

    // A row without a real date is a SALDO / subtotal line, not a measurement.
    // SALDO lines still matter: they carry each order's opening balance.
    if (!rec.tgl) {
      const marker = String(raw[map.tgl] ?? '').trim().toUpperCase();
      if (dataset === 'production' && marker === 'SALDO' && rec.mo && rec.produksi !== null) {
        saldo.push({ mo: rec.mo, kode_kain: rec.kode_kain, produksi: rec.produksi });
      }
      skipped++;
      continue;
    }

    if (dataset === 'production') {
      if (!rec.no_mc) { skipped++; continue; }
      rec.shift = rec.shift || '-';
    } else {
      if (!rec.mo) { skipped++; continue; }
      for (const c of GRADE_NUM) rec[c] = rec[c] ?? 0;
      if (!rec.total) rec.total = rec.grade_a + rec.grade_b + rec.bs + rec.rk;
    }
    out.push(rec);
  }
  return { records: out, saldo, skipped };
}

/** Last row wins when a sheet repeats a key, so a corrected line overrides. */
export function dedupe(records, keyOf) {
  const seen = new Map();
  for (const r of records) seen.set(keyOf(r), r);
  return [...seen.values()];
}

export async function upsert(client, dataset, records, sourceFile, editedBy = null, batchId = null) {
  // Same shape as the normal return: the caller destructures the result, and a
  // bare 0 left `written` undefined, which import_log then stored as NULL for
  // any recognised sheet that turned out to hold no rows.
  if (!records.length) return { inserted: 0, updated: 0, written: 0 };

  const cols = dataset === 'production' ? PROD_COLS : GRADE_COLS;
  const table = dataset === 'production' ? 'production' : 'grade';
  const conflict = dataset === 'production'
    ? '(family, tgl, shift, no_mc)' : '(family, tgl, mo, kode_kain)';
  // Only production carries an editor. A row imported before sign-in existed
  // keeps NULL unless this run actually rewrites it.
  const credited = dataset === 'production';
  const all = [...cols, 'source_file', ...(credited ? ['edited_by', 'batch_id'] : [])];
  const updates = cols.filter((c) => !conflict.includes(c));

  // Re-importing the same workbook re-writes every row it contains. Crediting
  // the importer for all of them would put a name against months of figures
  // they never touched, so the stamp only moves when a value actually differs;
  // an unchanged row keeps whatever it had, which for the backlog is nothing.
  const stamp = credited
    ? `CASE WHEN (${updates.map((c) => `${table}.${c}`).join(', ')})
              IS DISTINCT FROM (${updates.map((c) => `EXCLUDED.${c}`).join(', ')})
            THEN EXCLUDED.edited_by ELSE ${table}.edited_by END`
    : null;

  let inserted = 0;
  let updated = 0;
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const values = [];
    const tuples = batch.map((rec, r) => {
      const ph = all.map((_, c) => `$${r * all.length + c + 1}`);
      values.push(...cols.map((c) => rec[c]), sourceFile, ...(credited ? [editedBy, batchId] : []));
      return `(${ph.join(',')})`;
    });

    // xmax is 0 on a freshly inserted row and non-zero on one the conflict
    // clause updated, which is what separates "new day" from "corrected day".
    const sql = `
      INSERT INTO ${table} (${all.join(',')})
      VALUES ${tuples.join(',')}
      ON CONFLICT ${conflict} DO UPDATE SET
        ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
        source_file = EXCLUDED.source_file,
        ${credited ? `edited_by = ${stamp}, batch_id = EXCLUDED.batch_id,` : ''}
        imported_at = now()
      RETURNING (xmax = 0) AS is_new`;
    const res = await client.query(sql, values);
    for (const row of res.rows) row.is_new ? inserted++ : updated++;
  }
  return { inserted, updated, written: inserted + updated };
}

/**
 * Import every recognisable sheet in a workbook.
 * `only` limits the run to named sheets; `dataset` forces the target table;
 * `editedBy` is the signed-in user credited on every production row written.
 */
/** Rows carry the family they were imported under; nothing guesses it later. */
export const FAMILIES = ['ajl', 'rapier', 'shuttle'];
