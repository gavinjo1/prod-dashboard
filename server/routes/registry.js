/**
 * The looms themselves: each family's form and formula, the machine
 * registry, and checking saved metres against the formula.
 */
import { Router } from 'express';
import { pool, query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { FAMILIES } from '../importer/index.js';
import { MACHINE_TYPES, formOf, outputOf } from '../lib/machine-types.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const familyIn = (v) => {
  const f = String(v ?? '').trim().toLowerCase();
  if (!FAMILIES.includes(f)) throw new AppError('Pilih jenis mesin (AJL, Rapier atau Shuttle).');
  return f;
};

/* ------------------------------------------------------------------ *
 * The forms
 * ------------------------------------------------------------------ */

router.get('/api/machine-types', requireRole('viewer'), (req, res) => send(res, async () => {
  res.json(Object.fromEntries(Object.keys(MACHINE_TYPES).map((f) => [f, formOf(f)])));
}));

/* ------------------------------------------------------------------ *
 * Machine registry
 *
 * What each loom is. A change here applies to shifts typed in from now on;
 * rows already saved keep the values they were worked out with.
 * ------------------------------------------------------------------ */

router.get('/api/machine-registry', requireRole('viewer'), (req, res) => send(res, async () => {
  const family = familyIn(req.query.family);
  const { rows } = await query(`
    SELECT m.family, m.no_mc, m.type_mc, m.kelompok_mesin, m.jml_kain, m.rpm_target, m.width, m.active, m.note,
           m.updated_by, to_char(m.updated_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS updated_at,
           (SELECT max(p.tgl)::text FROM production p WHERE p.family = m.family AND p.no_mc = m.no_mc) AS last_seen
    FROM machine m WHERE m.family = $1`, [family]);
  rows.sort((a, b) => String(a.kelompok_mesin ?? '').localeCompare(String(b.kelompok_mesin ?? ''), 'id', { numeric: true })
    || a.no_mc.localeCompare(b.no_mc, 'id', { numeric: true }));
  res.json(rows);
}));

const NUM_FIELDS = { jml_kain: [0, 10], rpm_target: [0, 2000], width: [0, 500] };

