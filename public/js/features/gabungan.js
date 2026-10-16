/**
 * Semua: every loom family's daily output side by side.
 */
import { $ } from '../core/dom.js';
import { FAMILY_LABEL } from './family.js';
import { isCurrent, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { daysIn } from '../core/dates.js';
import { lineChart } from '../charts/line.js';
import { tile } from '../ui/tiles.js';

/* ------------------------------------------------------------------ *
 * Semua — the families' output together, month by month
 *
 * The server sends each day's metres per family (the counter, as on each
 * family's Produksi tab), PRODUKSI 100% and the efficiency; this lays them
 * out a line per day, with the month's total and the month before.
 * ------------------------------------------------------------------ */

export const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
  'September', 'Oktober', 'November', 'Desember'];
export const monthName = (ym) => { const [y, m] = ym.split('-'); return `${BULAN[Number(m) - 1]} ${y}`; };

// Two decimals throughout, as the mill's sheets print them: 52,30 and 2,82%.
export const f2 = (n) => (n === null || n === undefined || isNaN(n) ? '—'
  : Number(n).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const p2 = (n) => (n === null || n === undefined || isNaN(n) ? '—' : `${f2(n)}%`);

// Dates as the sheets print them — Excel's d-mmm, so 1-Sep, not 1 Sep.
export const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const sheetDay = (iso) => `${Number(iso.slice(8, 10))}-${MON3[Number(iso.slice(5, 7)) - 1]}`;

const gc = (v, cls = '', title = '') => `<td class="num${cls ? ` ${cls}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${v}</td>`;

export async function loadGabungan() {
  const ticket = takeTicket('gabungan');
  const res = await fetch(`/api/gabungan?${new URLSearchParams(state.gabMonth ? { month: state.gabMonth } : {})}`);
  if (res.status === 401) return toLogin();
  const g = await res.json();
  if (!isCurrent('gabungan', ticket)) return;

  $('#gabEmpty').hidden = !!g.month;
  $('#gabBody').hidden = !g.month;
  if (!g.month) return;

  state.gabMonth = g.month;
  $('#gabMonth').innerHTML = g.months
    .map((m) => `<option value="${m}"${m === g.month ? ' selected' : ''}>${monthName(m)}</option>`).join('');
  // The file is built from the same report as this page.
  if ($('#gabExport')) $('#gabExport').href = `/api/gabungan.xlsx?${new URLSearchParams({ month: g.month })}`;

  const [gy, gm] = g.month.split('-');
  $('#gabTitle').textContent = `LAPORAN PRODUKSI GABUNGAN ${BULAN[Number(gm) - 1].toUpperCase()} TAHUN ${gy}`;

  const fams = g.families;
  const cols = 4 + fams.length;
  // A family's day with clearly fewer shifts than its fullest day is still
  // being filled in: marked, so its metres are not read as a bad day.
  const full = Object.fromEntries(fams.map((f) => [f, Math.max(0, ...g.rows.map((d) => d.fam[f]?.shifts ?? 0))]));
  const famCell = (d, f, bold = '') => {
    const x = d.fam[f];
    if (!x) return gc('—', 'gab-none');
    const part = x.shifts !== undefined && x.shifts < full[f] * 0.9;
    return gc(f2(x.meter), `${bold}${part ? ' gab-part' : ''}`,
      `${FAMILY_LABEL[f]}: efisiensi ${p2(x.eff)}${part ? ` · baru ${x.shifts} dari ${full[f]} shift` : ''}`);
  };

  $('#gabTable thead').innerHTML = `<tr><th>TGL</th>${fams.map((f) => `<th>${esc((FAMILY_LABEL[f] ?? f).toUpperCase())}<br>(m)</th>`).join('')}
    <th>TOTAL<br>(m)</th><th>PRODUKSI<br>100% (m)</th><th>EFISIENSI</th></tr>`;
  $('#gabTable tbody').innerHTML = g.rows.map((d) => `<tr>
    <td class="gab-date">${sheetDay(d.tgl)}</td>
    ${fams.map((f) => famCell(d, f)).join('')}
    ${gc(f2(d.meter), 'b')}${gc(f2(d.prod100))}${gc(p2(d.eff), 'b')}
  </tr>`).join('');

  const block = (p, label) => `
    <tr class="gab-tot"><td class="gab-label">${label}</td>
      ${fams.map((f) => gc(f2(p.total.fam[f]?.meter), 'b', p.total.fam[f] ? `${FAMILY_LABEL[f]}: efisiensi ${p2(p.total.fam[f].eff)}` : '')).join('')}
      ${gc(f2(p.total.meter), 'b')}${gc(f2(p.total.prod100), 'b')}${gc(p2(p.total.eff), 'b')}</tr>
    <tr class="gab-tot"><td class="gab-label">RATA-RATA/HARI (${p.days} hari)</td>
      ${fams.map((f) => gc(f2(p.avg.fam[f]?.meter))).join('')}
      ${gc(f2(p.avg.meter))}${gc(f2(p.avg.prod100))}<td></td></tr>`;
  const prev = g.prev;
  $('#gabTable tfoot').innerHTML = [
    `<tr class="gab-gap"><td colspan="${cols}"></td></tr>`,
    block(g, 'TOTAL'),
    `<tr class="gab-left"><td colspan="${cols}">${g.days} dari ${g.days_in_month} hari bulan ini ada data</td></tr>`,
    ...(prev ? [
      `<tr class="gab-prev"><td colspan="${cols}">BULAN ${BULAN[Number(prev.month.slice(5)) - 1].toUpperCase()} (${daysIn(prev.month)} hari)</td></tr>`,
      block(prev, 'TOTAL')
    ] : [])
  ].join('');

  // Which family is missing on which days, so a low total is not misread.
  const notes = [];
  for (const f of fams) {
    const missing = g.rows.filter((d) => !d.fam[f]).map((d) => sheetDay(d.tgl));
    if (!g.total.fam[f]) notes.push(`${FAMILY_LABEL[f]}: belum ada data bulan ini.`);
    else if (missing.length) {
      notes.push(`${FAMILY_LABEL[f]}: tidak ada data untuk ${missing.length} hari (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}).`);
    }
  }
  if (g.rows.some((d) => fams.some((f) => d.fam[f] && d.fam[f].shifts < full[f] * 0.9))) {
    notes.push('Angka oranye: hari itu baru sebagian shift terisi.');
  }
  notes.push('Efisiensi dihitung pada shift yang punya pick dan RPM target, sama seperti tab Produksi. Lihat tab Kelengkapan Data untuk detail.');
  $('#gabNote').textContent = notes.join(' ');

  const t = g.total;
  const vsPrev = (now, before) => {
    if (!prev || before === null || before === undefined || now === null) return '';
    const d = now - before;
    return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${f2(Math.abs(d))} poin</span> vs ${BULAN[Number(prev.month.slice(5)) - 1]}`;
  };
  $('#gabStats').innerHTML = [
    // Whole metres in the tiles: the decimals are in the table.
    tile('Total output', fmt.int(t.meter), 'm', `rata-rata ${fmt.int(g.avg.meter)} m/hari`),
    tile('Efisiensi', p2(t.eff), '', vsPrev(t.eff, prev?.total.eff) || `dari ${fmt.int(t.prod100)} m produksi 100%`),
    ...fams.map((f) => (t.fam[f]
      ? tile(FAMILY_LABEL[f], fmt.int(t.fam[f].meter), 'm', `efisiensi ${p2(t.fam[f].eff)} · ${t.fam[f].days} hari`)
      : tile(FAMILY_LABEL[f], '—', '', 'belum ada data')))
  ].join('');

  lineChart($('#gabEffChart'), g.rows, {
    x: (d) => d.tgl,
    y: (d) => d.eff,
    format: f2,
    unit: '%',
    height: 220,
    baseZero: false,
    reference: t.eff,
    referenceLabel: t.eff === null ? '' : `bulan ini ${p2(t.eff)}`,
    tipRows: (d) => [
      [sheetDay(d.tgl), p2(d.eff)],
      ...fams.filter((f) => d.fam[f]).map((f) => [FAMILY_LABEL[f], `${f2(d.fam[f].meter)} m · ${p2(d.fam[f].eff)}`]),
      ['Total', `${f2(d.meter)} m`],
      ['Produksi 100%', `${f2(d.prod100)} m`]
    ]
  });
}

$('#gabMonth').addEventListener('change', (e) => { state.gabMonth = e.target.value; loadGabungan(); });
