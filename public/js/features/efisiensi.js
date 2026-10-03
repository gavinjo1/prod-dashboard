/**
 * Efisiensi kain: each fabric's efficiency per day, laid out as the mill's
 * "MAS VENAN 3 HARI SEKALI" sheet.
 */
import { $ } from '../core/dom.js';
import { api, isCurrent, session, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { daysIn } from '../core/dates.js';
import { BULAN, f2, sheetDay } from './gabungan.js';
import { FAMILY_LABEL } from './family.js';

/* ------------------------------------------------------------------ *
 * The sheet
 *
 * Block 3 of the mill's sheet, "MONITORING CAPAIAN MESIN ALL AJL 1,2,3,4
 * GABUNGAN":
 *
 *                           |        TANGGAL        |             |
 *   NE LAY OUT | KODE KAIN  | 1-Sep | 2-Sep | …     | Grand Total | RATA-RATA
 *   CD40       | C12072 AJL | 57,67 | 56,40 | …
 *              | C415 AJL   | …
 *   CD40 Total |            | …
 *   …
 *   Grand Total
 *
 * Each figure is the Produksi tab's efficiency for those shifts; the cell's
 * title says how many machines and shifts that is.
 * ------------------------------------------------------------------ */

export let effData = null;

/** "SEPTEMBER 2026" for a whole month, else "1 SEP – 22 SEP 2026". */
function periodName(from, to) {
  const [y, m] = from.split('-');
  const whole = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01')
    && Number(to.slice(8)) === daysIn(from.slice(0, 7));
  if (whole) return `${BULAN[Number(m) - 1].toUpperCase()} ${y}`;
  return `${fmt.day(from).toUpperCase()} – ${fmt.day(to).toUpperCase()} ${to.slice(0, 4)}`;
}

const cellOf = (d) => (d
  ? `<td class="num" title="${esc(`${fmt.int(d.machines)} mesin · ${fmt.int(d.shifts)} shift`)}">${f2(d.eff)}</td>`
  : '<td class="num"></td>');

export function paintEfisiensi() {
  const g = effData;
  if (!g) return;
  const q = $('#effSearch').value.trim().toLowerCase();
  const { dates } = g;

  $('#effTable thead').innerHTML = `<tr>
      <th class="eff-ne" rowspan="2">NE LAY OUT</th><th class="eff-kode" rowspan="2">KODE KAIN</th>
      ${dates.length ? `<th colspan="${dates.length}">TANGGAL</th>` : ''}
      <th rowspan="2">Grand Total</th><th rowspan="2">RATA-RATA</th>
    </tr>
    <tr>${dates.map((d) => `<th>${esc(sheetDay(d))}</th>`).join('')}</tr>`;
  // The row's own two columns on the right: the period as one ratio, and the
  // average of its days.
  const ends = (x) => `${cellOf(x.total)}<td class="num b">${f2(x.avg)}</td>`;

  const rows = [];
  for (const grp of g.groups) {
    const fabrics = grp.fabrics.filter((f) => !q || f.kode_kain.toLowerCase().includes(q));
    if (!fabrics.length) continue;
    fabrics.forEach((f, i) => rows.push(`<tr>
      <td class="eff-ne">${i === 0 ? esc(grp.ne) : ''}</td><td class="eff-kode">${esc(f.kode_kain)}</td>
      ${dates.map((d) => cellOf(f.days[d])).join('')}${ends(f)}</tr>`));
    // A group's total covers all of its fabrics, so it is left out while a
    // search shows only some of them.
    if (!q) {
      rows.push(`<tr class="gab-tot"><td class="eff-ne b">${esc(grp.ne)} Total</td><td class="eff-kode b"><span class="eff-phone">${esc(grp.ne)} Total</span></td>
        ${dates.map((d) => cellOf(grp.total.days[d])).join('')}${ends(grp.total)}</tr>`);
    }
  }
  if (!q && g.groups.length) {
    rows.push(`<tr class="gab-tot eff-grand"><td class="eff-ne b">Grand Total</td><td class="eff-kode b"><span class="eff-phone">Grand Total</span></td>
      ${dates.map((d) => cellOf(g.grand.days[d])).join('')}${ends(g.grand)}</tr>`);
  }
  $('#effTable tbody').innerHTML = rows.join('')
    || `<tr><td colspan="${dates.length + 4}" class="muted" style="padding:20px;text-align:center">${
      g.groups.length ? 'Tidak ada kode kain yang cocok.' : 'Belum ada data produksi untuk pilihan ini.'}</td></tr>`;

  // The fabric column pins just right of the NE column, however wide that is.
  const ne = $('#effTable th.eff-ne');
  $('#effTable').style.setProperty('--ne-w', `${ne ? ne.offsetWidth : 0}px`);

  // The latest day is the one asked about.
  const wrap = $('#effWrap');
  wrap.scrollLeft = wrap.scrollWidth;
}

export async function loadEfisiensi() {
  const ticket = takeTicket('efisiensi');
  const g = await api('efisiensi-kain');
  if (!isCurrent('efisiensi', ticket)) return;
  effData = g;

  // Titled as the mill's block 3, the period being the filter's.
  const from = state.from || g.dates[0];
  const to = state.to || g.dates[g.dates.length - 1];
  const fam = state.family;
  $('#effTitle').textContent = `MONITORING CAPAIAN MESIN ALL ${
    fam === 'ajl' ? 'AJL 1,2,3,4' : (FAMILY_LABEL[fam] ?? fam).toUpperCase()} GABUNGAN${
    from ? ` PERIODE ${periodName(from, to)}` : ''}`;
  $('#effSub').textContent = 'Efisiensi = hasil mesin ÷ PROD 100%, sama dengan tab Produksi';
  const notes = [];
  if (g.unpriced) notes.push(`${fmt.int(g.unpriced)} shift tanpa pick atau RPM target tidak dihitung.`);
  if (g.no_meter) notes.push(`${fmt.int(g.no_meter)} shift ada sodokannya tapi METER 0 (tabel SODOKAN belum lengkap), dihitung 0 m seperti di tab Produksi.`);
  const ungrouped = g.groups.find((x) => x.ungrouped);
  if (ungrouped) notes.push(`${fmt.int(ungrouped.fabrics.length)} kode kain belum punya grup NE.`);
  $('#effNote').textContent = notes.join(' ');

  const m = g.master;
  $('#effMaster').textContent = `${fmt.int(m.fixed)} kode kain dengan grup tetap dari pabrik${
    m.uploaded ? ` · ${fmt.int(m.uploaded)} tambahan dari ${m.file}, ${m.at}` : ''}. ` +
    'Kain baru yang belum punya grup bisa ditambahkan dari sheet KODE KAIN file EFFISIENSI.';
  // Viewers see the list, not the upload.
  $('#effDrop').hidden = !session.canWrite;

  paintEfisiensi();
}

$('#effSearch').addEventListener('input', paintEfisiensi);

/* ---- uploading the groups ---- */

async function uploadGroups(file) {
  const out = $('#effResult');
  out.innerHTML = `<div class="result result-ok">Membaca ${esc(file.name)}…</div>`;
  const body = new FormData();
  body.append('file', file);
  try {
    const res = await fetch('/api/efisiensi-kain/kelompok', { method: 'POST', body });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Upload gagal');
    out.innerHTML = `<div class="result result-ok"><div class="result-title">${
      fmt.int(d.written)} kode kain ditambahkan atau diperbarui dari sheet ${esc(d.sheet)}</div>${
      d.kept ? `<p>${fmt.int(d.kept)} kode sudah punya grup tetap dan tidak diubah.</p>` : ''}</div>`;
    await loadEfisiensi();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Gagal</div><p>${esc(err.message)}</p></div>`;
  }
}

$('#effBrowse').addEventListener('click', () => $('#effFile').click());
$('#effFile').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadGroups(e.target.files[0]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  $('#effDrop').addEventListener(ev, (e) => { e.preventDefault(); $('#effDrop').classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('#effDrop').addEventListener(ev, (e) => { e.preventDefault(); $('#effDrop').classList.remove('is-over'); }));
$('#effDrop').addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadGroups(file);
});
