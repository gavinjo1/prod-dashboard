/**
 * Reference data for the filter controls.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send } from '../errors.js';
import { SHIFT_WINDOWS, familyOf, TYPE_LABEL } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Reference data for the filter controls
 * ------------------------------------------------------------------ */

router.get('/api/filters', (req, res) => send(res, async () => {
  const fam = familyOf(req.query);
  const { rows: [range] } = await query(
    `SELECT min(tgl)::text AS min_date, max(tgl)::text AS max_date, count(*)::int AS total
     FROM production WHERE family = $1`, [fam]
  );
  // How many rows carry hours: without them a window filter matches nothing,
  // and the screen should say so rather than look broken.
  const { rows: [h] } = await query(
    'SELECT count(jam_mulai)::int AS with_hours FROM production WHERE family = $1', [fam]);

  const col = async (c) =>
    (await query(
      `SELECT DISTINCT ${c} AS v FROM production WHERE family = $1 AND ${c} IS NOT NULL ORDER BY 1`,
      [fam])).rows.map((r) => r.v);

  // Machine types carry the mill's own name for the loom ("AJL 2 AIR TUCKER"),
  // which is what people on the floor actually call them.
  const { rows: types } = await query(`
    SELECT DISTINCT p.type_mc AS value, ${TYPE_LABEL} AS label,
           t.description, t.band, t.sort_order
    FROM production p LEFT JOIN machine_type t USING (type_mc)
    WHERE p.family = $1 AND p.type_mc IS NOT NULL
    ORDER BY t.sort_order NULLS LAST, p.type_mc`, [fam]);

  res.json({
    range,
    shifts:   await col('shift'),
    groups:   await col('kelompok_mesin'),
    types,
    machines: await col('no_mc'),
    fabrics:  await col('kode_kain'),
    mos:      await col('mo'),
    windows:  SHIFT_WINDOWS,
    with_hours: h.with_hours
  });
}));
