/**
 * Correcting or deleting one production row. Shifts are typed in on the
 * Input Shift page (routes/shift-input.js).
 */
import { Router } from 'express';
import { query, pool } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

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
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new AppError('Jam harus format 24 jam, contoh 06:00.');
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
        edited_by = $12, manual = true,
        calc = CASE WHEN $6::numeric IS DISTINCT FROM produksi THEN 'typed' ELSE calc END
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
