/**
 * Typing a shift in: the arithmetic each family's workbook does on a shift
 * row, and writing the row. Shared by the one-machine form and the whole-shift
 * table, so a shift entered either way reads the same as an imported one.
 */
import { query } from '../db.js';
import { SHUTTLE_RPM } from '../importer/rows.js';

/** The shift before this one: B follows A, C follows B, A the night before's C. */
export function shiftBefore(tgl, shift) {
  if (shift === 'B') return [tgl, 'A'];
  if (shift === 'C') return [tgl, 'B'];
  const d = new Date(`${tgl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return [d.toISOString().slice(0, 10), 'C'];
}

/**
 * SODOKAN is the counter's advance over the shift. A reading below the one
 * before means the counter was reset, and the reading itself is the advance.
 * Rounded to 2 places, as the daily sheets round it before the lookup.
 */
export const sodokanOf = (ketik, before) =>
  Math.round((before <= ketik ? ketik - before : ketik) * 100) / 100;

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

/** The counter reading the shift before ended on; ketik is null when none was kept. */
export async function ketikBefore(no_mc, tgl, shift) {
  const [t, s] = shiftBefore(tgl, shift);
  const { rows: [r] } = await query(`
    SELECT ketik FROM production
    WHERE family = 'shuttle' AND no_mc = $1 AND tgl = $2 AND shift = $3 AND ketik IS NOT NULL`,
  [no_mc, t, s]);
  return { tgl: t, shift: s, ketik: r ? Number(r.ketik) : null };
}

/** METER for a SODOKAN from the workbook's table, or null when it has no line. */
export async function meterOf(kode_kain, width, sodokan) {
  if (sodokan === 0) return 0;
  const { rows: [r] } = await query(`
    SELECT meter FROM shuttle_sodokan
    WHERE kode_kain = $1 AND width = $2 AND cm = round($3::numeric, 2)`, [kode_kain, width, sodokan]);
  return r ? Number(r.meter) : null;
}

/** As every imported shuttle row: one fabric, the shed's fixed RPM, no RPM reading. */
export const SHUTTLE_FIXED = { jml_kain: 1, rpm: null, rpm_target: SHUTTLE_RPM };

/**
 * Writes one machine-shift, replacing what was there. `db` is the pool's
 * query or a transaction's client. Per-fabric metres and the RPM total are
 * derived here, the way the workbook derives them; a shuttle row has neither.
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
       jam_mulai, jam_selesai, edited_by, family, ketik, sodokan)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$13,$14,'manual entry',$15,$16,$17,$18,$19,$20)
    ON CONFLICT (family, tgl, shift, no_mc) DO UPDATE SET
      mo = EXCLUDED.mo, kode_kain = EXCLUDED.kode_kain, type_mc = EXCLUDED.type_mc,
      kelompok_mesin = EXCLUDED.kelompok_mesin, jml_kain = EXCLUDED.jml_kain,
      rpm = EXCLUDED.rpm, rpm_target = EXCLUDED.rpm_target, hit_rpm = EXCLUDED.hit_rpm,
      produksi = EXCLUDED.produksi, ketik_rpm = EXCLUDED.ketik_rpm,
      ketik_prod = EXCLUDED.ketik_prod, ket_bb = EXCLUDED.ket_bb,
      jam_mulai = EXCLUDED.jam_mulai, jam_selesai = EXCLUDED.jam_selesai,
      edited_by = EXCLUDED.edited_by, ketik = EXCLUDED.ketik, sodokan = EXCLUDED.sodokan,
      source_file = 'manual entry', imported_at = now()
    RETURNING (xmax = 0) AS inserted, tgl::text, shift, no_mc, produksi, ketik, sodokan, edited_by,
              to_char(jam_mulai, 'HH24:MI') AS jam_mulai,
              to_char(jam_selesai, 'HH24:MI') AS jam_selesai`,
  [r.tgl, r.shift, r.no_mc, r.mo || null, r.kode_kain || null, r.type_mc || null,
    r.kelompok_mesin || null, jml, r.rpm ?? null, r.rpm_target ?? null, hit_rpm, r.produksi ?? null,
    ketik_prod, (r.ket_bb || '').trim() || null, r.jam_mulai ?? null, r.jam_selesai ?? null,
    r.edited_by ?? null, r.family, r.ketik ?? null, r.sodokan ?? null]);
  return { ...row, ketik_prod, hit_rpm };
}
