/**
 * Import tab: typing one shift in by hand.
 */
import { $, $$ } from '../core/dom.js';
import { api, isCurrent, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { loadFilters, windows } from './filters.js';
import { loadImportLog } from './import.js';

/* ------------------------------------------------------------------ *
 * Manual entry
 *
 * The machine and the order carry most of the row with them, so only what
 * genuinely changes each shift is typed. What gets filled in automatically is
 * stated under the form rather than applied silently.
 * ------------------------------------------------------------------ */

export let entryAuto = {};
/** Shuttle only: the reading the shift before ended on, and the SODOKAN table. */
let shuttleInfo = null;

const round2 = (v) => Math.round(v * 100) / 100;
const numOrNull = (v) => (v === '' || v === null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Shuttle: SODOKAN from KETIK and the shift before, METER from the table —
 * as the workbook works them out. A box the operator typed in is theirs and
 * is never overwritten; emptied, it goes back to being worked out.
 */
function shuttleFill() {
  if (state.family !== 'shuttle' || !shuttleInfo) return;
  const sod = $('#eSodokan');
  const prod = $('#eProd');
  const ketik = numOrNull($('#eKetik').value);
  const before = shuttleInfo.before?.ketik ?? null;
  if (!sod.dataset.typed) {
    sod.value = ketik !== null && before !== null ? round2(before <= ketik ? ketik - before : ketik) : '';
  }
  const s = numOrNull(sod.value);
  if (!prod.dataset.typed) {
    const m = s === null ? null : s === 0 ? 0 : shuttleInfo.table.find(([cm]) => cm === round2(s))?.[1];
    prod.value = m === null || m === undefined ? '' : round2(m);
  }
}

/** What the shuttle boxes were worked out from, said under the form. */
function shuttleNote() {
  if (state.family !== 'shuttle' || !shuttleInfo) return [];
  const b = shuttleInfo.before;
  const fabric = shuttleInfo.kode_kain && shuttleInfo.width
    ? `${shuttleInfo.kode_kain} / MC ${shuttleInfo.width}` : null;
  return [
    b && (b.ketik !== null
      ? `ketik shift sebelumnya (${fmt.day(b.tgl)} ${b.shift}) ${fmt.num(b.ketik)}`
      : `ketik shift sebelumnya (${fmt.day(b.tgl)} ${b.shift}) belum ada, isi sodokan`),
    fabric && (shuttleInfo.table.length
      ? `meter dari tabel SODOKAN ${fabric}`
      : `tabel SODOKAN belum punya ${fabric}, isi meter`)
  ];
}

['#eSodokan', '#eProd'].forEach((s) => $(s).addEventListener('input', (e) => {
  if (e.target.value === '') delete e.target.dataset.typed;
  else e.target.dataset.typed = '1';
  shuttleFill();
}));
$('#eKetik').addEventListener('input', shuttleFill);

/** The pair of times the form is currently offering, or nulls. */
export function entryHours() {
  const slot = $('#eJamSlot').value;
  if (slot === 'custom') {
    return { jam_mulai: $('#eJamMulai').value, jam_selesai: $('#eJamSelesai').value };
  }
  const w = windows.find((x) => x.value === slot);
  return w ? { jam_mulai: w.start, jam_selesai: w.end } : { jam_mulai: '', jam_selesai: '' };
}

/** Picks the window whose times match, so a remembered pair shows as itself. */
export function setEntryHours(start, end) {
  const w = windows.find((x) => x.start === start && x.end === end);
  $('#eJamSlot').value = w ? w.value : (start ? 'custom' : '');
  $('#eJamMulai').value = start || '';
  $('#eJamSelesai').value = end || '';
  $('#eJamCustom').hidden = $('#eJamSlot').value !== 'custom';
}

export function fillLists(f) {
  // A viewer has no entry form — it is removed at sign-in — and throwing here
  // would stop the whole dashboard from loading for them.
  if (!$('#entryForm')) return;

  // Rebuilt with the rest of the reference data so it cannot drift from the
  // windows the filter uses.
  const keep = $('#eJamSlot').value;
  $('#eJamSlot').innerHTML = ['<option value="">—</option>',
    ...(f.windows ?? []).map((w) => `<option value="${esc(w.value)}">${esc(w.label)}</option>`),
    '<option value="custom">Lain-lain…</option>'].join('');
  $('#eJamSlot').value = keep;

  $('#dlMachines').innerHTML = f.machines.map((m) => `<option value="${esc(m)}">`).join('');
  $('#dlOrders').innerHTML = f.mos.filter((m) => m !== '0')
    .map((m) => `<option value="${esc(m)}">`).join('');
  if (!$('#eTgl').value) $('#eTgl').value = f.range.max_date || '';
}

export async function refreshEntryDefaults() {
  const no_mc = $('#eMc').value.trim();
  const mo = $('#eMo').value.trim();
  if (!no_mc && !mo) { entryAuto = {}; shuttleInfo = null; $('#entryAuto').textContent = ''; return; }

  const ticket = takeTicket('entryDefaults');
  const d = await api('entry/defaults', { no_mc, mo, shift: $('#eShift').value, tgl: $('#eTgl').value });
  if (!isCurrent('entryDefaults', ticket)) return;

  // The hours are re-set most weeks, so the last ones used for this shift are
  // a starting point, not a rule — typed hours are never overwritten.
  if (d.hours && !$('#eJamSlot').value) {
    setEntryHours(d.hours.jam_mulai, d.hours.jam_selesai);
  }

  entryAuto = {
    type_mc: d.machine?.type_mc ?? null,
    kelompok_mesin: d.machine?.kelompok_mesin ?? null,
    jml_kain: d.machine?.jml_kain ?? null,
    // A shuttle loom with no order typed keeps weaving what it wove last.
    kode_kain: d.order?.kode_kain ?? (state.family === 'shuttle' ? d.machine?.kode_kain : null) ?? null
  };
  shuttleInfo = d.shuttle ?? null;
  // Suggestions, not decisions: only fill an empty box, never overwrite typing.
  if (state.family === 'shuttle') {
    shuttleFill();
  } else {
    if (!$('#eRpm').value && d.machine?.rpm != null) $('#eRpm').value = d.machine.rpm;
    if (!$('#eTarget').value) {
      const t = d.order?.rpm_target ?? d.machine?.rpm_target;
      if (t != null) $('#eTarget').value = t;
    }
  }

  const bits = [
    entryAuto.kode_kain && `kain ${entryAuto.kode_kain}`,
    entryAuto.type_mc && `tipe ${entryAuto.type_mc}`,
    entryAuto.kelompok_mesin && `kelompok ${entryAuto.kelompok_mesin}`,
    entryAuto.jml_kain && `${fmt.int(entryAuto.jml_kain)} kain`,
    d.order?.customer && `customer ${d.order.customer}`,
    d.order?.pick != null && `pick ${fmt.num(d.order.pick)}`,
    ...shuttleNote()
  ].filter(Boolean);
  $('#entryAuto').textContent = bits.length ? `Terisi otomatis: ${bits.join(' · ')}.` : '';
}

$('#eMc').addEventListener('change', refreshEntryDefaults);
// The shift before depends on the date too.
$('#eTgl').addEventListener('change', refreshEntryDefaults);
$('#eMo').addEventListener('change', refreshEntryDefaults);
// Changing shift changes which hours apply, so drop the old pair and re-ask.
$('#eShift').addEventListener('change', () => {
  setEntryHours('', '');
  refreshEntryDefaults();
});
$('#eJamSlot').addEventListener('change', () => {
  const slot = $('#eJamSlot').value;
  $('#eJamCustom').hidden = slot !== 'custom';
  if (slot !== 'custom') { $('#eJamMulai').value = ''; $('#eJamSelesai').value = ''; }
});

$('#eClear').addEventListener('click', () => {
  ['eMc', 'eMo', 'eProd', 'eRpm', 'eTarget', 'eKet', 'eKetik', 'eSodokan'].forEach((id) => {
    $('#' + id).value = '';
    delete $('#' + id).dataset.typed;
  });
  // Hours stay: the next row entered is nearly always the same shift.
  entryAuto = {};
  shuttleInfo = null;
  $('#entryAuto').textContent = '';
  $('#entryResult').innerHTML = '';
});

$('#entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.family === 'semua') return;   // the form is hidden there
  const out = $('#entryResult');
  const btn = $('#eSave');
  btn.disabled = true;

  const body = {
    tgl: $('#eTgl').value, shift: $('#eShift').value, no_mc: $('#eMc').value.trim(),
    mo: $('#eMo').value.trim(), produksi: $('#eProd').value,
    rpm: $('#eRpm').value, rpm_target: $('#eTarget').value,
    ketik: $('#eKetik').value, sodokan: $('#eSodokan').value,
    ...entryHours(),
    ket_bb: $('#eKet').value, ...entryAuto,
    // Filed under the family on screen; the server refuses any other.
    family: state.family
  };

  try {
    const res = await fetch('/api/entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal menyimpan.');

    out.innerHTML = `<div class="result result-ok">
        <div class="result-title">${d.inserted ? 'Ditambahkan' : 'Diperbarui'} ${esc(d.no_mc)} · ${esc(fmt.day(d.tgl))} shift ${esc(d.shift)}</div>
        <p>${fmt.num(d.produksi)} m${d.ketik_prod ? ` · ${fmt.num(d.ketik_prod)} m per kain` : ''}${
          d.sodokan != null ? ` · sodokan ${fmt.num(d.sodokan)}` : ''}${d.ketik != null ? ` · ketik ${fmt.num(d.ketik)}` : ''}${
          d.jam_mulai ? ` · ${esc(d.jam_mulai)}–${esc(d.jam_selesai ?? '')}` : ''}${
          d.edited_by ? ` · oleh ${esc(d.edited_by)}` : ''}${
          d.inserted ? '' : ' — baris lama untuk mesin, tanggal dan shift ini diganti.'}</p>
      </div>`;

    // Straight onto the dashboard, and the filter lists may have gained a value.
    ['eProd', 'eKet', 'eKetik', 'eSodokan'].forEach((id) => {
      $('#' + id).value = '';
      delete $('#' + id).dataset.typed;
    });
    await loadFilters();
    $$('.picker').forEach((p) => p._sync?.());
    await loadImportLog();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Tidak tersimpan</div><p>${esc(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
  }
});
