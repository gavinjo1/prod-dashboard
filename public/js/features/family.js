/**
 * The loom family picker in the sidebar.
 */
import { $, $$ } from '../core/dom.js';
import { loadFilters } from './filters.js';
import { refresh, switchTab } from './shell.js';
import { state } from '../core/state.js';

/* ------------------------------------------------------------------ *
 * Loom family — the picker in place of the title
 *
 * Semua is the combined report; AJL is the detailed daily report the rest of
 * this dashboard is built on. Shuttle and Rapier have no daily report loaded
 * yet, so they say so rather than showing AJL's numbers under their name.
 * ------------------------------------------------------------------ */

export const FAMILY_LABEL = { semua: 'Semua', ajl: 'AJL', shuttle: 'Shuttle', rapier: 'Rapier' };

export function applyFamily(family) {
  if (!FAMILY_LABEL[family]) family = 'ajl';
  state.family = family;
  $('#family').value = family;
  try { localStorage.setItem('mr.family', family); } catch { /* private window */ }

  $$('.tab[data-family]').forEach((t) => {
    t.hidden = !t.dataset.family.split(' ').includes(family);
  });

  // Say plainly which family an upload will be filed under — the mistake this
  // prevents is silent and only shows up as machines in the wrong dashboard.
  const note = $('#importFamily');
  if (note) {
    note.textContent = family === 'semua'
      ? 'Unggahan di sini dibaca sebagai laporan gabungan.'
      : `Berkas yang diunggah akan dicatat sebagai mesin ${FAMILY_LABEL[family]}.`;
  }

  // A typed shift belongs to one family's machines; Semua has none of its own.
  // Viewers have no form at all.
  if ($('#entryForm')) {
    ['#entryForm', '#entryAuto', '#entryResult'].forEach((s) => { $(s).hidden = family === 'semua'; });
    $('#entryNoFamily').hidden = family !== 'semua';
    // Shuttle is counted by KETIK and SODOKAN into METER, with no RPM reading.
    $$('#entryForm [data-only]').forEach((el) => { el.hidden = el.dataset.only !== family; });
    $$('#entryForm [data-not]').forEach((el) => { el.hidden = el.dataset.not === family; });
    $('#eProdLabel').textContent = family === 'shuttle' ? 'Meter' : 'Output (m)';
    // What was filled in for another family's machine does not carry over.
    $('#eClear').click();
  }

  // Stay on the current tab when it belongs to this family too (Import).
  const current = $(`.tab[data-tab="${state.tab}"]`);
  if (current && !current.hidden) return switchTab(state.tab);
  switchTab(family === 'semua' ? 'gabungan' : 'production');
}

/** Switches the whole dashboard to another family, as the picker does. */
export async function chooseFamily(family) {
  // The machines, fabrics and orders all belong to one family, and the date
  // range differs too — so the filters are rebuilt rather than carried over.
  state.shift = []; state.jam = []; state.group = [];
  state.type = []; state.machine = []; state.fabric = []; state.mo = [];
  state.from = ''; state.to = '';
  applyFamily(family);
  await loadFilters();
  $$('.picker').forEach((p) => p._sync?.());
  await refresh();
}

$('#family').addEventListener('change', (e) => chooseFamily(e.target.value));
