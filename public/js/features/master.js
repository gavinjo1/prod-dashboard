/**
 * Master MO: PPIC's list of orders — one MO, one fabric, one pick — and, per
 * MO, whether the production saved under it agrees with the master.
 *
 * Two screens in one tab: the list, with a status per MO, and one MO in its
 * place. The MO screen leads with what needs deciding, in plain words; the
 * MO's own fields and its history come after.
 */
import { $ } from '../core/dom.js';
import { api, isCurrent, session, takeTicket, toLogin } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';

/* ------------------------------------------------------------------ *
 * The rules the page follows (see server/routes/master.js)
 *
 * Changing an MO never changes production already saved. Rows that no longer
 * match are listed per loom and run of days, and someone decides: bring them
 * in line with the master, or mark them as meant to differ. Only admins
 * change anything; everyone else reads.
 * ------------------------------------------------------------------ */

const mm = { list: [], q: '', filter: null, mo: null, d: null, editing: false, isNew: false, file: null, scroll: 0, note: '' };
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
const pickText = (p) => (p === null || p === undefined || Number(p) === 0 ? '—' : fmt.num(p));
const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
// A fabric code as the server compares it: spacing and punctuation do not count.
const kodeKey = (k) => String(k ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

const STATUS = {
  check: ['Perlu dicek', 'pill-err'],
  accepted: ['Ditandai berbeda', 'pill-note'],
  ok: ['Cocok', 'pill-ok'],
  unused: ['Belum dipakai', 'pill-undone']
};
const statusOf = (r) => (r.open > 0 ? 'check' : !r.shifts ? 'unused' : r.accepted > 0 ? 'accepted' : 'ok');
const FILTERS = [['check', 'Perlu dicek'], ['all', 'Semua'], ['unused', 'Belum dipakai']];
const toCheck = () => mm.list.filter((r) => statusOf(r) === 'check');

function paintList() {
  const counts = { all: mm.list.length };
  for (const r of mm.list) counts[statusOf(r)] = (counts[statusOf(r)] ?? 0) + 1;
  // Open on what needs doing when there is any; a choice made stays.
  if (!mm.filter) mm.filter = counts.check ? 'check' : 'all';
  $('#mmFilters').innerHTML = FILTERS.map(([k, l]) => `<button class="mm-filter${mm.filter === k ? ' is-on' : ''}"
    data-filter="${k}" aria-pressed="${mm.filter === k}">${l} <span>${fmt.int(counts[k] ?? 0)}</span></button>`).join('');

  const rows = mm.filter === 'all' ? mm.list : mm.list.filter((r) => statusOf(r) === mm.filter);
  $('#mmTable thead').innerHTML = `<tr><th>Status</th><th>MO</th><th>Kode kain</th><th class="num">Pick</th>
    <th class="mm-hide-sm">Customer</th><th>Dipakai</th></tr>`;
  $('#mmTable tbody').innerHTML = rows.map((r) => {
    const [label, pill] = STATUS[statusOf(r)];
    const used = r.shifts ? `${r.families.map((f) => FAMILY[f] ?? f).join(', ')} · ${fmt.int(r.machines)} mesin · s/d ${fmt.day(r.last_used)}` : '—';
    return `<tr tabindex="0" data-mo="${esc(r.mo)}">
      <td><span class="pill ${pill}">${label}</span></td>
      <td class="mc-name nowrap">${esc(r.mo)}</td><td>${esc(r.kode_kain ?? '')}</td>
      <td class="num">${pickText(r.pick)}</td><td class="mm-hide-sm">${esc(r.customer ?? '')}</td>
      <td class="muted nowrap">${used}</td></tr>`;
  }).join('') || `<tr><td colspan="6" class="muted mm-empty">${
    !mm.list.length ? (mm.q ? 'Tidak ada MO yang cocok dengan pencarian.' : 'Master MO masih kosong. Upload file MASTER PRODUCT dari PPIC.')
      : mm.filter === 'check' ? 'Tidak ada yang perlu dicek. Semua produksi cocok dengan master.' : 'Tidak ada MO di sini.'}</td></tr>`;
}

export async function loadMaster() {
  const ticket = takeTicket('master');
  const list = await api('master/mo', { q: mm.q });
  if (!isCurrent('master', ticket)) return;
  mm.list = list;
  $('#mmActions').hidden = !admin();
  $('#mmSub').textContent = `${fmt.int(list.length)} MO${mm.q ? ' cocok dengan pencarian' : ''}. `
    + 'Satu MO = satu kode kain = satu pick. Mengubah master tidak mengubah produksi yang sudah tersimpan.';
  paintList();
  if (mm.mo || mm.isNew) await openMo(mm.mo, { keep: true });
}

$('#mmFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  mm.filter = b.dataset.filter;
  paintList();
});

