/**
 * Quality tab: grades by day and fabric, and one fabric's machines.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { loomQuery } from '../loom-db.js';
import { send, AppError } from '../errors.js';
import { familyOf, gradeWhere, ISO_DAY } from '../lib/filters.js';
import { n0 } from '../lib/formulas.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Quality
 * ------------------------------------------------------------------ */

/**
 * The weaving dates to look at for a fabric's machines: the chosen period, not
 * the grading dates — cloth is graded days after it comes off the loom, so the
 * grading dates would cut off the first days of weaving.
 */
function weaveWindow(query, startAt = 0, prefix = 'p.') {
  const clauses = [];
  const params = [];
  if (ISO_DAY.test(String(query.from))) { params.push(query.from); clauses.push(`${prefix}tgl >= $${startAt + params.length}`); }
  if (ISO_DAY.test(String(query.to)))   { params.push(query.to);   clauses.push(`${prefix}tgl <= $${startAt + params.length}`); }
  return { sql: clauses.map((c) => `AND ${c}`).join(' '), params };
}

router.get('/api/quality', (req, res) => send(res, async () => {
  const { sql, params } = gradeWhere(req.query);

  const { rows: [totals] } = await query(`
    SELECT COALESCE(sum(grade_a),0) AS a, COALESCE(sum(grade_b),0) AS b,
           COALESCE(sum(bs),0) AS bs, COALESCE(sum(rk),0) AS rk,
           COALESCE(sum(total),0) AS total, count(*)::int AS rows
    FROM grade ${sql}`, params);

  const { rows: daily } = await query(`
    SELECT tgl::text AS date, sum(grade_a) AS a, sum(grade_b) AS b,
           sum(bs) AS bs, sum(rk) AS rk, sum(total) AS total
    FROM grade ${sql} GROUP BY tgl ORDER BY tgl`, params);

  // Machines are counted through the order: the grade sheet names the MO, the
  // daily report says which looms wove that MO in the chosen period.
  const { sql: pSql, params: pParams } = weaveWindow(req.query, params.length);
  const { rows: byFabric } = await query(`
    WITH f AS (
      SELECT kode_kain, sum(total) AS total, sum(grade_a) AS a, sum(grade_b) AS b,
             sum(bs) AS bs, sum(rk) AS rk, sum(bs) + sum(rk) AS defect,
             count(DISTINCT mo)::int AS orders, array_agg(DISTINCT mo) AS mos
      FROM grade ${sql} AND kode_kain IS NOT NULL
      GROUP BY kode_kain)
    SELECT kode_kain AS label, total, a, b, bs, rk, defect, orders,
           (SELECT count(DISTINCT p.no_mc)::int FROM production p
             WHERE p.family = $1 AND p.mo = ANY(f.mos) ${pSql}) AS machines
    FROM f ORDER BY total DESC`, [...params, ...pParams]);

  res.json({ totals, daily, byFabric });
}));

/**
 * One fabric: its orders' grades, and the looms that wove those orders with
 * how often each stopped for warp and weft.
 *
 * BS is graded per order, never per machine, so the machines here share their
 * fabric's BS. What does tell them apart is the loom's own stop count, taken
 * per 100 000 picks so a loom that ran twice as long is not counted as twice
 * as bad.
 */
router.get('/api/quality/fabric', (req, res) => send(res, async () => {
  const kode = String(req.query.kode ?? '').trim();
  if (!kode) throw new AppError('Kode kain belum dipilih.');
  const fam = familyOf(req.query);
  const { sql, params } = gradeWhere({ ...req.query, fabric: '' });
  params.push(kode);
  const { rows: orders } = await query(`
    SELECT mo, sum(grade_a) AS a, sum(grade_b) AS b, sum(bs) AS bs, sum(rk) AS rk,
           sum(total) AS total, min(tgl)::text AS first, max(tgl)::text AS last
    FROM grade ${sql} AND kode_kain = $${params.length}
    GROUP BY mo ORDER BY total DESC`, params);
  if (!orders.length) return res.json({ kode, orders, machines: [], stops: false });

  const win = weaveWindow(req.query, 2, '');
  const { rows: shifts } = await query(`
    SELECT tgl::text AS tgl, shift, no_mc, type_mc, mo, produksi
    FROM production
    WHERE family = $1 AND mo = ANY($2) ${win.sql}`,
  [fam, orders.map((o) => o.mo), ...win.params]);

  // The loom export only covers AJL; the other families get output alone.
  const stops = fam === 'ajl' && shifts.length > 0;
  const loomBy = new Map();
  if (stops) {
    const days = shifts.map((s) => s.tgl).sort();
    const { rows } = await loomQuery(`
      SELECT tgl::text AS tgl, crew, loom, prod_pick, warp_cnt, warp_min, weft_cnt, weft_min
      FROM loom_shift WHERE loom = ANY($1) AND tgl BETWEEN $2 AND $3`,
    [[...new Set(shifts.map((s) => s.no_mc))], days[0], days[days.length - 1]]);
    for (const r of rows) loomBy.set(`${r.tgl}|${r.crew}|${r.loom}`, r);
  }

  const machines = new Map();
  for (const s of shifts) {
    let m = machines.get(s.no_mc);
    if (!m) {
      machines.set(s.no_mc, (m = { no_mc: s.no_mc, type_mc: s.type_mc, shifts: 0, produksi: 0,
        mos: new Set(), loom_shifts: 0, picks: 0, warp_cnt: 0, warp_min: 0, weft_cnt: 0, weft_min: 0 }));
    }
    m.shifts++;
    m.produksi += n0(s.produksi);
    if (s.mo) m.mos.add(s.mo);
    const l = loomBy.get(`${s.tgl}|${s.shift}|${s.no_mc}`);
    if (!l) continue;
    m.loom_shifts++;
    m.picks += n0(l.prod_pick);
    for (const k of ['warp_cnt', 'warp_min', 'weft_cnt', 'weft_min']) m[k] += n0(l[k]);
  }
  // prod_pick is in thousands, so ×100 gives stops per 100 000 picks.
  const per100k = (cnt, picks) => (picks > 0 ? (cnt * 100) / picks : null);
  res.json({
    kode,
    orders,
    stops,
    machines: [...machines.values()]
      .map((m) => ({ ...m, mos: [...m.mos].sort(),
        warp_rate: per100k(m.warp_cnt, m.picks), weft_rate: per100k(m.weft_cnt, m.picks) }))
      .sort((a, b) => b.produksi - a.produksi)
  });
}));
