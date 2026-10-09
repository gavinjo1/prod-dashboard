/**
 * Import tab: uploads, recent imports and undo.
 */
import { $, $$ } from '../core/dom.js';
import { api, session, state } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { loadFilters } from './filters.js';
import { refresh } from './shell.js';

/* ------------------------------------------------------------------ *
 * Import panel
 * ------------------------------------------------------------------ */

/**
 * Recent imports, newest first, with undo on the most recent one still
 * standing. Only that one: restoring an older batch would put back values a
 * later import has since replaced.
 */
export async function loadBatches() {
  const host = $('#batches');
  if (!host) return;
  let rows;
  try {
    // The family on screen as it is: Semua lists every family's imports.
    rows = await api('batches', { family: state.family });
  } catch {
    host.innerHTML = '';     // viewers cannot see this; that is fine
    return;
  }

  host.innerHTML = rows.map((b) => `
    <div class="batch">
      <span class="batch-file">${esc(b.file_name)}</span>
      <span class="batch-meta">${esc(b.at)}${b.imported_by ? ` · ${esc(b.imported_by)}` : ''} · ${
        fmt.int(b.rows_touched)} baris${b.rows_new ? `, ${fmt.int(b.rows_new)} baru` : ''}</span>
      ${b.undone_at
        ? `<span class="batch-undone">dibatalkan ${esc(b.undone_at)}${b.undone_by ? ` oleh ${esc(b.undone_by)}` : ''}</span>`
        : b.can_undo
          ? `<button class="btn" data-undo="${b.id}">Batalkan import ini</button>`
          : ''}
    </div>`).join('');
}

