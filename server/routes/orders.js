/**
 * Order detail, order history and the order list.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send } from '../errors.js';
import { buildFilters, familyOf } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Order header — shown when the view is narrowed to an order or a fabric
 * ------------------------------------------------------------------ */

router.get('/api/order-info', (req, res) => send(res, async () => {
  const mos = String(req.query.mo ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const fabrics = String(req.query.fabric ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!mos.length && !fabrics.length) return res.json([]);

  // Only the order and fabric filters apply: an order header describes the
  // whole order, not one machine-shift, so a machine or shift filter would
  // narrow the production figure without narrowing the order it sits beside.
  const clauses = [];
  const params = [familyOf(req.query)];
  if (mos.length)     { params.push(mos);     clauses.push(`o.mo = ANY($${params.length})`); }
  if (fabrics.length) { params.push(fabrics); clauses.push(`o.kode_kain = ANY($${params.length})`); }

  const { rows } = await query(`
    SELECT DISTINCT ON (o.mo)
           o.mo, o.kode_kain, o.customer, o.pick, o.total_order, o.akumulasi, o.sisa_order,
           o.as_of::text AS as_of,
           COALESCE(p.periode, 0)   AS periode,
           COALESCE(p.machines, 0)  AS machines,
           p.terakhir::text         AS terakhir
    FROM order_info o
    LEFT JOIN (
      SELECT mo, sum(produksi) AS periode, count(DISTINCT no_mc)::int AS machines,
             max(tgl) AS terakhir
      FROM production WHERE family = $1 GROUP BY mo
    ) p ON p.mo = o.mo
    WHERE (${clauses.join(' OR ')})
      -- Only orders this family wove or graded; the header table has no family.
      AND (EXISTS (SELECT 1 FROM production x WHERE x.family = $1 AND x.mo = o.mo)
        OR EXISTS (SELECT 1 FROM grade g WHERE g.family = $1 AND g.mo = o.mo))
    ORDER BY o.mo, o.as_of DESC`, params);

  rows.sort((a, b) => (Number(b.akumulasi) || 0) - (Number(a.akumulasi) || 0));
  res.json(rows);
}));

/**
 * The day-by-day progression for one order, as each daily sheet recorded it,
 * with that day's loom output from the source sheet alongside.
 */
router.get('/api/order-history', (req, res) => send(res, async () => {
  const mo = String(req.query.mo ?? '').trim();
  if (!mo) return res.json([]);

  const { rows } = await query(`
    SELECT o.as_of::text AS date, o.total_order, o.akumulasi, o.sisa_order,
           COALESCE(p.produksi, 0) AS produksi
    FROM order_info o
    LEFT JOIN (
      SELECT tgl, sum(produksi) AS produksi FROM production WHERE mo = $1 AND family = $2 GROUP BY tgl
    ) p ON p.tgl = o.as_of
    WHERE o.mo = $1
    ORDER BY o.as_of`, [mo, familyOf(req.query)]);
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

const ORDER_SORTS = {
  mo: 'mo', saldo: 'saldo', period: 'periode', total: 'kumulatif',
  machines: 'machines', last: 'terakhir'
};

/**
 * Per order, from the source sheet alone: the SALDO opening balance, what was
 * woven in the selected period, and the two added together.
 */
router.get('/api/orders', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortCol = ORDER_SORTS[req.query.sort] || 'kumulatif';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const { rows } = await query(`
    SELECT p.mo,
           max(p.kode_kain)                              AS kode_kain,
           COALESCE(max(s.produksi), 0)                  AS saldo,
           sum(p.produksi)                               AS periode,
           COALESCE(max(s.produksi), 0) + sum(p.produksi) AS kumulatif,
           count(DISTINCT p.no_mc)::int                  AS machines,
           count(DISTINCT p.tgl)::int                    AS days,
           min(p.tgl)::text                              AS mulai,
           max(p.tgl)::text                              AS terakhir
    FROM production p
    LEFT JOIN saldo s ON s.mo = p.mo
    ${where}
    ${where ? 'AND' : 'WHERE'} p.mo IS NOT NULL
    GROUP BY p.mo
    ORDER BY ${sortCol} ${dir} NULLS LAST, p.mo`, params);

  // Orders carried over but not woven at all in this period.
  const { rows: [dormant] } = await query(`
    SELECT count(*)::int AS n, COALESCE(sum(s.produksi), 0) AS produksi
    FROM saldo s
    WHERE NOT EXISTS (SELECT 1 FROM production p WHERE p.mo = s.mo)`);

  res.json({ rows, dormant });
}));
