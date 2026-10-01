/**
 * The filter bar.
 */
import { $, $$ } from '../core/dom.js';
import { api, state } from '../core/state.js';
import { buildPicker, byMachineNo } from '../ui/picker.js';
import { fillLists } from './entry.js';
import { fmt } from '../charts/core.js';
import { refresh } from './shell.js';

/** The mill's three shift windows, as the server defines them. */
export let windows = [];

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

export async function loadFilters() {
  // Not a bare fetch: the lists, the date range and the row count all belong
  // to one family, and without it the header kept showing AJL's totals.
  const f = await api('filters');

  if (!state.from && f.range.min_date) {
    state.from = f.range.min_date;
    state.to = f.range.max_date;
    $('#fFrom').value = state.from;
    $('#fTo').value = state.to;
  }
  $('#fFrom').min = $('#fTo').min = f.range.min_date || '';
  $('#fFrom').max = $('#fTo').max = f.range.max_date || '';

  windows = f.windows ?? [];
  buildPicker($('#pShift'),  'shift',  f.shifts,   'shift');
  buildPicker($('#pJam'),    'jam',    windows,    'jam');
  buildPicker($('#pGroup'),  'group',  f.groups,   'kelompok');
  buildPicker($('#pType'),   'type',   f.types,    'tipe');
  buildPicker($('#pMachine'), 'machine', byMachineNo(f.machines), 'mesin');
  buildPicker($('#pFabric'), 'fabric', f.fabrics,  'kain');
  buildPicker($('#pMo'),     'mo',     f.mos,      'order');
  fillLists(f);
}

/** On small screens the filters fold away; the button carries a summary. */
export function syncFilterSummary() {
  const picked = ['shift', 'group', 'type', 'machine', 'fabric', 'mo']
    .reduce((n, k) => n + state[k].length, 0);
  const range = state.from && state.to ? `${fmt.day(state.from)} – ${fmt.day(state.to)}` : '';
  $('#filtersSummary').textContent =
    [range, picked ? `${picked} selected` : ''].filter(Boolean).join(' · ');
}

$('#filtersToggle').addEventListener('click', () => {
  const open = $('#filterBar').classList.toggle('is-open');
  $('#filtersToggle').setAttribute('aria-expanded', String(open));
});

$('#fFrom').addEventListener('change', (e) => { state.from = e.target.value; refresh(); });
$('#fTo').addEventListener('change', (e) => { state.to = e.target.value; refresh(); });

$('#btnReset').addEventListener('click', async () => {
  for (const k of ['shift', 'group', 'type', 'machine', 'fabric', 'mo']) state[k] = [];
  state.from = state.to = '';
  state.search = '';
  $('#mcSearch').value = '';
  await loadFilters();
  $$('.picker').forEach((p) => p._sync?.());
  refresh();
});
