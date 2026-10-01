/**
 * The mill's capability formula and PPIC's targets, shared by every view that
 * compares output with what the looms could have woven.
 */
import { query } from '../db.js';

/**
 * Every shift in the filter with what it could have woven at its target RPM.
 *
 * The mill's own capability formula, per day:
 *     RPM × 24 × 60 × 2,54 ÷ (pick × 100)      metres at 100%
 * Here per shift, so 8 × 60 minutes, and times the widths woven at once.
 * A shift missing its pick, target RPM or widths cannot be priced; `priced`
 * says which, with NULL turned into false — "NULL > 0 AND …" is NULL, and
 * NOT NULL is still NULL, which silently dropped those shifts from both sides.
 */
export const pricedShifts = (where) => `r AS (
      SELECT q.*,
             COALESCE(q.pick > 0 AND q.rpm_target > 0 AND q.jml_kain > 0, false) AS priced,
             q.rpm_target * 8 * 60 * 2.54 / (NULLIF(q.pick, 0) * 100) * q.jml_kain AS capability
      FROM (
        SELECT p.tgl, p.family, p.shift, p.no_mc, p.type_mc, p.mo, p.kode_kain,
               p.produksi, p.rpm_target, p.jml_kain,
               (SELECT o.pick FROM order_info o
                 WHERE o.mo = p.mo AND o.pick IS NOT NULL
                 ORDER BY abs(o.as_of - p.tgl), o.as_of DESC LIMIT 1) AS pick
        FROM production p ${where}
      ) q
    )`;

/** The family's efficiency target, the same for every day. */
export async function targetPcts(family) {
  const { rows: [s] } = await query(`SELECT value FROM app_setting WHERE key = 'target_eff'`);
  const pct = Number(s?.value?.[family] ?? 80);
  return { fallback: pct, of: () => pct };
}

export const n0 = (v) => Number(v) || 0;
