/**
 * Semua: the combined monthly report.
 */
import { $, $$ } from '../core/dom.js';
import { FAMILY_LABEL } from './family.js';
import { isCurrent, state, takeTicket, toLogin } from '../core/state.js';
import { fmt } from '../charts/core.js';
import { columnChart } from '../charts/bars.js';
import { daysIn } from '../core/dates.js';
import { lineChart } from '../charts/line.js';
import { tile } from '../ui/tiles.js';

/* ------------------------------------------------------------------ *
 * Semua — the combined monthly report across every loom family
 *
 * The server sends the measured figures and the ratios worked out from them;
 * this only lays them out the way the mill's GABUNGAN sheet does.
 * ------------------------------------------------------------------ */

export const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
  'September', 'Oktober', 'November', 'Desember'];
export const monthName = (ym) => { const [y, m] = ym.split('-'); return `${BULAN[Number(m) - 1]} ${y}`; };

// Two decimals throughout, as the sheet prints them: 52,30 and 2,82%.
export const f2 = (n) => (n === null || n === undefined || isNaN(n) ? '—'
  : Number(n).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const p2 = (n) => (n === null || n === undefined || isNaN(n) ? '—' : `${f2(n)}%`);

// Dates as the sheet prints them — Excel's d-mmm, so 1-Sep, not 1 Sep.
export const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const sheetDay = (iso) => `${Number(iso.slice(8, 10))}-${MON3[Number(iso.slice(5, 7)) - 1]}`;

export const gc = (v, cls = '') => `<td class="num${cls ? ` ${cls}` : ''}">${v}</td>`;

/** One day, in the sheet's seventeen columns. */
export const gabDayRow = (r) => `<tr>
  <td class="gab-date">${sheetDay(r.tgl)}</td>
  ${gc(f2(r.bs_pjg))}${gc(p2(r.bs_pct))}
  ${gc(f2(r.actual_meter), 'b')}${gc(p2(r.actual_pct))}
  ${gc(f2(r.prod100), 'b')}${gc(f2(r.pick_mesin))}
  ${gc(f2(r.pm_shuttle))}${gc(f2(r.pm_rapier))}${gc(f2(r.pm_ajl))}${gc(f2(r.pick_mesin))}${gc(f2(r.pick_mc_x_prod))}
  ${gc(f2(r.pi_shuttle))}${gc(f2(r.pi_rapier))}${gc(f2(r.pi_ajl))}${gc(f2(r.pick_inspect_x_prod))}
  ${gc(f2(r.pick_inspect), 'gab-green')}
</tr>`;

/**
 * The sheet's total block, two lines:
 *   days so far (red) | totals          | the two ratios and the pick span both lines
 *   days in month     | per-day average | RATA-RATA PICK GABUNGAN … | PICK GABUNGAN PICK KAIN INSPECT
 * The averages divide by the days reported, not the days in the month —
 * 136.827,13 over 24 is the sheet's 5.701,13.
 */
export const gabBlock = (p, dim) => {
  const t = p.total;
  const a = p.avg || {};
  return `<tr class="gab-tot">
    <td class="gab-days">${p.days}</td>
    ${gc(f2(t.bs_pjg), 'b')}
    <td class="num b gab-mid" rowspan="2">${p2(t.bs_pct)}</td>
    ${gc(f2(t.actual_meter), 'b')}
    <td class="num b gab-mid" rowspan="2">${p2(t.actual_pct)}</td>
    ${gc(f2(t.prod100), 'b')}
    <td class="num b gab-mid" rowspan="2">${f2(t.pick_mesin)}</td>
    ${gc(f2(t.pm_shuttle), 'b')}${gc(f2(t.pm_rapier), 'b')}${gc(f2(t.pm_ajl), 'b')}
    <td class="num b" colspan="2">${f2(t.pick_mc_x_prod)}</td>
    ${gc(f2(t.pi_shuttle), 'b gab-green')}${gc(f2(t.pi_rapier), 'b gab-green')}${gc(f2(t.pi_ajl), 'b gab-green')}
    ${gc(f2(t.pick_inspect_x_prod), 'b gab-yellow')}
    <td class="gab-blank"></td>
  </tr>
  <tr class="gab-tot">
    <td class="gab-dim">${dim}</td>
    ${gc(f2(a.bs_pjg), 'b')}
    ${gc(f2(a.actual_meter), 'b')}
    ${gc(f2(a.prod100), 'b')}
    <td class="gab-label" colspan="3">RATA-RATA PICK GABUNGAN ( BERDASARKAN MESIN )</td>
    <td class="num b gab-big" colspan="2">${f2(t.pick_mesin)}</td>
    <td class="gab-label gab-green" colspan="3">PICK GABUNGAN PICK KAIN INSPECT</td>
    ${gc(f2(t.pick_inspect), 'b gab-big gab-green')}
    <td class="gab-blank"></td>
  </tr>`;
};

export async function loadGabungan() {
  const ticket = takeTicket('gabungan');
  const q = {};
  if (state.gabMonth) q.month = state.gabMonth;
  if (state.gabSource) q.source = state.gabSource;
  const res = await fetch(`/api/gabungan?${new URLSearchParams(q)}`);
  if (res.status === 401) return toLogin();
  const g = await res.json();
  if (!isCurrent('gabungan', ticket)) return;

  // The switch shows even on an empty month, so the other source stays reachable.
  state.gabSource = g.source;
  $$('#gabSource .seg').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.src === g.source);
    b.disabled = !g.sources?.[b.dataset.src];
  });

  $('#gabEmpty').hidden = !!g.month;
  $('#gabBody').hidden = !g.month;
  if (!g.month) return;

  state.gabMonth = g.month;
  $('#gabMonth').innerHTML = g.months
    .map((m) => `<option value="${m}"${m === g.month ? ' selected' : ''}>${monthName(m)}</option>`).join('');
  // The file is built from the same report as this page, month and source included.
  $('#gabExport') && ($('#gabExport').href =
    `/api/gabungan.xlsx?${new URLSearchParams({ month: g.month, source: g.source })}`);

  const [gy, gm] = g.month.split('-');
  $('#gabTitle').textContent =
    `LAPORAN PRODUKSI GABUNGAN ${BULAN[Number(gm) - 1].toUpperCase()} TAHUN ${gy}`;

  // Say what the automatic figures rest on, and what they cannot include.
  const notes = [g.source === 'auto'
    ? 'Disusun otomatis dari laporan harian yang sudah diimport.'
    : 'Angka dari file LAPORAN PRODUKSI GABUNGAN yang diupload.'];
  if (g.source === 'auto' && g.coverage) {
    const c = g.coverage;
    const fams = ['ajl', 'rapier', 'shuttle'].map((f) =>
      `${FAMILY_LABEL[f]} ${c.families[f] ? `${c.families[f]} hari` : 'belum ada'}`).join(', ');
    notes.push(`Laporan harian: ${fams}. Grade (BS, A+B): ${c.grade_days} hari. ` +
      `Produksi 100%: ${c.capacity_days} hari.`);
    if (g.no_pick > 0) {
      notes.push(`${fmt.int(g.no_pick)} m kain inspect tidak masuk Pick kain inspect: ` +
        'ordernya tidak punya PICK, dan kain yang sama tidak tercatat di order lain.');
    }
    notes.push(c.families.shuttle
      ? 'Kolom Shuttle kosong: belum ada laporan kualitas Shuttle. Hasil mesinnya ada di kartu Shuttle di bawah.'
      : 'Kolom Shuttle kosong sampai laporan harian Shuttle diimport.');
  }
  if (g.prev_skipped) {
    notes.push(`Blok RATA² BULAN ${BULAN[Number(g.prev_skipped.slice(5)) - 1].toUpperCase()} belum ` +
      'ditampilkan: laporan harian bulan itu belum diimport.');
  }
  $('#gabNote').textContent = notes.join(' ');

  const t = g.total;
  const prev = g.prev;
  const vsPrev = (now, before, unit = '') => {
    if (!prev || before === null || before === undefined || now === null) return '';
    const d = now - before;
    return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${f2(Math.abs(d))}${unit}</span> vs ${BULAN[Number(prev.month.slice(5)) - 1]}`;
  };
  $('#gabStats').innerHTML = [
    // Whole metres in the tiles: the decimals are in the table, and at seven
    // digits they no longer fit a tile on a phone.
    tile('Actual hasil kain', fmt.int(t.actual_meter), 'm',
      `rata-rata ${fmt.int(g.avg.actual_meter)} m/hari`),
    tile('Efisiensi', p2(t.actual_pct), '',
      vsPrev(t.actual_pct, prev?.total.actual_pct, ' poin') || `dari ${fmt.int(t.prod100)} m produksi 100%`),
    tile('BS', fmt.int(t.bs_pjg), 'm', `${p2(t.bs_pct)} ${vsPrev(t.bs_pct, prev?.total.bs_pct, ' poin')}`),
    tile('Pick gabungan (mesin)', f2(t.pick_mesin), '', vsPrev(t.pick_mesin, prev?.total.pick_mesin)),
    tile('Pick kain inspect', f2(t.pick_inspect), '', vsPrev(t.pick_inspect, prev?.total.pick_inspect))
  ].join('');

  const left = g.days - g.days_in_month;
  $('#gabTable tbody').innerHTML = g.rows.map(gabDayRow).join('');
  $('#gabTable tfoot').innerHTML = [
    '<tr class="gab-gap"><td colspan="17"></td></tr>',
    gabBlock(g, g.days_in_month),
    `<tr class="gab-left"><td colspan="17">${left} &lt;sisa hari</td></tr>`,
    ...(prev ? [
      `<tr class="gab-prev"><td colspan="17">RATA² BULAN ${BULAN[Number(prev.month.slice(5)) - 1].toUpperCase()}</td></tr>`,
      gabBlock(prev, daysIn(prev.month))
    ] : [])
  ].join('');

  columnChart($('#gabChart'), g.rows, {
    x: (d) => d.tgl,
    y: (d) => Number(d.actual_meter),
    unit: ' m',
    height: 230,
    band: (d) => (d.prod100 ? [Number(d.prod100) * 0.9, Number(d.prod100)] : null),
    labels: (d) => [fmt.int(d.actual_meter), d.actual_pct !== null ? fmt.pct(d.actual_pct) : null],
    tipRows: (d) => [
      ['Actual (A+B)', fmt.num(d.actual_meter) + ' m'],
      ['Produksi 100%', fmt.num(d.prod100) + ' m'],
      ['Efisiensi', p2(d.actual_pct)],
      ['BS', `${fmt.num(d.bs_pjg)} m · ${p2(d.bs_pct)}`],
      ['Pick mesin', f2(d.pick_mesin)]
    ]
  });

  // The daily ratios, each against its month's own figure.
  const trend = (host, key, { unit = '', zero = false, label } = {}) => lineChart($(host), g.rows, {
    x: (d) => d.tgl,
    y: (d) => (d[key] === null || d[key] === undefined ? null : Number(d[key])),
    format: f2,
    unit,
    height: 200,
    baseZero: zero,
    // The month's own figure, as a line the days are read against.
    reference: t[key] === null || t[key] === undefined ? null : Number(t[key]),
    referenceLabel: t[key] === null || t[key] === undefined ? '' : `${label} ${f2(t[key])}${unit}`,
    tipRows: (d) => [
      [sheetDay(d.tgl), `${f2(d[key])}${unit}`],
      ['Actual (A+B)', `${f2(d.actual_meter)} m`],
      ['Produksi 100%', `${f2(d.prod100)} m`]
    ]
  });
  trend('#gabEffChart', 'actual_pct', { unit: '%', label: 'bulan ini' });
  trend('#gabBsChart', 'bs_pct', { unit: '%', zero: true, label: 'bulan ini' });
  trend('#gabPickChart', 'pick_mesin', { label: 'rata-rata' });
  trend('#gabPiChart', 'pick_inspect', { label: 'rata-rata' });

  paintShuttle(g.shuttle, g.month);
}

/**
 * Shuttle's own output for the month: METER against PRODUKSI 100% at the
 * shed's RPM. Beside the report, not in it — see the note it carries.
 */
function paintShuttle(s, month) {
  // Shown even without data, so a month with no shuttle report says so
  // rather than leaving the shed out without a word.
  if (!s) {
    $('#gabShuttleSub').textContent = `Belum ada laporan Shuttle untuk ${monthName(month)}.`;
    $('#gabShuttleChart').innerHTML = '';
    $('#gabShuttleNote').textContent = '';
    return;
  }
  const t = s.total;
  $('#gabShuttleSub').textContent = `${fmt.int(t.meter)} m dari produksi 100% ${fmt.int(t.prod100)} m · ` +
    `efisiensi ${p2(t.eff)} · ${fmt.int(t.machines)} mesin · ${t.days} hari`;
  lineChart($('#gabShuttleChart'), s.days, {
    x: (d) => d.tgl,
    y: (d) => d.eff,
    format: f2,
    unit: '%',
    height: 200,
    baseZero: false,
    reference: t.eff,
    referenceLabel: t.eff === null ? '' : `bulan ini ${p2(t.eff)}`,
    tipRows: (d) => [
      [sheetDay(d.tgl), p2(d.eff)],
      ['Meter', `${f2(d.meter)} m`],
      ['Produksi 100%', `${f2(d.prod100)} m`]
    ]
  });
  $('#gabShuttleNote').textContent = 'Tidak masuk total gabungan di atas, sama seperti sheet pabrik.' +
    (s.no_meter ? ` ${fmt.int(s.no_meter)} shift ada sodokannya tapi METER-nya 0 (tabel SODOKAN belum lengkap).` : '');
}

$('#gabMonth').addEventListener('change', (e) => { state.gabMonth = e.target.value; loadGabungan(); });
$('#gabSource').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]');
  if (!b || b.disabled || b.dataset.src === state.gabSource) return;
  // The two sources cover different months, so the month is picked afresh.
  state.gabSource = b.dataset.src;
  state.gabMonth = '';
  loadGabungan();
});
