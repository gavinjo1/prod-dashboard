/**
 * Pabrik: the looms' own monitoring export.
 */
import { $, $$ } from '../core/dom.js';
import { achievedCell, stopCell } from '../ui/cells.js';
import { isCurrent, state, takeTicket, toLogin } from '../core/state.js';
import { barChart } from '../charts/bars.js';
import { buildPicker, byMachineNo } from '../ui/picker.js';
import { esc, fmt } from '../charts/core.js';
import { lineChart } from '../charts/line.js';
import { share } from '../core/numbers.js';
import { tile } from '../ui/tiles.js';

/* ------------------------------------------------------------------ *
 * Pabrik — the looms' own monitoring export
 *
 * Its own endpoints and its own database. Deliberately does not reuse the
 * production filters: this data has different shifts, different fabric
 * spellings and a different notion of output, and pretending otherwise would
 * put two incompatible numbers side by side.
 * ------------------------------------------------------------------ */

export const loomState = { sort: 'achieved', dir: 'asc', search: '' };
export let loomRows = [];
export let loomList = '';

/**
 * The No. mesin choice is shared with the Production filter: the loom export
 * covers the AJL shed, and its loom numbers are the daily report's.
 */
export const loomParams = (extra = {}) => {
  const p = new URLSearchParams(extra);
  if (state.machine.length) p.set('loom', state.machine.join(','));
  return p;
};
export const getJson = async (url) => {
  const res = await fetch(url);
  if (res.status === 401) return toLogin();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};
export const loomApi = (path, extra = {}) => getJson(`/api/loom/${path}?${loomParams(extra)}`);
export const pabrikApi = (path, extra = {}) => getJson(`/api/pabrik/${path}?${loomParams(extra)}`);

/** A few styles arrive URL-encoded from the loom system: "UMR%2006%20AJL". */
export const styleText = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

export async function loadPabrik() {
  const ticket = takeTicket('pabrik');
  const meta = await loomApi('meta');
  if (!isCurrent('pabrik', ticket)) return;

  // Rebuilt only when the list changes: rebuilding closes the menu, and the
  // menu's own clicks are what trigger this reload.
  const list = byMachineNo(meta.looms);
  if (list.join(',') !== loomList) {
    loomList = list.join(',');
    buildPicker($('#pLoom'), 'machine', list, 'mesin');
  } else {
    $('#pLoom')._sync?.();
  }

  const empty = !meta.range.rows;
  $('#pabrikEmpty').hidden = !empty;
  ['#pabrikStats', '#loomTable', '#chartLoomStops', '#chartLoomWaktu', '#chartLoomDaily']
    .forEach((sel) => { const el = $(sel).closest('.card, .stats'); if (el) el.hidden = empty; });
  await loadLoomLog();
  if (empty) return;

  const [sum, stops, daily, waktu, mesin] = await Promise.all([
    loomApi('summary'), loomApi('stops'), loomApi('trend', { by: 'day' }), loomApi('by-waktu'),
    pabrikApi('mesin')
  ]);
  if (!isCurrent('pabrik', ticket)) return;

  const cov = sum.coverage;
  const dropped = cov.total - cov.full;
  const tot = mesin.total;
  $('#pabrikStats').innerHTML = [
    tile('Capai target', achievedCell(tot.achieved, tot.target_pct), '',
      tot.shifts ? `${fmt.int(tot.met)} dari ${fmt.int(tot.shifts)} shift mencapai target ${fmt.one(tot.target_pct)}%` : 'belum ada shift dengan target'),
    tile('Efisiensi', fmt.pct(sum.effic), '', 'jalan ÷ total waktu'),
    // Loom-hours, not elapsed hours: 116 looms in one eight-hour shift give
    // 928 loom-hours, so a single shift can lose far more than eight.
    tile('Berhenti', fmt.int(sum.stop_hour), 'jam-mesin', `${fmt.int(sum.run_hour)} jam-mesin jalan`),
    tile('Jumlah stop', fmt.int(sum.stops), '', ''),
    tile('Kain', fmt.int(sum.meter), 'm', 'satu lebar'),
    // The range of what is actually counted, not of what was imported: days
    // that hold only truncated records are excluded above, and a tile that
    // named them anyway would disagree with the chart beside it.
    tile('Mesin melapor', fmt.int(sum.looms), '', `${fmt.day(sum.min_date)} – ${fmt.day(sum.max_date)}`),
    tile('Shift dipakai', fmt.int(cov.full), '',
      dropped ? `${fmt.int(dropped)} shift tidak lengkap tidak dihitung` : '')
  ].join('');

  const totalMin = stops.reduce((t, r) => t + Number(r.minutes), 0);
  barChart($('#chartLoomStops'), stops, {
    max: 12,
    value: (d) => Number(d.minutes),
    format: (v) => fmt.int(v / 60) + ' h',
    labelWidth: 92,
    tipRows: (d) => [
      ['Waktu hilang', fmt.int(Number(d.minutes) / 60) + ' jam-mesin'],
      ['Jumlah stop', fmt.int(d.count)],
      ['Rata-rata tiap stop', fmt.one(Number(d.minutes) / Number(d.count)) + ' mnt'],
      ['Porsi waktu berhenti', fmt.pct(Number(d.minutes) / totalMin * 100)]
    ]
  });

  lineChart($('#chartLoomDaily'), daily, {
    y: (d) => Number(d.effic),
    format: (v) => fmt.one(v),
    unit: '%',
    height: 240,
    baseZero: false,
    tipRows: (d) => [
      ['Efisiensi', fmt.pct(d.effic)],
      ['Shift mesin', fmt.int(d.looms)],
      ['Kain', fmt.num(d.meter) + ' m'],
      ['Berhenti', fmt.int(d.stop_hour) + ' jam-mesin'],
      ['Jumlah stop', fmt.int(d.stops)]
    ]
  });

  // Not every day has all three shifts in the exports loaded so far; say so
  // rather than let a part-day look like a bad day.
  const perDay = daily.map((d) => Number(d.looms));
  const busiest = Math.max(...perDay, 0);
  const partial = daily.filter((d) => Number(d.looms) < busiest * 0.7).length;
  $('#loomDailyNote').textContent = partial
    ? `${fmt.int(partial)} dari ${fmt.int(daily.length)} hari datanya belum lengkap.`
    : '';

  barChart($('#chartLoomWaktu'), waktu, {
    label: (d) => d.waktu,
    value: (d) => Number(d.effic),
    format: (v) => fmt.one(v) + '%',
    labelWidth: 56,
    tipRows: (d) => [
      ['Shift mesin', fmt.int(d.shifts)],
      ['Kain', fmt.num(d.meter) + ' m'],
      ['Berhenti', fmt.int(d.stop_hour) + ' jam-mesin']
    ]
  });

  loomRows = mesin.rows;
  $('#loomTableNote').textContent = mesin.unpriced
    ? `${fmt.int(mesin.unpriced)} shift tanpa pick atau RPM target di laporan harian tidak ikut dihitung persennya.`
    : '';
  paintLooms();
}

