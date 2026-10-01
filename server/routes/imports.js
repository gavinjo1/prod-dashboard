/**
 * Uploading reports, the batch list and undo.
 */
import { Router } from 'express';
import multer from 'multer';
import { query, pool } from '../db.js';
import { importBuffer, previewBuffer, isSupported, FAMILIES } from '../importer/index.js';
import { send, AppError } from '../errors.js';
import { undoBatch } from '../undo.js';
import { requireRole } from '../auth.js';
import { familyOf } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

router.post('/api/preview', requireRole('operator'), upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diterima.' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: `Jenis file tidak didukung: ${req.file.originalname}` });
  }
  res.json({ file: req.file.originalname, sheets: previewBuffer(req.file.buffer, req.file.originalname) });
}));

router.post('/api/import', requireRole('operator'), upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diterima.' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: `Jenis file tidak didukung: ${req.file.originalname}` });
  }
  const only = req.body.sheets ? String(req.body.sheets).split(',').filter(Boolean) : null;
  const results = await importBuffer(req.file.buffer, req.file.originalname,
    { only, editedBy: req.user, family: familyOf(req.body) });
  res.json({ file: req.file.originalname, batch_id: results.batch_id, results });
}));

/**
 * The imports of the family on screen. Semua lists everything, including the
 * combined report and old imports whose family is not known (NULL).
 */
function familyScope(q, col) {
  const f = String(q.family ?? '').trim().toLowerCase();
  return FAMILIES.includes(f)
    ? { sql: `WHERE ${col} = $1`, params: [f] }
    : { sql: '', params: [] };
}

router.get('/api/batches', requireRole('operator'), (req, res) => send(res, async () => {
  const scope = familyScope(req.query, 'b.family');
  const { rows } = await query(`
    SELECT b.id, b.file_name, b.imported_by,
           to_char(b.created_at, 'YYYY-MM-DD HH24:MI') AS at,
           to_char(b.undone_at,  'YYYY-MM-DD HH24:MI') AS undone_at,
           b.undone_by,
           count(u.id)::int AS rows_touched,
           count(u.id) FILTER (WHERE u.before_json IS NULL)::int AS rows_new
    FROM import_batch b LEFT JOIN import_undo u ON u.batch_id = b.id
    ${scope.sql}
    GROUP BY b.id ORDER BY b.created_at DESC LIMIT 20`, scope.params);

  // Only the newest batch that is still standing can be undone: restoring an
  // older one would put back values a later import has since replaced. Newest
  // across every family, not just this one: order headers and the machine-type
  // legend are shared, so another family's later import may have replaced them.
  const { rows: [newest] } = await query(
    'SELECT id FROM import_batch WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1');
  res.json(rows.map((r) => ({ ...r, can_undo: r.id === newest?.id })));
}));

router.post('/api/batches/:id/undo', requireRole('operator'), (req, res) => send(res, async () => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('Nomor batch tidak sah.');

  const { rows: [newest] } = await query(
    'SELECT id FROM import_batch WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1');
  if (!newest) throw new AppError('Tidak ada import yang bisa dibatalkan.');
  if (newest.id !== id) {
    throw new AppError('Hanya import terakhir yang bisa dibatalkan. Batalkan yang lebih baru dulu.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await undoBatch(client, id, req.user);
    if (!out.ok) {
      await client.query('ROLLBACK');
      throw new AppError(out.reason === 'already_undone'
        ? 'Import itu sudah dibatalkan.' : 'Import tidak ditemukan.');
    }
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/api/imports', (req, res) => send(res, async () => {
  const scope = familyScope(req.query, 'l.family');
  // With the upload it belongs to, so a line whose import was undone says so.
  const { rows } = await query(
    `SELECT l.file_name, l.sheet_name, l.dataset, l.rows_read, l.rows_written, l.rows_skipped,
            l.status, l.message, l.imported_by, to_char(l.created_at, 'YYYY-MM-DD HH24:MI') AS at,
            to_char(b.undone_at, 'YYYY-MM-DD HH24:MI') AS undone_at, b.undone_by
     FROM import_log l LEFT JOIN import_batch b ON b.id = l.batch_id
     ${scope.sql} ORDER BY l.created_at DESC LIMIT 25`, scope.params
  );
  res.json(rows);
}));
