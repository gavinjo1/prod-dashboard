/**
 * The machine table and one machine's shifts.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send } from '../errors.js';
import { buildFilters } from '../lib/filters.js';
import { pricedShifts } from '../lib/formulas.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Per-machine table
 * ------------------------------------------------------------------ */

const MACHINE_SORTS = {
  machine: 'machine', produksi: 'produksi', avg_day: 'avg_day',
  rpm: 'avg_rpm', attainment: 'rpm_attainment', stoppages: 'stoppages', achieved: 'achieved'
};

router.get('/api/machines', (req, res) => send(res, async () => {
  // One filter set serves both the CTE and the main query: same alias, same
  // placeholders.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = `WHERE ${clauses.join(' AND ')}`;
  const sortCol = MACHINE_SORTS[req.query.sort] || 'produksi';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  // achieved: output over the output at RPM TARGET, on the shifts that can be
  // priced — the same ratio as the efficiency cards, per machine.
  const { rows } = await query(`
    WITH ${pricedShifts(where)},
    c AS (SELECT no_mc,
                 sum(produksi) FILTER (WHERE priced)   AS priced_output,
                 sum(capability) FILTER (WHERE priced) AS capability
          FROM r GROUP BY no_mc)
    SELECT p.no_mc                                   AS machine,
           max(p.kelompok_mesin)                     AS grp,
           max(p.type_mc)                            AS type,
           max(COALESCE(NULLIF(concat_ws(' | ', t.band, t.description), ''), p.type_mc)) AS type_name,
           sum(p.produksi)                           AS produksi,
           count(DISTINCT p.tgl)::int                AS days,
           sum(p.produksi) / NULLIF(count(DISTINCT p.tgl), 0) AS avg_day,
           avg(p.rpm)                                AS avg_rpm,
           CASE WHEN sum(p.rpm_target) > 0
                THEN sum(p.rpm) / sum(p.rpm_target) * 100 END AS rpm_attainment,
           CASE WHEN max(c.capability) > 0
                THEN max(c.priced_output) / max(c.capability) * 100 END AS achieved,
           count(*) FILTER (WHERE p.ket_bb IS NOT NULL)::int AS stoppages,
           count(*) FILTER (WHERE COALESCE(p.produksi,0) = 0)::int AS idle,
           string_agg(DISTINCT p.kode_kain, ', ' ORDER BY p.kode_kain) AS fabrics
    FROM production p
    LEFT JOIN machine_type t ON t.type_mc = p.type_mc
    LEFT JOIN c ON c.no_mc = p.no_mc
    ${where}
    GROUP BY p.no_mc
    ORDER BY ${sortCol} ${dir} NULLS LAST, p.no_mc`, params);
  res.json(rows);
}));

/**
 * Every shift line for one machine — the drill-down behind a table row.
 *
 * PICK comes from the order header on that day's sheet, joined on order *and*
 * date rather than order alone: it is a property of the order as it stood that
 * day, so a change part-way through the month would show on the right rows.
 */
router.get('/api/machine/:no', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  params.push(req.params.no);
  const where = [...clauses, `p.no_mc = $${params.length}`].join(' AND ');

  // The pick is the order's nearest snapshot, as the target chart takes it,
  // so a day without its own order sheet still has one. Output target is the
  // shift at RPM TARGET: RPM TARGET × 8 × 60 × 2,54 ÷ (pick × 100) × widths.
  const { rows } = await query(`
    SELECT q.*,
           CASE WHEN q.pick > 0 AND q.rpm_target > 0 AND q.jml_kain > 0
                THEN q.rpm_target * 8 * 60 * 2.54 / (q.pick * 100) * q.jml_kain END AS output_target
    FROM (
      SELECT p.id, p.tgl::text AS date, p.shift, p.no_mc, p.family, p.source_file,
             p.mo, p.kode_kain, p.jml_kain,
             p.pick_used AS pick,
             p.rpm, p.rpm_target, p.produksi, p.ket_bb, p.edited_by,
             to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
             to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai
      FROM production p
      WHERE ${where}
    ) q
    ORDER BY q.date, q.shift`, params);
  res.json(rows);
}));
