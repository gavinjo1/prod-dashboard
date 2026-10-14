/**
 * Kelengkapan data: for each day of a month and each loom family, which of the
 * sources the dashboard is built from are there — the shifts (from the daily
 * report or Input Shift), the quality report, the efficiency grid's capacity,
 * the loom monitor (AJL) — and how much of the MOs woven are in the master.
 *
 * Every figure elsewhere silently leaves out what was never uploaded; this is
 * where the gaps are said out loud.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { loomQuery } from '../loom-db.js';
import { send } from '../errors.js';
import { requireRole } from '../auth.js';
import { FAMILIES } from '../importer/index.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

const SHIFTS = 3;
const monthBounds = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return [`${m}-01`, `${next}-01`];
};
const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

/** Per family and day: shifts saved, quality lines, capacity, loom-monitor shifts. */
async function monthReport(m, today) {
  const [lo, hi] = monthBounds(m);
  const [{ rows: prod }, { rows: grade }, { rows: cap }, loom] = await Promise.all([
    query(`SELECT family, tgl::text AS tgl, count(*)::int AS shifts
           FROM production WHERE tgl >= $1 AND tgl < $2 GROUP BY 1, 2`, [lo, hi]),
    query(`SELECT family, tgl::text AS tgl, count(*)::int AS lines
           FROM grade WHERE tgl >= $1 AND tgl < $2 GROUP BY 1, 2`, [lo, hi]),
    query(`SELECT family, tgl::text AS tgl FROM daily_capacity
           WHERE tgl >= $1 AND tgl < $2 AND prod100 IS NOT NULL`, [lo, hi]),
    // A database of its own, and not on every install: without it, the column is left out.
    loomQuery(`SELECT tgl::text AS tgl, count(*)::int AS shifts FROM loom_shift
               WHERE tgl >= $1 AND tgl < $2 GROUP BY 1`, [lo, hi])
      .then((r) => r.rows).catch(() => null)
  ]);
  const key = (f, t) => `${f}|${t}`;
  const shifts = new Map(prod.map((r) => [key(r.family, r.tgl), r.shifts]));
  const lines = new Map(grade.map((r) => [key(r.family, r.tgl), r.lines]));
  const capacity = new Set(cap.map((r) => key(r.family, r.tgl)));
  const monitor = loom && new Map(loom.map((r) => [r.tgl, r.shifts]));

  // Every day of the month up to today; nothing for days still to come.
  const days = [];
  for (let d = new Date(`${lo}T00:00:00Z`); d.toISOString().slice(0, 10) < hi; d.setUTCDate(d.getUTCDate() + 1)) {
    const tgl = d.toISOString().slice(0, 10);
    if (tgl > today) break;
    days.push({
      tgl,
      fam: Object.fromEntries(FAMILIES.map((f) => [f, {
        shifts: shifts.get(key(f, tgl)) ?? 0,
        grade: lines.get(key(f, tgl)) ?? 0,
        capacity: capacity.has(key(f, tgl))
      }])),
      loom: monitor ? monitor.get(tgl) ?? 0 : null
    });
  }
  return days;
}

router.get('/api/kelengkapan', requireRole('viewer'), (req, res) => send(res, async () => {
  const { rows: [{ today }] } = await query(`SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date::text AS today`);
  const { rows: monthRows } = await query(`
    SELECT m FROM (
      SELECT to_char(tgl, 'YYYY-MM') AS m FROM production
      UNION SELECT to_char(tgl, 'YYYY-MM') FROM grade
      UNION SELECT to_char(tgl, 'YYYY-MM') FROM daily_capacity
      UNION SELECT to_char($1::date, 'YYYY-MM')) x
    WHERE m <= to_char($1::date, 'YYYY-MM') ORDER BY m DESC`, [today]);
  const months = monthRows.map((r) => r.m);
  const month = months.includes(String(req.query.month)) ? String(req.query.month) : months[0];
  const [lo, hi] = monthBounds(month);

  const [days, prevDays, { rows: machines }, { rows: ever }, { rows: master }] = await Promise.all([
    monthReport(month, today),
    months.includes(prevMonth(month)) ? monthReport(prevMonth(month), today) : null,
    // Shifts expected a day: every active loom in the registry, three shifts each.
    query(`SELECT family, count(*) FILTER (WHERE active)::int AS active FROM machine GROUP BY 1`),
    // A family that has never had a quality report or a capacity grid is not
    // missing one each day; it does not have that report at all.
    query(`SELECT f AS family,
                  EXISTS (SELECT 1 FROM grade g WHERE g.family = f) AS grade,
                  EXISTS (SELECT 1 FROM daily_capacity c WHERE c.family = f) AS capacity
           FROM unnest($1::text[]) AS f`, [FAMILIES]),
    // The MOs woven that month, and how many of them the master has.
    query(`SELECT p.family, count(DISTINCT p.mo)::int AS mos,
                  count(DISTINCT p.mo) FILTER (WHERE m.mo IS NOT NULL)::int AS in_master,
                  (array_agg(DISTINCT p.mo) FILTER (WHERE m.mo IS NULL))[1:8] AS missing
           FROM production p LEFT JOIN product_master m ON m.mo = p.mo
           WHERE p.tgl >= $1 AND p.tgl < $2 AND p.mo IS NOT NULL AND p.mo NOT IN ('', '0')
           GROUP BY 1`, [lo, hi])
  ]);

  const expected = Object.fromEntries(FAMILIES.map((f) => [f, (machines.find((r) => r.family === f)?.active ?? 0) * SHIFTS]));
  const has = Object.fromEntries(ever.map((r) => [r.family, { grade: r.grade, capacity: r.capacity }]));
  // How many family-days of the month before still lack shifts or capacity:
  // the month-end re-upload that is easy to forget. Only for a family that
  // has shifts that month at all; a month before the dashboard was in use is
  // not a gap to chase.
  const used = prevDays && FAMILIES.filter((f) => prevDays.some((d) => d.fam[f].shifts > 0));
  const prev = prevDays && {
    month: prevMonth(month),
    gaps: prevDays.reduce((t, d) => t + used.filter((f) => {
      const x = d.fam[f];
      return (expected[f] && x.shifts < expected[f]) || (has[f]?.capacity && !x.capacity);
    }).length, 0)
  };
  res.json({
    month, months, today, families: FAMILIES, expected, has, days, prev,
    master: Object.fromEntries(master.map((r) => [r.family, r])),
    loom: days.some((d) => d.loom !== null)
  });
}));
