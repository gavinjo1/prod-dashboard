/**
 * The multi-select dropdown used by every filter.
 */
import { $, $$ } from '../core/dom.js';
import { esc } from '../charts/core.js';
import { refresh } from '../features/shell.js';
import { state } from '../core/state.js';

/* ------------------------------------------------------------------ *
 * Multi-select picker
 * ------------------------------------------------------------------ */

export const optValue = (o) => (o && typeof o === 'object' ? o.value : o);
/** Text used for searching — matches the band, the mill's name or the code. */
export const optLabel = (o) => (o && typeof o === 'object'
  ? `${o.label ?? ''} ${o.value}` : String(o));
export const optShort = (o) => (o && typeof o === 'object' && o.label ? o.label : String(optValue(o)));
/** The TYPE MC code sits under the name, so rows stay one line. */
export const optNode = (o) => {
  const wrap = document.createElement('span');
  wrap.className = 'opt';
  if (o && typeof o === 'object' && o.label) {
    wrap.innerHTML = `${esc(o.label)}<small>${esc(o.value)}</small>`;
  } else {
    wrap.textContent = String(optValue(o));
  }
  return wrap;
};

/** A1, A2 … A10 rather than A1, A10, A11, A2: how the shed is numbered. */
export const byMachineNo = (list) => [...list].sort((a, b) =>
  String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' }));

export function buildPicker(host, key, options, noun) {
  host.innerHTML = `
    <button class="picker-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="val is-empty">Semua</span><span class="caret">▾</span>
    </button>
    <div class="picker-menu">
      ${options.length > 9 ? '<input type="search" class="search" placeholder="Cari…">' : ''}
      <div class="picker-list" role="listbox"></div>
      <div class="picker-foot"><button type="button" data-all>Pilih semua</button><button type="button" data-none>Kosongkan</button></div>
    </div>`;

  const btn = $('.picker-btn', host);
  const list = $('.picker-list', host);
  const label = $('.val', host);

  const paint = () => {
    list.replaceChildren();
    const q = ($('.search', host)?.value || '').toLowerCase();
    for (const opt of options) {
      const value = optValue(opt);
      if (q && !optLabel(opt).toLowerCase().includes(q)) continue;
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state[key].includes(value);
      box.addEventListener('change', () => {
        state[key] = box.checked
          ? [...state[key], value]
          : state[key].filter((v) => v !== value);
        sync();
        refresh();
      });
      row.append(box, optNode(opt));
      list.append(row);
    }
  };

  const sync = () => {
    const n = state[key].length;
    const one = options.find((o) => optValue(o) === state[key][0]);
    label.textContent = n === 0 ? 'Semua' : n === 1 ? optShort(one ?? state[key][0]) : `${n} ${noun}`;
    label.classList.toggle('is-empty', n === 0);
    host.classList.toggle('is-set', n > 0);
  };

  btn.addEventListener('click', () => {
    const open = host.classList.contains('is-open');
    $$('.picker.is-open').forEach((p) => p.classList.remove('is-open'));
    host.classList.toggle('is-open', !open);
    btn.setAttribute('aria-expanded', String(!open));
    if (!open) { paint(); $('.search', host)?.focus(); }
  });
  $('.search', host)?.addEventListener('input', paint);
  $('[data-all]', host).addEventListener('click', () => { state[key] = options.map(optValue); sync(); paint(); refresh(); });
  $('[data-none]', host).addEventListener('click', () => { state[key] = []; sync(); paint(); refresh(); });

  host._sync = () => { sync(); paint(); };
  sync();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) $$('.picker.is-open').forEach((p) => p.classList.remove('is-open'));
});
