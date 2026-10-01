/**
 * Semua: the combined monthly report and its Excel file.
 */
import { Router } from 'express';
import XLSX from 'xlsx';
import { query } from '../db.js';
import { send, AppError } from '../errors.js';
import { gabSheet, BULAN_UP } from '../gabungan-xlsx.js';
import { requireRole } from '../auth.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Semua — the combined report across every loom family
 *
 * Month by month, the way the mill's GABUNGAN sheet is laid out. Only the
 * measured figures are stored; the ratios are worked out here, the same way
 * for a day as for the month, so the total row cannot disagree with the days.
 * ------------------------------------------------------------------ */

const GAB = ['bs_pjg', 'actual_meter', 'prod100', 'pm_shuttle', 'pm_rapier', 'pm_ajl',
  'pi_shuttle', 'pi_rapier', 'pi_ajl'];

/** A column's total, or null when no day has it — 0 would claim a measurement. */
const sumOf = (rows, k) => {
  const have = rows.filter((r) => r[k] !== null && r[k] !== undefined);
  return have.length ? have.reduce((t, r) => t + Number(r[k]), 0) : null;
};
const addUp = (...vals) => (vals.every((v) => v === null || v === undefined)
  ? null : vals.reduce((t, v) => t + (Number(v) || 0), 0));

/** The sheet's derived columns, from a day's figures or a period's sums. */
function gabDerive(s) {
  const pmx = addUp(s.pm_shuttle, s.pm_rapier, s.pm_ajl);
  const pix = addUp(s.pi_shuttle, s.pi_rapier, s.pi_ajl);
  const actual = Number(s.actual_meter) || 0;
  const bs = Number(s.bs_pjg) || 0;
  const ratio = (a, b) => (a !== null && b ? a / b : null);
  return {
    ...s,
    bs_pct:          s.bs_pjg === null ? null : ratio(bs * 100, actual + bs),
    actual_pct:      ratio(actual * 100, Number(s.prod100) || 0),
    pick_mc_x_prod:  pmx,
    // Divided by the inspected metres, as the sheet does: 8.342.319,70 over
    // 159.496,25 is its 52,30 for 1 Sep.
    pick_mesin:      ratio(pmx, actual),
    pick_inspect_x_prod: pix,
    pick_inspect:    ratio(pix, actual)
  };
}

function gabPeriod(rows) {
  const sum = Object.fromEntries(GAB.map((k) => [k, sumOf(rows, k)]));
  const days = rows.length;
  const per = (k) => (sum[k] === null ? null : sum[k] / days);
  return {
    days,
    total: gabDerive(sum),
    // Per day, as the sheet's second total line has it: the lengths divided
    // by the days reported. The ratios are the same as the total's.
    avg: days ? { bs_pjg: per('bs_pjg'), actual_meter: per('actual_meter'), prod100: per('prod100') } : null
  };
}

/* ---- where the figures come from ----
 *
 * "auto" builds the report from the daily data already imported, family by
 * family. Every formula below was checked against the mill's own sheet for
 * September — to the cent, for AJL and Rapier on each day tried:
 *
 *   BS PJG             GRADE: BS + RK. The mill's "BS" is both — the AJL
 *                      quality sheet's 2.583,37 for 1 Sep is 2.107,87 + 475,50.
 *   ACTUAL (A+B)       GRADE: A + B
 *   PRODUKSI 100%      the monthly sheet's prod100%
 *   PICK MESIN/BULAN   a family's A+B × that day's average machine pick from
 *                      its monthly sheet (PICK RATA2). Not the shifts' output
 *                      × the order's pick, which ran 6–8% off.
 *   PICK KAIN INSPECT  each inspected order's A+B × its pick; where the order
 *                      header carries none, the pick of the same fabric on
 *                      another order — the sheet does the same.
 *
 * Shuttle has no daily report imported, so its columns stay empty.
 *
 * "file" reads the uploaded LAPORAN PRODUKSI GABUNGAN as it was typed.
 */

const monthBounds = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return [`${m}-01`, `${next}-01`];
};

const GAB_SOURCES = {
  file: {
    months: `SELECT DISTINCT to_char(tgl, 'YYYY-MM') AS m FROM gabungan_harian`,
    async load(m) {
      const [lo, hi] = monthBounds(m);
      return (await query(
        `SELECT tgl::text AS tgl, ${GAB.join(', ')} FROM gabungan_harian
         WHERE tgl >= $1 AND tgl < $2 ORDER BY tgl`, [lo, hi])).rows;
    }
  },
  auto: {
    months: `SELECT to_char(tgl, 'YYYY-MM') AS m FROM production
             UNION SELECT to_char(tgl, 'YYYY-MM') FROM grade`,
    async load(m) {
      const [lo, hi] = monthBounds(m);
      const { rows } = await query(`
        WITH g AS (
          SELECT g.family, g.tgl, g.bs + g.rk AS bs, g.grade_a + g.grade_b AS ab,
                 COALESCE(
                   (SELECT o.pick FROM order_info o
                     WHERE o.mo = g.mo AND o.pick IS NOT NULL
                     ORDER BY abs(o.as_of - g.tgl), o.as_of DESC LIMIT 1),
                   (SELECT o.pick FROM order_info o
                     WHERE o.kode_kain = g.kode_kain AND o.pick IS NOT NULL
                     ORDER BY abs(o.as_of - g.tgl), o.as_of DESC LIMIT 1)
                 ) AS pick
          FROM grade g
          WHERE g.tgl >= $1 AND g.tgl < $2
        ),
        fam AS (
          SELECT tgl, family, sum(bs) AS bs, sum(ab) AS ab, sum(ab * pick) AS pi,
                 COALESCE(sum(ab) FILTER (WHERE pick IS NULL), 0) AS no_pick
          FROM g GROUP BY tgl, family
        ),
        cap AS (
          SELECT tgl, family, prod100, pick_rata2
          FROM daily_capacity WHERE tgl >= $1 AND tgl < $2
        ),
        per AS (
          SELECT COALESCE(f.tgl, c.tgl) AS tgl, COALESCE(f.family, c.family) AS family,
                 f.bs, f.ab, f.pi, f.no_pick, c.prod100,
                 f.ab * c.pick_rata2 AS pm
          FROM fam f FULL JOIN cap c ON c.tgl = f.tgl AND c.family = f.family
        )
        SELECT tgl::text AS tgl,
               sum(bs) AS bs_pjg, sum(ab) AS actual_meter, sum(prod100) AS prod100,
               sum(pm) FILTER (WHERE family = 'shuttle') AS pm_shuttle,
               sum(pm) FILTER (WHERE family = 'rapier')  AS pm_rapier,
               sum(pm) FILTER (WHERE family = 'ajl')     AS pm_ajl,
               sum(pi) FILTER (WHERE family = 'shuttle') AS pi_shuttle,
               sum(pi) FILTER (WHERE family = 'rapier')  AS pi_rapier,
               sum(pi) FILTER (WHERE family = 'ajl')     AS pi_ajl,
               COALESCE(sum(no_pick), 0) AS no_pick
        FROM per GROUP BY tgl ORDER BY tgl`, [lo, hi]);
      return rows;
    }
  }
};

