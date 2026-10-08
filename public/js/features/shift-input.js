/**
 * Input Shift: a whole shift typed in at once, machine by machine, in place
 * of the GARAP sheet.
 */
import { $, $$ } from '../core/dom.js';
import { api, isCurrent, state, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { todayIso } from '../core/dates.js';
import { windows } from './filters.js';

/* ------------------------------------------------------------------ *
 * The table
 *
 * One row per machine the family has run lately, already carrying its order,
 * fabric and type from the shift before. The operator types what the loom
 * shows — the counter, the RPM, a note — and the row works out the rest as
 * it is typed, saying when something looks wrong:
 *
 *   ⚠ above the loom's capability    ↺ counter was reset
 *   ✕ cannot be worked out (no SODOKAN line, no pick) — must be typed
 *
 * Rapier takes the EFFISIENSI RAPIER day sheet's columns — RPM, EFF, PL,
 * CMPX, PP, CMPX, COUNT (the counter), KET — and, folded away until asked
 * for, the beam on each loom (No. Beam … KET). A CMPX left empty shows what
 * it works out to from PL or PP, RPM and EFF; one typed far from that is
 * flagged, as a slip between the two CMPX columns is easy.
 *
 * Nothing is written until "Simpan shift", and then only the rows changed,
 * all at once: if one cannot be saved, none is, and each problem is named.
 * A saved row stays on screen, locked: "Ubah" opens it again, and from there
 * "Hapus" takes the machine off the shift.
 * ------------------------------------------------------------------ */

const si = {
  key: '',               // family|date|shift the edits belong to
  data: null,
  edits: new Map(),      // no_mc -> { field: typed value }
  errors: new Map(),     // no_mc -> message from the last save
  editing: new Set(),    // saved rows opened again with "Ubah"
  group: '',
  search: ''
};

const numOf = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const dec = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

/* Rapier's other readings, and the beam columns, in the workbook's order. */
const CARD = ['eff', 'pl', 'cmpx_pl', 'pp', 'cmpx_pp'];
const BEAM = [['no_beam', 'No. Beam', 'si-w-beam'], ['tgl_kanji', 'TGL KANJI', 'si-w-date'], ['kp', 'KP', 'si-w-kp'],
  ['panjang_beam', 'PANJANG BEAM', 'si-w-len'], ['tgl_naik', 'TGL NAIK', 'si-w-date'], ['lusi', 'Lusi', 'si-w-lusi'],
  ['pakan', 'Pakan', 'si-w-pakan'], ['ket_benang', 'KET BENANG', 'si-w-ket']];
/** Breaks per 100 000 picks, from a shift of 480 minutes. */
const cmpxOf = (breaks, rpm, eff) =>
  (breaks !== null && rpm > 0 && eff > 0 ? (breaks * 100000) / (rpm * 480 * (eff / 100)) : null);
/** 21/09/26, as the sheet writes dates. */
const sheetDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');

function beamShown(m, f) {
  const b = m.beam;
  if (!b) return '';
  if (f === 'tgl_kanji' || f === 'tgl_naik') return sheetDate(b[f]);
  if (f === 'panjang_beam') return b[f] === null ? '' : fmt.int(b[f]);
  return b[f] ?? '';
}
const one = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : fmt.num(r2(v)));

/** What the box shows: what was typed, else what was saved, else the carry-over. */
function valueOf(m, field) {
  const e = si.edits.get(m.no_mc);
  if (e && field in e) return e[field];
  const s = m.saved;
  if (field === 'mo') return s?.mo ?? m.mo ?? '';
  // Saved numbers shown with a decimal comma, as everything else here is.
  if (CARD.includes(field)) return dec(m.card?.[field]);
  if (field.startsWith('b_')) return beamShown(m, field.slice(2));
  if (!s) return '';
  if (field === 'ketik') return dec(si.data.family === 'shuttle' ? s.ketik : s.ketik_prod);
  if (field === 'rpm') return dec(s.rpm);
  if (field === 'ket_bb') return s.ket_bb ?? '';
  // Shuttle SODOKAN and METER show as saved only when they were typed over;
  // otherwise they are worked out again from KETIK below.
  return '';
}

