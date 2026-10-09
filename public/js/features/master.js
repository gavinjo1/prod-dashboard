/**
 * Master MO: PPIC's list of orders — one MO, one fabric, one pick — its
 * changes, the MASTER PRODUCT upload, and bringing old production in line.
 */
import { $ } from '../core/dom.js';
import { api, isCurrent, session, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';

/* ------------------------------------------------------------------ *
 * The rules the page follows (see server/routes/master.js)
 *
 * Changing an MO never changes production already saved; the page says what
 * no longer matches, and bringing those rows in line is a separate button,
 * with a reason, over the dates chosen. Only admins change anything.
 * ------------------------------------------------------------------ */

const mm = { list: [], q: '', mo: null, file: null };
const admin = () => session.role === 'admin';

const FIELDS = [
  ['so', 'SO'], ['kode_kain', 'Kode kain'], ['pick', 'Pick', 'num'], ['lusi_per_inch', 'Lusi/inch', 'num'],
  ['lebar_inch', 'Lebar (inch)', 'num'], ['lebar_cm', 'Lebar (cm)', 'num'], ['konstruksi', 'Konstruksi'],
  ['lusi', 'Lusi'], ['ne_lusi', 'NE lusi'], ['pakan', 'Pakan'], ['ne_pakan', 'NE pakan'], ['benang', 'Benang'],
  ['qty', 'Qty order (m)', 'num'], ['toleransi', 'Toleransi', 'num'], ['customer', 'Customer'],
  ['anyaman', 'Anyaman'], ['tgl_share', 'Tgl share order', 'date']
];
const LABEL = Object.fromEntries(FIELDS.map(([k, l]) => [k, l]));
const FAMILY = { ajl: 'AJL', rapier: 'Rapier', shuttle: 'Shuttle' };

async function call(method, url, body) {
  const res = await fetch(url, body instanceof FormData ? { method, body }
    : { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) return toLogin();
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || res.statusText);
  return d;
}
const ok = (title, body = '') => `<div class="result result-ok"><div class="result-title">${esc(title)}</div>${body}</div>`;
const fail = (title, msg) => `<div class="result result-err"><div class="result-title">${esc(title)}</div><p>${esc(msg)}</p></div>`;
const range = (a, b) => (a === b ? fmt.day(a) : `${fmt.day(a)} – ${fmt.day(b)}`);

/* ---- the list ---- */

function paintList() {
  const rows = mm.list;
  $('#mmTable thead').innerHTML = `<tr><th>MO</th><th>Kode kain</th><th class="num">Pick</th><th class="num">Lebar (cm)</th>
    <th>Konstruksi</th><th>Benang</th><th class="num">Qty</th><th>Customer</th><th>Sumber</th><th>Diubah</th></tr>`;
  $('#mmTable tbody').innerHTML = rows.map((r) => `<tr tabindex="0" data-mo="${esc(r.mo)}"${r.mo === mm.mo ? ' class="is-picked"' : ''}>
      <td class="mc-name nowrap">${esc(r.mo)}</td><td>${esc(r.kode_kain ?? '')}</td>
      <td class="num">${r.pick === null ? '<span class="muted">—</span>' : fmt.num(r.pick)}</td>
      <td class="num">${r.lebar_cm === null ? '' : fmt.num(r.lebar_cm)}</td>
      <td class="muted">${esc(r.konstruksi ?? '')}</td><td class="muted">${esc(r.benang ?? '')}</td>
      <td class="num">${r.qty === null ? '' : fmt.int(r.qty)}</td><td>${esc(r.customer ?? '')}</td>
      <td><span class="pill ${r.source === 'manual' ? 'pill-undone' : 'pill-ok'}">${r.source === 'manual' ? 'diubah manual' : 'import'}</span></td>
      <td class="muted nowrap">${esc(r.updated_at ?? '')}${r.updated_by ? ` · ${esc(r.updated_by)}` : ''}</td></tr>`).join('')
    || `<tr><td colspan="10" class="muted" style="padding:20px;text-align:center">${mm.q
      ? 'Tidak ada MO yang cocok.' : 'Master MO masih kosong. Upload file MASTER PRODUCT dari PPIC.'}</td></tr>`;
}

function paintMismatch(rows) {
  const host = $('#mmMismatch');
  if (!rows.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="result result-err mm-mismatch">
    <div class="result-title">⚠ ${fmt.int(rows.length)} MO punya data produksi yang tidak cocok dengan master</div>
    <p>Produksi yang sudah tersimpan tidak diubah otomatis. Buka MO-nya untuk melihat dan, bila perlu, menerapkan koreksi.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>MO</th><th>Master</th><th>Dipakai di produksi</th>
      <th class="num">Baris</th><th>Tanggal</th></tr></thead><tbody>
    ${rows.map((r) => `<tr tabindex="0" data-mo="${esc(r.mo)}"><td class="mc-name nowrap">${esc(r.mo)}</td>
      <td>${esc(r.kode_kain ?? '—')} · pick ${r.pick === null ? '—' : fmt.num(r.pick)}</td>
      <td>${esc((r.kodes_used ?? []).join(', '))} · pick ${esc((r.picks_used ?? []).map(fmt.num).join(', ') || '—')}</td>
      <td class="num">${fmt.int(r.rows)}</td><td class="nowrap">${range(r.first, r.last)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

export async function loadMaster() {
  const ticket = takeTicket('master');
  const [list, mismatch] = await Promise.all([api('master/mo', { q: mm.q }), api('master/mo/mismatch')]);
  if (!isCurrent('master', ticket)) return;
  mm.list = list;
  $('#mmActions').hidden = !admin();
  const manual = list.filter((r) => r.source === 'manual').length;
  $('#mmSub').textContent = `${fmt.int(list.length)} MO${mm.q ? ' cocok' : ''}${manual ? ` · ${fmt.int(manual)} diubah manual` : ''}. `
    + 'Satu MO = satu kode kain = satu pick. Perubahan di sini tidak mengubah produksi yang sudah tersimpan.';
  paintList();
  paintMismatch(mismatch);
  if (mm.mo) await openDetail(mm.mo, { keepResult: true });
}

let searchTimer;
$('#mmSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { mm.q = e.target.value.trim(); loadMaster(); }, 250);
});
const pick = (e) => {
  const tr = e.target.closest('tr[data-mo]');
  if (!tr || (e.type === 'keydown' && e.key !== 'Enter')) return;
  openDetail(tr.dataset.mo);
};
['click', 'keydown'].forEach((ev) => {
  $('#mmTable').addEventListener(ev, pick);
  $('#mmMismatch').addEventListener(ev, pick);
});

/* ---- one MO ---- */

function formOf(m, isNew, exists = !isNew) {
  const edit = admin();
  const input = ([k, label, kind]) => {
    const v = m?.[k] ?? '';
    const shown = kind === 'num' && v !== '' ? String(v).replace('.', ',') : v;
    return `<label class="field"><span>${esc(label)}</span>${edit
      ? `<input class="mm-in" data-f="${k}" type="${kind === 'date' ? 'date' : 'text'}"${kind === 'num' ? ' inputmode="decimal"' : ''} value="${esc(shown)}">`
      : `<span class="mm-value">${esc(shown || '—')}</span>`}</label>`;
  };
  return `<div class="mm-grid">
      ${isNew && edit ? '<label class="field"><span>MO</span><input class="mm-in" data-f="mo" placeholder="MO/UW/26530"></label>' : ''}
      ${FIELDS.map(input).join('')}
    </div>
    ${edit ? `<div class="mm-save">
      <label class="field mm-reason"><span>Alasan perubahan</span><input id="mmReason" placeholder="contoh: pick dari PPIC dikoreksi"></label>
      <button class="btn btn-primary" id="mmSave">${!exists ? 'Tambahkan ke master' : 'Simpan perubahan'}</button>
      ${exists ? '<button class="btn btn-quiet mm-danger" id="mmDelete">Hapus dari master</button>' : ''}
    </div>` : ''}`;
}

function changesOf(e) {
  if (e.action === 'apply') {
    const a = e.after ?? {};
    return `produksi dikoreksi ke pick ${a.pick ?? '—'}, kain ${esc(a.kode_kain ?? '—')}${a.from || a.to ? ` (${esc(a.from ?? '…')} – ${esc(a.to ?? '…')})` : ''}`;
  }
  if (!e.before) return 'dibuat';
  if (!e.after) return 'dihapus';
  return FIELDS.filter(([k]) => String(e.before[k] ?? '') !== String(e.after[k] ?? ''))
    .map(([k, l]) => `${esc(l)}: ${esc(e.before[k] ?? '—')} → ${esc(e.after[k] ?? '—')}`).join('<br>') || 'tidak ada beda';
}

async function openDetail(mo, { keepResult = false, isNew = false } = {}) {
  const card = $('#mmDetail');
  card.hidden = false;
  mm.mo = isNew ? null : mo;
  paintList();
  if (isNew) {
    card.innerHTML = `<div class="card-head-row"><div class="card-head"><h2>MO baru</h2></div>
      <button class="btn btn-quiet" data-close>Tutup</button></div>${formOf(null, true)}<div id="mmDetailOut"></div>`;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const out = keepResult ? $('#mmDetailOut')?.innerHTML ?? '' : '';
  let d;
  try { d = await api('master/mo/item', { mo }); } catch (err) { card.innerHTML = fail(`Tidak bisa membuka ${mo}`, err.message); return; }
  const mis = d.mismatch;
  card.innerHTML = `
    <div class="card-head-row"><div class="card-head"><h2>${esc(d.mo)}</h2>
      <p class="card-sub">${d.master ? `${esc(d.master.kode_kain ?? '')} · pick ${d.master.pick === null ? '—' : fmt.num(d.master.pick)}${
        d.master.customer ? ` · ${esc(d.master.customer)}` : ''}` : 'Belum ada di master; hanya ada di data produksi.'}</p></div>
      <button class="btn btn-quiet" data-close>Tutup</button></div>
    ${d.master ? formOf(d.master, false) : (admin() ? formOf({ mo: d.mo }, false, false) : '')}
    <div id="mmDetailOut">${out}</div>

    <h3 class="mm-h">Dipakai di produksi</h3>
    ${d.usage.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Jenis</th><th class="num">Pick dipakai</th>
      <th class="num">Baris</th><th class="num">Mesin</th><th>Tanggal</th></tr></thead><tbody>
      ${d.usage.map((u) => `<tr><td>${esc(FAMILY[u.family] ?? u.family)}</td><td class="num">${u.pick === null ? '—' : fmt.num(u.pick)}</td>
        <td class="num">${fmt.int(u.rows)}</td><td class="num">${fmt.int(u.machines)}</td><td class="nowrap">${range(u.first, u.last)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="note-line">Belum pernah dipakai di produksi.</p>'}

    ${mis && mis.rows ? `<h3 class="mm-h">Tidak cocok dengan master</h3>
      <p class="note-line">${fmt.int(mis.rows)} baris produksi dihitung dengan pick atau kain yang berbeda dari master. Angkanya tidak diubah otomatis.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Jenis</th><th class="num">Pick dipakai</th><th>Kain dipakai</th>
        <th class="num">Baris</th><th class="num">SULZER</th><th>Tanggal</th></tr></thead><tbody>
        ${mis.groups.map((g) => `<tr><td>${esc(FAMILY[g.family] ?? g.family)}</td><td class="num">${g.pick === null ? '—' : fmt.num(g.pick)}</td>
          <td>${esc(g.kode_kain ?? '—')}</td><td class="num">${fmt.int(g.rows)}</td><td class="num">${g.sulzer ? fmt.int(g.sulzer) : ''}</td>
          <td class="nowrap">${range(g.first, g.last)}</td></tr>`).join('')}
      </tbody></table></div>
      ${admin() ? `<div class="mm-apply">
        <label class="field"><span>Dari</span><input type="date" id="mmApFrom"></label>
        <label class="field"><span>Sampai</span><input type="date" id="mmApTo"></label>
        <label class="field mm-reason"><span>Alasan koreksi</span><input id="mmApReason" placeholder="contoh: pick salah ketik di master"></label>
        <button class="btn btn-primary" id="mmApply">Terapkan master ke produksi</button>
      </div>
      <p class="note-line">Pick dan kain baris-baris itu diganti dengan nilai master. Meter SULZER dihitung ulang dengan pick baru; meter mesin lain tidak bergantung pada pick. Setiap baris tercatat.</p>` : ''}` : ''}

    <h3 class="mm-h">Riwayat</h3>
    ${d.log.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Waktu</th><th>Aksi</th><th>Oleh</th><th>Perubahan</th>
      <th>Alasan</th><th class="num">Baris terdampak</th></tr></thead><tbody>
      ${d.log.map((e) => `<tr><td class="nowrap muted">${esc(e.changed_at)}</td>
        <td>${esc({ create: 'dibuat', update: 'diubah', delete: 'dihapus', apply: 'koreksi produksi' }[e.action] ?? e.action)}</td>
        <td class="muted">${esc(e.changed_by ?? '')}</td><td>${changesOf(e)}</td><td class="muted">${esc(e.reason ?? '')}</td>
        <td class="num">${e.affected === null ? '' : fmt.int(e.affected)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="note-line">Belum ada perubahan tercatat.</p>'}`;
  if (!keepResult) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#mmDetail').addEventListener('click', async (e) => {
  const out = $('#mmDetailOut');
  if (e.target.closest('[data-close]')) { $('#mmDetail').hidden = true; mm.mo = null; paintList(); return; }

  if (e.target.closest('#mmSave')) {
    const body = { reason: $('#mmReason').value };
    document.querySelectorAll('#mmDetail .mm-in').forEach((el) => { body[el.dataset.f] = el.value; });
    body.mo = body.mo ?? mm.mo ?? $('#mmDetail h2').textContent;
    try {
      const d = await call('PUT', '/api/master/mo/item', body);
      mm.mo = d.mo;
      await loadMaster();
      $('#mmDetailOut').innerHTML = ok(d.changed.length ? `${d.mo} tersimpan` : 'Tidak ada yang berubah',
        d.affected?.rows ? `<p>${fmt.int(d.affected.rows)} baris produksi masih memakai nilai lama dan tidak diubah. Terapkan koreksi di bawah bila memang perlu.</p>` : '');
    } catch (err) { out.innerHTML = fail('Tidak tersimpan', err.message); }
  }

  if (e.target.closest('#mmDelete')) {
    if (!confirm(`Hapus ${mm.mo} dari master? Produksi yang sudah tersimpan tidak berubah.`)) return;
    try {
      await call('DELETE', `/api/master/mo/item?${new URLSearchParams({ mo: mm.mo, reason: $('#mmReason').value })}`);
      $('#mmDetail').hidden = true;
      mm.mo = null;
      await loadMaster();
    } catch (err) { out.innerHTML = fail('Tidak terhapus', err.message); }
  }

  if (e.target.closest('#mmApply')) {
    const body = { mo: mm.mo, from: $('#mmApFrom').value, to: $('#mmApTo').value, reason: $('#mmApReason').value };
    if (!body.reason.trim()) { out.innerHTML = fail('Alasan wajib diisi', 'Tulis kenapa produksi lama dikoreksi.'); return; }
    if (!confirm(`Terapkan master ${mm.mo} ke produksi${body.from || body.to ? ` (${body.from || '…'} – ${body.to || '…'})` : ''}? Setiap baris yang diubah tercatat.`)) return;
    try {
      const d = await call('POST', '/api/master/mo/apply', body);
      await openDetail(mm.mo, { keepResult: true });
      $('#mmDetailOut').innerHTML = ok(`${fmt.int(d.corrected)} baris produksi dikoreksi`);
      loadMaster();
    } catch (err) { out.innerHTML = fail('Koreksi tidak diterapkan', err.message); }
  }
});

$('#mmNew').addEventListener('click', () => openDetail(null, { isNew: true }));

/* ---- the MASTER PRODUCT upload: preview first, then save ---- */

async function uploadMaster(save) {
  const host = $('#mmImport');
  const body = new FormData();
  body.append('file', mm.file);
  if (!save) body.append('dry', '1');
  if ($('#mmOverwrite')?.checked) body.append('overwrite', '1');
  host.innerHTML = ok(`Membaca ${mm.file.name}…`);
  try {
    const d = await call('POST', '/api/master/mo/import', body);
    if (save) {
      host.innerHTML = ok(`Master tersimpan dari ${d.file}: ${fmt.int(d.added)} MO baru, ${fmt.int(d.changed.length)} diubah, ${fmt.int(d.unchanged)} sama.`);
      mm.file = null;
      await loadMaster();
      return;
    }
    const pickChanges = d.changed.filter((c) => c.pick);
    host.innerHTML = `<div class="result ${d.changed.length || d.kept_manual.length ? 'result-err' : 'result-ok'}">
      <div class="result-title">Preview ${esc(d.file)} (sheet ${esc(d.sheet)}): ${fmt.int(d.read)} MO dibaca —
        ${fmt.int(d.added)} baru, ${fmt.int(d.changed.length)} berubah, ${fmt.int(d.unchanged)} sama</div>
      <ul>
        ${d.changed.map((c) => `<li><strong>${esc(c.mo)}</strong>: ${c.fields.map((f) => esc(LABEL[f] ?? f)).join(', ')}${
          c.pick ? ` (pick ${c.pick.before ?? '—'} → ${c.pick.after ?? '—'})` : ''}</li>`).join('')}
        ${d.kept_manual.map((c) => `<li><strong>${esc(c.mo)}</strong> diubah manual di dashboard; file berbeda di ${c.fields.map((f) => esc(LABEL[f] ?? f)).join(', ')} — tidak ditimpa kecuali dicentang di bawah.</li>`).join('')}
      </ul>
      ${d.production_mismatch.length ? `<p>Setelah disimpan, ${fmt.int(d.production_mismatch.length)} MO punya produksi yang tidak cocok dengan master (${
        d.production_mismatch.map((m) => `${esc(m.mo)}: ${fmt.int(m.rows)} baris`).join(', ')}). Produksi itu tidak diubah otomatis.</p>` : ''}
      ${pickChanges.length ? `<p>⚠ ${fmt.int(pickChanges.length)} MO berganti pick.</p>` : ''}
      ${d.skipped.length ? `<details><summary>${fmt.int(d.skipped.length)} baris dilewati</summary><ul>${
        d.skipped.map((s) => `<li>baris ${s.row}: ${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}
      <div class="mm-save">
        ${d.kept_manual.length ? '<label class="mm-check"><input type="checkbox" id="mmOverwrite"> Timpa juga MO yang diubah manual</label>' : ''}
        <button class="btn btn-primary" id="mmImportSave">Simpan ke master</button>
        <button class="btn btn-quiet" id="mmImportCancel">Batal</button>
      </div></div>`;
  } catch (err) {
    host.innerHTML = fail(`Gagal membaca ${mm.file?.name ?? 'file'}`, err.message);
  }
}

$('#mmUpload').addEventListener('click', () => $('#mmFile').click());
$('#mmFile').addEventListener('change', (e) => {
  if (!e.target.files[0]) return;
  mm.file = e.target.files[0];
  e.target.value = '';
  uploadMaster(false);
});
$('#mmImport').addEventListener('click', (e) => {
  if (e.target.closest('#mmImportSave')) uploadMaster(true);
  if (e.target.closest('#mmImportCancel')) { mm.file = null; $('#mmImport').innerHTML = ''; }
});
