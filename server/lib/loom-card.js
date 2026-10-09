/**
 * What a Rapier loom's display shows at the end of a shift besides its
 * counter and speed — the EFFISIENSI RAPIER day sheet's EFF, PL, CMPX, PP,
 * CMPX — and the beams put on the looms. Typed in with the shift on the
 * Input Shift page; the counter (COUNT), RPM and note go to the production
 * row as before.
 */
import { AppError } from '../errors.js';

/* ------------------------------------------------------------------ *
 * The readings
 *
 * PL and PP are warp and weft breaks; each CMPX is breaks per 100 000 picks
 * inserted, so it follows from the rest: breaks × 100 000 ÷ (RPM × 480 min
 * × EFF). The loom shows it rounded, so a CMPX left empty is worked out.
 * ------------------------------------------------------------------ */

export const CARD_FIELDS = ['eff', 'pl', 'cmpx_pl', 'pp', 'cmpx_pp'];
const LIMITS = {
  eff: ['EFF', 100], pl: ['PL', 100000], cmpx_pl: ['CMPX lusi', 100000],
  pp: ['PP', 100000], cmpx_pp: ['CMPX pakan', 100000]
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Breaks per 100 000 picks, from a shift of 480 minutes. */
export const cmpxOf = (breaks, rpm, eff) =>
  (breaks !== null && rpm > 0 && eff > 0 ? (breaks * 100000) / (rpm * 480 * (eff / 100)) : null);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

function numberIn(v, field, no_mc) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(',', '.'));
  const [label, max] = LIMITS[field];
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${no_mc}: ${label} harus angka, bukan "${v}".`);
  if (n > max) throw new AppError(`${no_mc}: ${label} ${String(v).trim()} terlalu besar${field === 'eff' ? ' (maksimal 100)' : ''}.`);
  return n;
}

/**
 * The readings typed for one loom-shift, with empty CMPX worked out from the
 * RPM typed beside them; null when none was typed, so the line comes off.
 */
export function checkCard(raw, rpm, no_mc) {
  const v = Object.fromEntries(CARD_FIELDS.map((f) => [f, numberIn(raw[f], f, no_mc)]));
  if (CARD_FIELDS.every((f) => v[f] === null)) return null;
  if (v.cmpx_pl === null) v.cmpx_pl = r1(cmpxOf(v.pl, rpm, v.eff));
  if (v.cmpx_pp === null) v.cmpx_pp = r1(cmpxOf(v.pp, rpm, v.eff));
  return v;
}

export async function writeCard(db, family, tgl, shift, no_mc, v, user) {
  await db.query(`
    INSERT INTO loom_card (family, tgl, shift, no_mc, eff, pl, cmpx_pl, pp, cmpx_pp, edited_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (family, tgl, shift, no_mc) DO UPDATE SET
      eff = EXCLUDED.eff, pl = EXCLUDED.pl, cmpx_pl = EXCLUDED.cmpx_pl, pp = EXCLUDED.pp,
      cmpx_pp = EXCLUDED.cmpx_pp, edited_by = EXCLUDED.edited_by, updated_at = now()`,
  [family, tgl, shift, no_mc, v.eff, v.pl, v.cmpx_pl, v.pp, v.cmpx_pp, user]);
}

export const removeCard = (db, family, tgl, shift, no_mc) => db.query(
  `DELETE FROM loom_card WHERE family = $1 AND tgl = $2 AND shift = $3 AND no_mc = $4`,
  [family, tgl, shift, no_mc]);

/* ------------------------------------------------------------------ *
 * Beams
 *
 * The day sheet's left-hand columns (No. Beam, TGL KANJI, KP, PANJANG BEAM,
 * TGL NAIK, Lusi, Pakan, KET) belong to the beam, not the day: kept once per
 * beam and shown on every shift it stands on the loom.
 * ------------------------------------------------------------------ */

export const BEAM_FIELDS = ['no_beam', 'tgl_kanji', 'kp', 'panjang_beam', 'tgl_naik', 'lusi', 'pakan', 'ket_benang'];

const text = (v, max, label, no_mc) => {
  const t = String(v ?? '').trim();
  if (t.length > max) throw new AppError(`${no_mc}: ${label} terlalu panjang (maksimal ${max} huruf).`);
  return t || null;
};

/** A date as the sheet writes it — 21/09/26, 21/09/2026 — or as a date box sends it. */
function dateIn(v, label, no_mc) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (ISO.test(t)) return t;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) return iso;
  }
  throw new AppError(`${no_mc}: ${label} "${t}" bukan tanggal. Tulis seperti 21/09/26.`);
}

/** A beam as typed; `id` is the beam being changed, absent for one going up. */
export function checkBeam(b, no_mc, today) {
  const tgl_naik = dateIn(b.tgl_naik, 'TGL NAIK', no_mc);
  if (!tgl_naik) throw new AppError(`${no_mc}: isi TGL NAIK beam.`);
  if (tgl_naik > today) throw new AppError(`${no_mc}: TGL NAIK belum lewat.`);
  // Metres, as the sheet writes them: "3,500" and "3.500" are both 3500.
  const raw = String(b.panjang_beam ?? '').replace(/\s/g, '');
  const panjang = /^\d{1,3}([.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.');
  const panjang_beam = panjang === '' ? null : Number(panjang);
  if (panjang_beam !== null && (!Number.isFinite(panjang_beam) || panjang_beam < 0)) {
    throw new AppError(`${no_mc}: PANJANG BEAM harus angka meter, bukan "${b.panjang_beam}".`);
  }
  const id = b.id === undefined || b.id === null || b.id === '' ? null : Number(b.id);
  return {
    id, no_mc, tgl_naik, no_beam: text(b.no_beam, 40, 'No. Beam', no_mc),
    tgl_kanji: dateIn(b.tgl_kanji, 'TGL KANJI', no_mc), kp: text(b.kp, 40, 'KP', no_mc), panjang_beam,
    kode_kain: text(b.kode_kain, 60, 'Kode kain', no_mc), lusi: text(b.lusi, 80, 'Lusi', no_mc),
    pakan: text(b.pakan, 120, 'Pakan', no_mc), ket_benang: text(b.ket_benang, 200, 'KET BENANG', no_mc)
  };
}

export async function writeBeam(db, family, b, user) {
  const v = [b.no_mc, b.tgl_naik, b.no_beam, b.tgl_kanji, b.kp, b.panjang_beam, b.kode_kain,
    b.lusi, b.pakan, b.ket_benang, user, family];
  try {
    const { rows: [row] } = b.id
      ? await db.query(`
          UPDATE loom_beam SET no_mc = $1, tgl_naik = $2, no_beam = $3, tgl_kanji = $4, kp = $5,
            panjang_beam = $6, kode_kain = $7, lusi = $8, pakan = $9, ket_benang = $10,
            edited_by = $11, updated_at = now()
          WHERE family = $12 AND id = $13 RETURNING id`, [...v, b.id])
      : await db.query(`
          INSERT INTO loom_beam (no_mc, tgl_naik, no_beam, tgl_kanji, kp, panjang_beam, kode_kain,
            lusi, pakan, ket_benang, edited_by, family)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, v);
    if (!row) throw new AppError(`${b.no_mc}: beam itu tidak ditemukan — mungkin sudah dihapus.`, 404);
    return row.id;
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(`${b.no_mc}: sudah ada beam yang naik tanggal ${b.tgl_naik}. Ubah yang itu.`);
    }
    throw err;
  }
}

/** The beam standing on each loom on a day: the last one up by then. */
export async function beamsOn(query, family, tgl) {
  const { rows } = await query(`
    SELECT DISTINCT ON (no_mc) id, no_mc, tgl_naik::text AS tgl_naik, no_beam, tgl_kanji::text AS tgl_kanji,
           kp, panjang_beam, kode_kain, lusi, pakan, ket_benang
    FROM loom_beam WHERE family = $1 AND tgl_naik <= $2 ORDER BY no_mc, tgl_naik DESC`, [family, tgl]);
  return new Map(rows.map((r) => [r.no_mc, r]));
}
