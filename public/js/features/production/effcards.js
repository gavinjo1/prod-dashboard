/**
 * Produksi: efficiency per machine type, opening onto each machine.
 */
import { $ } from '../../core/dom.js';
import { esc, fmt } from '../../charts/core.js';
import { openMachine } from './machines.js';

/* ------------------------------------------------------------------ *
 * Production panel
 * ------------------------------------------------------------------ */

/**
 * One card per layout band — AJL TOYOTA 1, 2 810, 910, 4 — each with its
 * machine types underneath, as the sheet heads its columns. Efficiency is
 * output over capability; the target colours it, and a ▼ or ✓ says the same
 * for anyone who cannot tell the red from the green.
 */
/** Types whose machine list is open, kept across redraws of the cards. */
export const openTypes = new Set();

export function renderEffCards(rows, targetPct, byMachine = []) {
  const bands = [];
  for (const r of rows) {
    let b = bands.find((x) => x.band === r.band);
    if (!b) bands.push((b = { band: r.band, produksi: 0, capability: 0, machines: 0, unpriced: 0, types: [] }));
    b.unpriced += r.unpriced || 0;
    b.produksi += Number(r.produksi || 0);
    b.capability += Number(r.capability || 0);
    b.machines += r.machines;
    b.types.push(r);
  }
  const pct = (p, c) => (c > 0 ? (p / c) * 100 : null);
  const mark = (v) => (v === null ? '' : v >= targetPct ? '✓ ' : '▼ ');
  const cls = (v) => (v === null ? '' : v >= targetPct ? 'is-good' : 'is-bad');
  // Always one decimal, so 79,0% sits in line with 64,7% rather than as "79%".
  const show = (v) => (v === null ? '—'
    : `${v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

  // Each type opens onto its machines, numbered as the shed is (A1, A2 … A10).
  const machinesOf = (type) => byMachine
    .filter((m) => m.type_mc === type)
    .sort((a, b) => a.no_mc.localeCompare(b.no_mc, 'en', { numeric: true }));
  const machineList = (type) => {
    const list = machinesOf(type);
    return `<ul class="eff-machines"${openTypes.has(type) ? '' : ' hidden'}>${list.map((m) => {
      const me = pct(Number(m.produksi || 0), Number(m.capability || 0));
      return `<li><button type="button" class="eff-mc" data-mc="${esc(m.no_mc)}" title="Lihat semua shift">` +
        `<span>${esc(m.no_mc)}</span><b class="${cls(me)}">${mark(me)}${show(me)}</b></button></li>`;
    }).join('') || '<li class="muted">Tidak ada mesin.</li>'}</ul>`;
  };

  $('#effCards').innerHTML = bands.map((b) => {
    const e = pct(b.produksi, b.capability);
    const types = `<ul>${b.types.map((t) => {
      const te = pct(Number(t.produksi || 0), Number(t.capability || 0));
      const open = openTypes.has(t.type_mc);
      return `<li class="eff-type-row"><button type="button" class="eff-type" data-type="${esc(t.type_mc)}"
          aria-expanded="${open}" title="${esc(t.type_mc)}">
          <span><i class="eff-caret" aria-hidden="true">${open ? '▾' : '▸'}</i>${esc(t.description)}</span>
          <b class="${cls(te)}">${mark(te)}${show(te)}</b></button>${machineList(t.type_mc)}</li>`;
    }).join('')}</ul>`;
    return `<div class="eff-card">
      <h3>${esc(b.band)}</h3>
      <p class="eff-big ${cls(e)}">${mark(e)}${show(e)}</p>
      <p class="eff-sub">target ${fmt.int(targetPct)}% · ${fmt.int(b.machines)} mesin${
        b.unpriced ? ` · ${fmt.int(b.unpriced)} shift tanpa pick tidak dihitung` : ''}</p>
      ${types}
    </div>`;
  }).join('');
}

// A type opens and closes its machine list; a machine opens its shifts.
$('#effCards').addEventListener('click', (e) => {
  const mc = e.target.closest('.eff-mc');
  if (mc) { openMachine(mc.dataset.mc); return; }
  const btn = e.target.closest('.eff-type');
  if (!btn) return;
  const type = btn.dataset.type;
  const open = !openTypes.has(type);
  if (open) openTypes.add(type); else openTypes.delete(type);
  btn.setAttribute('aria-expanded', String(open));
  btn.querySelector('.eff-caret').textContent = open ? '▾' : '▸';
  btn.nextElementSibling.hidden = !open;
});
