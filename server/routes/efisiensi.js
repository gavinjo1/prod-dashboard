/**
 * Efisiensi kain: each fabric's efficiency per day, grouped the way the mill's
 * "MAS VENAN 3 HARI SEKALI" sheet groups it, and the upload of those groups.
 */
import { Router } from 'express';
import multer from 'multer';
import { pool, query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { buildFilters } from '../lib/filters.js';
import { pricedShifts } from '../lib/formulas.js';
import { readFabricGroupFile, upsertFabricGroups } from '../importer/fabric-groups.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ------------------------------------------------------------------ *
 * Efficiency per fabric per day
 *
 * The Produksi tab's own efficiency, cut by fabric and day: everything the
 * fabric's machines wove that day against everything they could have at
 * their RPM target. So a cell is the figure the Produksi tab shows when
 * filtered to that fabric and that day, and a group's line, the Grand Total
 * row and the Grand Total column are the same ratio over more shifts.
 * RATA-RATA is the average of the days shown, as the mill's sheet has it.
 *
 * Shifts that cannot be priced (no pick or RPM target) are left out of both
 * sides, as on the Produksi tab, and counted.
 * ------------------------------------------------------------------ */

export const UNGROUPED = 'Tanpa grup NE';
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const cell = () => ({ out: 0, cap: 0, n: 0, looms: new Set() });
const add = (days, tgl, s) => {
  const c = days.get(tgl) ?? cell();
  c.out += Number(s.produksi) || 0;
  c.cap += Number(s.capability);
  c.n++;
  c.looms.add(s.no_mc);
  days.set(tgl, c);
};
const ratio = (out, cap) => (cap > 0 ? (out / cap) * 100 : null);
const close = (days) => {
  const out = Object.fromEntries([...days].map(([tgl, c]) => [tgl, {
    eff: ratio(c.out, c.cap), machines: c.looms.size, shifts: c.n
  }]));
  const all = [...days.values()];
  const looms = new Set(all.flatMap((c) => [...c.looms]));
  const vals = Object.values(out).map((d) => d.eff).filter((v) => v !== null);
  return {
    days: out,
    // Grand Total: the whole period as one ratio, as the pivot's own column.
    total: { eff: ratio(all.reduce((t, c) => t + c.out, 0), all.reduce((t, c) => t + c.cap, 0)),
      machines: looms.size, shifts: all.reduce((t, c) => t + c.n, 0) },
    avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  };
};

// Admins only, the tab and its data alike.
router.get('/api/efisiensi-kain', requireRole('admin'), (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [{ rows: shifts }, { rows: groups }] = await Promise.all([
    query(`
      WITH ${pricedShifts(where)}
      SELECT tgl::text AS tgl, kode_kain, no_mc, produksi, capability, priced, sodokan
      FROM r WHERE kode_kain IS NOT NULL`, params),
    query(`SELECT kode_kain, ne, fixed, sort_ne, sort_kode, source_file,
                  to_char(imported_at, 'YYYY-MM-DD HH24:MI') AS at
           FROM fabric_group`)
  ]);

  // Matched exactly first, then ignoring spaces and punctuation: the sheet
  // writes "RY3100 N AJL" where the daily report has "RY 3100N AJL".
  const exact = new Map(groups.map((g) => [g.kode_kain, g]));
  const loose = new Map(groups.map((g) => [norm(g.kode_kain), g]));
  const groupOf = (kode) => exact.get(kode) ?? loose.get(norm(kode));
  const neOf = (kode) => groupOf(kode)?.ne ?? UNGROUPED;

  // In the sheet's order: its groups and fabrics as it lists them, anything
  // added later after them alphabetically, the ungrouped at the very end.
  const neRank = new Map();
  for (const g of groups) {
    if (g.sort_ne !== null) neRank.set(g.ne, Math.min(neRank.get(g.ne) ?? Infinity, g.sort_ne));
  }
  const byRank = (rank) => ([a], [b]) => (a === UNGROUPED) - (b === UNGROUPED)
    || (rank(a) ?? Infinity) - (rank(b) ?? Infinity)
    || a.localeCompare(b, 'id', { numeric: true });

  const byNe = new Map();      // ne -> { days, fabrics: Map(kode -> days) }
  const grand = new Map();
  const dates = new Set();
  let unpriced = 0;
  let noMeter = 0;
  for (const s of shifts) {
    if (!s.priced) { unpriced++; continue; }
    // Counted at 0 m, as the Produksi tab counts them; said in the note.
    if (Number(s.sodokan) > 0 && !(Number(s.produksi) > 0)) noMeter++;
    const ne = neOf(s.kode_kain);
    const g = byNe.get(ne) ?? { days: new Map(), fabrics: new Map() };
    const f = g.fabrics.get(s.kode_kain) ?? new Map();
    add(f, s.tgl, s);
    add(g.days, s.tgl, s);
    add(grand, s.tgl, s);
    g.fabrics.set(s.kode_kain, f);
    byNe.set(ne, g);
    dates.add(s.tgl);
  }

  const uploaded = groups.filter((g) => !g.fixed);
  const last = uploaded.reduce((m, g) => (!m || g.at > m.at ? g : m), null);
  res.json({
    dates: [...dates].sort(),
    groups: [...byNe]
      .sort(byRank((ne) => neRank.get(ne)))
      .map(([ne, g]) => ({
        ne,
        ungrouped: ne === UNGROUPED,
        fabrics: [...g.fabrics].sort(byRank((kode) => groupOf(kode)?.sort_kode ?? undefined))
          .map(([kode_kain, days]) => ({ kode_kain, ...close(days) })),
        total: close(g.days)
      })),
    grand: close(grand),
    unpriced,
    no_meter: noMeter,
    master: { fixed: groups.length - uploaded.length, uploaded: uploaded.length,
      file: last?.source_file ?? null, at: last?.at ?? null }
  });
}));

