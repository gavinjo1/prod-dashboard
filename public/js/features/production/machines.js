/**
 * Produksi: the machine table and one machine's shifts.
 */
import { $, $$ } from '../../core/dom.js';
import { achievedCell } from '../../ui/cells.js';
import { api, isCurrent, session, state, takeTicket } from '../../core/state.js';
import { defaultTarget, targets } from './targets.js';
import { esc, fmt } from '../../charts/core.js';

export let machineRows = [];

export async function loadMachines() {
  const ticket = takeTicket('machines');
  const [rows, effs] = await Promise.all([
    api('machines', { sort: state.sort, dir: state.dir }),
    targets.effs ? Promise.resolve(targets.effs) : api('settings/target-eff')
  ]);
  if (!isCurrent('machines', ticket)) return;
  targets.effs = effs;
  machineRows = rows;
  paintMachines();
}

export function paintMachines() {
  const q = state.search.toLowerCase();
  const shown = machineRows.filter((r) => !q
    || r.machine.toLowerCase().includes(q)
    || (r.grp || '').toLowerCase().includes(q)
    || (r.type_name || '').toLowerCase().includes(q));
  const top = Math.max(...shown.map((r) => Number(r.produksi) || 0), 1);

  $('#machineTable tbody').innerHTML = shown.map((r) => {
    const width = (Number(r.produksi) / top) * 54;
    return `<tr tabindex="0" data-mc="${esc(r.machine)}">
      <td class="mc-name">${esc(r.machine)}</td>
      <td>${esc(r.type_name ?? '—')}</td>
      <td class="muted">${esc(r.grp ?? '—')}</td>
      <td class="num"><span class="cell-bar"><i style="width:${width.toFixed(1)}px"></i>${fmt.num(r.produksi)}</span></td>
      <td class="num">${achievedCell(r.achieved == null ? null : Number(r.achieved), defaultTarget())}</td>
      <td class="num">${fmt.num(r.avg_day)}</td>
      <td class="num">${fmt.num(r.avg_rpm)}</td>
      <td class="num">${r.stoppages || '—'}</td>
      <td class="num">${r.idle || '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">Tidak ada mesin yang cocok.</td></tr>`;
}

export let drawerRows = [];
export let drawerMachine = null;

export async function openMachine(no) {
  const rows = await api(`machine/${encodeURIComponent(no)}`);
  drawerRows = rows;
  drawerMachine = no;
  const meta = machineRows.find((r) => r.machine === no);
  $('#drawerTitle').textContent =
    `Mesin ${no}${meta?.type_name ? ` · ${meta.type_name}` : ''} — ${rows.length} shift`;
  $('#drawerTable tbody').innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(fmt.day(r.date))}</td>
      <td>${esc(r.shift)}</td>
      <td class="hours">${r.jam_mulai ? esc(`${r.jam_mulai}–${r.jam_selesai ?? ''}`) : ''}</td>
      <td class="muted">${esc(r.mo ?? '—')}</td>
      <td class="muted">${esc(r.kode_kain ?? '—')}</td>
      <td class="num">${r.pick == null ? '—' : fmt.num(r.pick)}</td>
      <td class="num target-ref">${fmt.num(r.rpm_target)}</td>
      <td class="num">${fmt.num(r.rpm)}</td>
      <td class="num target-ref">${r.output_target == null ? '—' : fmt.num(Number(r.output_target).toFixed(1))}</td>
      <td class="num">${fmt.num(r.produksi)}</td>
      <td class="num">${r.output_target > 0
        ? achievedCell(Number(r.produksi) / Number(r.output_target) * 100, defaultTarget()) : '—'}</td>
      <td>${esc(r.ket_bb ?? '')}</td>
      <td class="muted">${esc(r.edited_by ?? '')}</td>
      <td>${session.canWrite ? `<button class="row-action" data-edit="${r.id}">edit</button>` : ''}</td>
    </tr>`).join('');
  // Also called to redraw after an edit, with the drawer already open.
  if (!$('#drawer').open) $('#drawer').showModal();
}

$('#mcSearch').addEventListener('input', (e) => { state.search = e.target.value; paintMachines(); });


$$('#machineTable th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  state.dir = state.sort === key && state.dir === 'desc' ? 'asc' : 'desc';
  state.sort = key;
  $$('#machineTable th').forEach((h) => h.classList.remove('is-sorted-asc', 'is-sorted-desc'));
  th.classList.add(state.dir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
  loadMachines();
}));

$('#machineTable tbody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-mc]');
  if (row) openMachine(row.dataset.mc);
});
$('#machineTable tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('tr[data-mc]');
  if (row) openMachine(row.dataset.mc);
});
$('#drawerClose').addEventListener('click', () => $('#drawer').close());
