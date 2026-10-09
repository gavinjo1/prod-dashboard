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

/* ------------------------------------------------------------------ *
 * Deciding what an import may write
 *
 * One policy for every sheet that lands in production or grade:
 *
 *   new row                      written
 *   same values as stored        left alone (counted as unchanged)
 *   stored row came from import  written, its old values kept for undo
 *   stored row typed or corrected on the dashboard (production.manual)
 *                                never overwritten: kept as a conflict for
 *                                someone to decide (import_conflict)
 *
 * Values are compared as the database will hold them: a loom whose type is
 * overridden, and Rapier's deret, are applied to the incoming row first, or
 * every re-import of the same file would look like a change. HIT RPM and
 * KETIK RPM are worked out from the RPM when a shift is typed in; a sheet
 * without those columns is not taken to differ there.
 * ------------------------------------------------------------------ */

const KEY = {
  production: ['family', 'tgl', 'shift', 'no_mc'],
  grade: ['family', 'tgl', 'mo', 'kode_kain']
};

/** Rapier's row pair from a machine number, as rapier_deret() in the schema. */
export function rapierDeret(no_mc) {
  const c = String(no_mc ?? '').trim().toUpperCase().charCodeAt(0);
  if (!(c >= 65 && c <= 90)) return null;
  const first = 65 + 2 * Math.floor((c - 65) / 2);
  return String.fromCharCode(first, first + 1);
}

// Worked out on the dashboard from the RPM; a file that leaves them out does not differ.
const DERIVED = new Set(['hit_rpm', 'ketik_rpm']);

const same = (a, b) => {
  const blank = (v) => v === null || v === undefined || v === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'string' && typeof b !== 'string') {
    return Math.abs(na - nb) < 1e-9;
  }
  return String(a).trim() === String(b).trim();
};

export async function planRows(client, dataset, records) {
  const key = KEY[dataset];
  if (!key || !records.length) return { write: records, unchanged: 0, conflicts: [] };
  const cols = dataset === 'production' ? PROD_COLS : GRADE_COLS;
  const compare = cols.filter((c) => !key.includes(c));
  const keyOf = (r) => key.map((c) => String(r[c] ?? '')).join('|');

  const { rows: stored } = await client.query(`
    SELECT t.*, t.tgl::text AS tgl FROM ${dataset} t
    JOIN unnest($1::text[], $2::date[], $3::text[], $4::text[]) AS k(${key.join(', ')})
      USING (${key.join(', ')})`,
  key.map((c) => records.map((r) => r[c] ?? null)));
  const byKey = new Map(stored.map((r) => [keyOf(r), r]));

  let overrides = new Map();
  if (dataset === 'production') {
    const { rows } = await client.query(
      `SELECT family, no_mc, type_mc FROM machine_type_override WHERE family = ANY($1)`,
      [[...new Set(records.map((r) => r.family))]]);
    overrides = new Map(rows.map((r) => [`${r.family}|${r.no_mc}`, r.type_mc]));
  }

  const write = [];
  const conflicts = [];
  let unchanged = 0;
  for (const rec of records) {
    const was = byKey.get(keyOf(rec));
    if (!was) { write.push(rec); continue; }
    const incoming = { ...rec };
    if (dataset === 'production') {
      incoming.type_mc = overrides.get(`${rec.family}|${rec.no_mc}`) ?? rec.type_mc;
      if (rec.family === 'rapier') incoming.kelompok_mesin = rapierDeret(rec.no_mc);
    }
    const differs = compare.filter((c) => !same(incoming[c], was[c])
      && !(DERIVED.has(c) && (incoming[c] === null || incoming[c] === undefined)));
    if (!differs.length) { unchanged++; continue; }
    if (was.manual) { conflicts.push({ rec, was, differs }); continue; }
    write.push(rec);
  }
  return { write, unchanged, conflicts };
}

/**
 * Keeps each refused row, with what is stored, for someone to decide — once:
 * the same row from a second sheet of the workbook, or from the same file
 * uploaded again, is not recorded twice while the first is still open.
 */
export async function recordConflicts(client, batchId, dataset, conflicts, sourceFile) {
  const key = KEY[dataset];
  let recorded = 0;
  for (const { rec, was, differs } of conflicts) {
    const { rowCount } = await client.query(`
      INSERT INTO import_conflict (batch_id, table_name, key_json, incoming_json, existing_json, source_file)
      SELECT $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6
      WHERE NOT EXISTS (
        SELECT 1 FROM import_conflict c
        WHERE c.status = 'open' AND c.table_name = $2 AND c.key_json = $3::jsonb
          AND c.incoming_json - '_differs' = $4::jsonb - '_differs')`,
    [batchId, dataset, JSON.stringify(Object.fromEntries(key.map((c) => [c, rec[c]]))),
      JSON.stringify({ ...rec, _differs: differs }), JSON.stringify(was), sourceFile]);
    recorded += rowCount;
  }
  return recorded;
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
  // A production row from a workbook carries the workbook's own figure.
  const all = [...cols, 'source_file', ...(credited ? ['edited_by', 'batch_id', 'calc'] : [])];
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
      values.push(...cols.map((c) => rec[c]), sourceFile, ...(credited ? [editedBy, batchId, 'excel'] : []));
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
        ${credited ? `edited_by = ${stamp}, batch_id = EXCLUDED.batch_id, calc = EXCLUDED.calc,` : ''}
        imported_at = now()
      ${table === 'production' ? 'WHERE NOT production.manual' : ''}
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
