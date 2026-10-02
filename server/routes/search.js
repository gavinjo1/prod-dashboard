/**
 * The search box over everything.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send } from '../errors.js';
import { familyOf } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Global search
 *
 * One box over everything — customer, order, fabric, machine, machine type,
 * stoppage note — but the answer is always a list of orders, because that is
 * the level the mill plans and ships at.
 * ------------------------------------------------------------------ */

/** "A1" must not match A10/A11/A12, so machine numbers match as whole tokens. */
const MACHINE_SHAPED = /^[A-Za-z]{1,2}\d{1,2}$/;

router.get('/api/search', (req, res) => send(res, async () => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ query: q, rows: [] });

  const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const machineToken = MACHINE_SHAPED.test(q) ? q : null;

  // Scoped to the family on screen, like every other figure: an order belongs
  // to a family when that family wove it or graded it. The order header table
  // carries no family, so it only describes orders found that way. Semua
  // searches every family, and each order says whose it is.
  const fam = String(req.query.family ?? '').trim().toLowerCase() === 'semua' ? null : familyOf(req.query);
  const { rows } = await query(`
    WITH found AS (
      SELECT mo, family FROM production
      WHERE ($3::text IS NULL OR family = $3) AND mo IS NOT NULL AND mo <> '0'
      UNION
      SELECT mo, family FROM grade WHERE ($3::text IS NULL OR family = $3)
    ),
    mos AS (
      SELECT mo, string_agg(DISTINCT family, ',') AS families FROM found GROUP BY mo
    ),
    latest AS (
      SELECT DISTINCT ON (mo) mo, customer, kode_kain, total_order, akumulasi, sisa_order, as_of
      FROM order_info ORDER BY mo, as_of DESC
    ),
    prod AS (
      SELECT p.mo,
             sum(p.produksi)                                        AS produksi,
             count(DISTINCT p.no_mc)::int                           AS n_machines,
             min(p.tgl)::text                                       AS mulai,
             max(p.tgl)::text                                       AS terakhir,
             string_agg(DISTINCT p.no_mc, ' ')                      AS machines,
             string_agg(DISTINCT p.kode_kain, ', ')                 AS fabrics,
             string_agg(DISTINCT COALESCE(t.band || ' | ', '') || COALESCE(t.description, p.type_mc), ' · ') AS types,
             string_agg(DISTINCT p.ket_bb, ', ')                    AS notes
      FROM production p LEFT JOIN machine_type t USING (type_mc)
      WHERE ($3::text IS NULL OR p.family = $3) AND p.mo IS NOT NULL AND p.mo <> '0'
      GROUP BY p.mo
    )
    SELECT m.mo, m.families,
           l.customer,
           COALESCE(pr.fabrics, l.kode_kain)                        AS kode_kain,
           pr.types                                                 AS type_mc,
           l.total_order, l.akumulasi, l.sisa_order,
           pr.produksi, pr.n_machines, pr.mulai, pr.terakhir,
           CASE
             WHEN l.customer ILIKE $1                                        THEN 'customer'
             WHEN m.mo ILIKE $1                                              THEN 'order'
             WHEN pr.fabrics ILIKE $1 OR l.kode_kain ILIKE $1                THEN 'fabric'
             WHEN pr.types ILIKE $1                                          THEN 'machine type'
             WHEN $2::text IS NOT NULL AND pr.machines ~* ('\\m' || $2 || '\\M') THEN 'machine'
             WHEN pr.notes ILIKE $1                                          THEN 'note'
           END AS matched
    FROM mos m
    LEFT JOIN latest l ON l.mo = m.mo
    LEFT JOIN prod  pr ON pr.mo = m.mo
    WHERE l.customer ILIKE $1
       OR m.mo ILIKE $1
       OR pr.fabrics ILIKE $1
       OR l.kode_kain ILIKE $1
       OR pr.types ILIKE $1
       OR pr.notes ILIKE $1
       OR ($2::text IS NOT NULL AND pr.machines ~* ('\\m' || $2 || '\\M'))
    ORDER BY pr.produksi DESC NULLS LAST, m.mo
    LIMIT 60`, [like, machineToken, fam]);

  res.json({ query: q, rows });
}));