/** Capability of one machine-shift at its target RPM, as the Produksi tab has it. */
const capOf = (m, pick) => (pick > 0 && m.rpm_target > 0 && m.jml_kain > 0
  ? (m.rpm_target * 480 * 2.54) / (pick * 100) * m.jml_kain : null);

/**
 * Everything the row works out from what is typed, the same way the server
 * will when it is saved (lib/shift-entry.js).
 */
function derive(m) {
  const fam = si.data.family;
  const mo = String(valueOf(m, 'mo')).trim();
  const order = si.data.orders[mo];
  const kode = order?.kode_kain ?? (mo === m.mo ? m.kode_kain : null);
  const pick = order?.pick ?? null;
  const ketik = numOf(valueOf(m, 'ketik'));
  const note = String(valueOf(m, 'ket_bb')).trim();
  const out = { kode, pick, ketik, warn: [], bad: null, output: null, sodokan: null };

  if (Number.isNaN(ketik)) { out.bad = 'KETIK bukan angka'; return out; }
  if (fam === 'shuttle') {
    const prev = m.prev?.ketik === null || m.prev?.ketik === undefined ? null : Number(m.prev.ketik);
    const typedSod = numOf(valueOf(m, 'sodokan'));
    const typedMeter = numOf(valueOf(m, 'produksi'));
    if (typedSod !== null) out.sodokan = typedSod;
    else if (ketik !== null && prev !== null) {
      out.sodokan = r2(prev <= ketik ? ketik - prev : ketik);
      if (prev > ketik) out.warn.push('↺ counter direset');
    } else if (ketik !== null) out.bad = 'KETIK shift sebelumnya tidak ada — isi sodokan';
    if (typedMeter !== null) out.output = typedMeter;
    else if (out.sodokan !== null) {
      const table = si.data.sodokan[`${kode}|${m.width}`];
      const hit = out.sodokan === 0 ? [0, 0] : table?.find(([cm]) => cm === r2(out.sodokan));
      if (hit) out.output = hit[1];
      else out.bad = table ? `tabel SODOKAN tidak punya sodokan ${one(out.sodokan)} — isi meter`
        : `tabel SODOKAN belum punya ${kode ?? 'kain ini'} / MC ${m.width} — isi meter`;
    }
  } else if (ketik !== null) {
    if (fam === 'rapier' && /SULZER/i.test(m.type_mc ?? '')) {
      if (pick > 0) out.output = (1000 / pick / 39.37) * ketik;
      else if (ketik > 0) out.bad = 'pick order belum diketahui';
      else out.output = 0;
    } else if (m.jml_kain > 0) out.output = ketik * m.jml_kain;
    else out.bad = 'jumlah kain mesin belum diketahui';
  }
  if (out.output === null && !out.bad && note) out.output = 0;   // a note alone: did not run

  if (fam === 'rapier') {
    const rpm = numOf(valueOf(m, 'rpm'));
    const v = Object.fromEntries(CARD.map((f) => [f, numOf(valueOf(m, f))]));
    out.cmpx = {};
    for (const f of CARD) if (Number.isNaN(v[f])) out.bad ??= `${f === 'eff' ? 'EFF' : f.startsWith('cmpx') ? 'CMPX' : f.toUpperCase()} bukan angka`;
    if (Number.isNaN(rpm)) out.bad ??= 'RPM bukan angka';
    if (v.eff > 100) out.bad ??= 'EFF lebih dari 100';
    for (const [f, breaks, label] of [['cmpx_pl', v.pl, 'CMPX lusi'], ['cmpx_pp', v.pp, 'CMPX pakan']]) {
      const want = Number.isNaN(rpm) || Number.isNaN(breaks) || Number.isNaN(v.eff) ? null : cmpxOf(breaks, rpm, v.eff);
      if (v[f] === null) out.cmpx[f] = want === null ? '' : dec(r1(want));
      else if (want !== null && !Number.isNaN(v[f]) && Math.abs(v[f] - want) > Math.max(1, want * 0.3)) {
        out.warn.push(`⚠ ${label} ${fmt.one(v[f])}, hitungan ${fmt.one(want)}`);
      }
    }
  }

  const cap = capOf(m, pick);
  out.pct = out.output !== null && cap ? (out.output / cap) * 100 : null;
  if (out.pct !== null && out.pct > 100) out.warn.push('⚠ di atas kapasitas');
  if (mo && !order && mo !== m.mo) out.warn.push('MO belum dikenal');
  return out;
}