/** What the automatic report is built from that month, said plainly. */
async function autoCoverage(m) {
  const [lo, hi] = monthBounds(m);
  const { rows: fam } = await query(
    `SELECT family, count(DISTINCT tgl)::int AS days FROM production
     WHERE tgl >= $1 AND tgl < $2 GROUP BY family`, [lo, hi]);
  const one = async (sql) => (await query(sql, [lo, hi])).rows[0].n;
  return {
    families: Object.fromEntries(fam.map((r) => [r.family, r.days])),
    grade_days: await one('SELECT count(DISTINCT tgl)::int AS n FROM grade WHERE tgl >= $1 AND tgl < $2'),
    capacity_days: await one('SELECT count(DISTINCT tgl)::int AS n FROM daily_capacity WHERE tgl >= $1 AND tgl < $2')
  };
}

/**
 * The combined report for a month — used by the page and by the Excel export,
 * so the file can never disagree with what is on screen.
 */
async function gabReport(q) {
  // The automatic report by default once daily data exists; the uploaded
  // sheet stays available to check it against.
  const { rows: [has] } = await query(
    `SELECT EXISTS (SELECT 1 FROM production) AS daily, EXISTS (SELECT 1 FROM gabungan_harian) AS file`);
  const source = ['auto', 'file'].includes(q.source) ? q.source
    : has.daily ? 'auto' : 'file';
  const src = GAB_SOURCES[source];

  const { rows: months } = await query(`SELECT m FROM (${src.months}) x ORDER BY m DESC`);
  const list = months.map((r) => r.m);
  const month = /^\d{4}-\d{2}$/.test(String(q.month)) && list.includes(q.month)
    ? q.month : list[0];
  const sources = { auto: has.daily, file: has.file };
  if (!month) return { source, sources, months: [], month: null, rows: [] };

  const [y, mo] = month.split('-').map(Number);
  const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const rows = await src.load(month);
  let prevRows = await src.load(prevMonth);
  // In the automatic report a month only stands as a comparison when its
  // daily reports were imported. September's workbooks carry some of
  // August's grade lines, and totalling those scraps put a 136% efficiency
  // and a pick of 15 under "RATA² BULAN AGUSTUS" as if they were the month.
  let prevSkipped = null;
  if (source === 'auto' && prevRows.length) {
    const { families } = await autoCoverage(prevMonth);
    if (!Object.keys(families).length) { prevSkipped = prevMonth; prevRows = []; }
  }
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();

  return {
    source,
    sources,
    months: list,
    month,
    days_in_month: daysInMonth,
    rows: rows.map(gabDerive),
    ...gabPeriod(rows),
    no_pick: source === 'auto' ? rows.reduce((t, r) => t + Number(r.no_pick || 0), 0) : null,
    coverage: source === 'auto' ? await autoCoverage(month) : null,
    prev: prevRows.length ? { month: prevMonth, ...gabPeriod(prevRows) } : null,
    prev_skipped: prevSkipped
  };
}

router.get('/api/gabungan', (req, res) => send(res, async () => {
  res.json(await gabReport(req.query));
}));

/* ---- Semua as a workbook ----
 *
 * Laid out as the mill's LAPORAN PRODUKSI GABUNGAN is printed: title, the two
 * merged header rows, a line per day, the two-line total block, the days
 * left, and the previous month underneath. Measured figures are written as
 * numbers and everything derived from them as Excel formulas, so a figure
 * corrected in the file recalculates its percentages and picks the way the
 * mill's own sheet does. Each formula also carries the value the dashboard
 * computed, so a viewer that does not recalculate still shows the numbers.
 *
 * Colours, bold and borders are not written: the free SheetJS build cannot.
 */

router.get('/api/gabungan.xlsx', requireRole('operator'), (req, res) => send(res, async () => {
  const g = await gabReport(req.query);
  if (!g.month) throw new AppError('Belum ada data untuk laporan gabungan.', 404);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, gabSheet(g), 'GABUNGAN');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const [y, m] = g.month.split('-').map(Number);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="LAPORAN PRODUKSI GABUNGAN ${BULAN_UP[m - 1]} ${y}.xlsx"`);
  res.send(buf);
}));
