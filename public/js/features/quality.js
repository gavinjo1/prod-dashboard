/**
 * Kualitas: grades by period and by fabric.
 */
import { $, $$ } from '../core/dom.js';
import { Q_PERIOD } from '../core/periods.js';
import { api, isCurrent, params, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { share } from '../core/numbers.js';
import { stackedBars } from '../charts/bars.js';
import { statusDot, tile } from '../ui/tiles.js';
import { stopCell } from '../ui/cells.js';

export const GRADE_COLOURS = {
  a:  getComputedStyle(document.documentElement).getPropertyValue('--grade-a').trim(),
  b:  getComputedStyle(document.documentElement).getPropertyValue('--grade-b').trim(),
  bs: getComputedStyle(document.documentElement).getPropertyValue('--grade-bs').trim(),
  rk: getComputedStyle(document.documentElement).getPropertyValue('--grade-rk').trim()
};


/* ------------------------------------------------------------------ *
 * Quality panel
 * ------------------------------------------------------------------ */

/* ---- Quality ---- */

/** Daily grade rows summed into weeks, months or years. */
export function gradePeriods(daily, period) {
  const P = Q_PERIOD[period];
  const out = new Map();
  for (const r of daily) {
    const k = P.key(r.date);
    let b = out.get(k);
    if (!b) out.set(k, (b = { date: k, first: r.date, last: r.date, a: 0, b: 0, bs: 0, rk: 0, total: 0, days: 0 }));
    b.last = r.date;
    for (const f of ['a', 'b', 'bs', 'rk', 'total']) b[f] += Number(r[f]) || 0;
    b.days++;
  }
  return [...out.values()];
}

export let qData = null;
export const qFabric = { sort: 'total', dir: 'desc', search: '' };

export async function loadQuality() {
  const ticket = takeTicket('quality');
  const data = await api('quality');
  if (!isCurrent('quality', ticket)) return;
  qData = data;
  const { totals } = data;
  const total = Number(totals.total) || 0;
  const defect = Number(totals.bs) + Number(totals.rk);
  const rate = share(defect, total);

  $('#qStats').innerHTML = [
    tile('Diperiksa', fmt.int(total), 'm', `${totals.rows} order-hari`),
    tile('Grade A', fmt.pct(share(Number(totals.a), total)), '', `${fmt.num(totals.a)} m`),
    tile('Grade B', fmt.pct(share(Number(totals.b), total)), '', `${fmt.num(totals.b)} m`),
    tile('Cacat (BS+RK)', fmt.pct(rate), '',
      statusDot(rate, { good: 1, warn: 2.5, invert: true, words: ['Rendah', 'Naik', 'Tinggi'] })),
    tile('BS', fmt.int(totals.bs), 'm', 'bad stock'),
    tile('Reject', fmt.int(totals.rk), 'm', 'RK')
  ].join('');

  paintQualityPeriod();
  paintFabrics();
}

export function paintQualityPeriod() {
  if (!qData) return;
  const P = Q_PERIOD[state.qPeriod];
  const rows = gradePeriods(qData.daily, state.qPeriod);
  $$('#qPeriod [data-qperiod]').forEach((b) => b.classList.toggle('is-active', b.dataset.qperiod === state.qPeriod));
  $('#qChartTitle').textContent = P.title;
  $('#qTableTitle').textContent = P.table;
  $('#qTableHead').textContent = P.head;

  stackedBars($('#chartQuality'), rows, [
    { name: 'Grade A', colour: GRADE_COLOURS.a,  value: (d) => d.a },
    { name: 'Grade B', colour: GRADE_COLOURS.b,  value: (d) => d.b },
    { name: 'BS', colour: GRADE_COLOURS.bs, value: (d) => d.bs },
    { name: 'Reject', colour: GRADE_COLOURS.rk, value: (d) => d.rk }
  ], {
    label: (d) => P.label(d.date, d),
    title: (d) => P.long(d.date, d),
    tipExtra: (d) => [
      ['A+B', fmt.pct(share(d.a + d.b, d.total))],
      ['BS+RK', fmt.pct(share(d.bs + d.rk, d.total))],
      ...(state.qPeriod === 'day' ? [] : [['Hari tercatat', fmt.int(d.days)]])
    ]
  });

  // Say how much history there is: two months of grades make a thin year.
  const first = qData.daily[0]?.date;
  const last = qData.daily[qData.daily.length - 1]?.date;
  $('#qPeriodNote').textContent = first && state.qPeriod !== 'day'
    ? `Data grade ada dari ${fmt.day(first)} ${first.slice(0, 4)} sampai ${fmt.day(last)} ${last.slice(0, 4)} — ` +
      `${fmt.int(rows.length)} ${P.head.split(' ')[0].toLowerCase()}` +
      (state.qPeriod === 'week' ? '. Minggu pertama dan terakhir bisa belum penuh.' : '.')
    : '';

  // The table view is the relief for the light segment colours in the stack.
  $('#qDailyTable tbody').innerHTML = [...rows].reverse().map((r) => `<tr>
      <td>${esc(P.long(r.date, r))}</td>
      <td class="num">${fmt.num(r.a)}</td>
      <td class="num">${fmt.num(r.b)}</td>
      <td class="num">${fmt.num(r.bs)}</td>
      <td class="num">${fmt.num(r.rk)}</td>
      <td class="num">${fmt.num(r.total)}</td>
      <td class="num">${fmt.pct(share(r.a + r.b, r.total))}</td>
      <td class="num">${fmt.pct(share(r.bs + r.rk, r.total))}</td>
    </tr>`).join('') || `<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">Belum ada data grade.</td></tr>`;
}

export function paintFabrics() {
  if (!qData) return;
  const q = qFabric.search.trim().toLowerCase();
  const rows = qData.byFabric.map((r) => {
    const t = Number(r.total) || 0;
    return { ...r, t, a_pct: share(Number(r.a), t), b_pct: share(Number(r.b), t),
      defect_pct: share(Number(r.bs) + Number(r.rk), t) };
  }).filter((r) => !q || String(r.label).toLowerCase().includes(q));
  const key = qFabric.sort;
  const val = (r) => (key === 'label' ? String(r.label) : key === 'total' ? r.t : Number(r[key] ?? -1));
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y, 'en', { numeric: true }) : x - y;
    return qFabric.dir === 'asc' ? c : -c;
  });

  // The worst defect rates are what someone opens this table to find.
  const worst = [...rows].filter((r) => r.t > 0).map((r) => r.defect_pct).sort((a, b) => b - a);
  const flagAt = worst.length >= 4 ? worst[Math.floor(worst.length / 4) - 1] : Infinity;
  $('#qFabricTable tbody').innerHTML = rows.map((r) => `
    <tr tabindex="0" data-kode="${esc(r.label)}">
      <td class="mc-name">${esc(r.label)}</td>
      <td class="num">${fmt.num(r.t)}</td>
      <td class="num">${fmt.pct(r.a_pct)}</td>
      <td class="num muted">${fmt.pct(r.b_pct)}</td>
      <td class="num">${fmt.num(r.bs)}</td>
      <td class="num">${fmt.num(r.rk)}</td>
      <td class="num ${r.defect_pct >= flagAt && r.defect_pct > 0 ? 'is-bad' : ''}">${
        r.defect_pct >= flagAt && r.defect_pct > 0 ? '▲ ' : ''}${fmt.pct(r.defect_pct)}</td>
      <td class="num">${fmt.int(r.orders)}</td>
      <td class="num">${r.machines ? fmt.int(r.machines) : '—'}</td>
    </tr>`).join('') || `<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">Belum ada data grade.</td></tr>`;
}