const filled = (m) => ['ketik', 'ket_bb', 'sodokan', 'produksi'].some((f) => String(valueOf(m, f)).trim() !== '');

function statusOf(m, d) {
  if (si.errors.has(m.no_mc)) return { cls: 'is-bad', text: si.errors.get(m.no_mc) };
  if (d.bad) return { cls: 'is-bad', text: `✕ ${d.bad}` };
  const tag = si.edits.has(m.no_mc) ? '● diubah' : m.saved ? '✓ tersimpan' : filled(m) ? '' : 'belum';
  return { cls: d.warn.length ? 'is-warn' : si.edits.has(m.no_mc) ? 'is-dirty' : m.saved ? 'is-ok' : 'is-empty',
    text: [tag, ...d.warn].filter(Boolean).join(' · ') };
}

/** A saved row is shown locked until "Ubah" opens it; one with typing in it never is. */
const locked = (m) => !!m.saved && !si.editing.has(m.no_mc) && !si.edits.has(m.no_mc);

const input = (m, field, cls = '', extra = '') =>
  `<input class="si-in ${cls}" data-mc="${esc(m.no_mc)}" data-f="${field}" value="${esc(valueOf(m, field))}" ${extra}${
    locked(m) ? ' disabled' : ''}>`;

function actionsOf(m) {
  if (!m.saved) return '<td class="si-act"></td>';
  if (locked(m)) return '<td class="si-act"><button class="btn btn-quiet" data-act="edit">Ubah</button></td>';
  return `<td class="si-act"><button class="btn btn-quiet si-del" data-act="delete">Hapus</button>
    <button class="btn btn-quiet" data-act="cancel">Batal</button></td>`;
}

function cellsOf(m) {
  const fam = si.data.family;
  const d = derive(m);
  const st = statusOf(m, d);
  const prevKetik = m.prev?.ketik ?? null;
  const common = `
    <td class="mc-name">${esc(m.no_mc)}</td>
    <td class="muted">${esc(fam === 'shuttle' ? (m.kelompok_mesin ?? '') : (m.type_mc ?? ''))}</td>
    <td>${input(m, 'mo', 'si-mo', 'list="siMos" autocomplete="off"')}</td>
    <td class="si-kode">${esc(d.kode ?? '—')}</td>`;
  const tail = `
    <td class="num si-pct">${d.pct === null ? '' : fmt.pct(d.pct)}</td>
    <td>${input(m, 'ket_bb', 'si-note', 'placeholder="TYING, OH…"')}</td>
    <td class="si-st ${st.cls}">${esc(st.text)}</td>${actionsOf(m)}`;
  if (fam === 'shuttle') {
    return `${common}
      <td class="num muted">${prevKetik === null ? '—' : fmt.num(prevKetik)}</td>
      <td>${input(m, 'ketik', 'si-num', 'inputmode="decimal"')}</td>
      <td>${input(m, 'sodokan', 'si-num', `inputmode="decimal" placeholder="${esc(one(d.sodokan))}"`)}</td>
      <td>${input(m, 'produksi', 'si-num', `inputmode="decimal" placeholder="${esc(one(d.output))}"`)}</td>
      ${tail}`;
  }
  if (fam === 'rapier') {
    // The day sheet's order: the beam, then RPM … COUNT, then the note.
    const beam = BEAM.map(([f, label, w]) => `<td class="si-beamcol">${input(m, `b_${f}`, w,
      `aria-label="${esc(`${m.no_mc} ${label}`)}"${f.startsWith('tgl_') ? ' placeholder="dd/mm/yy"' : ''}${
        f === 'ket_benang' ? ' list="siBenang"' : f === 'panjang_beam' ? ' inputmode="numeric"' : ''}`)}</td>`).join('');
    const reading = (f, extra = '') => `<td>${input(m, f, 'si-num si-sm', `inputmode="decimal" ${extra}`)}</td>`;
    return `${common}${beam}
      ${reading('rpm', `placeholder="${esc(m.rpm_target ?? '')}"`)}${reading('eff')}${reading('pl')}
      ${reading('cmpx_pl', `placeholder="${esc(d.cmpx?.cmpx_pl ?? '')}"`)}${reading('pp')}
      ${reading('cmpx_pp', `placeholder="${esc(d.cmpx?.cmpx_pp ?? '')}"`)}${reading('ketik')}
      <td class="num si-out">${one(d.output)}</td>
      <td class="num si-pct">${d.pct === null ? '' : fmt.pct(d.pct)}</td>
      <td>${input(m, 'ket_bb', 'si-note', 'list="siKets" placeholder="HB, BB, TY…"')}</td>
      <td class="si-st ${st.cls}">${esc(st.text)}</td>${actionsOf(m)}`;
  }
  // The counter first: it is typed for every loom, the RPM only when read.
  return `${common}
    <td>${input(m, 'ketik', 'si-num', 'inputmode="decimal"')}</td>
    <td>${input(m, 'rpm', 'si-num', `inputmode="numeric" placeholder="${esc(m.rpm_target ?? '')}"`)}</td>
    <td class="num si-out">${one(d.output)}</td>
    ${tail}`;
}

