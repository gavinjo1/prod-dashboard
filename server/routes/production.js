/**
 * Production tab: headline numbers, the daily trend against target,
 * efficiency by type and machine, breakdowns and stoppage reasons.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send } from '../errors.js';
import { buildFilters, gradeWhere, whereFrom, TYPE_LABEL } from '../lib/filters.js';
import { pricedShifts } from '../lib/formulas.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Headline numbers
 * ------------------------------------------------------------------ */

router.get('/api/summary', (req, res) => send(res, async () => {
  const { sql, params } = whereFrom(req.query);

  const { rows: [s] } = await query(`
    SELECT
      COALESCE(sum(produksi), 0)                       AS produksi,
      count(DISTINCT tgl)::int                         AS days,
      count(DISTINCT mo)::int                          AS orders
    FROM production ${sql}`, params);

  // The same period length immediately before this one, under the same
  // dimension filters — comparing a filtered period to an unfiltered one
  // would make the delta meaningless.
  const dims = buildFilters(req.query, { prefix: 'p.', startAt: params.length, dates: false });
  const { rows: [prev] } = await query(`
    WITH bounds AS (
      SELECT min(tgl) AS lo, max(tgl) AS hi FROM production ${sql}
    )
    SELECT COALESCE(sum(p.produksi), 0) AS produksi, count(DISTINCT p.tgl)::int AS days
    FROM production p, bounds b
    WHERE p.tgl < b.lo AND p.tgl >= b.lo - (b.hi - b.lo + 1)
    ${dims.clauses.map((c) => `AND ${c}`).join(' ')}`,
    [...params, ...dims.params]);

  // The last day in the filter — the latest input, or the day the filter
  // ends on — beside the whole period. Efficiency is the Produksi tab's own:
  // output over what the looms could have woven, on the shifts that can be
  // priced.
  const { clauses, params: pParams } = buildFilters(req.query, { prefix: 'p.' });
  const { rows: [last] } = await query(`
    WITH ${pricedShifts(clauses.length ? `WHERE ${clauses.join(' AND ')}` : '')},
         d AS (SELECT max(tgl) AS tgl FROM r)
    SELECT d.tgl::text AS tgl,
           sum(r.produksi) FILTER (WHERE r.tgl = d.tgl) AS produksi,
           sum(r.produksi) FILTER (WHERE r.priced AND r.tgl = d.tgl) * 100
             / NULLIF(sum(r.capability) FILTER (WHERE r.priced AND r.tgl = d.tgl), 0) AS eff,
           sum(r.produksi) FILTER (WHERE r.priced) * 100
             / NULLIF(sum(r.capability) FILTER (WHERE r.priced), 0) AS eff_period
    FROM r, d GROUP BY d.tgl`, pParams);

  // Grades are dated by inspection, not weaving, so their last day is their
  // own. Only the filters the grade sheet can answer apply, as on the Kualitas
  // tab.
  const g = gradeWhere(req.query);
  const { rows: [grade] } = await query(`
    WITH g AS (SELECT * FROM grade ${g.sql}),
         d AS (SELECT max(tgl) AS tgl FROM g)
    SELECT d.tgl::text AS tgl,
           sum(g.grade_a) FILTER (WHERE g.tgl = d.tgl) AS a,
           sum(g.bs)      FILTER (WHERE g.tgl = d.tgl) AS bs,
           sum(g.total)   FILTER (WHERE g.tgl = d.tgl) AS total,
           sum(g.grade_a) AS a_period, sum(g.bs) AS bs_period, sum(g.total) AS total_period
    FROM g, d GROUP BY d.tgl`, g.params);

  res.json({ ...s, prev, last: last ?? null, grade: grade ?? null });
}));

/* ------------------------------------------------------------------ *
 * Series and breakdowns
 * ------------------------------------------------------------------ */

/**
 * `prod100` is the whole mill's output at 100% efficiency, from the monthly
 * sheet. It is only comparable with an unfiltered day, so it is served only
 * when nothing narrows the machines — see `capacityApplies`.
 */
const NARROWING = ['shift', 'machine', 'group', 'type', 'fabric', 'mo', 'jam'];
const capacityApplies = (q) => !NARROWING.some((k) => String(q[k] ?? '').trim());