$('#batches')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-undo]');
  if (!btn) return;
  if (!confirm('Batalkan import ini? Semua baris yang ditimpanya akan dikembalikan ke nilai sebelumnya.')) return;

  btn.disabled = true;
  btn.textContent = 'Membatalkan…';
  const out = $('#importResult');
  try {
    const res = await fetch(`/api/batches/${btn.dataset.undo}/undo`, { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal membatalkan');
    out.innerHTML = `<div class="result result-ok">
      <div class="result-title">Import dibatalkan — ${esc(d.file_name)}</div>
      <p>${fmt.int(d.restored)} baris dikembalikan ke nilai sebelumnya${
        d.deleted ? `, ${fmt.int(d.deleted)} baris yang baru dibuat dihapus` : ''}.</p></div>`;
    await loadFilters();
    $$('.picker').forEach((p) => p._sync?.());
    await loadImportLog();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Tidak dibatalkan</div><p>${esc(err.message)}</p></div>`;
    btn.disabled = false;
    btn.textContent = 'Batalkan import ini';
  }
});

export async function loadImportLog() {
  await Promise.all([loadBatches(), loadConflicts()]);
  const rows = await fetch(`/api/imports?${new URLSearchParams({ family: state.family })}`).then((r) => r.json());
  $('#importLog tbody').innerHTML = rows.map((r) => `
    <tr>
      <td class="muted nowrap">${esc(r.at)}</td>
      <td>${esc(r.file_name)}</td>
      <td class="muted">${esc(r.sheet_name ?? '—')}</td>
      <td class="num">${fmt.int(r.rows_written)}</td>
      <td class="num">${r.rows_skipped || '—'}</td>
      <td class="muted">${esc(r.imported_by ?? '')}</td>
      <td>${r.undone_at
        ? `<span class="pill pill-undone">dibatalkan</span> <span class="muted">${esc(r.undone_at)}${
          r.undone_by ? ` oleh ${esc(r.undone_by)}` : ''}</span>`
        : `<span class="pill pill-${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span>`}${
        r.message ? ` <span class="muted">${esc(r.message)}</span>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">Belum ada import.</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Upload: preview first, then save
 *
 * The file is read and checked against what is stored without keeping
 * anything (dry run): rows new, changed, unchanged, and refused because they
 * were typed or corrected on the dashboard. Only "Simpan import" writes it —
 * all of it or, if anything fails, none.
 * ------------------------------------------------------------------ */

let pending = null;

const sheetLine = (r, dry) => {
  if (r.status !== 'ok') return `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.message)}</li>`;
  if (r.dataset === 'production' || r.dataset === 'shuttle' || r.dataset === 'grade') {
    const conflicts = r.conflicts ?? 0;
    return `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.dataset)}: ${fmt.int(r.inserted ?? 0)} baru, ${
      fmt.int(r.updated ?? 0)} ${dry ? 'akan diperbarui' : 'diperbarui'}, ${fmt.int(r.unchanged ?? 0)} sama${
      conflicts ? `, <span class="import-warn">${fmt.int(conflicts)} tidak ditimpa (diisi di dashboard)</span>` : ''}${
      r.skipped ? `, ${r.skipped} dilewati` : ''}${r.duplicates ? `, ${r.duplicates} duplikat digabung` : ''}${
      (r.conflict_sample ?? []).length ? `<br><span class="muted">${r.conflict_sample.map((c) =>
        `${esc(c.no_mc)} ${esc(fmt.day(c.tgl))} ${esc(c.shift)}`).join(', ')}${conflicts > r.conflict_sample.length ? ', …' : ''}</span>` : ''}${
      r.warning ? `<br><span class="import-warn">⚠ ${esc(r.warning)}</span>` : ''}</li>`;
  }
  return `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.dataset)}: ${fmt.int(r.written ?? 0)} ${dry ? 'akan ditulis' : 'ditulis'}</li>`;
};

async function sendImport(dry) {
  const file = pending;
  const drop = $('#drop');
  const out = $('#importResult');
  drop.classList.add('is-busy');
  out.innerHTML = `<div class="result result-ok">${dry ? 'Membaca' : 'Menyimpan'} ${esc(file.name)}…</div>`;

  const body = new FormData();
  body.append('file', file);
  // The sheet never says which looms it is about, so the family selected on
  // screen is what tags the rows. Uploading a Rapier workbook while AJL is
  // showing would file it under AJL. Semua takes the combined report only.
  body.append('family', state.family);
  if (dry) body.append('dry', '1');

  try {
    const res = await fetch('/api/import', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import gagal');

    const ok = data.results.filter((r) => r.status === 'ok');
    const bad = data.results.filter((r) => r.status !== 'ok');
    const sum = (k) => ok.reduce((t, r) => t + (r[k] ?? 0), 0);
    const added = sum('inserted');
    const changed = sum('updated');
    const same = sum('unchanged');
    const conflicts = sum('conflicts');

    if (dry) {
      out.innerHTML = `
        <div class="result ${bad.length || conflicts ? 'result-err' : 'result-ok'}">
          <div class="result-title">Preview ${esc(data.file)}: ${fmt.int(added)} baru, ${fmt.int(changed)} akan diperbarui, ${
            fmt.int(same)} sama${conflicts ? `, ${fmt.int(conflicts)} tidak ditimpa` : ''} — belum disimpan</div>
          <ul>${data.results.map((r) => sheetLine(r, true)).join('')}</ul>
          ${conflicts ? '<p>Baris yang sudah diisi atau dikoreksi di dashboard tidak ditimpa. Setelah disimpan, perbedaannya muncul di Konflik import di bawah.</p>' : ''}
          <div class="mm-save">
            <button class="btn btn-primary" id="importSave">Simpan import</button>
            <button class="btn btn-quiet" id="importCancel">Batal</button>
          </div>
        </div>`;
      return;
    }

    pending = null;
    out.innerHTML = `
      <div class="result ${bad.length ? 'result-err' : 'result-ok'}">
        <div class="result-title">${fmt.int(added)} baris baru, ${fmt.int(changed)} diperbarui, ${fmt.int(same)} sama — dari ${esc(data.file)}</div>
        <ul>${data.results.map((r) => sheetLine(r, false)).join('')}</ul>
      </div>`;
    await Promise.all([loadFilters(), loadImportLog()]);
    await refresh();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Gagal import ${esc(file.name)}</div><p>${esc(err.message)}</p></div>`;
  } finally {
    drop.classList.remove('is-busy');
  }
}