export const LOOM_SORT = {
  loom: (r) => r.loom,
  achieved: (r) => r.priced.achieved,
  pagi: (r) => r.waktu.pagi.achieved,
  siang: (r) => r.waktu.siang.achieved,
  malam: (r) => r.waktu.malam.achieved,
  output: (r) => r.meter,
  target: (r) => r.priced.target,
  warp: (r) => r.warp_cnt,
  weft: (r) => r.weft_cnt,
  other: (r) => r.other_cnt,
  effic: (r) => r.effic
};

export function paintLooms() {
  const q = loomState.search.trim().toLowerCase();
  const shown = loomRows.filter((r) => !q
    || r.loom.toLowerCase().includes(q) || r.styles.map(styleText).join(' ').toLowerCase().includes(q));
  const get = LOOM_SORT[loomState.sort] ?? LOOM_SORT.achieved;
  shown.sort((a, b) => {
    const x = get(a), y = get(b);
    // Machines that cannot be priced go last whichever way the column runs.
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y, 'en', { numeric: true }) : x - y;
    return loomState.dir === 'asc' ? c : -c;
  });

  const w = (r, k) => `<td class="num">${achievedCell(r.waktu[k].achieved, r.waktu[k].target_pct)}</td>`;
  $('#loomTable tbody').innerHTML = shown.map((r) => {
    const styles = r.styles.map(styleText).join(', ') || '—';
    return `<tr tabindex="0" data-loom="${esc(r.loom)}">
      <td class="mc-name">${esc(r.loom)}</td>
      <td class="muted loom-style" title="${esc(styles)}">${esc(styles)}</td>
      <td class="num"><b>${achievedCell(r.priced.achieved, r.priced.target_pct)}</b>${
        r.priced.shifts ? `<span class="muted"> · ${fmt.int(r.priced.met)}/${fmt.int(r.priced.shifts)}</span>` : ''}</td>
      ${w(r, 'pagi')}${w(r, 'siang')}${w(r, 'malam')}
      <td class="num">${fmt.num(r.meter)}</td>
      <td class="num muted">${r.priced.target ? fmt.num(r.priced.target) : '—'}</td>
      ${stopCell(r.warp_cnt, r.warp_min)}
      ${stopCell(r.weft_cnt, r.weft_min)}
      ${stopCell(r.other_cnt, r.other_min)}
      <td class="num">${fmt.pct(r.effic)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="12" class="muted" style="padding:20px;text-align:center">Tidak ada mesin yang cocok.</td></tr>`;
}

export const WAKTU_LABEL = { pagi: 'Pagi 07–15', siang: 'Siang 15–23', malam: 'Malam 23–07' };

export async function openLoom(loom) {
  const rows = await pabrikApi(`mesin/${encodeURIComponent(loom)}`);
  const priced = rows.filter((r) => r.achieved !== null);
  const out = priced.reduce((t, r) => t + r.output, 0);
  const tgt = priced.reduce((t, r) => t + r.target, 0);
  const tPct = tgt ? priced.reduce((t, r) => t + r.target * r.target_pct, 0) / tgt : null;
  const met = priced.filter((r) => r.achieved >= r.target_pct).length;

  $('#loomDrawerTitle').textContent = `Mesin ${loom} — ${fmt.int(rows.length)} shift`;
  $('#loomDrawerSub').innerHTML = priced.length
    ? `Capai target ${achievedCell(tgt ? (out / tgt) * 100 : null, tPct)} · ` +
      `${fmt.int(met)} dari ${fmt.int(priced.length)} shift mencapai target harian` +
      (rows.length > priced.length ? ` · ${fmt.int(rows.length - priced.length)} shift tanpa target` : '')
    : 'Tidak ada shift dengan pick dan RPM target di laporan harian.';

  $('#loomShiftTable tbody').innerHTML = [...rows].reverse().map((r) => `<tr>
      <td>${esc(fmt.day(r.tgl))}</td>
      <td class="hours">${esc(WAKTU_LABEL[r.waktu] ?? r.slot)}<span class="muted"> · regu ${esc(r.crew ?? '—')}</span></td>
      <td class="muted">${esc(r.style ? styleText(r.style) : '—')}</td>
      <td class="muted">${esc(r.beam ?? '—')}</td>
      <td class="muted">${esc(r.mo ?? '—')}</td>
      <td class="num">${fmt.int(r.rpm)}</td>
      <td class="num">${r.rpm_target == null ? '—' : fmt.int(r.rpm_target)}</td>
      <td class="num">${r.pick == null ? '—' : fmt.num(r.pick)}</td>
      <td class="num" title="${fmt.int(r.run_min)} mnt jalan, ${fmt.int(r.stop_min)} mnt stop">${
        fmt.pct(share(Number(r.run_min), Number(r.run_min) + Number(r.stop_min)))}</td>
      <td class="num">${r.output == null ? fmt.num(r.prod_meter) : fmt.num(r.output)}</td>
      <td class="num muted">${r.target == null ? '—' : fmt.num(r.target)}</td>
      <td class="num">${achievedCell(r.achieved, r.target_pct)}</td>
      ${stopCell(r.warp_cnt, r.warp_min)}
      ${stopCell(r.weft_cnt, r.weft_min)}
      ${stopCell(r.other_cnt, r.other_min)}
    </tr>`).join('');
  if (!$('#loomDrawer').open) $('#loomDrawer').showModal();
}

export const onLoomRow = (e) => {
  const row = e.target.closest('tr[data-loom]');
  if (row && (e.type === 'click' || e.key === 'Enter')) openLoom(row.dataset.loom).catch((err) => alert(err.message));
};
$('#loomTable tbody').addEventListener('click', onLoomRow);
$('#loomTable tbody').addEventListener('keydown', onLoomRow);
$('#loomDrawerClose').addEventListener('click', () => $('#loomDrawer').close());

export async function loadLoomLog() {
  const rows = await loomApi('imports');
  $('#loomLog tbody').innerHTML = rows.map((r) => `
    <tr>
      <td class="muted nowrap">${esc(r.at)}</td>
      <td>${esc(r.file_name)}</td>
      <td class="muted">${esc((r.periode ?? '').replace('Period(Shift) :', '').trim() || '—')}</td>
      <td class="num">${fmt.int(r.rows_written)}</td>
      <td><span class="pill pill-${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span>${r.message ? ` <span class="muted">${esc(r.message)}</span>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted" style="padding:20px;text-align:center">Belum ada import.</td></tr>`;
}

export async function uploadLoom(file) {
  const drop = $('#loomDrop');
  const out = $('#loomResult');
  drop.classList.add('is-busy');
  out.innerHTML = `<div class="result result-ok">Membaca ${esc(file.name)}…</div>`;
  try {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/loom/import', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import gagal');
    out.innerHTML = `<div class="result result-ok">
        <div class="result-title">${fmt.int(data.written)} shift mesin diimport dari ${esc(data.file)}</div>
        <p>${esc((data.periode ?? '').replace('Period(Shift) :', 'Periode:'))}</p>
      </div>`;
    await loadPabrik();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Gagal import ${esc(file.name)}</div><p>${esc(err.message)}</p></div>`;
  } finally {
    drop.classList.remove('is-busy');
  }
}

$('#loomSearch').addEventListener('input', (e) => { loomState.search = e.target.value; paintLooms(); });
$$('#loomTable th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.lsort;
  loomState.dir = loomState.sort === key && loomState.dir === 'asc' ? 'desc' : 'asc';
  loomState.sort = key;
  $$('#loomTable th').forEach((h) => h.classList.remove('is-sorted-asc', 'is-sorted-desc'));
  th.classList.add(loomState.dir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
  paintLooms();
}));
$('#loomBrowse').addEventListener('click', () => $('#loomFile').click());
$('#loomFile').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadLoom(e.target.files[0]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  $('#loomDrop').addEventListener(ev, (e) => { e.preventDefault(); $('#loomDrop').classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('#loomDrop').addEventListener(ev, (e) => { e.preventDefault(); $('#loomDrop').classList.remove('is-over'); }));
$('#loomDrop').addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) uploadLoom(e.dataTransfer.files[0]);
});
