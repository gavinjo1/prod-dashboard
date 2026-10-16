/**
 * Semua: every loom family's daily output side by side, and its Excel file.
 */
import { Router } from 'express';
import XLSX from 'xlsx';
import { query } from '../db.js';
import { send, AppError } from '../errors.js';
import { semuaSheet, BULAN_UP } from '../gabungan-xlsx.js';
import { requireRole } from '../auth.js';
import { pricedShifts } from '../lib/formulas.js';
import { FAMILIES } from '../importer/index.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Semua — the families' output together, month by month
 *
 * Built from the shifts themselves, the same figures as each family's
 * Produksi tab: the metres woven (the counter), against PRODUKSI 100% — what
 * the looms could weave at their RPM target, the Produksi tab's capability.
 * Efficiency is output over capability on the shifts that can be priced (a
 * shift with no pick or RPM target has no capability, so its output is left
 * out of both sides), as on the Produksi tab.
 *
 * Grade (A+B, BS, pick inspect) is not part of it. The quality report is
 * still imported and stored; it is just not what this page shows.
 * ------------------------------------------------------------------ */

const monthBounds = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return [`${m}-01`, `${next}-01`];
};
const prevMonthOf = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};
const n = (v) => (v === null || v === undefined ? null : Number(v));
const add = (a, b) => (a === null ? b : b === null ? a : a + b);
const eff = (priced, cap) => (cap ? (priced * 100) / cap : null);

/** Each day of a month with output: per family, and all families together. */
async function monthDays(m) {
  const [lo, hi] = monthBounds(m);
  const { rows } = await query(`
    WITH ${pricedShifts(`WHERE p.tgl >= $1 AND p.tgl < $2`)}
    SELECT tgl::text AS tgl, family,
           count(*)::int                          AS shifts,
           sum(produksi)                          AS meter,
           sum(capability) FILTER (WHERE priced)  AS prod100,
           sum(produksi)   FILTER (WHERE priced)  AS priced
    FROM r GROUP BY 1, 2 ORDER BY 1`, [lo, hi]);
  const days = new Map();
  for (const r of rows) {
    const d = days.get(r.tgl) ?? { tgl: r.tgl, fam: {} };
    d.fam[r.family] = { shifts: r.shifts, meter: n(r.meter), prod100: n(r.prod100), priced: n(r.priced) };
    days.set(r.tgl, d);
  }
  return [...days.values()].map(summed);
}

/** A day's or a period's family figures, added up across families, with the ratios. */
function summed(d) {
  let meter = null, prod100 = null, priced = null;
  for (const f of FAMILIES) {
    const x = d.fam[f];
    if (!x) continue;
    x.eff = eff(x.priced ?? 0, x.prod100);
    meter = add(meter, x.meter);
    prod100 = add(prod100, x.prod100);
    priced = add(priced, x.priced);
  }
  return { ...d, meter, prod100, priced, eff: eff(priced ?? 0, prod100) };
}

/** The month as a whole: totals, and per day over the days with output. */
function period(rows) {
  const fam = {};
  for (const f of FAMILIES) {
    const have = rows.filter((d) => d.fam[f]);
    if (!have.length) continue;
    const s = (k) => have.reduce((t, d) => add(t, d.fam[f][k]), null);
    fam[f] = { days: have.length, meter: s('meter'), prod100: s('prod100'), priced: s('priced'), shifts: s('shifts') };
  }
  const total = summed({ fam });
  const days = rows.length;
  const per = (v) => (v === null || !days ? null : v / days);
  return {
    days,
    total,
    // Per day over the days reported, not the days in the month.
    avg: { meter: per(total.meter), prod100: per(total.prod100),
      fam: Object.fromEntries(Object.entries(fam).map(([f, x]) => [f, { meter: x.meter / x.days }])) }
  };
}

async function semuaReport(q) {
  const { rows: months } = await query(
    `SELECT DISTINCT to_char(tgl, 'YYYY-MM') AS m FROM production ORDER BY m DESC`);
  const list = months.map((r) => r.m);
  const month = /^\d{4}-\d{2}$/.test(String(q.month)) && list.includes(q.month) ? q.month : list[0];
  if (!month) return { months: [], month: null, rows: [] };

  const [y, mo] = month.split('-').map(Number);
  const rows = await monthDays(month);
  const prevMonth = prevMonthOf(month);
  const prevRows = list.includes(prevMonth) ? await monthDays(prevMonth) : [];
  return {
    families: FAMILIES,
    months: list,
    month,
    days_in_month: new Date(Date.UTC(y, mo, 0)).getUTCDate(),
    rows,
    ...period(rows),
    prev: prevRows.length ? { month: prevMonth, ...period(prevRows) } : null
  };
}

router.get('/api/gabungan', (req, res) => send(res, async () => {
  res.json(await semuaReport(req.query));
}));

/* ---- Semua as a workbook: the page's table, the same figures ---- */

router.get('/api/gabungan.xlsx', requireRole('operator'), (req, res) => send(res, async () => {
  const g = await semuaReport(req.query);
  if (!g.month) throw new AppError('Belum ada data untuk laporan gabungan.', 404);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, semuaSheet(g), 'GABUNGAN');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const [y, m] = g.month.split('-').map(Number);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="LAPORAN PRODUKSI GABUNGAN ${BULAN_UP[m - 1]} ${y}.xlsx"`);
  res.send(buf);
}));
