/**
 * Typing a shift in by hand, and correcting or deleting one row.
 */
import { Router } from 'express';
import { query, pool } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { familyOf } from '../lib/filters.js';
import { FAMILIES } from '../importer/index.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Manual entry — one shift at a time, without a file
 * ------------------------------------------------------------------ */

/**
 * Sensible values for the fields the operator should not have to retype.
 * Machine type and fabric count never vary per machine in the data, and a
 * fabric code never varies per order, so those are safe to fill in. Machine
 * group and target RPM do drift, so the most recent value is offered as a
 * starting point and stays editable.
 */
router.get('/api/entry/defaults', (req, res) => send(res, async () => {
  const out = { machine: null, order: null, hours: null };
  // Offered from the same family only: Rapier's A1 is not AJL's A1, and its
  // type, group and RPM would be the wrong ones to fill in.
  const fam = familyOf(req.query);

  // Shift hours are re-set most weeks, so the form offers the last ones used
  // for this shift rather than a fixed clock. Only rows that actually carry
  // hours count, which means the pre-2026-09 backlog never answers.
  if (req.query.shift) {
    const { rows: [h] } = await query(`
      SELECT to_char(jam_mulai, 'HH24:MI')   AS jam_mulai,
             to_char(jam_selesai, 'HH24:MI') AS jam_selesai
      FROM production
      WHERE family = $2 AND shift = $1 AND jam_mulai IS NOT NULL
      ORDER BY tgl DESC LIMIT 1`, [String(req.query.shift).toUpperCase(), fam]);
    out.hours = h ?? null;
  }

  if (req.query.no_mc) {
    const { rows: [m] } = await query(`
      SELECT type_mc, kelompok_mesin, jml_kain, rpm, rpm_target
      FROM production WHERE family = $2 AND no_mc = $1
      ORDER BY tgl DESC, shift DESC LIMIT 1`, [req.query.no_mc, fam]);
    out.machine = m ?? null;
  }
  if (req.query.mo) {
    const { rows: [o] } = await query(`
      SELECT kode_kain, rpm_target FROM production
      WHERE family = $2 AND mo = $1 ORDER BY tgl DESC LIMIT 1`, [req.query.mo, fam]);
    const { rows: [i] } = await query(
      `SELECT customer, pick FROM order_info WHERE mo = $1 ORDER BY as_of DESC LIMIT 1`, [req.query.mo]);
    out.order = o ? { ...o, ...(i ?? {}) } : null;
  }
  res.json(out);
}));

const ENTRY_NUM = ['jml_kain', 'rpm', 'rpm_target', 'produksi'];

