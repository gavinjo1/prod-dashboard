/**
 * Master MO (PPIC): the list, its changes, the MASTER PRODUCT upload, and
 * correcting production that was worked out with an earlier pick.
 */
import { Router } from 'express';
import multer from 'multer';
import { pool, query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { MASTER_FIELDS, readMasterProduct } from '../importer/master.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ------------------------------------------------------------------ *
 * Rules
 *
 * One MO is one fabric and one pick. Changing an MO here never changes
 * production already saved: each production row keeps the pick it was worked
 * out with (production.pick_used). What a change would affect is shown, and
 * applying it to old rows is a separate step (POST /api/master/mo/apply),
 * logged row by row in edit_log and as a whole in product_master_log.
 * ------------------------------------------------------------------ */

const MO = /^MO\/[A-Z0-9]+\/[A-Z0-9-]+$/;
const normMo = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
const NUMERIC = new Set(['pick', 'lusi_per_inch', 'lebar_inch', 'lebar_cm', 'qty', 'toleransi']);
const COLS = `mo, ${MASTER_FIELDS.join(', ')}, source, source_file, updated_by,
  to_char(updated_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS updated_at`;

function readFields(b) {
  const out = {};
  for (const f of MASTER_FIELDS) {
    const raw = b[f];
    if (raw === undefined) continue;
    const t = String(raw ?? '').trim();
    if (NUMERIC.has(f)) {
      if (!t) { out[f] = null; continue; }
      const n = Number(t.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) throw new AppError(`${f} harus angka, bukan "${raw}".`);
      out[f] = n;
    } else if (f === 'tgl_share') {
      if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new AppError('Tanggal share order harus YYYY-MM-DD.');
      out[f] = t || null;
    } else {
      if (t.length > 200) throw new AppError(`${f} terlalu panjang.`);
      out[f] = t || null;
    }
  }
  if ('pick' in out && out.pick !== null && !(out.pick > 0)) out.pick = null;
  return out;
}

const blank = (v) => v === null || v === undefined || v === '';
function sameValue(f, a, b) {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (NUMERIC.has(f)) return Math.abs(Number(a) - Number(b)) < 1e-9;
  return String(a).trim() === String(b).trim();
}
/** The fields `after` sets to something other than `before` has. */
const differs = (before, after) => MASTER_FIELDS.filter((f) => f in after && !sameValue(f, after[f], before?.[f]));

/**
 * Production that does not match the master for an MO: rows worked out with
 * another pick, or filed under another fabric. Per family and pick, with the
 * dates it spans. A field the master leaves empty is not known, so nothing
 * differs from it; fabric codes are compared ignoring spaces and punctuation.
 */
async function affected(db, mo, from = null, to = null) {
  const params = [mo];
  const range = [];
  if (from) { params.push(from); range.push(`p.tgl >= $${params.length}`); }
  if (to) { params.push(to); range.push(`p.tgl <= $${params.length}`); }
  const { rows } = await db.query(`
    SELECT p.family, p.pick_used AS pick, p.kode_kain, count(*)::int AS rows,
           min(p.tgl)::text AS first, max(p.tgl)::text AS last,
           count(*) FILTER (WHERE p.family = 'rapier' AND p.type_mc ILIKE '%SULZER%')::int AS sulzer
    FROM production p JOIN product_master m ON m.mo = p.mo
    WHERE p.mo = $1 ${range.map((r) => `AND ${r}`).join(' ')}
      AND ((m.pick IS NOT NULL AND p.pick_used IS DISTINCT FROM m.pick) OR (m.kode_kain IS NOT NULL AND kode_key(p.kode_kain) IS DISTINCT FROM kode_key(m.kode_kain)))
    GROUP BY 1, 2, 3 ORDER BY 1, 2`, params);
  return { rows: rows.reduce((t, r) => t + r.rows, 0), groups: rows };
}

/* ---- reading ---- */

router.get('/api/master/mo', requireRole('viewer'), (req, res) => send(res, async () => {
  const q = String(req.query.q ?? '').trim();
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE mo ILIKE $1 OR kode_kain ILIKE $1 OR customer ILIKE $1 OR so ILIKE $1`;
  }
  const { rows } = await query(`SELECT ${COLS} FROM product_master ${where} ORDER BY mo DESC LIMIT 1000`, params);
  res.json(rows);
}));

/** Every MO whose saved production no longer matches the master, for PPIC to look at. */
router.get('/api/master/mo/mismatch', requireRole('viewer'), (req, res) => send(res, async () => {
  const { rows } = await query(`
    SELECT p.mo, m.kode_kain, m.pick, count(*)::int AS rows,
           array_agg(DISTINCT p.pick_used) FILTER (WHERE p.pick_used IS NOT NULL) AS picks_used,
           array_agg(DISTINCT p.kode_kain) FILTER (WHERE p.kode_kain IS NOT NULL) AS kodes_used,
           min(p.tgl)::text AS first, max(p.tgl)::text AS last
    FROM production p JOIN product_master m ON m.mo = p.mo
    WHERE (m.pick IS NOT NULL AND p.pick_used IS DISTINCT FROM m.pick)
       OR (m.kode_kain IS NOT NULL AND kode_key(p.kode_kain) IS DISTINCT FROM kode_key(m.kode_kain))
    GROUP BY 1, 2, 3 ORDER BY 1`);
  res.json(rows);
}));

router.get('/api/master/mo/item', requireRole('viewer'), (req, res) => send(res, async () => {
  const mo = normMo(req.query.mo);
  const [{ rows: [row] }, { rows: log }, { rows: usage }] = await Promise.all([
    query(`SELECT ${COLS} FROM product_master WHERE mo = $1`, [mo]),
    query(`SELECT id, action, before_json AS before, after_json AS after, reason, affected, changed_by,
                  to_char(changed_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS changed_at
           FROM product_master_log l WHERE mo = $1 ORDER BY l.changed_at DESC, l.id DESC LIMIT 50`, [mo]),
    // Where the MO has been woven, and with which pick.
    query(`SELECT family, pick_used AS pick, count(*)::int AS rows, count(DISTINCT no_mc)::int AS machines,
                  min(tgl)::text AS first, max(tgl)::text AS last
           FROM production WHERE mo = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [mo])
  ]);
  if (!row && !usage.length) throw new AppError(`${mo} tidak ada di master maupun di data produksi.`, 404);
  res.json({ mo, master: row ?? null, log, usage, mismatch: row ? await affected(pool, mo) : null });
}));