router.put('/api/machine-registry', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const family = familyIn(b.family);
  const no_mc = String(b.no_mc ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,12}$/.test(no_mc)) throw new AppError(`"${b.no_mc}" bukan nomor mesin.`);
  const set = {};
  for (const f of ['type_mc', 'kelompok_mesin', 'note']) {
    if (f in b) set[f] = String(b[f] ?? '').trim() || null;
  }
  for (const [f, [lo, hi]] of Object.entries(NUM_FIELDS)) {
    if (!(f in b)) continue;
    const t = String(b[f] ?? '').trim();
    if (!t) { set[f] = null; continue; }
    const n = Number(t.replace(',', '.'));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new AppError(`${f} harus angka ${lo}–${hi}, bukan "${b[f]}".`);
    set[f] = n;
  }
  if ('active' in b) set.active = b.active === true || b.active === 'true' || b.active === 1;
  if (family === 'shuttle') set.jml_kain = 1;
  const reason = String(b.reason ?? '').trim() || null;
  const cols = Object.keys(set);
  if (!cols.length) throw new AppError('Tidak ada yang diubah.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [before] } = await client.query(
      `SELECT * FROM machine WHERE family = $1 AND no_mc = $2 FOR UPDATE`, [family, no_mc]);
    const { rows: [after] } = before
      ? await client.query(`
          UPDATE machine SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')},
            updated_by = $${cols.length + 3}, updated_at = now()
          WHERE family = $1 AND no_mc = $2 RETURNING *`, [family, no_mc, ...cols.map((c) => set[c]), req.user])
      : await client.query(`
          INSERT INTO machine (family, no_mc, ${cols.join(', ')}, updated_by)
          VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3}) RETURNING *`,
        [family, no_mc, ...cols.map((c) => set[c]), req.user]);
    await client.query(`
      INSERT INTO machine_log (family, no_mc, action, before_json, after_json, reason, changed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [family, no_mc, before ? 'update' : 'create', before ? JSON.stringify(before) : null,
      JSON.stringify(after), reason, req.user]);
    await client.query('COMMIT');
    res.json(after);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ------------------------------------------------------------------ *
 * Saved metres against the formula
 *
 * Every row's metres worked out again from its own readings (and its own
 * pick, fabrics and fabric code) with the family's current formula, beside
 * what is stored — grouped by where the stored figure came from (calc). On
 * imported rows this is the reconciliation against the workbooks; on rows
 * worked out here it shows what a formula change would move. Nothing is
 * written by the check; re-working rows is the separate, logged step below.
 * ------------------------------------------------------------------ */

async function sodokanTables() {
  const { rows } = await query(`SELECT kode_kain, width, cm, meter FROM shuttle_sodokan`);
  return new Map(rows.map((r) => [`${r.kode_kain}|${r.width}|${Number(r.cm)}`, Number(r.meter)]));
}

function rangeOf(q, params) {
  const where = [];
  if (ISO.test(String(q.from))) { params.push(q.from); where.push(`tgl >= $${params.length}`); }
  if (ISO.test(String(q.to))) { params.push(q.to); where.push(`tgl <= $${params.length}`); }
  return where.map((w) => `AND ${w}`).join(' ');
}

const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

async function checkRows(db, family, q) {
  const params = [family];
  const range = rangeOf(q, params);
  const { rows } = await db.query(`
    SELECT id, family, tgl::text AS tgl, shift, no_mc, type_mc, kode_kain, jml_kain, pick_used,
           ketik_prod, sodokan, produksi, calc
    FROM production WHERE family = $1 ${range}`, params);
  const tables = family === 'shuttle' ? await sodokanTables() : null;
  return rows.map((r) => ({ ...r, formula: outputOf(r, tables) }));
}

router.get('/api/production/recalc-check', requireRole('operator'), (req, res) => send(res, async () => {
  const family = familyIn(req.query.family);
  const rows = await checkRows(pool, family, req.query);
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.calc ?? '-') ?? { calc: r.calc ?? '-', rows: 0, match: 0, differ: 0, cannot: 0,
      stored_m: 0, formula_m: 0, sample: [] };
    g.rows++;
    if (r.formula === null || r.produksi === null) g.cannot++;
    else {
      g.stored_m += Number(r.produksi);
      g.formula_m += r.formula;
      if (close(r.produksi, r.formula)) g.match++;
      else {
        g.differ++;
        if (g.sample.length < 10) {
          g.sample.push({ tgl: r.tgl, shift: r.shift, no_mc: r.no_mc, stored: Number(r.produksi),
            formula: Math.round(r.formula * 100) / 100 });
        }
      }
    }
    groups.set(g.calc, g);
  }
  res.json({
    family, formula: MACHINE_TYPES[family].output, calc: MACHINE_TYPES[family].calc,
    groups: [...groups.values()].map((g) => ({ ...g,
      stored_m: Math.round(g.stored_m * 100) / 100, formula_m: Math.round(g.formula_m * 100) / 100 }))
  });
}));

/**
 * Re-works saved metres with the current formula where they differ. By
 * default only rows worked out on the dashboard (an older formula version);
 * imported rows only when asked for (include_excel), and metres typed in by a
 * person never. Each row changed is logged with the reason.
 */
router.post('/api/production/recalc', requireRole('admin'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const family = familyIn(b.family);
  const reason = String(b.reason ?? '').trim();
  if (!reason) throw new AppError('Tulis alasan menghitung ulang.');
  const current = MACHINE_TYPES[family].calc;
  const allowed = (c) => (c === 'excel' ? !!b.include_excel : c !== 'typed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = (await checkRows(client, family, b))
      .filter((r) => r.formula !== null && allowed(r.calc) && !(r.produksi !== null && close(r.produksi, r.formula)));
    for (const r of rows) {
      const { rows: [before] } = await client.query(`SELECT * FROM production WHERE id = $1 FOR UPDATE`, [r.id]);
      const { rows: [after] } = await client.query(`
        UPDATE production SET produksi = $2, calc = $3, edited_by = $4, manual = true
        WHERE id = $1 RETURNING *`, [r.id, r.formula, current, req.user]);
      await client.query(`
        INSERT INTO edit_log (table_name, row_id, action, before_json, after_json, edited_by, reason)
        VALUES ('production', $1, 'edit', $2, $3, $4, $5)`,
      [r.id, JSON.stringify(before), JSON.stringify(after), req.user, `hitung ulang ${current}: ${reason}`]);
    }
    await client.query('COMMIT');
    res.json({ family, calc: current, recalculated: rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));