let searchTimer;
$('#mmSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { mm.q = e.target.value.trim(); loadMaster(); }, 250);
});
['click', 'keydown'].forEach((ev) => $('#mmTable').addEventListener(ev, (e) => {
  const tr = e.target.closest('tr[data-mo]');
  if (!tr || (e.type === 'keydown' && e.key !== 'Enter')) return;
  mm.scroll = window.scrollY;
  openMo(tr.dataset.mo);
}));

function showList() {
  mm.mo = null;
  mm.d = null;
  mm.isNew = false;
  mm.editing = false;
  mm.note = '';
  $('#mmDetail').hidden = true;
  $('#mmListCard').hidden = false;
  paintList();
  window.scrollTo(0, mm.scroll);
}

/* ------------------------------------------------------------------ *
 * One MO
 * ------------------------------------------------------------------ */

async function openMo(mo, { keep = false, isNew = false } = {}) {
  mm.isNew = isNew || (keep && mm.isNew);
  mm.mo = mm.isNew ? null : mo;
  if (!keep) { mm.editing = mm.isNew; mm.note = ''; }
  $('#mmListCard').hidden = true;
  $('#mmDetail').hidden = false;
  if (mm.isNew) { mm.d = null; paintMo(); window.scrollTo(0, 0); return; }
  try {
    mm.d = await api('master/mo/item', { mo });
  } catch (err) {
    $('#mmDetail').innerHTML = `<section class="card"><button class="mm-back" data-act="back">← Kembali ke daftar</button>
      ${fail(`Tidak bisa membuka ${mo}`, err.message)}</section>`;
    return;
  }
  paintMo();
  if (!keep) window.scrollTo(0, 0);
}

/** The runs still to be checked, grouped by what they carry: fabric and pick per family. */
function kindsOf(runs) {
  const kinds = new Map();
  for (const r of runs) {
    const key = `${r.family}|${r.kode}|${r.pick ?? ''}`;
    const k = kinds.get(key) ?? { family: r.family, kode: r.kode, kode_kain: r.kode_kain, pick: r.pick, shifts: 0, machines: new Set(), sulzer: 0 };
    k.shifts += r.shifts;
    k.sulzer += r.sulzer;
    k.machines.add(r.no_mc);
    kinds.set(key, k);
  }
  return [...kinds.values()];
}

function paintMo() {
  const d = mm.d;
  const m = d?.master;
  const host = $('#mmDetail');
  const next = toCheck().find((r) => r.mo !== mm.mo);
  const nextBtn = next ? `<button class="btn" data-act="next" data-mo="${esc(next.mo)}">Berikutnya yang perlu dicek →</button>` : '';

  if (mm.isNew) {
    host.innerHTML = `<section class="card">
      <button class="mm-back" data-act="back">← Kembali ke daftar</button>
      <h2 class="mm-title">MO baru</h2>${fieldsCard(null)}</section>`;
    return;
  }

  const usage = d.usage.length
    ? `Dipakai di ${d.usage.map((u) => `${FAMILY[u.family] ?? u.family}: ${fmt.int(u.machines)} mesin, ${fmt.int(u.rows)} shift, ${range(u.first, u.last)}`).join('; ')}.`
    : 'Belum pernah dipakai di produksi.';
  host.innerHTML = `
    <section class="card">
      <button class="mm-back" data-act="back">← Kembali ke daftar</button>
      <div class="mm-head">
        <div><h2 class="mm-title">${esc(d.mo)}</h2>
          <p class="card-sub">${m ? [m.kode_kain, m.pick === null ? null : `pick ${fmt.num(m.pick)}`, m.customer].filter(Boolean).map(esc).join(' · ')
            : 'Belum ada di master; hanya ada di data produksi.'}</p></div>
        ${nextBtn}
      </div>
      <p class="mm-used">${usage}</p>
    </section>
    <div id="mmOut">${mm.note}</div>
    ${statusBox(d, nextBtn)}
    <section class="card">
      <div class="mm-head"><h2>Data MO dari PPIC</h2>
        ${admin() && m && !mm.editing ? '<button class="btn" data-act="edit">Ubah data MO</button>' : ''}</div>
      ${m || mm.editing ? fieldsCard(m) : `<p class="note-line">MO ini belum ada di master.</p>
        ${admin() ? '<button class="btn" data-act="edit">Tambahkan ke master</button>' : ''}`}
    </section>
    ${historyCard(d.log)}`;
  pickChanged();
}