router.get('/api/master/mo/affected', requireRole('operator'), (req, res) => send(res, async () => {
  const mo = normMo(req.query.mo);
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v : null);
  res.json(await affected(pool, mo, iso(req.query.from), iso(req.query.to)));
}));

/* ---- changing one MO ---- */

router.put('/api/master/mo/item', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const mo = normMo(b.mo);
  if (!MO.test(mo)) throw new AppError(`"${b.mo}" bukan nomor MO (contoh MO/UW/26501).`);
  const fields = readFields(b);
  const reason = String(b.reason ?? '').trim() || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [before] } = await client.query(`SELECT * FROM product_master WHERE mo = $1 FOR UPDATE`, [mo]);
    if (!before && !fields.kode_kain) throw new AppError('MO baru harus punya kode kain.');
    const changed = differs(before, fields);
    if (before && !changed.length) {
      await client.query('ROLLBACK');
      return res.json({ mo, changed: [], affected: await affected(pool, mo) });
    }
    const cols = Object.keys(fields);
    const { rows: [after] } = before
      ? await client.query(`
          UPDATE product_master SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
            source = 'manual', updated_by = $${cols.length + 2}, updated_at = now()
          WHERE mo = $1 RETURNING *`, [mo, ...cols.map((c) => fields[c]), req.user])
      : await client.query(`
          INSERT INTO product_master (mo, ${cols.join(', ')}, source, updated_by)
          VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, 'manual', $${cols.length + 2})
          RETURNING *`, [mo, ...cols.map((c) => fields[c]), req.user]);
    const impact = await affected(client, mo);
    await client.query(`
      INSERT INTO product_master_log (mo, action, before_json, after_json, reason, affected, changed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [mo, before ? 'update' : 'create', before ? JSON.stringify(before) : null, JSON.stringify(after),
      reason, impact.rows, req.user]);
    await client.query('COMMIT');
    // Saved production is left as it was; what no longer matches is reported.
    res.json({ mo, changed: before ? changed : ['(baru)'], affected: impact });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/api/master/mo/item', requireRole('admin'), (req, res) => send(res, async () => {
  const mo = normMo(req.query.mo);
  const { rows: [before] } = await query(`DELETE FROM product_master WHERE mo = $1 RETURNING *`, [mo]);
  if (!before) throw new AppError(`${mo} tidak ada di master.`, 404);
  await query(`INSERT INTO product_master_log (mo, action, before_json, changed_by, reason)
               VALUES ($1, 'delete', $2, $3, $4)`,
  [mo, JSON.stringify(before), req.user, String(req.query.reason ?? '').trim() || null]);
  res.json({ ok: true, mo });
}));

/* ---- the MASTER PRODUCT upload ---- */

/**
 * Upload with dry=1 first: it says what would be added and changed — and
 * which production no longer matches — without writing. An MO edited on the
 * dashboard is not overwritten by the file unless overwrite=1.
 */
router.post('/api/master/mo/import', requireRole('admin'), upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) throw new AppError('Tidak ada file yang diterima.');
  const dryRun = String(req.body.dry ?? '') === '1';
  const overwrite = String(req.body.overwrite ?? '') === '1';
  const { sheet, lines, skipped } = readMasterProduct(req.file.buffer, req.file.originalname);
  if (!sheet) throw new AppError('Tidak ditemukan tabel MASTER PRODUCT: butuh kolom MO, KODE dan PKN/PICK di satu baris judul.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: stored } = await client.query(
      `SELECT * FROM product_master WHERE mo = ANY($1) FOR UPDATE`, [lines.map((l) => l.mo)]);
    const byMo = new Map(stored.map((r) => [r.mo, r]));
    const added = [];
    const changed = [];
    const kept = [];
    let unchanged = 0;
    for (const line of lines) {
      const before = byMo.get(line.mo);
      const fields = Object.fromEntries(MASTER_FIELDS.map((f) => [f, line[f] ?? null]));
      if (!before) { added.push(line.mo); }
      else {
        const diff = differs(before, fields);
        if (!diff.length) { unchanged++; continue; }
        if (before.source === 'manual' && !overwrite) { kept.push({ mo: line.mo, fields: diff }); continue; }
        changed.push({ mo: line.mo, fields: diff,
          pick: diff.includes('pick') ? { before: before.pick, after: fields.pick } : undefined });
      }
      const { rows: [after] } = await client.query(`
        INSERT INTO product_master (mo, ${MASTER_FIELDS.join(', ')}, source, source_file, updated_by)
        VALUES ($1, ${MASTER_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, 'import', $${MASTER_FIELDS.length + 2}, $${MASTER_FIELDS.length + 3})
        ON CONFLICT (mo) DO UPDATE SET ${MASTER_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')},
          source = 'import', source_file = EXCLUDED.source_file, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING *`,
      [line.mo, ...MASTER_FIELDS.map((f) => fields[f]), req.file.originalname, req.user]);
      await client.query(`
        INSERT INTO product_master_log (mo, action, before_json, after_json, reason, changed_by)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [line.mo, before ? 'update' : 'create', before ? JSON.stringify(before) : null, JSON.stringify(after),
        `import ${req.file.originalname}`, req.user]);
    }
    // Production that no longer matches the master after this upload.
    const touched = [...added, ...changed.map((c) => c.mo)];
    const { rows: mism } = await client.query(`
      SELECT p.mo, count(*)::int AS rows, min(p.tgl)::text AS first, max(p.tgl)::text AS last
      FROM production p JOIN product_master m ON m.mo = p.mo
      WHERE p.mo = ANY($1) AND ((m.pick IS NOT NULL AND p.pick_used IS DISTINCT FROM m.pick) OR (m.kode_kain IS NOT NULL AND kode_key(p.kode_kain) IS DISTINCT FROM kode_key(m.kode_kain)))
      GROUP BY 1 ORDER BY 1`, [touched]);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    res.json({
      file: req.file.originalname, sheet, dry_run: dryRun,
      read: lines.length, added: added.length, changed, unchanged,
      kept_manual: kept, skipped,
      production_mismatch: mism
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---- correcting old production to the master ---- */

/**
 * Brings an MO's saved production in line with the master — its pick, and
 * its fabric — over the dates asked for. A Rapier SULZER's metres follow its
 * pick (1000 ÷ pick ÷ 39,37 × counter), so they are worked out again; every
 * other loom's metres do not depend on the pick and stay as typed. Each row
 * changed is logged with the reason.
 */
router.post('/api/master/mo/apply', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const mo = normMo(b.mo);
  const reason = String(b.reason ?? '').trim();
  if (!reason) throw new AppError('Tulis alasan koreksi (contoh: pick salah ketik di master).');
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v : null);
  const from = iso(b.from);
  const to = iso(b.to);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(`SELECT * FROM product_master WHERE mo = $1`, [mo]);
    if (!m) throw new AppError(`${mo} tidak ada di master.`, 404);
    const params = [mo];
    const range = [];
    if (from) { params.push(from); range.push(`tgl >= $${params.length}`); }
    if (to) { params.push(to); range.push(`tgl <= $${params.length}`); }
    const { rows: targets } = await client.query(`
      SELECT * FROM production WHERE mo = $1 ${range.map((r) => `AND ${r}`).join(' ')}
        AND (($${params.length + 1}::numeric IS NOT NULL AND pick_used IS DISTINCT FROM $${params.length + 1}::numeric)
          OR ($${params.length + 2}::text IS NOT NULL AND kode_key(kode_kain) IS DISTINCT FROM kode_key($${params.length + 2}::text)))
      FOR UPDATE`, [...params, m.pick, m.kode_kain]);
    for (const before of targets) {
      // What the master leaves empty, the row keeps.
      const pick = m.pick ?? before.pick_used;
      const sulzer = before.family === 'rapier' && /SULZER/i.test(before.type_mc ?? '') && before.ketik_prod !== null && pick > 0;
      const produksi = sulzer ? (1000 / pick / 39.37) * Number(before.ketik_prod) : before.produksi;
      const { rows: [after] } = await client.query(`
        UPDATE production SET pick_used = $2, kode_kain = $3, produksi = $4, edited_by = $5, manual = true,
          calc = $6
        WHERE id = $1 RETURNING *`, [before.id, pick, m.kode_kain ?? before.kode_kain, produksi, req.user,
        sulzer ? 'rapier-1' : before.calc]);
      await client.query(`
        INSERT INTO edit_log (table_name, row_id, action, before_json, after_json, edited_by, reason)
        VALUES ('production', $1, 'edit', $2, $3, $4, $5)`,
      [before.id, JSON.stringify(before), JSON.stringify(after), req.user, `koreksi master ${mo}: ${reason}`]);
    }
    await client.query(`
      INSERT INTO product_master_log (mo, action, after_json, reason, affected, changed_by)
      VALUES ($1, 'apply', $2, $3, $4, $5)`,
    [mo, JSON.stringify({ pick: m.pick, kode_kain: m.kode_kain, from, to }), reason, targets.length, req.user]);
    await client.query('COMMIT');
    res.json({ mo, corrected: targets.length, from, to });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));
