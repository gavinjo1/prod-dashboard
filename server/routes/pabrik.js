/**
 * Pabrik: the loom export joined to the daily report's targets.
 */
import { Router } from 'express';
import { where as loomWhere } from './loom.js';
import { query } from '../db.js';
import { loomQuery } from '../loom-db.js';
import { send } from '../errors.js';
import { pricedShifts, targetPcts, n0 } from '../lib/formulas.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Pabrik — each loom's own count against its target
 *
 * The loom export says what every loom wove, shift by shift, and why it
 * stopped; it knows nothing of targets. The daily report has the RPM target,
 * the order (so its pick) and how many widths the loom weaves at once. The
 * two meet on date + crew + loom: `crew` is the mill's letter for the loom's
 * time slot that day, the same letter the daily report files the shift under.
 *
 * Output here is the loom's metres × widths, which is how the daily report
 * books it. Target is the capability at the RPM target, the same number the
 * Production tab's chart uses, and the percentage is judged against PPIC's
 * target for that day, or the family default.
 * ------------------------------------------------------------------ */


/** One row per loom-shift: the loom's figures, and the daily report's target. */
async function pabrikShifts(q) {
  const { sql, params } = loomWhere(q);
  const { rows: looms } = await loomQuery(`
    SELECT tgl::text AS tgl, slot, crew, waktu, loom, style, beam,
           rpm, effic, run_min, stop_min, prod_pick, prod_meter,
           warp_cnt, warp_min, weft_cnt, weft_min,
           -- Everything that is neither warp nor weft. The export's total is
           -- the sum of its causes on all but a handful of rows.
           GREATEST(COALESCE(total_cnt,0) - COALESCE(warp_cnt,0) - COALESCE(weft_cnt,0), 0) AS other_cnt,
           GREATEST(COALESCE(total_min,0) - COALESCE(warp_min,0) - COALESCE(weft_min,0), 0) AS other_min
    FROM loom_shift ${sql}
    ORDER BY tgl, CASE slot WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, loom`, params);
  if (!looms.length) return [];

  const from = looms[0].tgl;
  const to = looms[looms.length - 1].tgl;
  // The loom export only covers the AJL shed.
  const { rows: prod } = await query(`
    WITH ${pricedShifts(`WHERE p.family = 'ajl' AND p.tgl BETWEEN $1 AND $2`)}
    SELECT tgl::text AS tgl, shift, no_mc, mo, kode_kain, produksi,
           rpm_target, jml_kain, pick, priced, capability
    FROM r`, [from, to]);
  const byKey = new Map(prod.map((p) => [`${p.tgl}|${p.shift}|${p.no_mc}`, p]));
  const pct = await targetPcts('ajl');

  return looms.map((l) => {
    const p = byKey.get(`${l.tgl}|${l.crew}|${l.loom}`);
    const widths = p?.jml_kain ? Number(p.jml_kain) : null;
    const output = widths ? n0(l.prod_meter) * widths : null;
    const target = p?.priced ? Number(p.capability) : null;
    return {
      ...l,
      mo: p?.mo ?? null,
      kode_kain: p?.kode_kain ?? null,
      rpm_target: p?.rpm_target ?? null,
      pick: p?.pick ?? null,
      jml_kain: widths,
      output,
      target,
      achieved: target && output !== null ? (output / target) * 100 : null,
      target_pct: pct.of(l.tgl),
      in_report: Boolean(p)
    };
  });
}

