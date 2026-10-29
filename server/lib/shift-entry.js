/**
 * Typing a shift in: the arithmetic each family's workbook does on a shift
 * row, and writing the row. Shared by the one-machine form and the whole-shift
 * table, so a shift entered either way reads the same as an imported one.
 */
import { query } from '../db.js';

/** The shift before this one: B follows A, C follows B, A the night before's C. */
export function shiftBefore(tgl, shift) {
  if (shift === 'B') return [tgl, 'A'];
  if (shift === 'C') return [tgl, 'B'];
  const d = new Date(`${tgl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return [d.toISOString().slice(0, 10), 'C'];
}

/** The shift after this one: A is followed by B, B by C, C by the next day's A. */
export function shiftAfter(tgl, shift) {
  if (shift === 'A') return [tgl, 'B'];
  if (shift === 'B') return [tgl, 'C'];
  const d = new Date(`${tgl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return [d.toISOString().slice(0, 10), 'A'];
}

/** Loom width from the type: "SHUTTLE 75" is 75. */
export const widthOf = (type_mc) => Number(/(\d+)\s*$/.exec(type_mc ?? '')?.[1]) || null;

/**
 * Metres woven from the counter typed for an AJL or Rapier loom, as the
 * GARAP sheets work it out: the counter is metres per fabric, times the
 * fabrics woven at once — except a Rapier SULZER, whose counter is in
 * thousands of picks, so 1000 ÷ pick ÷ 39.37 metres per count.
 */
export function outputFromKetik(family, type_mc, jml_kain, pick, ketik) {
  if (ketik === null || ketik === undefined) return null;
  if (family === 'rapier' && /SULZER/i.test(type_mc ?? '')) {
    return pick > 0 ? (1000 / pick / 39.37) * ketik : null;
  }
  return jml_kain > 0 ? ketik * jml_kain : null;
}

/**
 * Each shuttle loom's last SODOKAN before this shift (or up to and including
 * it), whichever shift it was read on: a shift the loom stood with only a
 * note has none, and the reading before it carries on. `db` is the pool's
 * query or a transaction's client.
 */
export async function lastReadings(db, tgl, shift, inclusive = false) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (no_mc) no_mc, sodokan::float8 AS sodokan, kode_kain, tgl::text AS tgl, shift
    FROM production
    WHERE family = 'shuttle' AND sodokan IS NOT NULL AND (tgl, shift) ${inclusive ? '<=' : '<'} ($1::date, $2)
    ORDER BY no_mc, tgl DESC, shift DESC`, [tgl, shift]);
  return new Map(rows.map((r) => [r.no_mc, r]));
}

/**
 * Where a shift's reading starts: the loom's last one, or 0 when the loom has
 * since gone on to another fabric — a new roll. null when it has no reading yet.
 */
export function awalOf(last, kode_kain) {
  if (!last) return null;
  if (kode_kain && last.kode_kain && last.kode_kain !== kode_kain) return 0;
  return Number(last.sodokan);
}

/** The SODOKAN table as a Map "kode|width|cm" → metres on the roll. */
export async function sodokanTables(db = { query }) {
  const { rows } = await db.query(`SELECT kode_kain, width, cm, meter FROM shuttle_sodokan`);
  return new Map(rows.map((r) => [`${r.kode_kain}|${r.width}|${Number(r.cm)}`, Number(r.meter)]));
}

/** As every imported shuttle row: one fabric, no RPM or counter reading. */
export const SHUTTLE_FIXED = { jml_kain: 1, rpm: null, ketik: null };

/**
 * Writes one machine-shift, replacing what was there. `db` is the pool's
 * query or a transaction's client. Per-fabric metres and the RPM total are
 * derived here, the way the workbook derives them; a shuttle row has neither.
 *
 * The row is marked manual — typed on the dashboard — so an Excel import
 * cannot overwrite it, and keeps the pick it was worked out with (`pick_used`;
 * left out, the database takes the MO's pick for the day).
 */
export async function upsertProduction(db, r) {
  const jml = r.jml_kain || null;
  const hit_rpm = r.rpm != null && jml ? r.rpm * jml : null;
  const ketik_prod = r.family === 'shuttle' ? null
    : r.ketik_prod ?? (r.produksi != null && jml ? r.produksi / jml : null);
  const { rows: [row] } = await db.query(`
    INSERT INTO production
      (tgl, shift, no_mc, mo, kode_kain, type_mc, kelompok_mesin, jml_kain,
       rpm, rpm_target, hit_rpm, produksi, ketik_rpm, ketik_prod, ket_bb, source_file,
       jam_mulai, jam_selesai, edited_by, family, ketik, sodokan, pick_used, manual, calc, sodokan_awal)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$13,$14,'manual entry',$15,$16,$17,$18,$19,$20,$21,true,$22,$23)
    ON CONFLICT (family, tgl, shift, no_mc) DO UPDATE SET
      mo = EXCLUDED.mo, kode_kain = EXCLUDED.kode_kain, type_mc = EXCLUDED.type_mc,
      kelompok_mesin = EXCLUDED.kelompok_mesin, jml_kain = EXCLUDED.jml_kain,
      rpm = EXCLUDED.rpm, rpm_target = EXCLUDED.rpm_target, hit_rpm = EXCLUDED.hit_rpm,
      produksi = EXCLUDED.produksi, ketik_rpm = EXCLUDED.ketik_rpm,
      ketik_prod = EXCLUDED.ketik_prod, ket_bb = EXCLUDED.ket_bb,
      jam_mulai = EXCLUDED.jam_mulai, jam_selesai = EXCLUDED.jam_selesai,
      edited_by = EXCLUDED.edited_by, ketik = EXCLUDED.ketik, sodokan = EXCLUDED.sodokan,
      sodokan_awal = EXCLUDED.sodokan_awal,
      pick_used = EXCLUDED.pick_used, manual = true, calc = EXCLUDED.calc,
      source_file = 'manual entry', imported_at = now()
    RETURNING (xmax = 0) AS inserted, tgl::text, shift, no_mc, produksi, ketik, sodokan, edited_by,
              to_char(jam_mulai, 'HH24:MI') AS jam_mulai,
              to_char(jam_selesai, 'HH24:MI') AS jam_selesai`,
  [r.tgl, r.shift, r.no_mc, r.mo || null, r.kode_kain || null, r.type_mc || null,
    r.kelompok_mesin || null, jml, r.rpm ?? null, r.rpm_target ?? null, hit_rpm, r.produksi ?? null,
    ketik_prod, (r.ket_bb || '').trim() || null, r.jam_mulai ?? null, r.jam_selesai ?? null,
    r.edited_by ?? null, r.family, r.ketik ?? null, r.sodokan ?? null, r.pick_used ?? null,
    r.calc ?? `${r.family}-1`, r.sodokan_awal ?? null]);
  return { ...row, ketik_prod, hit_rpm };
}
