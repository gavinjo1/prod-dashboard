import XLSX from 'xlsx';

export const BULAN_UP = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS',
  'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
const GZ = { num: '#,##0.00', pct: '0.00%', day: 'd-mmm', int: '0' };
const FAMILY_UP = { ajl: 'AJL', rapier: 'RAPIER', shuttle: 'SHUTTLE' };

/**
 * Semua as one sheet, laid out as the page: a line per day — each family's
 * output, the total, PRODUKSI 100% and the efficiency — then the month's
 * total, the per-day average, and the month before for comparison.
 *
 * Output and capacity are written as numbers and the total and TOTAL lines as
 * formulas over them. Efficiency is the dashboard's figure as a number: it is
 * counted on the shifts that can be priced only, which the sheet cannot see.
 * Colours, bold and borders are not written: the free SheetJS build cannot.
 */
export function semuaSheet(g) {
  const ws = {};
  const merges = [];
  const at = (r, c) => XLSX.utils.encode_cell({ r, c });
  const ref = (c, r) => `${XLSX.utils.encode_col(c)}${r + 1}`;
  const text = (r, c, v) => { ws[at(r, c)] = { t: 's', v }; };
  const num = (r, c, v, z = GZ.num) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return;
    ws[at(r, c)] = { t: 'n', v: Number(v), z };
  };
  const fx = (r, c, f, cached, z = GZ.num) => {
    const ok = cached !== null && cached !== undefined && !Number.isNaN(Number(cached));
    ws[at(r, c)] = ok ? { t: 'n', v: Number(cached), f, z } : { t: 's', v: '', f };
  };
  const pct = (v) => (v === null || v === undefined ? null : Number(v) / 100);

  const fams = g.families;
  const TGL = 0;
  const FAM = Object.fromEntries(fams.map((f, i) => [f, 1 + i]));
  const TOT = 1 + fams.length, PROD = TOT + 1, EFF = TOT + 2;
  const LAST = EFF;

  const [y, m] = g.month.split('-').map(Number);
  text(0, 0, `LAPORAN PRODUKSI GABUNGAN ${BULAN_UP[m - 1]} TAHUN ${y}`);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST } });
  text(1, 0, 'Output mesin (counter) per hari, sama dengan tab Produksi tiap jenis mesin');
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST } });

  const H = 3;
  text(H, TGL, 'TGL');
  for (const f of fams) text(H, FAM[f], `${FAMILY_UP[f] ?? f} (m)`);
  text(H, TOT, 'TOTAL (m)');
  text(H, PROD, 'PRODUKSI 100% (m)');
  text(H, EFF, 'EFISIENSI');

  const FIRST = H + 1;
  g.rows.forEach((d, i) => {
    const r = FIRST + i;
    const [dy, dm, dd] = d.tgl.split('-').map(Number);
    num(r, TGL, Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(1899, 11, 30)) / 86400000), GZ.day);
    for (const f of fams) num(r, FAM[f], d.fam[f]?.meter);
    fx(r, TOT, `SUM(${ref(FAM[fams[0]], r)}:${ref(FAM[fams[fams.length - 1]], r)})`, d.meter);
    num(r, PROD, d.prod100);
    num(r, EFF, pct(d.eff), GZ.pct);
  });
  const LASTDAY = FIRST + g.rows.length - 1;

  // TOTAL as formulas over the days above; RATA-RATA over the days reported.
  const T = LASTDAY + 2;
  text(T, TGL, 'TOTAL');
  const sumCol = (c, cached) => fx(T, c, `IF(COUNT(${ref(c, FIRST)}:${ref(c, LASTDAY)})=0,"",SUM(${ref(c, FIRST)}:${ref(c, LASTDAY)}))`, cached);
  for (const f of fams) sumCol(FAM[f], g.total.fam[f]?.meter);
  sumCol(TOT, g.total.meter);
  sumCol(PROD, g.total.prod100);
  num(T, EFF, pct(g.total.eff), GZ.pct);
  text(T + 1, TGL, `RATA-RATA/HARI (${g.days} hari)`);
  for (const f of fams) num(T + 1, FAM[f], g.avg.fam[f]?.meter);
  num(T + 1, TOT, g.avg.meter);
  num(T + 1, PROD, g.avg.prod100);

  let end = T + 1;
  if (g.prev) {
    const [, pm] = g.prev.month.split('-').map(Number);
    const P = T + 3;
    text(P, TGL, `BULAN ${BULAN_UP[pm - 1]} (${g.prev.days} hari)`);
    for (const f of fams) num(P, FAM[f], g.prev.total.fam[f]?.meter);
    num(P, TOT, g.prev.total.meter);
    num(P, PROD, g.prev.total.prod100);
    num(P, EFF, pct(g.prev.total.eff), GZ.pct);
    text(P + 1, TGL, 'RATA-RATA/HARI');
    for (const f of fams) num(P + 1, FAM[f], g.prev.avg.fam[f]?.meter);
    num(P + 1, TOT, g.prev.avg.meter);
    num(P + 1, PROD, g.prev.avg.prod100);
    end = P + 1;
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: end, c: LAST } });
  ws['!merges'] = merges;
  ws['!cols'] = [22, ...fams.map(() => 14), 15, 18, 11].map((wch) => ({ wch }));
  return ws;
}
