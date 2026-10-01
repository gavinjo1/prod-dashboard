/**
 * Produksi: correcting or deleting one shift.
 */
import { $ } from '../../core/dom.js';
import { FAMILY_LABEL } from '../family.js';
import { toLogin } from '../../core/state.js';
import { drawerMachine, drawerRows, openMachine } from './machines.js';
import { fmt } from '../../charts/core.js';
import { refresh } from '../shell.js';

/* ---- editing one row ---- */

export let editing = null;
export const edSay = (text, kind) => {
  $('#edMsg').textContent = text;
  $('#edMsg').className = `pw-msg ${kind ? `is-${kind}` : ''}`;
};

$('#drawerTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  const r = drawerRows.find((x) => String(x.id) === btn.dataset.edit);
  if (!r) return;
  editing = r;
  $('#edWho').textContent =
    `Mesin ${r.no_mc} · ${fmt.day(r.date)} · shift ${r.shift} · ${FAMILY_LABEL[r.family] ?? r.family}`;
  $('#edMo').value = r.mo ?? '';
  $('#edKode').value = r.kode_kain ?? '';
  $('#edProd').value = r.produksi ?? '';
  $('#edRpm').value = r.rpm ?? '';
  $('#edTarget').value = r.rpm_target ?? '';
  $('#edJam1').value = r.jam_mulai ?? '';
  $('#edJam2').value = r.jam_selesai ?? '';
  $('#edKet').value = r.ket_bb ?? '';
  // The workbook is the record: a fix made only here is undone by the next
  // import of the same file, so say so while there is still time to act on it.
  $('#edWarn').textContent = r.source_file && r.source_file !== 'manual entry'
    ? `Baris ini dari file "${r.source_file}". Perbaiki juga di Excel-nya — ` +
      'kalau file itu diimport lagi, perbaikan di sini akan tertimpa.'
    : '';
  edSay('');
  $('#editDialog').showModal();
  $('#edProd').focus();
});

$('#edCancel').addEventListener('click', () => $('#editDialog').close());

export async function afterRowChange(message) {
  $('#editDialog').close();
  await openMachine(drawerMachine);
  // The totals, charts and machine list all include this row.
  refresh();
  $('#drawerTitle').textContent += ` — ${message}`;
}

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  $('#edSave').disabled = true;
  edSay('…');
  try {
    const res = await fetch(`/api/production/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mo: $('#edMo').value, kode_kain: $('#edKode').value,
        produksi: $('#edProd').value, rpm: $('#edRpm').value, rpm_target: $('#edTarget').value,
        jam_mulai: $('#edJam1').value, jam_selesai: $('#edJam2').value, ket_bb: $('#edKet').value
      })
    });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal menyimpan.');
    await afterRowChange('perubahan tersimpan');
  } catch (err) {
    edSay(err.message, 'err');
  } finally {
    $('#edSave').disabled = false;
  }
});

$('#edDelete').addEventListener('click', async () => {
  if (!editing) return;
  if (!confirm(`Hapus baris mesin ${editing.no_mc}, ${fmt.day(editing.date)} shift ${editing.shift}? ` +
    'Isinya tetap tersimpan di riwayat perubahan.')) return;
  try {
    const res = await fetch(`/api/production/${editing.id}`, { method: 'DELETE' });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal menghapus.');
    await afterRowChange('baris dihapus');
  } catch (err) {
    edSay(err.message, 'err');
  }
});
