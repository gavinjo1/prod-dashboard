/**
 * Produksi: the order detail shown when the view is narrowed to an order.
 */
import { $ } from '../../core/dom.js';
import { api, isCurrent, state, takeTicket } from '../../core/state.js';
import { esc, fmt } from '../../charts/core.js';
import { lineChart } from '../../charts/line.js';

/* ------------------------------------------------------------------ *
 * Order detail — only meaningful once the view is narrowed to an order
 * or a fabric, so it stays hidden otherwise
 * ------------------------------------------------------------------ */

export async function loadOrderInfo() {
  const card = $('#orderInfo');
  if (!state.mo.length && !state.fabric.length) { card.hidden = true; return; }

  const ticket = takeTicket('orderInfo');
  const rows = await api('order-info');
  if (!isCurrent('orderInfo', ticket)) return;

  card.hidden = rows.length === 0;
  if (!rows.length) return;

  const asOf = [...new Set(rows.map((r) => r.as_of).filter(Boolean))].sort();
  $('#orderInfoSub').textContent = asOf.length
    ? `per ${asOf.length > 1 ? `${fmt.day(asOf[0])}–${fmt.day(asOf[asOf.length - 1])}` : fmt.day(asOf[0])}`
    : '';

  // One order selected: show how it progressed, day by day.
  await loadOrderHistory(rows.length === 1 ? rows[0] : null);

  $('#orderInfoTable tbody').innerHTML = rows.map((r) => {
    const target = Number(r.total_order) || 0;
    const done = Number(r.akumulasi) || 0;
    // Four orders in the sheet have no quantity entered; a percentage of zero
    // would be meaningless, so the bar is left out rather than faked.
    const pct = target > 0 ? (done / target) * 100 : null;
    const over = pct !== null && pct > 100;
    return `<tr>
      <td class="mc-name">${esc(r.mo)}</td>
      <td>${esc(r.customer ?? '—')}</td>
      <td class="muted">${esc(r.kode_kain ?? '—')}</td>
      <td class="num">${r.pick == null ? '—' : fmt.num(r.pick)}</td>
      <td class="num">${target > 0 ? fmt.num(target) : '—'}</td>
      <td class="num">${fmt.num(done)}</td>
      <td class="num">${r.sisa_order === null ? '—' : fmt.num(r.sisa_order)}</td>
      <td>${pct === null
        ? '<span class="muted">tanpa qty order</span>'
        : `<span class="progress"><span class="progress-track"><span class="progress-fill${
            over ? ' is-over' : ''}" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>` +
          `<span class="progress-pct">${fmt.pct(pct)}</span></span>`}</td>
    </tr>`;
  }).join('');
}

export async function loadOrderHistory(order) {
  const box = $('#orderHistory');
  if (!order) { box.hidden = true; return; }

  const ticket = takeTicket('orderHistory');
  const rows = await api('order-history', { mo: order.mo });
  if (!isCurrent('orderHistory', ticket)) return;

  box.hidden = rows.length < 2;
  if (rows.length < 2) return;

  const target = Number(order.total_order) || 0;
  $('#orderHistoryTitle').textContent = `Per hari — ${order.mo}`;

  lineChart($('#chartOrderHistory'), rows, {
    y: (d) => Number(d.akumulasi),
    format: fmt.num,
    unit: ' m',
    height: 240,
    baseZero: false,
    reference: target > 0 ? target : null,
    referenceLabel: target > 0 ? `Order ${fmt.num(target)} m` : '',
    tipRows: (d) => [
      ['Output hari itu', fmt.num(d.produksi) + ' m'],
      ['Akumulasi', fmt.num(d.akumulasi) + ' m'],
      ['Sisa order', fmt.num(d.sisa_order) + ' m']
    ]
  });

  $('#orderHistoryTable tbody').innerHTML = rows.map((r) => {
    const pct = target > 0 ? (Number(r.akumulasi) / target) * 100 : null;
    return `<tr>
      <td>${fmt.day(r.date)}</td>
      <td class="num ${Number(r.produksi) ? '' : 'muted'}">${Number(r.produksi) ? fmt.num(r.produksi) : '—'}</td>
      <td class="num">${fmt.num(r.akumulasi)}</td>
      <td class="num">${fmt.num(r.sisa_order)}</td>
      <td class="num ${pct === null ? 'muted' : ''}">${pct === null ? '—' : fmt.pct(pct)}</td>
    </tr>`;
  }).join('');
}
