/**
 * Data Mesin: the family's looms as the registry has them, and the saved
 * metres checked against the family's formula.
 */
import { $ } from '../core/dom.js';
import { api, isCurrent, session, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { FAMILY_LABEL } from './family.js';

/* ------------------------------------------------------------------ *
 * The registry
 *
 * What each loom is: type, group, fabrics woven at once (or width, for a
 * shuttle loom), target RPM, active. A shift typed in takes these from here;
 * a row already saved keeps what it was worked out with. Only admins change it.
 * ------------------------------------------------------------------ */

const rg = { rows: [], q: '', edit: null, types: null };
const admin = () => session.role === 'admin';

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) return toLogin();
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || res.statusText);
  return d;
}
const ok = (title, body = '') => `<div class="result result-ok"><div class="result-title">${esc(title)}</div>${body}</div>`;
const fail = (title, msg) => `<div class="result result-err"><div class="result-title">${esc(title)}</div><p>${esc(msg)}</p></div>`;

function paintRegistry() {
  const shuttle = state.family === 'shuttle';
  const rows = rg.rows.filter((r) => !rg.q || r.no_mc.toLowerCase().includes(rg.q)
    || String(r.type_mc ?? '').toLowerCase().includes(rg.q) || String(r.kelompok_mesin ?? '').toLowerCase().includes(rg.q));
  $('#rgTable thead').innerHTML = `<tr><th>Mesin</th><th>Tipe</th><th>Kelompok</th>
    <th class="num">${shuttle ? 'Lebar' : 'Jumlah kain'}</th><th class="num">RPM target</th><th>Status</th>
    <th>Data terakhir</th><th>Catatan</th><th>Diubah</th><th></th></tr>`;
  const cell = (r, f, extra = '') => `<input class="si-in rg-in" data-f="${f}" value="${esc(r[f] ?? '')}" ${extra}>`;
  $('#rgTable tbody').innerHTML = rows.map((r) => (rg.edit === r.no_mc ? `<tr data-mc="${esc(r.no_mc)}" class="is-picked">
      <td class="mc-name">${esc(r.no_mc)}</td><td>${cell(r, 'type_mc')}</td><td>${cell(r, 'kelompok_mesin')}</td>
      <td class="num">${shuttle ? cell(r, 'width', 'inputmode="numeric"') : cell(r, 'jml_kain', 'inputmode="decimal"')}</td>
      <td class="num">${shuttle ? `<span class="muted">${fmt.int(r.rpm_target)} (tetap)</span>` : cell(r, 'rpm_target', 'inputmode="numeric"')}</td>
      <td><label class="mm-check"><input type="checkbox" class="rg-in" data-f="active"${r.active ? ' checked' : ''}> aktif</label></td>
      <td class="muted nowrap">${r.last_seen ? esc(fmt.day(r.last_seen)) : '—'}</td>
      <td>${cell(r, 'note')}</td>
      <td colspan="2" class="rg-actions"><input class="si-in rg-in rg-reason" data-f="reason" placeholder="alasan">
        <button class="btn btn-primary" data-act="save">Simpan</button><button class="btn btn-quiet" data-act="cancel">Batal</button></td>
    </tr>` : `<tr data-mc="${esc(r.no_mc)}"${r.active ? '' : ' class="rg-off"'}>
      <td class="mc-name">${esc(r.no_mc)}</td><td>${esc(r.type_mc ?? '')}</td><td>${esc(r.kelompok_mesin ?? '')}</td>
      <td class="num">${shuttle ? (r.width ?? '—') : (r.jml_kain === null ? '—' : fmt.num(r.jml_kain))}</td>
      <td class="num">${r.rpm_target === null ? '—' : fmt.int(r.rpm_target)}</td>
      <td><span class="pill ${r.active ? 'pill-ok' : 'pill-undone'}">${r.active ? 'aktif' : 'tidak aktif'}</span></td>
      <td class="muted nowrap">${r.last_seen ? esc(fmt.day(r.last_seen)) : '—'}</td>
      <td class="muted">${esc(r.note ?? '')}</td>
      <td class="muted nowrap">${esc(r.updated_by ? `${r.updated_at} · ${r.updated_by}` : '')}</td>
      <td>${admin() ? '<button class="btn btn-quiet" data-act="edit">Ubah</button>' : ''}</td></tr>`)).join('')
    || '<tr><td colspan="10" class="muted" style="padding:20px;text-align:center">Tidak ada mesin yang cocok.</td></tr>';
}

export async function loadMesin() {
  const family = state.family;
  const ticket = takeTicket('mesin');
  const [rows, types] = await Promise.all([api('machine-registry', { family }), rg.types ?? api('machine-types')]);
  if (!isCurrent('mesin', ticket)) return;
  rg.rows = rows;
  rg.types = types;
  rg.edit = null;
  const t = types[family];
  const active = rows.filter((r) => r.active).length;
  $('#rgTitle').textContent = `Data mesin ${FAMILY_LABEL[family] ?? family}`;
  $('#rgSub').textContent = `${fmt.int(rows.length)} mesin, ${fmt.int(active)} aktif. Isian per shift: ${
    t.fields.map((f) => f.label).join(', ')}. ${t.output}. Mengubah data mesin hanya berlaku untuk input berikutnya.`;
  $('#rcSub').textContent = 'Meter yang tersimpan dihitung ulang dari angka mentahnya dengan rumus dashboard, '
    + 'dikelompokkan menurut asal angkanya. Untuk data dari Excel, ini sekaligus pencocokan dashboard dengan Excel.';
  $('#rgResult').innerHTML = '';
  $('#rcOut').innerHTML = '';
  paintRegistry();
}