const visible = () => si.data.machines.filter((m) =>
  (!si.group || m.kelompok_mesin === si.group)
  && (!si.search || m.no_mc.toLowerCase().includes(si.search) || String(valueOf(m, 'mo')).toLowerCase().includes(si.search)));

function paintStatus() {
  const all = si.data.machines;
  const saved = all.filter((m) => m.saved).length;
  const missing = all.filter((m) => !m.saved && !filled(m)).length;
  const bad = all.filter((m) => si.edits.has(m.no_mc) && derive(m).bad).length;
  $('#siStatus').textContent = `${fmt.int(all.length)} mesin · ${fmt.int(saved)} tersimpan · `
    + `${fmt.int(si.edits.size)} diubah · ${fmt.int(missing)} belum diisi${bad ? ` · ${fmt.int(bad)} perlu diperbaiki` : ''}`;
  $('#siSave').disabled = !si.edits.size;
  $('#siUndo').disabled = !si.edits.size;
  $('#siDirty').textContent = si.edits.size ? `${fmt.int(si.edits.size)} mesin belum disimpan` : '';
}

function paintTable() {
  const fam = si.data.family;
  $('#siBeamToggle').hidden = fam !== 'rapier';
  $('#siLegend').hidden = fam !== 'rapier';
  $('#siTable thead').innerHTML = fam === 'rapier' ? `<tr>
    <th>Mesin</th><th>Tipe</th><th>MO</th><th>Kain</th>
    ${BEAM.map(([, label]) => `<th class="si-beamcol">${label}</th>`).join('')}
    <th>RPM</th><th>EFF</th><th>PL</th><th>CMPX</th><th>PP</th><th>CMPX</th><th>COUNT</th>
    <th class="num">Output (m)</th><th class="num">Kapasitas</th><th>KET</th><th>Status</th><th></th></tr>` : `<tr>
    <th>Mesin</th><th>${fam === 'shuttle' ? 'Line' : 'Tipe'}</th><th>MO</th><th>Kain</th>
    ${fam === 'shuttle'
    ? '<th class="num">Ketik sebelum</th><th>Ketik</th><th>Sodokan</th><th>Meter</th>'
    : '<th>Ketik prod</th><th>RPM</th><th class="num">Output (m)</th>'}
    <th class="num">Kapasitas</th><th>Catatan</th><th>Status</th><th></th></tr>`;
  const rows = visible();
  $('#siTable tbody').innerHTML = rows.map((m) => `<tr data-mc="${esc(m.no_mc)}">${cellsOf(m)}</tr>`).join('')
    || `<tr><td colspan="30" class="muted" style="padding:20px;text-align:center">Tidak ada mesin yang cocok.</td></tr>`;
  paintStatus();
}

