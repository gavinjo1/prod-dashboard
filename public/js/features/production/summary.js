/**
 * Produksi: the headline tiles.
 */
import { $ } from '../../core/dom.js';
import { api, isCurrent, takeTicket } from '../../core/state.js';
import { fmt } from '../../charts/core.js';
import { tile } from '../../ui/tiles.js';

export async function loadSummary() {
  const ticket = takeTicket('summary');
  const s = await api('summary');
  if (!isCurrent('summary', ticket)) return;
  const perDay = s.days ? s.produksi / s.days : 0;
  const delta = (() => {
    if (!s.prev || !s.prev.days || !s.prev.produksi) return '';
    const prevPerDay = s.prev.produksi / s.prev.days;
    const pc = ((perDay - prevPerDay) / prevPerDay) * 100;
    const up = pc >= 0;
    return `<span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt.pct(Math.abs(pc))}</span> vs ${s.prev.days} hari sebelumnya`;
  })();

  $('#stats').innerHTML = [
    // Whole metres: at seven digits the decimals no longer fit a tile.
    tile('Total output', fmt.int(s.produksi), 'm', `${s.days} hari · ${s.orders} order`),
    tile('Rata-rata per hari', fmt.int(perDay), 'm', delta),
    tile('Mesin jalan', fmt.int(s.machines), '', `${fmt.int(s.entries)} shift mesin`),
    tile('Berhenti tercatat', fmt.int(s.stoppages), '',
      s.entries ? `${fmt.pct((s.stoppages / s.entries) * 100)} dari shift` : ''),
    tile('Shift kosong', fmt.int(s.idle_shifts), '', 'tanpa output')
  ].join('');
}