$('#rgSearch').addEventListener('input', (e) => { rg.q = e.target.value.trim().toLowerCase(); paintRegistry(); });

$('#rgTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const no_mc = tr.dataset.mc;
  if (btn.dataset.act === 'edit') {
    rg.edit = no_mc;
    paintRegistry();
    // The table was drawn again; the row being changed is the new one.
    $('#rgTable tr.is-picked .rg-in')?.focus();
    return;
  }
  if (btn.dataset.act === 'cancel') { rg.edit = null; paintRegistry(); return; }
  if (btn.dataset.act === 'save') {
    const body = { family: state.family, no_mc };
    tr.querySelectorAll('.rg-in').forEach((el) => { body[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
    try {
      await call('PUT', '/api/machine-registry', body);
      await loadMesin();
      $('#rgResult').innerHTML = ok(`${no_mc} tersimpan`, '<p>Berlaku untuk input shift berikutnya; baris yang sudah tersimpan tidak berubah.</p>');
    } catch (err) {
      $('#rgResult').innerHTML = fail(`${no_mc} tidak tersimpan`, err.message);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The formula check
 * ------------------------------------------------------------------ */

const ORIGIN = {
  excel: 'Dari Excel (import)', typed: 'Diketik orang', '-': 'Tanpa keterangan',
  'ajl-1': 'Rumus dashboard v1', 'rapier-1': 'Rumus dashboard v1', 'shuttle-1': 'Rumus dashboard v1'
};

async function runCheck() {
  const out = $('#rcOut');
  out.innerHTML = ok('Menghitung…');
  try {
    // Dates of its own, not the hidden filter's: empty means every day.
    const d = await api('production/recalc-check', { family: state.family, from: $('#rcFrom').value, to: $('#rcTo').value });
    const differ = d.groups.reduce((t, g) => t + g.differ, 0);
    const redoable = d.groups.filter((g) => g.calc !== 'typed' && g.calc !== 'excel').reduce((t, g) => t + g.differ, 0);
    out.innerHTML = `
      <p class="note-line">Rumus: ${esc(d.formula)} (${esc(d.calc)}).</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Asal angka</th><th class="num">Baris</th><th class="num">Cocok</th>
        <th class="num">Beda</th><th class="num">Tak bisa dihitung</th><th class="num">Meter tersimpan</th><th class="num">Meter rumus</th>
        <th class="num">Selisih</th></tr></thead><tbody>
        ${d.groups.map((g) => `<tr><td>${esc(ORIGIN[g.calc] ?? g.calc)} <span class="muted">${esc(g.calc)}</span></td>
          <td class="num">${fmt.int(g.rows)}</td><td class="num">${fmt.int(g.match)}</td>
          <td class="num${g.differ ? ' rc-bad' : ''}">${fmt.int(g.differ)}</td><td class="num muted">${fmt.int(g.cannot)}</td>
          <td class="num">${fmt.num(g.stored_m)}</td><td class="num">${fmt.num(g.formula_m)}</td>
          <td class="num">${fmt.num(Math.round((g.stored_m - g.formula_m) * 100) / 100)}</td></tr>`).join('')}
      </tbody></table></div>
      ${d.groups.filter((g) => g.sample.length).map((g) => `<details class="note"><summary>Contoh yang beda — ${esc(ORIGIN[g.calc] ?? g.calc)}</summary><ul>${
        g.sample.map((s) => `<li>${esc(fmt.day(s.tgl))} shift ${esc(s.shift)} ${esc(s.no_mc)}: tersimpan ${fmt.num(s.stored)} m, rumus ${fmt.num(s.formula)} m</li>`).join('')}</ul></details>`).join('')}
      <p class="note-line">"Tak bisa dihitung": angka mentahnya tidak ada (ketik kosong, kain belum ada di tabel SODOKAN). Baris "Diketik orang" tidak pernah dihitung ulang.</p>
      ${admin() && differ ? `<div class="mm-apply">
        <label class="field mm-reason"><span>Alasan hitung ulang</span><input id="rcReason" placeholder="contoh: rumus diperbarui"></label>
        <label class="mm-check"><input type="checkbox" id="rcExcel"> termasuk baris dari Excel</label>
        <button class="btn btn-primary" id="rcRedo">Hitung ulang yang beda</button>
      </div>
      <p class="note-line">${fmt.int(redoable)} baris hasil dashboard berbeda dari rumus sekarang. Baris dari Excel hanya ikut bila dicentang.</p>` : ''}`;
  } catch (err) {
    out.innerHTML = fail('Cek gagal', err.message);
  }
}

$('#rcRun').addEventListener('click', runCheck);
$('#rcOut').addEventListener('click', async (e) => {
  if (!e.target.closest('#rcRedo')) return;
  const reason = $('#rcReason').value.trim();
  if (!reason) { $('#rcOut').insertAdjacentHTML('afterbegin', fail('Alasan wajib diisi', 'Tulis kenapa meter dihitung ulang.')); return; }
  const excel = $('#rcExcel').checked;
  if (!confirm(`Hitung ulang meter yang berbeda dari rumus${excel ? ', termasuk baris dari Excel' : ''}? Setiap baris yang diubah tercatat.`)) return;
  try {
    const d = await call('POST', '/api/production/recalc', { family: state.family, from: $('#rcFrom').value,
      to: $('#rcTo').value, reason, include_excel: excel });
    await runCheck();
    $('#rcOut').insertAdjacentHTML('afterbegin', ok(`${fmt.int(d.recalculated)} baris dihitung ulang (${d.calc})`));
  } catch (err) {
    $('#rcOut').insertAdjacentHTML('afterbegin', fail('Tidak dihitung ulang', err.message));
  }
});