router.post('/api/entry', requireRole('operator'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const tgl = String(b.tgl ?? '').trim();
  const shift = String(b.shift ?? '').trim().toUpperCase();
  const no_mc = String(b.no_mc ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) return res.status(400).json({ error: 'Tanggal harus berformat YYYY-MM-DD.' });
  if (!['A', 'B', 'C'].includes(shift)) return res.status(400).json({ error: 'Shift harus A, B atau C.' });
  if (!no_mc) return res.status(400).json({ error: 'Mesin wajib diisi.' });
  // Said, never assumed: a shift filed under the wrong family lands on another
  // family's machine of the same name.
  if (!FAMILIES.includes(b.family)) {
    return res.status(400).json({ error: 'Pilih jenis mesin (AJL, Rapier atau Shuttle) dulu.' });
  }

  // Shift hours are optional — left empty the row simply carries none, which is
  // how every row from before this field existed already reads.
  const hour = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return false;
    return t;
  };
  const jam_mulai = hour(b.jam_mulai);
  const jam_selesai = hour(b.jam_selesai);
  if (jam_mulai === false || jam_selesai === false) {
    return res.status(400).json({ error: 'Jam shift harus format 24 jam, contoh 07:00.' });
  }

  const num = {};
  for (const k of ENTRY_NUM) {
    const raw = b[k];
    if (raw === '' || raw === null || raw === undefined) { num[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a number, not "${raw}".` });
    num[k] = v;
  }

  // Derived exactly as the workbook derives them, so a hand-entered row and an
  // imported one cannot disagree.
  const jml = num.jml_kain || null;
  const hit_rpm = num.rpm != null && jml ? num.rpm * jml : null;
  const ketik_prod = num.produksi != null && jml ? num.produksi / jml : null;

  const { rows: [row] } = await query(`
    INSERT INTO production
      (tgl, shift, no_mc, mo, kode_kain, type_mc, kelompok_mesin, jml_kain,
       rpm, rpm_target, hit_rpm, produksi, ketik_rpm, ketik_prod, ket_bb, source_file,
       jam_mulai, jam_selesai, edited_by, family)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$13,$14,'manual entry',$15,$16,$17,$18)
    ON CONFLICT (family, tgl, shift, no_mc) DO UPDATE SET
      mo = EXCLUDED.mo, kode_kain = EXCLUDED.kode_kain, type_mc = EXCLUDED.type_mc,
      kelompok_mesin = EXCLUDED.kelompok_mesin, jml_kain = EXCLUDED.jml_kain,
      rpm = EXCLUDED.rpm, rpm_target = EXCLUDED.rpm_target, hit_rpm = EXCLUDED.hit_rpm,
      produksi = EXCLUDED.produksi, ketik_rpm = EXCLUDED.ketik_rpm,
      ketik_prod = EXCLUDED.ketik_prod, ket_bb = EXCLUDED.ket_bb,
      jam_mulai = EXCLUDED.jam_mulai, jam_selesai = EXCLUDED.jam_selesai,
      edited_by = EXCLUDED.edited_by,
      source_file = 'manual entry', imported_at = now()
    RETURNING (xmax = 0) AS inserted, tgl::text, shift, no_mc, produksi, edited_by,
              to_char(jam_mulai, 'HH24:MI') AS jam_mulai,
              to_char(jam_selesai, 'HH24:MI') AS jam_selesai`,
    [tgl, shift, no_mc, b.mo || null, b.kode_kain || null, b.type_mc || null,
     b.kelompok_mesin || null, jml, num.rpm, num.rpm_target, hit_rpm, num.produksi,
     ketik_prod, (b.ket_bb || '').trim() || null, jam_mulai, jam_selesai, req.user,
     // The family on screen, as for an import: AJL's A1 and Rapier's A1 are
     // different machines, and the key has to say which one this shift is.
     b.family]);

  res.json({ ...row, ketik_prod, hit_rpm });
}));

/* ------------------------------------------------------------------ *
 * Correcting one row by hand
 *
 * Date, shift, machine and family are the row's identity and stay as they
 * are; a row filed under the wrong machine or day is deleted and entered
 * again. Every change keeps its before and after in edit_log.
 * ------------------------------------------------------------------ */

const EDIT_NUM = ['rpm', 'rpm_target', 'produksi'];

async function productionRow(client, id) {
  const { rows: [r] } = await client.query('SELECT * FROM production WHERE id = $1 FOR UPDATE', [id]);
  return r;
}

router.patch('/api/production/:id', requireRole('operator'), (req, res) => send(res, async () => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Baris tidak dikenal.');
  const b = req.body ?? {};

  const num = {};
  for (const k of EDIT_NUM) {
    const raw = b[k];
    if (raw === '' || raw === null || raw === undefined) { num[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new AppError(`${k} harus angka, bukan "${raw}".`);
    num[k] = v;
  }
  const hour = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new AppError('Jam harus format 24 jam, contoh 07:00.');
    return t;
  };
  const text = (v) => String(v ?? '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await productionRow(client, id);
    if (!before) throw new AppError('Baris tidak ditemukan — mungkin sudah dihapus.', 404);

    // Derived the way the workbook derives them, as manual entry does.
    const jml = Number(before.jml_kain) || null;
    const { rows: [after] } = await client.query(`
      UPDATE production SET
        mo = $2, kode_kain = $3, rpm = $4, rpm_target = $5, produksi = $6,
        ket_bb = $7, jam_mulai = $8, jam_selesai = $9,
        hit_rpm = $10, ketik_rpm = $4, ketik_prod = $11,
        edited_by = $12
      WHERE id = $1 RETURNING *`,
      [id, text(b.mo), text(b.kode_kain), num.rpm, num.rpm_target, num.produksi,
       text(b.ket_bb), hour(b.jam_mulai), hour(b.jam_selesai),
       num.rpm != null && jml ? num.rpm * jml : null,
       num.produksi != null && jml ? num.produksi / jml : null,
       req.user]);

    await client.query(
      `INSERT INTO edit_log (table_name, row_id, action, before_json, after_json, edited_by)
       VALUES ('production', $1, 'edit', $2, $3, $4)`,
      [id, JSON.stringify(before), JSON.stringify(after), req.user]);
    await client.query('COMMIT');
    res.json({ ok: true, id, produksi: after.produksi });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/api/production/:id', requireRole('operator'), (req, res) => send(res, async () => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Baris tidak dikenal.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await productionRow(client, id);
    if (!before) throw new AppError('Baris tidak ditemukan — mungkin sudah dihapus.', 404);
    await client.query('DELETE FROM production WHERE id = $1', [id]);
    // The whole row is kept, so a deletion can be put back from here.
    await client.query(
      `INSERT INTO edit_log (table_name, row_id, action, before_json, edited_by)
       VALUES ('production', $1, 'delete', $2, $3)`,
      [id, JSON.stringify(before), req.user]);
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));