/** Per loom: output against target, per time of day, and what stopped it. */
router.get('/api/pabrik/mesin', (req, res) => send(res, async () => {
  const shifts = await pabrikShifts(req.query);
  const WAKTU = ['pagi', 'siang', 'malam'];
  const blank = () => ({ output: 0, target: 0, weighted: 0, shifts: 0, met: 0 });
  const looms = new Map();
  const all = blank();

  for (const s of shifts) {
    let m = looms.get(s.loom);
    if (!m) {
      looms.set(s.loom, (m = {
        loom: s.loom, styles: new Set(), shifts: 0, unpriced: 0, meter: 0,
        run_min: 0, stop_min: 0, picks: 0,
        warp_cnt: 0, warp_min: 0, weft_cnt: 0, weft_min: 0, other_cnt: 0, other_min: 0,
        priced: blank(), waktu: Object.fromEntries(WAKTU.map((w) => [w, blank()]))
      }));
    }
    if (s.style) m.styles.add(s.style);
    m.shifts++;
    // A shift the daily report lacks has no width count; it counts as one.
    m.meter += n0(s.output ?? s.prod_meter);
    m.run_min += n0(s.run_min);
    m.stop_min += n0(s.stop_min);
    m.picks += n0(s.prod_pick);
    for (const k of ['warp_cnt', 'warp_min', 'weft_cnt', 'weft_min', 'other_cnt', 'other_min']) m[k] += n0(s[k]);

    if (s.achieved === null) { m.unpriced++; continue; }
    // Summed as metres, not averaged as percentages: a short shift should not
    // count as much as a full one.
    for (const b of [m.priced, m.waktu[s.waktu], all].filter(Boolean)) {
      b.output += s.output;
      b.target += s.target;
      b.weighted += s.target * s.target_pct;
      b.shifts++;
      if (s.achieved >= s.target_pct) b.met++;
    }
  }

  const close = (b) => ({
    achieved: b.target > 0 ? (b.output / b.target) * 100 : null,
    target_pct: b.target > 0 ? b.weighted / b.target : null,
    output: b.output, target: b.target, shifts: b.shifts, met: b.met
  });
  const rows = [...looms.values()].map((m) => ({
    ...m,
    styles: [...m.styles].sort(),
    effic: m.run_min + m.stop_min > 0 ? (m.run_min / (m.run_min + m.stop_min)) * 100 : null,
    priced: close(m.priced),
    waktu: Object.fromEntries(WAKTU.map((w) => [w, close(m.waktu[w])]))
  }));
  res.json({ rows, total: close(all), unpriced: rows.reduce((t, r) => t + r.unpriced, 0) });
}));

/** Every shift of one loom, for the drill-down. */
router.get('/api/pabrik/mesin/:loom', (req, res) => send(res, async () => {
  res.json(await pabrikShifts({ ...req.query, loom: req.params.loom }));
}));

/* ------------------------------------------------------------------ *
 * Efficiency per fabric per day
 *
 * What the mill's "MAS VENAN 3 HARI SEKALI" pivot shows — Average of Effic.
 * by KODE KAIN × TANGGAL: the loom's own efficiency for every machine-shift
 * that wove the fabric that day, averaged. Asked as "how did R3120 do
 * today?".
 *
 * The fabric is the daily report's for that loom and shift. A shift the
 * report lacks is placed by the loom's style name, read as the fabric that
 * style is most often filed under in the same period, and counted as such.
 * ------------------------------------------------------------------ */

/** "UMR%2006%20AJL" as the loom system sometimes writes it, made readable. */
const styleText = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

router.get('/api/pabrik/kain', (req, res) => send(res, async () => {
  const shifts = (await pabrikShifts(req.query)).filter((s) => s.effic !== null && s.effic !== undefined);

  const seen = new Map();   // style -> fabric -> times filed under it
  for (const s of shifts) {
    if (!s.style || !s.kode_kain) continue;
    const m = seen.get(s.style) ?? new Map();
    m.set(s.kode_kain, (m.get(s.kode_kain) ?? 0) + 1);
    seen.set(s.style, m);
  }
  const fromStyle = new Map([...seen].map(([style, m]) => [style, [...m].sort((a, b) => b[1] - a[1])[0][0]]));

  const fabrics = new Map();   // fabric -> date -> cell
  const dates = new Set();
  for (const s of shifts) {
    const kode = s.kode_kain ?? fromStyle.get(s.style) ?? (s.style ? styleText(s.style) : null);
    if (!kode) continue;
    dates.add(s.tgl);
    const days = fabrics.get(kode) ?? new Map();
    const c = days.get(s.tgl) ?? { sum: 0, shifts: 0, looms: new Set(), by_style: 0 };
    c.sum += Number(s.effic);
    c.shifts++;
    c.looms.add(s.loom);
    if (!s.kode_kain) c.by_style++;
    days.set(s.tgl, c);
    fabrics.set(kode, days);
  }

  res.json({
    dates: [...dates].sort(),
    rows: [...fabrics].sort((a, b) => a[0].localeCompare(b[0])).map(([kode_kain, days]) => ({
      kode_kain,
      days: Object.fromEntries([...days].map(([tgl, c]) => [tgl, {
        effic: c.sum / c.shifts, machines: c.looms.size, shifts: c.shifts, by_style: c.by_style
      }]))
    }))
  });
}));

