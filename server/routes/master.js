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
 * out with (production.pick_used). Rows that no longer match are shown, and
 * someone decides: bring them in line (POST /api/master/mo/apply, logged row
 * by row in edit_log), or say they are meant to differ (POST
 * /api/master/mo/accept). Both are logged in product_master_log.
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

/* ------------------------------------------------------------------ *
 * Production against the master, as SQL on a production row p joined to its
 * master m.
 *
 * DIFFERS: the row was worked out with another pick, or filed under another
 * fabric. A field the master leaves empty is not known, so nothing differs
 * from it; fabric codes are compared ignoring spaces and punctuation.
 * ACCEPTED: someone has said this fabric and pick are meant to differ, against
 * the master as it still is (product_master_accept).
 * OPEN: differs and nobody has said so: what the page asks someone to check.
 * ------------------------------------------------------------------ */

const DIFFERS = `((m.pick IS NOT NULL AND p.pick_used IS DISTINCT FROM m.pick)
  OR (m.kode_kain IS NOT NULL AND kode_key(p.kode_kain) IS DISTINCT FROM kode_key(m.kode_kain)))`;
const ACCEPTED = `EXISTS (SELECT 1 FROM product_master_accept a
  WHERE a.mo = p.mo AND a.family = p.family
    AND a.kode = coalesce(kode_key(p.kode_kain), '') AND a.pick = coalesce(p.pick_used, 0)
    AND a.master_kode IS NOT DISTINCT FROM kode_key(m.kode_kain) AND a.master_pick IS NOT DISTINCT FROM m.pick)`;
const OPEN = `(${DIFFERS} AND NOT ${ACCEPTED})`;

/** How many of an MO's production rows are still to be checked against its master. */
async function openRows(db, mo) {
  const { rows: [r] } = await db.query(`
    SELECT count(*)::int AS rows FROM production p JOIN product_master m ON m.mo = p.mo
    WHERE p.mo = $1 AND ${OPEN}`, [mo]);
  return r.rows;
}

/**
 * The rows of an MO that differ from its master, as runs of consecutive days
 * on one loom with one fabric and pick — "E4, KM 63-MAKLOON, 8–22 Sep" —
 * with where they came from, and whether that fabric and pick were accepted.
 */
async function differingRuns(db, mo) {
  const { rows } = await db.query(`
    WITH d AS (
      SELECT p.family, p.no_mc, p.tgl, p.kode_kain, p.pick_used, p.type_mc, p.source_file,
             coalesce(kode_key(p.kode_kain), '') AS kode, ${ACCEPTED} AS accepted
      FROM production p JOIN product_master m ON m.mo = p.mo
      WHERE p.mo = $1 AND ${DIFFERS}),
    r AS (
      SELECT d.*, tgl - (dense_rank() OVER (PARTITION BY family, no_mc, kode, pick_used ORDER BY tgl))::int AS run
      FROM d)
    SELECT family, no_mc, min(kode_kain) AS kode_kain, kode, pick_used AS pick, accepted,
           min(tgl)::text AS first, max(tgl)::text AS last, count(*)::int AS shifts,
           count(*) FILTER (WHERE family = 'rapier' AND type_mc ILIKE '%SULZER%')::int AS sulzer,
           array_agg(DISTINCT CASE WHEN source_file = 'manual entry' THEN 'diketik di dashboard'
                                   ELSE coalesce(source_file, '—') END) AS sources
    FROM r GROUP BY family, no_mc, kode, pick_used, accepted, run
    ORDER BY family, no_mc, first`, [mo]);
  return rows;
}

/* ---- reading ---- */

