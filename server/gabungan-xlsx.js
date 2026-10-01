import XLSX from 'xlsx';

export const BULAN_UP = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS',
  'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
const GZ = { num: '#,##0.00', pct: '0.00%', pick: '0.00', day: 'd-mmm', int: '0' };

export function gabSheet(g) {
  const ws = {};
  const merges = [];
  const col = (c) => XLSX.utils.encode_col(c);
  const at = (r, c) => XLSX.utils.encode_cell({ r, c });
  const ref = (c, r) => `${col(c)}${r + 1}`;          // A1 notation of a 0-based cell
  const merge = (r1, c1, r2, c2) => merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });

  const text = (r, c, v) => { ws[at(r, c)] = { t: 's', v }; };
  const num = (r, c, v, z = GZ.num) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return;
    ws[at(r, c)] = { t: 'n', v: Number(v), z };
  };
  // A formula with the dashboard's own result cached beside it.
  const fx = (r, c, f, cached, z = GZ.num) => {
    const ok = cached !== null && cached !== undefined && !Number.isNaN(Number(cached));
    ws[at(r, c)] = ok ? { t: 'n', v: Number(cached), f, z } : { t: 's', v: '', f };
  };
  const pct = (v) => (v === null || v === undefined ? null : Number(v) / 100);

  // Columns, as on the sheet.
  const TGL = 0, BS = 1, BSP = 2, ACT = 3, ACTP = 4, PROD = 5, PICK = 6,
    PMS = 7, PMR = 8, PMA = 9, PMC = 10, PMX = 11, PIS = 12, PIR = 13, PIA = 14, PIX = 15, PIH = 16;
  const LAST = PIH;

  const [y, m] = g.month.split('-').map(Number);
  text(0, 0, `LAPORAN PRODUKSI GABUNGAN ${BULAN_UP[m - 1]} TAHUN ${y}`); merge(0, 0, 0, LAST);
  text(1, 0, 'SHUTTLE - RAPIER - AJL TOYOTA ( AJL TOYOTA LAMA + AJL TOYOTA BARU )'); merge(1, 0, 1, LAST);

  // Header, two rows.
  const H1 = 3, H2 = 4;
  text(H1, TGL, 'TGL'); merge(H1, TGL, H2, TGL);
  text(H1, BS, 'BS'); merge(H1, BS, H1, BSP);
  text(H1, ACT, 'ACTUAL HASIL KAIN GABUNGAN (A+B)'); merge(H1, ACT, H1, ACTP);
  text(H1, PROD, 'PRODUKSI');
  text(H1, PICK, 'PICK MESIN'); merge(H1, PICK, H2, PICK);
  text(H1, PMS, 'PICK MESIN/BULAN'); merge(H1, PMS, H1, PMX);
  text(H1, PIS, 'PICK KAIN INSPECT/BULAN'); merge(H1, PIS, H1, PIX);
  text(H1, PIH, 'PICK INSPECT PERHARI'); merge(H1, PIH, H2, PIH);
  [[BS, 'PJG'], [BSP, '%'], [ACT, 'METER'], [ACTP, '%'], [PROD, '100%'],
   [PMS, 'SHUTTLE'], [PMR, 'RAPIER'], [PMA, 'AJL'], [PMC, 'PICK MC'], [PMX, 'PICK MC X PROD'],
   [PIS, 'SHUTTLE'], [PIR, 'RAPIER'], [PIA, 'AJL 1+2+3+4'], [PIX, 'PICK KAIN INSPECT X PROD']]
    .forEach(([c, v]) => text(H2, c, v));

  // One line per day. Blank stays blank: a day without a figure is not a 0.
  const FIRST = 5;
  const sumIfAny = (c, r1, r2) =>
    `IF(COUNT(${ref(c, r1)}:${ref(c, r2)})=0,"",SUM(${ref(c, r1)}:${ref(c, r2)}))`;
  g.rows.forEach((d, i) => {
    const r = FIRST + i;
    const [dy, dm, dd] = d.tgl.split('-').map(Number);
    num(r, TGL, Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(1899, 11, 30)) / 86400000), GZ.day);
    num(r, BS, d.bs_pjg);
    fx(r, BSP, `IFERROR(${ref(BS, r)}/(${ref(ACT, r)}+${ref(BS, r)}),"")`, pct(d.bs_pct), GZ.pct);
    num(r, ACT, d.actual_meter);
    fx(r, ACTP, `IFERROR(${ref(ACT, r)}/${ref(PROD, r)},"")`, pct(d.actual_pct), GZ.pct);
    num(r, PROD, d.prod100);
    fx(r, PICK, `IFERROR(${ref(PMX, r)}/${ref(ACT, r)},"")`, d.pick_mesin, GZ.pick);
    num(r, PMS, d.pm_shuttle); num(r, PMR, d.pm_rapier); num(r, PMA, d.pm_ajl);
    fx(r, PMC, ref(PICK, r), d.pick_mesin, GZ.pick);
    fx(r, PMX, `IF(COUNT(${ref(PMS, r)}:${ref(PMA, r)})=0,"",SUM(${ref(PMS, r)}:${ref(PMA, r)}))`,
      d.pick_mc_x_prod);
    num(r, PIS, d.pi_shuttle); num(r, PIR, d.pi_rapier); num(r, PIA, d.pi_ajl);
    fx(r, PIX, `IF(COUNT(${ref(PIS, r)}:${ref(PIA, r)})=0,"",SUM(${ref(PIS, r)}:${ref(PIA, r)}))`,
      d.pick_inspect_x_prod);
    fx(r, PIH, `IFERROR(${ref(PIX, r)}/${ref(ACT, r)},"")`, d.pick_inspect, GZ.pick);
  });
  const LASTDAY = FIRST + g.rows.length - 1;

  /**
   * The two-line total block. Over the days above it is formulas; for the
   * previous month, which has no day lines here, it is the figures themselves
   * with the ratios still as formulas.
   */
  const block = (r1, p, dim, fromDays) => {
    const r2 = r1 + 1;
    const t = p.total;
    const a = p.avg || {};
    const total = (c, value) => (fromDays
      ? fx(r1, c, sumIfAny(c, FIRST, LASTDAY), value)
      : num(r1, c, value));

    num(r1, TGL, p.days, GZ.int);
    total(BS, t.bs_pjg);
    fx(r1, BSP, `IFERROR(${ref(BS, r1)}/(${ref(ACT, r1)}+${ref(BS, r1)}),"")`, pct(t.bs_pct), GZ.pct);
    merge(r1, BSP, r2, BSP);
    total(ACT, t.actual_meter);
    fx(r1, ACTP, `IFERROR(${ref(ACT, r1)}/${ref(PROD, r1)},"")`, pct(t.actual_pct), GZ.pct);
    merge(r1, ACTP, r2, ACTP);
    total(PROD, t.prod100);
    // The total pick sits in the merged PICK MC cell, so it is read from there.
    fx(r1, PICK, `IFERROR(${ref(PMC, r1)}/${ref(ACT, r1)},"")`, t.pick_mesin, GZ.pick);
    merge(r1, PICK, r2, PICK);
    total(PMS, t.pm_shuttle); total(PMR, t.pm_rapier); total(PMA, t.pm_ajl);
    if (fromDays) fx(r1, PMC, sumIfAny(PMX, FIRST, LASTDAY), t.pick_mc_x_prod);
    else num(r1, PMC, t.pick_mc_x_prod);
    merge(r1, PMC, r1, PMX);
    total(PIS, t.pi_shuttle); total(PIR, t.pi_rapier); total(PIA, t.pi_ajl);
    total(PIX, t.pick_inspect_x_prod);

    // Per day: divided by the days reported, as the sheet's 136.827,13 / 24.
    num(r2, TGL, dim, GZ.int);
    fx(r2, BS, `IFERROR(${ref(BS, r1)}/${ref(TGL, r1)},"")`, a.bs_pjg);
    fx(r2, ACT, `IFERROR(${ref(ACT, r1)}/${ref(TGL, r1)},"")`, a.actual_meter);
    fx(r2, PROD, `IFERROR(${ref(PROD, r1)}/${ref(TGL, r1)},"")`, a.prod100);
    text(r2, PMS, 'RATA-RATA PICK GABUNGAN ( BERDASARKAN MESIN )'); merge(r2, PMS, r2, PMA);
    fx(r2, PMC, ref(PICK, r1), t.pick_mesin, GZ.pick); merge(r2, PMC, r2, PMX);
    text(r2, PIS, 'PICK GABUNGAN PICK KAIN INSPECT'); merge(r2, PIS, r2, PIA);
    fx(r2, PIX, `IFERROR(${ref(PIX, r1)}/${ref(ACT, r1)},"")`, t.pick_inspect, GZ.pick);
    return r2;
  };

  const T1 = LASTDAY + 2;
  const T2 = block(T1, g, g.days_in_month, true);
  // "-6 <sisa hari": the days reported less the days in the month.
  fx(T2 + 1, TGL, `${ref(TGL, T1)}-${ref(TGL, T2)}`, g.days - g.days_in_month, GZ.int);
  text(T2 + 1, BS, '<sisa hari');

  let end = T2 + 1;
  if (g.prev) {
    const [py, pm] = g.prev.month.split('-').map(Number);
    text(T2 + 3, TGL, `RATA" BULAN ${BULAN_UP[pm - 1]}`);
    end = block(T2 + 4, g.prev, new Date(Date.UTC(py, pm, 0)).getUTCDate(), false);
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: end, c: LAST } });
  ws['!merges'] = merges;
  ws['!cols'] = [8, 11, 8, 13, 8, 13, 9, 14, 14, 14, 9, 15, 14, 14, 14, 17, 10].map((wch) => ({ wch }));
  return ws;
}