/** Redraws one row's worked-out cells without touching the box being typed in. */
function refreshRow(no_mc) {
  const tr = $(`#siTable tr[data-mc="${CSS.escape(no_mc)}"]`);
  const m = si.data.machines.find((x) => x.no_mc === no_mc);
  if (!tr || !m) return;
  const d = derive(m);
  const st = statusOf(m, d);
  tr.querySelector('.si-kode').textContent = d.kode ?? '—';
  tr.querySelector('.si-pct').textContent = d.pct === null ? '' : fmt.pct(d.pct);
  const out = tr.querySelector('.si-out');
  if (out) out.textContent = one(d.output);
  if (si.data.family === 'shuttle') {
    tr.querySelector('[data-f="sodokan"]').placeholder = one(d.sodokan);
    tr.querySelector('[data-f="produksi"]').placeholder = one(d.output);
  }
  if (si.data.family === 'rapier') {
    tr.querySelector('[data-f="cmpx_pl"]').placeholder = d.cmpx?.cmpx_pl ?? '';
    tr.querySelector('[data-f="cmpx_pp"]').placeholder = d.cmpx?.cmpx_pp ?? '';
  }
  const cell = tr.querySelector('.si-st');
  cell.className = `si-st ${st.cls}`;
  cell.textContent = st.text;
  paintStatus();
}

/* ---- loading ---- */

export async function loadShiftInput() {
  const tgl = $('#siTgl').value || todayIso();
  $('#siTgl').value = tgl;
  const shift = $('#siShift .seg.is-active')?.dataset.shift ?? 'A';
  const ticket = takeTicket('shiftinput');
  const data = await api('input-shift', { tgl, shift });
  if (!isCurrent('shiftinput', ticket)) return;
  // Coming back to the same shift (another tab and back) keeps what was typed;
  // a different shift or family starts clean — the date and shift controls
  // ask before throwing typing away.
  const key = `${state.family}|${tgl}|${shift}`;
  if (key !== si.key) {
    si.edits.clear();
    si.errors.clear();
    si.editing.clear();
    $('#siResult').innerHTML = '';
  }
  si.key = key;
  si.data = data;

  // The shift hours chosen stay chosen, saving included.
  const jam = $('#siJam').value;
  $('#siJam').innerHTML = ['<option value="">—</option>',
    ...windows.map((w) => `<option value="${esc(w.value)}">${esc(w.label)}</option>`)].join('');
  $('#siJam').value = windows.some((w) => w.value === jam) ? jam : '';
  const groups = [...new Set(data.machines.map((m) => m.kelompok_mesin).filter(Boolean))];
  if (!groups.includes(si.group)) si.group = '';
  $('#siGroup').innerHTML = ['<option value="">Semua</option>',
    ...groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`)].join('');
  $('#siGroup').value = si.group;
  $('#siMos').innerHTML = data.mos.map((o) => `<option value="${esc(o.mo)}">${esc(o.kode_kain ?? '')}</option>`).join('');
  paintTable();
}

/** Leaving with unsaved rows asks first. */
const leaveOk = () => !si.edits.size || confirm(`${si.edits.size} mesin belum disimpan. Tinggalkan perubahan?`);

$('#siTgl').addEventListener('change', (e) => {
  if (!leaveOk()) { e.target.value = si.data?.tgl ?? e.target.value; return; }
  loadShiftInput();
});
$('#siShift').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shift]');
  if (!b || b.classList.contains('is-active') || !leaveOk()) return;
  $$('#siShift .seg').forEach((x) => x.classList.toggle('is-active', x === b));
  loadShiftInput();
});
$('#siGroup').addEventListener('change', (e) => { si.group = e.target.value; paintTable(); });

// Rapier's beam columns change only when a beam does, so they start folded
// away and the readings are in view; each viewer's choice is remembered.
function showBeamCols(on) {
  $('#siBeamCols').checked = on;
  $('#siTable').classList.toggle('hide-beam', !on);
}
try { showBeamCols(localStorage.getItem('mr.si.beam') === '1'); } catch { showBeamCols(false); }
$('#siBeamCols').addEventListener('change', (e) => {
  showBeamCols(e.target.checked);
  try { localStorage.setItem('mr.si.beam', e.target.checked ? '1' : '0'); } catch { /* private window */ }
});
$('#siSearch').addEventListener('input', (e) => { si.search = e.target.value.trim().toLowerCase(); paintTable(); });
$$('#siShift .seg')[0].classList.add('is-active');

/* ---- typing ---- */

$('#siTable').addEventListener('input', (e) => {
  const box = e.target.closest('.si-in');
  if (!box) return;
  const { mc, f } = box.dataset;
  const edit = si.edits.get(mc) ?? {};
  edit[f] = box.value;
  si.edits.set(mc, edit);
  si.errors.delete(mc);
  refreshRow(mc);
});

// Enter goes down the column, as in a spreadsheet; Shift+Enter goes up.
$('#siTable').addEventListener('keydown', (e) => {
  const box = e.target.closest('.si-in');
  if (!box || e.key !== 'Enter') return;
  e.preventDefault();
  const boxes = $$(`#siTable .si-in[data-f="${box.dataset.f}"]`).filter((x) => !x.disabled);
  const next = boxes[boxes.indexOf(box) + (e.shiftKey ? -1 : 1)];
  if (next) { next.focus(); next.select(); }
});