/** The groups, from the EFFISIENSI workbook or any file with its KODE KAIN sheet. */
router.post('/api/efisiensi-kain/kelompok', requireRole('admin'), upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) throw new AppError('Tidak ada file yang diterima.');
  const { sheet, groups } = readFabricGroupFile(req.file.buffer, req.file.originalname);
  if (!groups.length) {
    throw new AppError('Tidak ditemukan tabel KODE | KONTRUKSI. Upload file EFFISIENSI yang berisi sheet KODE KAIN.');
  }
  const client = await pool.connect();
  try {
    const written = await upsertFabricGroups(client, groups, req.file.originalname);
    res.json({ file: req.file.originalname, sheet, fabrics: groups.length, written,
      kept: groups.length - written });
  } finally {
    client.release();
  }
}));

/* ------------------------------------------------------------------ *
 * Rapier per deret
 *
 * The EFFISIENSI RAPIER workbook's DERET sheet: for each row pair of the
 * shed (AB, CD … MN) and each shift, the average EFF, warp CMPX and weft
 * CMPX of its looms — a plain average over loom-shifts, those with nothing
 * read left out, and the Total row over every loom rather than over the
 * pairs, as its pivot tables do. Two blocks, as there: one day — the last
 * read unless another is asked for (?tgl) — and the whole period. Only what
 * was typed on Input Shift counts.
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function deretBlock(where, params) {
  const { rows } = await query(`
    SELECT rapier_deret(no_mc) AS deret, shift,
           avg(eff) AS eff, avg(cmpx_pl) AS cl, avg(cmpx_pp) AS cp,
           count(eff)::int AS n, count(DISTINCT no_mc)::int AS mesin
    FROM loom_card ${where}
    GROUP BY GROUPING SETS ((rapier_deret(no_mc), shift), (shift))`, params);
  const by = new Map();
  for (const r of rows) {
    const key = r.deret ?? 'Total';
    const line = by.get(key) ?? { deret: key, shifts: {} };
    line.shifts[r.shift] = { eff: r.eff === null ? null : Number(r.eff), cl: r.cl === null ? null : Number(r.cl),
      cp: r.cp === null ? null : Number(r.cp), n: r.n, mesin: r.mesin };
    by.set(key, line);
  }
  const total = by.get('Total') ?? null;
  by.delete('Total');
  return { rows: [...by.values()].sort((a, b) => a.deret.localeCompare(b.deret)), total };
}

router.get('/api/efisiensi-kain/deret', requireRole('admin'), (req, res) => send(res, async () => {
  const from = ISO_DAY.test(String(req.query.from)) ? req.query.from : null;
  const to = ISO_DAY.test(String(req.query.to)) ? req.query.to : null;
  const range = [];
  const params = ['rapier'];
  if (from) { params.push(from); range.push(`tgl >= $${params.length}`); }
  if (to) { params.push(to); range.push(`tgl <= $${params.length}`); }
  const inRange = ['family = $1', ...range].join(' AND ');
  const [{ rows: [b] }, { rows: [all] }] = await Promise.all([
    query(`SELECT max(tgl)::text AS last, min(tgl)::text AS first FROM loom_card WHERE ${inRange}`, params),
    // Every day read, for the day picker's bounds.
    query(`SELECT max(tgl)::text AS last, min(tgl)::text AS first FROM loom_card WHERE family = $1`, ['rapier'])
  ]);
  if (!b.last && !all.last) return res.json({ last: null });
  const tgl = ISO_DAY.test(String(req.query.tgl)) ? req.query.tgl : (b.last ?? all.last);
  if (!b.last) {
    const day = await deretBlock(`WHERE family = $1 AND tgl = $2`, ['rapier', tgl]);
    return res.json({ last: null, tgl, first_all: all.first, last_all: all.last, day, period: null });
  }
  // The period: the filter's, or the month of the last day read when none is
  // set — named by the days actually read in it.
  const period = from || to
    ? { where: `WHERE ${inRange}`, params, from: b.first, to: b.last }
    : { where: `WHERE family = $1 AND date_trunc('month', tgl) = date_trunc('month', $2::date)`,
      params: ['rapier', b.last], from: `${b.last.slice(0, 7)}-01`, to: b.last };
  const [day, whole] = await Promise.all([
    deretBlock(`WHERE family = $1 AND tgl = $2`, ['rapier', tgl]),
    deretBlock(period.where, period.params)
  ]);
  res.json({ last: b.last, tgl, first_all: all.first, last_all: all.last,
    from: period.from, to: period.to, day, period: whole });
}));