export async function uploadFile(file) {
  pending = file;
  await sendImport(true);
}

$('#importResult').addEventListener('click', (e) => {
  if (e.target.closest('#importSave') && pending) sendImport(false);
  if (e.target.closest('#importCancel')) { pending = null; $('#importResult').innerHTML = ''; }
});

/* ------------------------------------------------------------------ *
 * Import conflicts
 * ------------------------------------------------------------------ */

const FIELD_LABEL = {
  produksi: 'Meter', ketik_prod: 'Ketik / COUNT', ketik: 'Ketik', sodokan: 'Sodokan', rpm: 'RPM',
  rpm_target: 'RPM target', mo: 'MO', kode_kain: 'Kain', ket_bb: 'KET', jml_kain: 'Jumlah kain',
  type_mc: 'Tipe', kelompok_mesin: 'Kelompok', hit_rpm: 'HIT RPM', ketik_rpm: 'Ketik RPM',
  grade_a: 'A', grade_b: 'B', bs: 'BS', rk: 'RK', total: 'Total'
};
const show = (v) => (v === null || v === undefined || v === '' ? '—'
  : typeof v === 'number' ? fmt.num(v) : esc(String(v)));

export async function loadConflicts() {
  const card = $('#conflictCard');
  if (!card) return;
  const res = await fetch(`/api/import/conflicts?${new URLSearchParams({ family: state.family })}`);
  if (!res.ok) { card.hidden = true; return; }
  const rows = await res.json();
  card.hidden = false;
  const admin = session.role === 'admin';
  $('#conflictCount').hidden = !rows.length;
  $('#conflictCount').textContent = fmt.int(rows.length);
  $('#conflictTable thead').innerHTML = `<tr><th>Tanggal</th><th>Shift</th><th>Mesin</th><th>Yang beda (dashboard → file)</th>
    <th>File</th><th>Dicatat</th><th></th></tr>`;
  $('#conflictTable tbody').innerHTML = rows.map((c) => `<tr data-id="${c.id}">
      <td class="nowrap">${esc(fmt.day(c.key.tgl))} ${esc(c.key.tgl.slice(0, 4))}</td><td>${esc(c.key.shift ?? '')}</td>
      <td class="mc-name">${esc(c.key.no_mc ?? c.key.mo ?? '')}${state.family === 'semua' ? ` <span class="muted">${esc(c.key.family)}</span>` : ''}</td>
      <td>${c.differences.map((d) => `${esc(FIELD_LABEL[d.field] ?? d.field)}: <strong>${show(d.dashboard)}</strong> → ${show(d.file)}`).join('<br>')}</td>
      <td class="muted">${esc(c.file ?? '')}</td><td class="muted nowrap">${esc(c.created_at)}</td>
      <td class="nowrap">${admin ? `<button class="btn btn-quiet" data-resolve="keep">Pakai dashboard</button>
        <button class="btn btn-quiet" data-resolve="replace">Pakai file</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">Tidak ada konflik.</td></tr>';
}

$('#conflictTable')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-resolve]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const action = btn.dataset.resolve;
  if (!confirm(action === 'keep' ? 'Pakai angka dashboard dan tutup konflik ini?'
    : 'Ganti angka dashboard dengan angka dari file? Perubahan ini tercatat.')) return;
  const out = $('#conflictOut');
  try {
    const res = await fetch(`/api/import/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal');
    out.innerHTML = `<div class="result result-ok"><div class="result-title">${action === 'keep' ? 'Angka dashboard dipakai' : 'Angka dari file dipakai'}</div></div>`;
    await loadConflicts();
    if (action === 'replace') await refresh();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Tidak berhasil</div><p>${esc(err.message)}</p></div>`;
  }
});

export const drop = $('#drop');
$('#browse').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});