$('#siUndo').addEventListener('click', () => {
  if (!confirm('Batalkan semua perubahan yang belum disimpan?')) return;
  si.edits.clear();
  si.errors.clear();
  si.editing.clear();
  paintTable();
});

window.addEventListener('beforeunload', (e) => { if (si.edits.size) e.preventDefault(); });

/* ---- opening a saved row again, and taking it off ---- */

function repaintRow(no_mc) {
  const tr = $(`#siTable tr[data-mc="${CSS.escape(no_mc)}"]`);
  const m = si.data.machines.find((x) => x.no_mc === no_mc);
  if (tr && m) tr.innerHTML = cellsOf(m);
  paintStatus();
  return tr;
}

$('#siTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const no_mc = btn.closest('tr').dataset.mc;
  const { family, tgl, shift } = si.data;
  if (btn.dataset.act === 'edit') {
    si.editing.add(no_mc);
    const tr = repaintRow(no_mc);
    tr?.querySelector('.si-in:not([data-f="mo"])')?.focus();
  } else if (btn.dataset.act === 'cancel') {
    si.editing.delete(no_mc);
    si.edits.delete(no_mc);
    si.errors.delete(no_mc);
    repaintRow(no_mc);
  } else if (btn.dataset.act === 'delete') {
    if (!confirm(`Hapus ${no_mc} shift ${shift} tanggal ${fmt.day(tgl)}? Seluruh baris mesin ini untuk shift ini dihapus${
      family === 'rapier' ? ', termasuk EFF, PL, CMPX dan PP' : ''}.`)) return;
    btn.disabled = true;
    const res = await fetch(`/api/input-shift?${new URLSearchParams({ family, tgl, shift, no_mc })}`, { method: 'DELETE' });
    if (res.status === 401) return toLogin();
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      btn.disabled = false;
      $('#siResult').innerHTML = `<div class="result result-err"><div class="result-title">${esc(d.error || 'Gagal menghapus')}</div></div>`;
      return;
    }
    si.editing.delete(no_mc);
    si.edits.delete(no_mc);
    si.errors.delete(no_mc);
    await loadShiftInput();
    $('#siResult').innerHTML = `<div class="result result-ok"><div class="result-title">${
      esc(`${no_mc} shift ${shift} ${fmt.day(tgl)} dihapus.`)}</div></div>`;
  }
});

/* ---- saving ---- */

