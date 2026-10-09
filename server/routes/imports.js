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
  // Said, never assumed: a workbook filed under the wrong family lands on
  // another family's machines of the same name. Semua takes the combined report.
  const family = String(req.body.family ?? '').trim().toLowerCase();
  if (family !== 'semua' && !FAMILIES.includes(family)) {
    throw new AppError('Pilih jenis mesin (AJL, Rapier atau Shuttle) dulu.');
  }
  // dry=1: everything an import would do, reported, nothing kept.
  const dryRun = String(req.body.dry ?? '') === '1';
  const results = await importBuffer(req.file.buffer, req.file.originalname,
    { only, editedBy: req.user, family, dryRun });
  res.json({ file: req.file.originalname, batch_id: results.batch_id, dry_run: dryRun, results });
}));

/* ------------------------------------------------------------------ *
 * Import conflicts
 *
 * Rows an import found typed or corrected on the dashboard and so did not
 * overwrite. Each waits for someone to keep the dashboard's figures or take
 * the file's; either way the decision is logged.
 * ------------------------------------------------------------------ */

const PRODUCTION_FIELDS = ['mo', 'kode_kain', 'type_mc', 'kelompok_mesin', 'jml_kain', 'rpm', 'rpm_target',
  'hit_rpm', 'produksi', 'ketik_rpm', 'ketik_prod', 'ket_bb', 'ketik', 'sodokan'];

router.get('/api/import/conflicts', requireRole('operator'), (req, res) => send(res, async () => {
  const status = ['open', 'kept', 'replaced'].includes(req.query.status) ? req.query.status : 'open';
  const family = String(req.query.family ?? '').trim().toLowerCase();
  const params = [status];
  let fam = '';
  if (FAMILIES.includes(family)) { params.push(family); fam = `AND c.key_json->>'family' = $2`; }
  const { rows } = await query(`
    SELECT c.id, c.batch_id, c.table_name, c.key_json AS key, c.source_file, c.status,
           c.resolved_by, to_char(c.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS created_at,
           c.incoming_json->'_differs' AS fields,
           c.incoming_json - '_differs' AS incoming, c.existing_json AS existing
    FROM import_conflict c
    WHERE c.status = $1 ${fam}
    ORDER BY c.created_at DESC, c.id LIMIT 500`, params);
  // Only the fields that differ, side by side.
  res.json(rows.map((r) => ({
    id: r.id, batch_id: r.batch_id, table: r.table_name, key: r.key, file: r.source_file,
    status: r.status, resolved_by: r.resolved_by, created_at: r.created_at,
    differences: (r.fields ?? []).map((f) => ({ field: f, dashboard: r.existing[f] ?? null, file: r.incoming[f] ?? null }))
  })));
}));

router.post('/api/import/conflicts/:id/resolve', requireRole('admin'), (req, res) => send(res, async () => {
  const id = Number(req.params.id);
  const action = String(req.body?.action ?? '');
  if (!Number.isInteger(id)) throw new AppError('Konflik tidak dikenal.');
  if (!['keep', 'replace'].includes(action)) throw new AppError('Pilih: pakai isian dashboard (keep) atau pakai file (replace).');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(`
      SELECT c.*, b.undone_at FROM import_conflict c LEFT JOIN import_batch b ON b.id = c.batch_id
      WHERE c.id = $1 FOR UPDATE OF c`, [id]);
    if (!c) throw new AppError('Konflik tidak ditemukan.', 404);
    if (c.status !== 'open') throw new AppError('Konflik ini sudah diputuskan.');
    if (c.undone_at) throw new AppError('Import konflik ini sudah dibatalkan (undo).');
    if (c.table_name !== 'production') throw new AppError('Hanya konflik produksi yang bisa diputuskan di sini.');
    if (action === 'replace') {
      const k = c.key_json;
      const inc = c.incoming_json;
      const { rows: [before] } = await client.query(
        `SELECT * FROM production WHERE family = $1 AND tgl = $2 AND shift = $3 AND no_mc = $4 FOR UPDATE`,
        [k.family, k.tgl, k.shift, k.no_mc]);
      if (!before) throw new AppError('Baris produksinya sudah tidak ada.', 404);
      // The file's figures, as an import would write them; the row is the
      // import's again, so a later import of a corrected file may update it.
      const set = PRODUCTION_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const { rows: [after] } = await client.query(`
        UPDATE production SET ${set}, source_file = $${PRODUCTION_FIELDS.length + 2},
          manual = false, calc = 'excel', edited_by = $${PRODUCTION_FIELDS.length + 3}, imported_at = now()
        WHERE id = $1 RETURNING *`,
      [before.id, ...PRODUCTION_FIELDS.map((f) => inc[f] ?? null), c.source_file, req.user]);
      await client.query(
        `INSERT INTO edit_log (table_name, row_id, action, before_json, after_json, edited_by, reason)
         VALUES ('production', $1, 'edit', $2, $3, $4, $5)`,
        [before.id, JSON.stringify(before), JSON.stringify(after), req.user, `konflik import #${id}: pakai file ${c.source_file}`]);
    }
    await client.query(
      `UPDATE import_conflict SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
      [id, action === 'keep' ? 'kept' : 'replaced', req.user]);
    await client.query('COMMIT');
    res.json({ ok: true, id, status: action === 'keep' ? 'kept' : 'replaced' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
