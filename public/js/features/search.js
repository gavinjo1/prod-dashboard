/**
 * The search box over everything.
 */
import { $, $$ } from '../core/dom.js';
import { isCurrent, params, state, takeTicket } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { refresh, switchTab } from './shell.js';

/* ------------------------------------------------------------------ *
 * Search over everything
 *
 * Whatever you type — a customer, an order, a fabric, a machine, a stoppage
 * note — the answer comes back as a list of orders, because that is the level
 * the mill plans and ships at.
 * ------------------------------------------------------------------ */

export const gsPanel = $('#gsPanel');
export const gsInput = $('#gsInput');

export const closeSearch = () => {
  gsPanel.hidden = true;
  gsInput.setAttribute('aria-expanded', 'false');
};

export const MATCHED = { customer: 'customer', order: 'order', fabric: 'kain', 'machine type': 'tipe mesin',
  machine: 'mesin', note: 'catatan' };

export function renderSearch(query, rows) {
  $('#gsStatus').textContent = rows.length
    ? `${fmt.int(rows.length)} order untuk "${query}"`
    : `Tidak ada yang cocok dengan "${query}"`;

  // An order can run on five machine types across nineteen looms; listing them
  // all fills the line and truncates before anything useful is visible.
  const summarise = (value, sep, noun) => {
    if (!value) return null;
    const parts = value.split(sep).map((v) => v.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : `${parts[0]} +${parts.length - 1} ${noun}`;
  };

  $('#gsList').innerHTML = rows.map((r) => {
    const bits = [
      summarise(r.kode_kain, ',', 'kain'),
      summarise(r.type_mc, '·', 'tipe'),
      r.n_machines ? `${fmt.int(r.n_machines)} mesin` : null
    ].filter(Boolean).join(' · ');
    return `<button class="gs-row" type="button" data-mo="${esc(r.mo)}">
      <span class="gs-main">
        <span><span class="gs-mo">${esc(r.mo)}</span><span class="gs-cust">${esc(r.customer ?? '—')}</span></span>
        <span class="gs-sub">${esc(bits) || 'tidak ditenun di periode ini'}</span>
      </span>
      <span class="gs-right">
        <span class="gs-prod">${r.produksi === null ? '—' : fmt.num(r.produksi) + ' m'}</span><br>
        <span class="gs-tag">${esc(MATCHED[r.matched] ?? r.matched ?? 'cocok')}</span>
      </span>
    </button>`;
  }).join('');

  gsPanel.hidden = false;
  gsInput.setAttribute('aria-expanded', 'true');
}

export let gsTimer = null;
gsInput.addEventListener('input', () => {
  clearTimeout(gsTimer);
  const query = gsInput.value.trim();
  if (query.length < 2) { closeSearch(); return; }

  gsTimer = setTimeout(async () => {
    const ticket = takeTicket('search');
    // Only the family on screen: AJL's orders are not Rapier's.
    const res = await fetch(`/api/search?${new URLSearchParams({ q: query, family: params().get('family') })}`);
    const data = await res.json();
    if (!isCurrent('search', ticket)) return;
    renderSearch(data.query, data.rows);
  }, 180);
});

gsInput.addEventListener('focus', () => {
  if (gsInput.value.trim().length >= 2 && $('#gsList').children.length) gsPanel.hidden = false;
});

/** Picking an order narrows the whole dashboard to it. */
$('#gsList').addEventListener('click', async (e) => {
  const row = e.target.closest('.gs-row');
  if (!row) return;
  state.mo = [row.dataset.mo];
  $$('.picker').forEach((p) => p._sync?.());
  closeSearch();
  gsInput.value = '';
  if (state.tab !== 'production') switchTab('production'); else await refresh();
});

document.addEventListener('click', (e) => { if (!e.target.closest('.gsearch')) closeSearch(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