/* ---- does production agree? ---- */

function statusBox(d, nextBtn) {
  const m = d.master;
  if (!m) return '';
  const open = d.runs.filter((r) => !r.accepted);
  const accepts = d.accepts.length ? acceptedBox(d) : '';
  if (!open.length) {
    if (!d.usage.length) return accepts;
    return `<div class="mm-status mm-ok"><p class="mm-status-title">Cocok dengan master</p>
      <p>${d.accepts.length ? 'Semua shift cocok, kecuali yang ditandai berbeda dengan sengaja di bawah.'
        : `Semua shift yang memakai MO ini tercatat kain ${esc(m.kode_kain ?? '—')} dan pick ${pickText(m.pick)}.`}</p>
      ${nextBtn ? `<div class="mm-actions-row">${nextBtn}</div>` : ''}</div>${accepts}`;
  }

  const kinds = kindsOf(open);
  const kodeDiff = (k) => m.kode_kain !== null && kodeKey(k.kode_kain) !== kodeKey(m.kode_kain);
  const pickDiff = (k) => m.pick !== null && Number(k.pick ?? 0) !== Number(m.pick);
  const what = [kinds.some(kodeDiff) && 'nama kain', kinds.some(pickDiff) && 'pick'].filter(Boolean).join(' dan ');
  const lines = kinds.map((k) => `<p>${fmt.int(k.shifts)} shift di ${fmt.int(k.machines.size)} mesin ${FAMILY[k.family] ?? k.family} tercatat
    ${kodeDiff(k) ? `kain <b>${esc(k.kode_kain ?? '(kosong)')}</b> (master: ${esc(m.kode_kain)})` : `kain ${esc(k.kode_kain ?? '—')}`}${
    pickDiff(k) ? `, pick <b>${pickText(k.pick)}</b> (master: ${pickText(m.pick)})` : ''}.</p>`).join('');
  const metres = !kinds.some(pickDiff) ? 'Pick-nya sama dengan master, jadi meter tidak berubah kalau disamakan.'
    : kinds.some((k) => pickDiff(k) && k.sulzer) ? 'Pick berbeda: meter mesin SULZER dihitung ulang dengan pick master kalau disamakan. Meter mesin lain tidak bergantung pada pick.'
      : 'Pick berbeda, tapi meter mesin-mesin ini tidak bergantung pada pick, jadi meter tidak berubah kalau disamakan.';
  const edit = admin();
  const multiFamily = new Set(open.map((r) => r.family)).size > 1;

  return `<div class="mm-status mm-warn" id="mmCheck">
    <p class="mm-status-title">Perlu dicek: ${what || 'data'} berbeda dengan master</p>
    ${lines}<p>${metres}</p>
    <div class="table-wrap mm-runs"><table class="data"><thead><tr>
      ${edit ? '<th><input type="checkbox" id="mmAll" checked aria-label="Pilih semua"></th>' : ''}
      <th>Mesin</th><th>Kain tercatat</th><th class="num">Pick</th><th>Tanggal</th><th class="num">Shift</th><th class="mm-hide-sm">Asal data</th>
    </tr></thead><tbody>
    ${open.map((r) => `<tr>
      ${edit ? `<td><input type="checkbox" class="mm-run" data-i="${d.runs.indexOf(r)}" checked aria-label="${esc(r.no_mc)} ${esc(range(r.first, r.last))}"></td>` : ''}
      <td class="mc-name">${esc(r.no_mc)}${multiFamily ? ` <span class="muted">${esc(FAMILY[r.family] ?? r.family)}</span>` : ''}</td>
      <td class="${kodeDiff(r) ? 'mm-diff' : ''}">${esc(r.kode_kain ?? '(kosong)')}</td>
      <td class="num ${m.pick !== null && Number(r.pick ?? 0) !== Number(m.pick) ? 'mm-diff' : ''}">${pickText(r.pick)}</td>
      <td class="nowrap">${range(r.first, r.last)}</td><td class="num">${fmt.int(r.shifts)}</td>
      <td class="muted mm-hide-sm">${r.sources.map(esc).join(', ')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="mm-small">Tanggal di luar daftar ini sudah cocok dengan master.</p>
    ${edit ? `<div class="mm-choice">
      <label class="mm-opt" data-opt="keep"><input type="radio" name="mmAct" value="keep">
        <span>Biarkan, memang berbeda<small>Misalnya order maklon yang sengaja diberi nama kain sendiri. Data tidak diubah.</small></span></label>
      <label class="mm-opt" data-opt="fix"><input type="radio" name="mmAct" value="fix">
        <span>Samakan dengan master<small>Kain dan pick pada shift yang dicentang diganti jadi ${esc(m.kode_kain ?? '—')}, pick ${pickText(m.pick)}.</small></span></label>
      <p class="mm-summary" id="mmSummary" hidden></p>
      <label class="field mm-reason-wide" id="mmReasonField" hidden><span>Alasan (wajib, tercatat di riwayat)</span>
        <input id="mmActReason" maxlength="200" placeholder="contoh: nama kain di laporan salah tulis"></label>
      <div class="mm-actions-row" id="mmGoRow" hidden><button class="btn btn-primary" data-act="go" disabled>Lanjut</button></div>
      <div class="mm-summary" id="mmConfirm" hidden></div>
    </div>` : '<p class="mm-small">Hanya admin yang bisa menyamakan atau menandai data ini.</p>'}
  </div>${accepts}`;
}

function acceptedBox(d) {
  return `<div class="mm-status mm-note"><p class="mm-status-title">Ditandai berbeda dengan sengaja</p>
    ${d.accepts.map((a) => {
      const rows = sum(d.runs.filter((r) => r.accepted && r.family === a.family && r.kode === a.kode
        && Number(r.pick ?? 0) === Number(a.pick)), (r) => r.shifts);
      return `<p>${esc(FAMILY[a.family] ?? a.family)}: kain ${esc(a.kode_kain ?? '(kosong)')}, pick ${pickText(a.pick)}
        (${fmt.int(rows)} shift). Alasan: ${esc(a.reason)} <span class="muted">· ${esc(a.accepted_by ?? '')}, ${esc(a.accepted_at)}</span>
        ${admin() ? `<button class="mm-link" data-act="unaccept" data-family="${esc(a.family)}" data-kode="${esc(a.kode)}"
          data-pick="${esc(a.pick)}">Batalkan tanda</button>` : ''}</p>`;
    }).join('')}
    <p class="mm-small">Shift baru dengan kain dan pick yang sama juga tidak ditandai. Kalau kain atau pick di master berubah, tanda ini tidak berlaku lagi.</p>
  </div>`;
}

const pickedRuns = () => [...document.querySelectorAll('#mmDetail .mm-run:checked')].map((c) => mm.d.runs[c.dataset.i]);
const action = () => document.querySelector('#mmDetail input[name=mmAct]:checked')?.value;

/** Says what the choice would do to the rows ticked, and enables Lanjut once there is a reason. */
function pickChanged() {
  if (!$('#mmCheck') || !admin()) return;
  const m = mm.d.master;
  const act = action();
  const picked = pickedRuns();
  const all = document.querySelectorAll('#mmDetail .mm-run');
  $('#mmAll').checked = picked.length === all.length;
  $('#mmAll').indeterminate = picked.length > 0 && picked.length < all.length;
  document.querySelectorAll('#mmDetail .mm-opt').forEach((l) => l.classList.toggle('is-on', l.dataset.opt === act));
  const shifts = sum(picked, (r) => r.shifts);
  const machines = new Set(picked.map((r) => `${r.family} ${r.no_mc}`)).size;
  let text = '';
  if (!picked.length) text = 'Belum ada baris yang dicentang.';
  else if (act === 'fix') {
    const sulzer = sum(picked.filter((r) => m.pick !== null && Number(r.pick ?? 0) !== Number(m.pick)), (r) => r.sulzer);
    text = `${fmt.int(shifts)} shift di ${fmt.int(machines)} mesin akan diganti jadi kain <b>${esc(m.kode_kain ?? '—')}</b>, pick ${pickText(m.pick)}. `
      + (sulzer ? `Meter ${fmt.int(sulzer)} shift SULZER dihitung ulang.` : 'Meter tetap sama.') + ' Setiap shift yang diubah tercatat.';
  } else if (act === 'keep') {
    // Marking goes by fabric and pick, so it reaches rows of the same kind left unticked.
    const kinds = kindsOf(picked);
    const covered = mm.d.runs.filter((r) => !r.accepted && kinds.some((k) => k.family === r.family && k.kode === r.kode
      && Number(k.pick ?? 0) === Number(r.pick ?? 0)));
    const total = sum(covered, (r) => r.shifts);
    text = `Data tidak diubah. ${kinds.map((k) => `Kain ${esc(k.kode_kain ?? '(kosong)')} pick ${pickText(k.pick)}`).join(' dan ')} di MO ini
      tidak ditandai lagi: ${fmt.int(total)} shift${total > shifts ? ', termasuk yang tidak dicentang' : ''}, dan shift baru dengan kain dan pick yang sama.`;
  }
  $('#mmSummary').hidden = !act;
  $('#mmSummary').innerHTML = text;
  $('#mmReasonField').hidden = !act;
  $('#mmGoRow').hidden = !act;
  const go = $('#mmDetail [data-act="go"]');
  go.disabled = !picked.length || !$('#mmActReason').value.trim();
  go.textContent = act === 'fix' ? `Samakan ${fmt.int(shifts)} shift` : 'Tandai memang berbeda';
  $('#mmConfirm').hidden = true;
}

/* ---- the MO's own fields ---- */

function fieldsCard(m) {
  const editing = mm.editing && admin();
  if (!editing) {
    return `<dl class="mm-fields">${FIELDS.map(([k, label, kind]) => {
      const v = m?.[k];
      const shown = v === null || v === undefined || v === '' ? '—'
        : kind === 'num' ? fmt.num(v) : kind === 'date' ? fmt.day(v) : v;
      return `<div><dt>${esc(label)}</dt><dd>${esc(shown)}</dd></div>`;
    }).join('')}</dl>`;
  }
  const isNew = mm.isNew || !m;
  const input = ([k, label, kind]) => {
    const v = m?.[k] ?? '';
    const shown = kind === 'num' && v !== '' ? String(v).replace('.', ',') : v;
    return `<label class="field"><span>${esc(label)}</span><input class="mm-in" data-f="${k}" type="${kind === 'date' ? 'date' : 'text'}"${
      kind === 'num' ? ' inputmode="decimal"' : ''} value="${esc(shown)}"></label>`;
  };
  return `<div class="mm-grid">
      ${isNew ? `<label class="field"><span>MO</span><input class="mm-in" data-f="mo" placeholder="MO/UW/26530" value="${esc(mm.mo ?? '')}"></label>` : ''}
      ${FIELDS.map(input).join('')}
    </div>
    <label class="field mm-reason-wide"><span>Alasan${isNew ? '' : ' perubahan (wajib, tercatat di riwayat)'}</span>
      <input id="mmReason" maxlength="200" placeholder="${isNew ? 'contoh: MO baru dari PPIC' : 'contoh: pick dari PPIC dikoreksi'}"></label>
    <p class="mm-small">${isNew ? 'MO baru harus punya kode kain.'
      : 'Mengubah data MO tidak mengubah shift yang sudah tersimpan. Kalau jadi berbeda, akan muncul di "Perlu dicek".'}</p>
    <div class="mm-actions-row">
      <button class="btn btn-primary" data-act="save">${isNew ? 'Tambahkan ke master' : 'Simpan'}</button>
      <button class="btn btn-quiet" data-act="cancel">Batal</button>
      ${!isNew ? '<button class="btn btn-quiet mm-danger" data-act="delete">Hapus dari master</button>' : ''}
    </div>
    <div id="mmFieldsOut"></div>`;
}

/* ---- history ---- */

function changesOf(e) {
  const a = e.after ?? {};
  const kinds = (ks) => (ks ?? []).map((k) => `kain ${esc(k.kode_kain ?? '(kosong)')} pick ${pickText(k.pick)}`).join(', ');
  if (e.action === 'apply') {
    const where = a.runs ? `${a.runs.length} rentang mesin` : a.from || a.to ? `${esc(a.from ?? '…')} – ${esc(a.to ?? '…')}` : 'semua tanggal';
    return `${e.affected === null ? '' : `${fmt.int(e.affected)} shift `}disamakan ke kain ${esc(a.kode_kain ?? '—')}, pick ${pickText(a.pick)} (${where})`;
  }
  if (e.action === 'accept') return `ditandai memang berbeda: ${kinds(a.kinds)}${e.affected ? ` (${fmt.int(e.affected)} shift)` : ''}`;
  if (e.action === 'unaccept') return `tanda "memang berbeda" dibatalkan: ${kinds([e.before])}`;
  if (!e.before) return 'MO dibuat';
  if (!e.after) return 'MO dihapus dari master';
  return FIELDS.filter(([k]) => String(e.before[k] ?? '') !== String(a[k] ?? ''))
    .map(([k, l]) => `${esc(l)}: ${esc(e.before[k] ?? '—')} → ${esc(a[k] ?? '—')}`).join('<br>') || 'tidak ada beda';
}

function historyCard(log) {
  return `<section class="card"><details class="mm-history">
    <summary>Riwayat perubahan (${fmt.int(log.length)})</summary>
    ${log.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Waktu</th><th>Oleh</th><th>Apa</th><th>Alasan</th></tr></thead><tbody>
      ${log.map((e) => `<tr><td class="nowrap muted">${esc(e.changed_at)}</td><td class="muted">${esc(e.changed_by ?? '')}</td>
        <td>${changesOf(e)}</td><td class="muted">${esc(e.reason ?? '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="note-line">Belum ada perubahan tercatat.</p>'}
  </details></section>`;
}

/* ---- what the MO screen's buttons do ---- */

const runsBody = (runs) => runs.map(({ family, no_mc, first, last }) => ({ family, no_mc, from: first, to: last }));

async function afterChange(note) {
  mm.note = note;
  mm.editing = false;
  mm.isNew = false;
  await loadMaster();
}

$('#mmDetail').addEventListener('change', (e) => {
  if (e.target.id === 'mmAll') document.querySelectorAll('#mmDetail .mm-run').forEach((c) => { c.checked = e.target.checked; });
  if (e.target.matches('.mm-run, #mmAll, input[name=mmAct]')) pickChanged();
});
$('#mmDetail').addEventListener('input', (e) => { if (e.target.id === 'mmActReason') pickChanged(); });

$('#mmDetail').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const out = (html) => { const host = $('#mmFieldsOut') ?? $('#mmOut'); if (host) host.innerHTML = html; };

  if (act === 'back') { showList(); return; }
  if (act === 'next') { openMo(btn.dataset.mo); return; }
  if (act === 'edit') { mm.editing = true; paintMo(); $('#mmDetail .mm-in')?.focus(); return; }
  if (act === 'cancel') {
    if (mm.isNew) { showList(); return; }
    mm.editing = false; paintMo(); return;
  }

  if (act === 'save') {
    const body = { reason: $('#mmReason').value };
    document.querySelectorAll('#mmDetail .mm-in').forEach((el) => { body[el.dataset.f] = el.value; });
    body.mo = body.mo ?? mm.mo;
    if (!mm.isNew && mm.d?.master && !body.reason.trim()) { out(fail('Alasan wajib diisi', 'Tulis kenapa data MO diubah.')); return; }
    try {
      const d = await call('PUT', '/api/master/mo/item', body);
      mm.mo = d.mo;
      await afterChange(ok(d.changed.length ? `${d.mo} tersimpan` : 'Tidak ada yang berubah',
        d.open ? `<p>${fmt.int(d.open)} shift sekarang berbeda dengan master; lihat "Perlu dicek" di bawah.</p>` : ''));
    } catch (err) { out(fail('Tidak tersimpan', err.message)); }
    return;
  }

  if (act === 'delete') {
    const reason = $('#mmReason').value.trim();
    if (!reason) { out(fail('Alasan wajib diisi', 'Tulis kenapa MO ini dihapus dari master.')); return; }
    if (!confirm(`Hapus ${mm.mo} dari master? Produksi yang sudah tersimpan tidak berubah.`)) return;
    try {
      await call('DELETE', `/api/master/mo/item?${new URLSearchParams({ mo: mm.mo, reason })}`);
      showList();
      await loadMaster();
    } catch (err) { out(fail('Tidak terhapus', err.message)); }
    return;
  }

  if (act === 'go') {
    const picked = pickedRuns();
    const shifts = sum(picked, (r) => r.shifts);
    const what = action() === 'fix'
      ? `<b>${fmt.int(shifts)} shift</b> (${picked.map((r) => `${esc(r.no_mc)} ${esc(range(r.first, r.last))}`).join(', ')}) diganti jadi kain ${esc(mm.d.master.kode_kain ?? '—')}, pick ${pickText(mm.d.master.pick)}.`
      : 'Tandai sebagai memang berbeda? Data tidak diubah.';
    $('#mmConfirm').hidden = false;
    $('#mmConfirm').innerHTML = `Yakin? ${what}
      <span class="mm-actions-row"><button class="btn btn-primary" data-act="yes">Ya, ${action() === 'fix' ? 'samakan' : 'tandai'}</button>
      <button class="btn btn-quiet" data-act="no">Batal</button></span>`;
    return;
  }
  if (act === 'no') { $('#mmConfirm').hidden = true; return; }
  if (act === 'yes') {
    const fix = action() === 'fix';
    const body = { mo: mm.mo, runs: runsBody(pickedRuns()), reason: $('#mmActReason').value };
    btn.disabled = true;
    try {
      const d = await call('POST', `/api/master/mo/${fix ? 'apply' : 'accept'}`, body);
      await afterChange(ok(fix ? `${fmt.int(d.corrected)} shift disamakan dengan master` : `${fmt.int(d.accepted)} shift ditandai memang berbeda`));
    } catch (err) {
      btn.disabled = false;
      $('#mmConfirm').innerHTML = fail(fix ? 'Tidak disamakan' : 'Tidak ditandai', err.message);
    }
    return;
  }

  if (act === 'unaccept') {
    if (!confirm('Batalkan tanda "memang berbeda"? Shift-shift itu akan muncul lagi di "Perlu dicek". Data tidak diubah.')) return;
    try {
      await call('POST', '/api/master/mo/unaccept', { mo: mm.mo, family: btn.dataset.family, kode: btn.dataset.kode, pick: btn.dataset.pick });
      await afterChange(ok('Tanda dibatalkan'));
    } catch (err) { out(fail('Tanda tidak dibatalkan', err.message)); }
  }
});

$('#mmNew').addEventListener('click', () => { mm.scroll = window.scrollY; openMo(null, { isNew: true }); });

/* ------------------------------------------------------------------ *
 * The MASTER PRODUCT upload: preview first, then save
 * ------------------------------------------------------------------ */

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
      mm.filter = null;
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
      ${d.production_mismatch.length ? `<p>Setelah disimpan, ${fmt.int(d.production_mismatch.length)} MO punya produksi yang perlu dicek (${
        d.production_mismatch.map((m) => `${esc(m.mo)}: ${fmt.int(m.rows)} shift`).join(', ')}). Produksi itu tidak diubah otomatis.</p>` : ''}
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