router.get('/api/trend', (req, res) => send(res, async () => {
  // Aliased via buildFilters rather than rewriting the clause with a regex —
  // a filter value could contain a column name and get mangled.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const showCapacity = capacityApplies(req.query);

  const { rows } = await query(`
    WITH ${pricedShifts(where)}
    SELECT r.tgl::text AS date,
           sum(r.produksi)              AS produksi,
           count(DISTINCT r.no_mc)::int AS machines,
           ${showCapacity ? 'max(c.prod100)' : 'NULL::numeric'} AS prod100,
           sum(r.capability) FILTER (WHERE r.priced) AS at_target_rpm,
           COALESCE(sum(r.produksi) FILTER (WHERE NOT r.priced), 0) AS target_as_is,
           count(*) FILTER (WHERE NOT r.priced)::int AS unpriced
    FROM r
    LEFT JOIN daily_capacity c ON c.tgl = r.tgl AND c.family = r.family
    GROUP BY r.tgl ORDER BY r.tgl`, params);
  res.json(rows);
}));

/**
 * Efficiency per machine type, grouped under the layout bands the mill's
 * sheet heads its columns with (AJL TOYOTA 1 → E SHADE, E SHADE 190, …).
 * Output over capability, on the shifts that can be priced only — a shift
 * with no pick has no capability, so counting its output would inflate the
 * ratio.
 */
router.get('/api/efficiency-by-type', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    WITH ${pricedShifts(where)}
    SELECT COALESCE(t.band, t.description, r.type_mc) AS band,
           COALESCE(t.description, r.type_mc)          AS description,
           r.type_mc,
           min(t.sort_order)                            AS sort_order,
           count(DISTINCT r.no_mc)::int                 AS machines,
           sum(r.produksi)   FILTER (WHERE r.priced)    AS produksi,
           sum(r.capability) FILTER (WHERE r.priced)    AS capability,
           count(*) FILTER (WHERE NOT r.priced)::int    AS unpriced
    FROM r LEFT JOIN machine_type t ON t.type_mc = r.type_mc
    WHERE r.type_mc IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY min(t.sort_order) NULLS LAST, 2`, params);
  res.json(rows);
}));

/**
 * The same ratio one level down: each machine within each type, for the list
 * that opens under a type on the efficiency cards. Per type and machine, so a
 * loom that changed type in the period counts under each for its own shifts.
 */
router.get('/api/efficiency-by-machine', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    WITH ${pricedShifts(where)}
    SELECT r.type_mc, r.no_mc,
           sum(r.produksi)   FILTER (WHERE r.priced) AS produksi,
           sum(r.capability) FILTER (WHERE r.priced) AS capability,
           count(*) FILTER (WHERE NOT r.priced)::int AS unpriced
    FROM r
    WHERE r.type_mc IS NOT NULL
    GROUP BY 1, 2`, params);
  res.json(rows);
}));

// dim is whitelisted, never interpolated from raw input.
const DIMS = {
  group: 'kelompok_mesin',
  type: 'type_mc',
  shift: 'shift',
  fabric: 'kode_kain',
  mo: 'mo',
  machine: 'no_mc'
};

router.get('/api/breakdown/:dim', (req, res) => send(res, async () => {
  const col = DIMS[req.params.dim];
  if (!col) return res.status(400).json({ error: `Dimensi tidak dikenal: "${req.params.dim}"` });

  // Aliased, because the machine-type breakdown joins the name lookup.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  params.push(limit);

  // For machine type, show the mill's name and keep the code alongside it.
  const isType = col === 'type_mc';
  const label = isType ? TYPE_LABEL : `p.${col}`;
  const join = isType ? 'LEFT JOIN machine_type t USING (type_mc)' : '';
  const where = [...clauses, `p.${col} IS NOT NULL`].join(' AND ');

  const { rows } = await query(`
    SELECT ${label} AS label,
           ${isType ? 'p.type_mc' : 'NULL'} AS code,
           sum(p.produksi)              AS produksi,
           count(*)::int                AS entries,
           count(DISTINCT p.no_mc)::int AS machines,
           CASE WHEN sum(p.rpm_target) > 0
                THEN sum(p.rpm) / sum(p.rpm_target) * 100 END AS rpm_attainment
    FROM production p ${join}
    WHERE ${where}
    GROUP BY ${label}${isType ? ', p.type_mc' : ''}
    ORDER BY produksi DESC NULLS LAST
    LIMIT $${params.length}`, params);
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Stoppages and quality
 * ------------------------------------------------------------------ */

router.get('/api/stoppages', (req, res) => send(res, async () => {
  const { sql, params } = whereFrom(req.query);
  const { rows } = await query(`
    SELECT ket_bb AS label, count(*)::int AS entries,
           count(DISTINCT no_mc)::int AS machines,
           COALESCE(sum(produksi), 0) AS produksi
    FROM production ${sql}
    ${sql ? 'AND' : 'WHERE'} ket_bb IS NOT NULL
    GROUP BY ket_bb ORDER BY entries DESC`, params);
  res.json(rows);
}));
