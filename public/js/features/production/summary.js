/**
 * Produksi: the headline tiles.
 */
import { $ } from '../../core/dom.js';
import { api, isCurrent, takeTicket } from '../../core/state.js';
import { fmt } from '../../charts/core.js';
import { tile } from '../../ui/tiles.js';
import { share } from '../../core/numbers.js';

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

  // The big figure is the filter's last day; the line under it, the period.
  const last = s.last;
  const g = s.grade;
  const onDay = (iso) => (iso ? fmt.day(iso) : '');
  const vsAvg = (() => {
    if (!last || !perDay || last.produksi === null) return '';
    const pc = ((Number(last.produksi) - perDay) / perDay) * 100;
    const up = pc >= 0;
    return ` · <span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt.pct(Math.abs(pc))}</span> vs rata-rata`;
  })();
  const gradeTile = (label, part, partPeriod) => (g && Number(g.total_period) > 0
    ? tile(`${label} · ${onDay(g.tgl)}`, fmt.pct(share(Number(g[part]), Number(g.total))), '',
      `periode ${fmt.pct(share(Number(g[partPeriod]), Number(g.total_period)))}`)
    : tile(label, '—', '', 'belum ada data grade'));

  $('#stats').innerHTML = [
    // Whole metres: at seven digits the decimals no longer fit a tile.
    tile('Total output', fmt.int(s.produksi), 'm', `${s.days} hari · ${s.orders} order`),
    tile('Rata-rata per hari', fmt.int(perDay), 'm', delta),
    tile(`Output · ${onDay(last?.tgl)}`, fmt.int(last?.produksi), 'm',
      last ? `hari terakhir${vsAvg}` : ''),
    tile(`Produktivitas · ${onDay(last?.tgl)}`, fmt.pct(last?.eff), '',
      last ? `periode ${fmt.pct(last.eff_period)}` : ''),
    gradeTile('Grade A', 'a', 'a_period'),
    gradeTile('BS', 'bs', 'bs_period')
  ].join('');
}
