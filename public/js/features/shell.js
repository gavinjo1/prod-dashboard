/**
 * Tabs, the sidebar menu, and reloading whatever tab is showing.
 */
import { $, $$ } from '../core/dom.js';
import { FAMILY_LABEL } from './family.js';
import { params, session, state } from '../core/state.js';
import { hideTip } from '../charts/core.js';
import { loadCharts } from './production/charts.js';
import { loadGabungan } from './gabungan.js';
import { loadImportLog } from './import.js';
import { loadMachines } from './production/machines.js';
import { loadOrderInfo } from './production/orders.js';
import { loadPabrik } from './pabrik.js';
import { loadEfisiensi } from './efisiensi.js';
import { loadShiftInput } from './shift-input.js';
import { loadMesin } from './mesin.js';
import { loadMaster } from './master.js';
import { loadQuality } from './quality.js';
import { loadSummary } from './production/summary.js';
import { loadUsers } from './users.js';
import { syncFilterSummary } from './filters.js';

export async function refresh() {
  // Absent for a viewer: the buttons are removed at sign-in.
  if ($('#btnExport')) $('#btnExport').href = `/api/export.csv?${params()}`;
  if ($('#btnExportXlsx')) $('#btnExportXlsx').href = `/api/export.xlsx?${params()}`;
  syncFilterSummary();
  if (state.tab === 'production') {
    await Promise.all([loadSummary(), loadCharts(), loadMachines(), loadOrderInfo()]);
  } else if (state.tab === 'quality') {
    await loadQuality();
  } else if (state.tab === 'pabrik') {
    await loadPabrik();
  } else if (state.tab === 'efisiensi') {
    await loadEfisiensi();
  } else if (state.tab === 'shiftinput') {
    await loadShiftInput();
  } else if (state.tab === 'mesin') {
    await loadMesin();
  } else if (state.tab === 'master') {
    await loadMaster();
  } else if (state.tab === 'users') {
    if (session.role === 'admin') await loadUsers();
  } else if (state.tab === 'gabungan') {
    await loadGabungan();
  } else if (state.tab === 'kosong') {
    // Nothing to load: the panel only says there is no data yet.
  } else {
    await loadImportLog();
  }
}

export function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $('#pageTitle').textContent = $(`.tab[data-tab="${name}"]`)?.textContent
    ?? (name === 'kosong' ? FAMILY_LABEL[state.family] : '');
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  // Machine-level filters mean nothing on the import screen.
  // The combined report goes month by month and has its own month picker.
  const ownData = ['pabrik', 'users', 'gabungan', 'kosong', 'shiftinput', 'mesin', 'master'].includes(name);
  $('#filterBar').classList.toggle('is-hidden', name === 'import' || ownData);
  // Search answers with orders, so it stays on the combined report too: from
  // there it searches every family and opens the one that wove the order.
  $('#gsearch').hidden = ownData && name !== 'gabungan';
  $$('.field[data-pick]').forEach((f) => {
    const onlyOrderFilters = name === 'quality';
    f.style.display = onlyOrderFilters && !['fabric', 'mo'].includes(f.dataset.pick) ? 'none' : '';
  });
  // No. mesin is chosen on two tabs; each picker shows the current choice.
  $$('.picker').forEach((p) => p._sync?.());
  refresh();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  switchTab(t.dataset.tab);
  // On a phone the menu is a drawer over the page; picking a tab closes it.
  if (phoneNav.matches) setNav(false);
}));

/* ---- the menu on the left ----
 * Laptop: ☰ folds it away and back, remembered per browser.
 * Phone: ☰ opens it as a drawer; the backdrop or a tab closes it. */
export const phoneNav = matchMedia('(max-width: 860px)');
export function setNav(open) {
  if (phoneNav.matches) {
    document.body.classList.toggle('nav-open', open);
    document.body.classList.remove('nav-collapsed');
  } else {
    document.body.classList.toggle('nav-collapsed', !open);
    document.body.classList.remove('nav-open');
    try { localStorage.setItem('mr.nav', open ? 'open' : 'closed'); } catch { /* private window */ }
  }
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}
export const navOpen = () => (phoneNav.matches
  ? document.body.classList.contains('nav-open')
  : !document.body.classList.contains('nav-collapsed'));
$('#menuBtn').addEventListener('click', () => setNav(!navOpen()));
$('#sidebarScrim').addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && phoneNav.matches) setNav(false); });
{
  let saved = 'open';
  try { saved = localStorage.getItem('mr.nav') || 'open'; } catch { /* private window */ }
  setNav(phoneNav.matches ? false : saved !== 'closed');
}
// Crossing the breakpoint (a tablet turned, a window resized) starts closed on
// the phone side and as remembered on the laptop side.
phoneNav.addEventListener('change', () => {
  let saved = 'open';
  try { saved = localStorage.getItem('mr.nav') || 'open'; } catch { /* private window */ }
  setNav(phoneNav.matches ? false : saved !== 'closed');
});

window.addEventListener('scroll', hideTip, { passive: true });
