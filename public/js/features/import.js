/**
 * Import tab: uploads, recent imports and undo.
 */
import { $, $$ } from '../core/dom.js';
import { api, state } from '../core/state.js';
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
  await loadBatches();
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

export async function uploadFile(file) {
  const drop = $('#drop');
  const out = $('#importResult');
  drop.classList.add('is-busy');
  out.innerHTML = `<div class="result result-ok">Membaca ${esc(file.name)}…</div>`;

  const body = new FormData();
  body.append('file', file);
  // The sheet never says which looms it is about, so the family selected on
  // screen is what tags the rows. Uploading a Rapier workbook while AJL is
  // showing would file it under AJL. Semua takes the combined report only.
  body.append('family', state.family);

  try {
    const res = await fetch('/api/import', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import gagal');

    const ok = data.results.filter((r) => r.status === 'ok');
    const bad = data.results.filter((r) => r.status !== 'ok');
    const added = ok.reduce((t, r) => t + (r.inserted ?? 0), 0);
    const changed = ok.reduce((t, r) => t + (r.updated ?? 0), 0);

    out.innerHTML = `
      <div class="result ${bad.length ? 'result-err' : 'result-ok'}">
        <div class="result-title">${fmt.int(added)} baris baru, ${fmt.int(changed)} diperbarui — dari ${esc(data.file)}</div>
        <ul>
          ${data.results.map((r) => r.status === 'ok'
            ? `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.dataset)}: ${fmt.int(r.inserted ?? 0)} baru, ${fmt.int(r.updated ?? 0)} diperbarui, ${r.skipped} dilewati${r.duplicates ? `, ${r.duplicates} duplikat digabung` : ''}${
              r.warning ? `<br><span class="import-warn">⚠ ${esc(r.warning)}</span>` : ''}</li>`
            : `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.message)}</li>`).join('')}
        </ul>
      </div>`;

    await Promise.all([loadFilters(), loadImportLog()]);
    await refresh();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Gagal import ${esc(file.name)}</div><p>${esc(err.message)}</p></div>`;
  } finally {
    drop.classList.remove('is-busy');
  }
}

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