router.get('/api/master/mo', requireRole('viewer'), (req, res) => send(res, async () => {
  const q = String(req.query.q ?? '').trim();
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE m.mo ILIKE $1 OR m.kode_kain ILIKE $1 OR m.customer ILIKE $1 OR m.so ILIKE $1`;
  }
  // With where each MO has been woven and how much of that is still to check.
  const { rows } = await query(`
    SELECT ${COLS}, u.shifts, u.machines, u.families, u.last_used, u.open, u.accepted
    FROM product_master m
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS shifts, count(DISTINCT p.family || ' ' || p.no_mc)::int AS machines,
             coalesce(array_agg(DISTINCT p.family) FILTER (WHERE p.family IS NOT NULL), '{}') AS families,
             max(p.tgl)::text AS last_used,
             count(*) FILTER (WHERE ${OPEN})::int AS open,
             count(*) FILTER (WHERE ${DIFFERS} AND ${ACCEPTED})::int AS accepted
      FROM production p WHERE p.mo = m.mo) u
    ${where} ORDER BY m.mo DESC LIMIT 1000`, params);
  res.json(rows);
}));

router.get('/api/master/mo/item', requireRole('viewer'), (req, res) => send(res, async () => {
  const mo = normMo(req.query.mo);
  const [{ rows: [row] }, { rows: log }, { rows: usage }] = await Promise.all([
    query(`SELECT ${COLS} FROM product_master WHERE mo = $1`, [mo]),
    query(`SELECT id, action, before_json AS before, after_json AS after, reason, affected, changed_by,
                  to_char(changed_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS changed_at
           FROM product_master_log l WHERE mo = $1 ORDER BY l.changed_at DESC, l.id DESC LIMIT 50`, [mo]),
    // Where the MO has been woven.
    query(`SELECT family, count(*)::int AS rows, count(DISTINCT no_mc)::int AS machines,
                  min(tgl)::text AS first, max(tgl)::text AS last
           FROM production WHERE mo = $1 GROUP BY 1 ORDER BY 1`, [mo])
  ]);
  if (!row && !usage.length) throw new AppError(`${mo} tidak ada di master maupun di data produksi.`, 404);
  const [runs, { rows: accepts }] = row ? await Promise.all([
    differingRuns(pool, mo),
    query(`SELECT a.family, a.kode, a.kode_kain, a.pick, a.reason, a.accepted_by,
                  to_char(a.accepted_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS accepted_at
           FROM product_master_accept a JOIN product_master m ON m.mo = a.mo
           WHERE a.mo = $1 AND a.master_kode IS NOT DISTINCT FROM kode_key(m.kode_kain)
             AND a.master_pick IS NOT DISTINCT FROM m.pick
           ORDER BY a.accepted_at`, [mo])
  ]) : [[], { rows: [] }];
  res.json({ mo, master: row ?? null, log, usage, runs, accepts });
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
      return res.json({ mo, changed: [], open: await openRows(pool, mo) });
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
    const open = await openRows(client, mo);
    await client.query(`
      INSERT INTO product_master_log (mo, action, before_json, after_json, reason, affected, changed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [mo, before ? 'update' : 'create', before ? JSON.stringify(before) : null, JSON.stringify(after),
      reason, open, req.user]);
    await client.query('COMMIT');
    // Saved production is left as it was; what no longer matches is reported.
    res.json({ mo, changed: before ? changed : ['(baru)'], open });
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
      WHERE p.mo = ANY($1) AND ${OPEN}
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

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The runs picked on the page — loom and dates — checked, as JSON for the query. */
function readRuns(raw) {
  const runs = (Array.isArray(raw) ? raw : []).map((r) => ({
    family: String(r?.family ?? ''), no_mc: String(r?.no_mc ?? ''), from: String(r?.from ?? ''), to: String(r?.to ?? '')
  }));
  if (!runs.length) throw new AppError('Pilih dulu mesin dan tanggal yang mau diubah.');
  if (runs.length > 500 || runs.some((r) => !r.family || !r.no_mc || !ISO.test(r.from) || !ISO.test(r.to))) {
    throw new AppError('Pilihan mesin dan tanggal tidak terbaca. Muat ulang halaman lalu coba lagi.');
  }
  return runs;
}
const IN_RUNS = (n) => `EXISTS (SELECT 1 FROM jsonb_to_recordset($${n}::jsonb) AS r(family text, no_mc text, "from" date, "to" date)
  WHERE r.family = p.family AND r.no_mc = p.no_mc AND p.tgl BETWEEN r."from" AND r."to")`;

/**
 * Brings the runs picked on the page in line with the master — pick and
 * fabric. Only rows still to be checked change; one accepted as different is
 * left. A Rapier SULZER's metres follow its pick (1000 ÷ pick ÷ 39,37 ×
 * counter), so they are worked out again; every other loom's metres do not
 * depend on the pick and stay as they are. Each row changed is logged with
 * the reason.
 */
router.post('/api/master/mo/apply', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const mo = normMo(b.mo);
  const reason = String(b.reason ?? '').trim();
  if (!reason) throw new AppError('Tulis alasan (contoh: nama kain di laporan salah tulis).');
  const runs = readRuns(b.runs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(`SELECT * FROM product_master WHERE mo = $1`, [mo]);
    if (!m) throw new AppError(`${mo} tidak ada di master.`, 404);
    const { rows: targets } = await client.query(`
      SELECT p.* FROM production p JOIN product_master m ON m.mo = p.mo
      WHERE p.mo = $1 AND ${OPEN} AND ${IN_RUNS(2)}
      FOR UPDATE OF p`, [mo, JSON.stringify(runs)]);
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
    [mo, JSON.stringify({ pick: m.pick, kode_kain: m.kode_kain, runs }), reason, targets.length, req.user]);
    await client.query('COMMIT');
    res.json({ mo, corrected: targets.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---- saying production is meant to differ ---- */

/**
 * The fabric and pick of the runs picked are meant to differ from the master
 * (a maklon order under its own fabric name, say). Nothing in production
 * changes; those rows, and later ones with the same fabric and pick, are no
 * longer reported — until the master's fabric or pick changes.
 */
router.post('/api/master/mo/accept', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const mo = normMo(b.mo);
  const reason = String(b.reason ?? '').trim();
  if (!reason) throw new AppError('Tulis alasan (contoh: order maklon, sengaja dibedakan).');
  if (reason.length > 200) throw new AppError('Alasan terlalu panjang (maksimal 200 huruf).');
  const runs = readRuns(b.runs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(`SELECT * FROM product_master WHERE mo = $1 FOR UPDATE`, [mo]);
    if (!m) throw new AppError(`${mo} tidak ada di master.`, 404);
    // Each fabric and pick among the rows picked, once.
    const { rows: kinds } = await client.query(`
      SELECT p.family, coalesce(kode_key(p.kode_kain), '') AS kode, coalesce(p.pick_used, 0) AS pick,
             min(p.kode_kain) AS kode_kain
      FROM production p JOIN product_master m ON m.mo = p.mo
      WHERE p.mo = $1 AND ${OPEN} AND ${IN_RUNS(2)}
      GROUP BY 1, 2, 3`, [mo, JSON.stringify(runs)]);
    if (!kinds.length) throw new AppError('Tidak ada lagi yang perlu dicek di pilihan itu. Muat ulang halaman.');
    for (const k of kinds) {
      await client.query(`
        INSERT INTO product_master_accept (mo, family, kode, pick, kode_kain, master_kode, master_pick, reason, accepted_by)
        VALUES ($1, $2, $3, $4, $5, kode_key($6), $7, $8, $9)
        ON CONFLICT (mo, family, kode, pick) DO UPDATE SET kode_kain = EXCLUDED.kode_kain,
          master_kode = EXCLUDED.master_kode, master_pick = EXCLUDED.master_pick, reason = EXCLUDED.reason,
          accepted_by = EXCLUDED.accepted_by, accepted_at = now()`,
      [mo, k.family, k.kode, k.pick, k.kode_kain, m.kode_kain, m.pick, reason, req.user]);
    }
    // Counted over the whole MO: the mark reaches rows of the same fabric and pick left unticked.
    const { rows: [{ rows }] } = await client.query(`
      SELECT count(*)::int AS rows FROM production p JOIN product_master m ON m.mo = p.mo
      WHERE p.mo = $1 AND ${DIFFERS} AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS k(family text, kode text, pick numeric)
        WHERE k.family = p.family AND k.kode = coalesce(kode_key(p.kode_kain), '') AND k.pick = coalesce(p.pick_used, 0))`,
    [mo, JSON.stringify(kinds)]);
    await client.query(`
      INSERT INTO product_master_log (mo, action, after_json, reason, affected, changed_by)
      VALUES ($1, 'accept', $2, $3, $4, $5)`,
    [mo, JSON.stringify({ kinds: kinds.map(({ family, kode_kain, pick }) => ({ family, kode_kain, pick: Number(pick) || null })) }),
      reason, rows, req.user]);
    await client.query('COMMIT');
    res.json({ mo, accepted: rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/** Takes back "meant to differ" for one fabric and pick: its rows are reported again. */
router.post('/api/master/mo/unaccept', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const mo = normMo(b.mo);
  const { rows: [gone] } = await query(`
    DELETE FROM product_master_accept WHERE mo = $1 AND family = $2 AND kode = $3 AND pick = $4 RETURNING *`,
  [mo, String(b.family ?? ''), String(b.kode ?? ''), Number(b.pick) || 0]);
  if (!gone) throw new AppError('Tanda itu sudah tidak ada. Muat ulang halaman.', 404);
  await query(`
    INSERT INTO product_master_log (mo, action, before_json, reason, changed_by)
    VALUES ($1, 'unaccept', $2, $3, $4)`,
  [mo, JSON.stringify({ family: gone.family, kode_kain: gone.kode_kain, pick: Number(gone.pick) || null }),
    String(b.reason ?? '').trim() || null, req.user]);
  res.json({ mo, ok: true });
}));