$('#siSave').addEventListener('click', async () => {
  const fam = si.data.family;
  const w = windows.find((x) => x.value === $('#siJam').value);
  const machineOf = (no_mc) => si.data.machines.find((x) => x.no_mc === no_mc);
  const changed = (no_mc, beam) => Object.keys(si.edits.get(no_mc)).some((f) => f.startsWith('b_') === beam);
  const rows = [...si.edits.keys()].filter((no_mc) => changed(no_mc, false)).map((no_mc) => {
    const m = machineOf(no_mc);
    const row = { no_mc, mo: valueOf(m, 'mo'), ketik: valueOf(m, 'ketik'), ket_bb: valueOf(m, 'ket_bb') };
    if (fam === 'shuttle') Object.assign(row, { sodokan: valueOf(m, 'sodokan'), produksi: valueOf(m, 'produksi') });
    else row.rpm = valueOf(m, 'rpm');
    if (fam === 'rapier') {
      for (const f of CARD) row[f] = valueOf(m, f);
      // A CMPX filled in automatically before is sent empty, so it is worked
      // out again from PL, PP, RPM and EFF as they now stand.
      const c = m.card;
      const edit = si.edits.get(no_mc);
      for (const [f, breaks] of [['cmpx_pl', 'pl'], ['cmpx_pp', 'pp']]) {
        if (c && c[f] !== null && !(f in edit)
          && Number(c[f]) === r1(cmpxOf(c[breaks] === null ? null : Number(c[breaks]), Number(m.saved?.rpm), Number(c.eff)) ?? NaN)) row[f] = '';
      }
    }
    return row;
  });
  // A loom whose beam columns changed: that beam, or a new one if TGL NAIK did.
  const beams = fam !== 'rapier' ? [] : [...si.edits.keys()].filter((no_mc) => changed(no_mc, true)).map((no_mc) => {
    const m = machineOf(no_mc);
    const b = { no_mc, kode_kain: derive(m).kode ?? m.kode_kain ?? null };
    for (const [f] of BEAM) b[f] = valueOf(m, `b_${f}`);
    const cur = m.beam;
    if (!String(b.tgl_naik).trim()) b.tgl_naik = cur ? cur.tgl_naik : si.data.tgl;
    b.id = cur && (b.tgl_naik === cur.tgl_naik || b.tgl_naik === sheetDate(cur.tgl_naik)) ? cur.id : null;
    return b;
  });
  const btn = $('#siSave');
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  try {
    const res = await fetch('/api/input-shift', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: si.data.family, tgl: si.data.tgl, shift: si.data.shift,
        jam_mulai: w?.start ?? null, jam_selesai: w?.end ?? null, rows, beams })
    });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) {
      si.errors.clear();
      for (const x of d.errors ?? []) si.errors.set(x.no_mc, `✕ ${x.error.replace(`${x.no_mc}: `, '')}`);
      paintTable();
      $('#siResult').innerHTML = `<div class="result result-err"><div class="result-title">${esc(d.error || 'Gagal menyimpan')}</div>${
        (d.errors ?? []).length ? `<ul>${d.errors.map((x) => `<li>${esc(x.error)}</li>`).join('')}</ul>` : ''}</div>`;
      return;
    }
    const msg = `${fmt.int(d.saved)} mesin tersimpan untuk ${fmt.day(si.data.tgl)} shift ${si.data.shift}`
      + ` (${fmt.int(d.inserted)} baru, ${fmt.int(d.updated)} diperbarui)${d.beams ? `, ${fmt.int(d.beams)} beam` : ''}.`;
    si.edits.clear();
    si.errors.clear();
    si.editing.clear();
    await loadShiftInput();
    $('#siResult').innerHTML = `<div class="result result-ok"><div class="result-title">${esc(msg)}</div></div>`;
  } catch (err) {
    $('#siResult').innerHTML = `<div class="result result-err"><div class="result-title">Tidak tersimpan</div><p>${esc(err.message)}</p></div>`;
  } finally {
    btn.textContent = 'Simpan shift';
    paintStatus();
  }
});