export async function openFabric(kode) {
  const p = new URLSearchParams({ kode, family: params().get('family') });
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  const res = await fetch(`/api/quality/fabric?${p}`);
  if (res.status === 401) return toLogin();
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || res.statusText);

  const sum = (k) => d.orders.reduce((t, o) => t + (Number(o[k]) || 0), 0);
  const total = sum('total');
  $('#qDrawerTitle').textContent = kode;
  $('#qDrawerSub').textContent =
    `${fmt.int(d.orders.length)} order · ${fmt.num(total)} m diperiksa · ` +
    `BS+RK ${fmt.pct(share(sum('bs') + sum('rk'), total))} · ${fmt.int(d.machines.length)} mesin`;

  $('#qOrderTable tbody').innerHTML = d.orders.map((o) => {
    const t = Number(o.total) || 0;
    return `<tr>
      <td class="mc-name">${esc(o.mo)}</td>
      <td class="muted">${esc(o.first === o.last ? fmt.day(o.first) : `${fmt.day(o.first)} – ${fmt.day(o.last)}`)}</td>
      <td class="num">${fmt.num(o.a)}</td>
      <td class="num">${fmt.num(o.b)}</td>
      <td class="num">${fmt.num(o.bs)}</td>
      <td class="num">${fmt.num(o.rk)}</td>
      <td class="num">${fmt.num(t)}</td>
      <td class="num">${fmt.pct(share(Number(o.bs) + Number(o.rk), t))}</td>
    </tr>`;
  }).join('');

  // The fabric's own rate, so each loom is judged against looms weaving the
  // same cloth rather than against the whole shed.
  const picks = d.machines.reduce((t, m) => t + m.picks, 0);
  const avg = (k) => (picks > 0 ? d.machines.reduce((t, m) => t + m[k], 0) * 100 / picks : null);
  const avgWarp = avg('warp_cnt');
  const avgWeft = avg('weft_cnt');
  const high = (v, a) => v !== null && a !== null && d.machines.length > 1 && v > a * 1.5;
  const rateCell = (v, a) => `<td class="num ${high(v, a) ? 'is-bad' : ''}">${
    high(v, a) ? '▲ ' : ''}${v === null ? '—' : fmt.one(v)}</td>`;

  $('#qMachineNote').textContent = d.stops
    ? `BS dan reject dicatat per order, bukan per mesin — semua mesin di bawah ikut menanggung BS kain ini. ` +
      `Yang membedakan mesin adalah stop-nya: rata-rata kain ini ${fmt.one(avgWarp)} stop lusi dan ` +
      `${fmt.one(avgWeft)} stop pakan per 100 rb pick. ▲ = lebih dari 1,5× rata-rata itu.`
    : 'BS dan reject dicatat per order, bukan per mesin. Data stop lusi/pakan hanya ada untuk AJL (dari export Pabrik).';

  $('#qMachineTable tbody').innerHTML = d.machines.map((m) => `<tr>
      <td class="mc-name">${esc(m.no_mc)}</td>
      <td class="muted">${esc(m.type_mc ?? '—')}</td>
      <td class="num">${fmt.int(m.shifts)}</td>
      <td class="num">${fmt.num(m.produksi)}</td>
      ${m.loom_shifts ? stopCell(m.warp_cnt, m.warp_min) + stopCell(m.weft_cnt, m.weft_min) : '<td class="num muted">—</td><td class="num muted">—</td>'}
      ${m.loom_shifts ? rateCell(m.warp_rate, avgWarp) + rateCell(m.weft_rate, avgWeft) : '<td class="num muted">—</td><td class="num muted">—</td>'}
    </tr>`).join('') || `<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">Tidak ada mesin di laporan harian untuk order kain ini pada periode yang dipilih.</td></tr>`;

  if (!$('#qDrawer').open) $('#qDrawer').showModal();
}

$$('#qPeriod [data-qperiod]').forEach((b) => b.addEventListener('click', () => {
  state.qPeriod = b.dataset.qperiod;
  paintQualityPeriod();
}));
$('#qFabricSearch').addEventListener('input', (e) => { qFabric.search = e.target.value; paintFabrics(); });
$$('#qFabricTable th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.qsort;
  qFabric.dir = qFabric.sort === key && qFabric.dir === 'desc' ? 'asc' : 'desc';
  qFabric.sort = key;
  $$('#qFabricTable th').forEach((h) => h.classList.remove('is-sorted-asc', 'is-sorted-desc'));
  th.classList.add(qFabric.dir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
  paintFabrics();
}));
export const onFabricRow = (e) => {
  const row = e.target.closest('tr[data-kode]');
  if (row && (e.type === 'click' || e.key === 'Enter')) openFabric(row.dataset.kode).catch((err) => alert(err.message));
};
$('#qFabricTable tbody').addEventListener('click', onFabricRow);
$('#qFabricTable tbody').addEventListener('keydown', onFabricRow);
$('#qDrawerClose').addEventListener('click', () => $('#qDrawer').close());
