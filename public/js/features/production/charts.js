/**
 * Produksi: the output chart by day, week, month or year, and the breakdown charts.
 */
import { $, $$ } from '../../core/dom.js';
import { Q_PERIOD } from '../../core/periods.js';
import { api, isCurrent, state, takeTicket } from '../../core/state.js';
import { barChart } from '../../charts/bars.js';
import { daysIn, fridayOf, isoPlus, todayIso } from '../../core/dates.js';
import { fmt } from '../../charts/core.js';
import { multiLineChart } from '../../charts/line.js';
import { renderEffCards } from './effcards.js';
import { targetFamily, targets } from './targets.js';
import { FAMILY_LABEL } from '../family.js';

/**
 * The breakdown cards' own time range, counted back from the last day of the
 * main filter rather than from the calendar: the daily report arrives a week
 * or two late, so "today" by the clock would nearly always be empty.
 */
export const RANGE_DAYS = { day: 1, 7: 7, month: 30 };
export function rangeFor(key) {
  const end = state.to;
  if (!end) return {};
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((RANGE_DAYS[key] ?? 30) - 1));
  return { from: d.toISOString().slice(0, 10), to: end };
}
// Non-breaking inside each date, so a narrow card wraps at the dash and never
// leaves "Sep" alone on the next line.
export const nb = (t) => t.replace(/ /g, '\u00a0');
export const rangeLabel = (r) => (!r.from ? '' : r.from === r.to ? nb(fmt.day(r.to))
  : `${nb(fmt.day(r.from))} – ${nb(fmt.day(r.to))}`);

/* ---- Output against target, by day, week, month or year ---- */

export let trendDays = [];
export const TREND_TITLE = { day: 'Output harian', week: 'Output per minggu', month: 'Output per bulan', year: 'Output per tahun' };
export const TREND_UNIT = { day: 'hari', week: 'minggu', month: 'bulan', year: 'tahun' };

/**
 * Capability × the family's efficiency target. Shifts that cannot be priced
 * count as what they produced.
 */
export function withTargets(trend) {
  const pct = Number(targets.effs?.[targetFamily()] ?? 80);
  return trend.map((d) => ({
    ...d,
    pct,
    target: Number(d.at_target_rpm || 0) * (pct / 100) + Number(d.target_as_is || 0)
  }));
}

/**
 * The days a week, month or year view covers. The daily view follows the
 * filter exactly; the others count back from its end date — eight weeks,
 * twelve months, every year — so a filter of 20–22 Sep shows that week among
 * the weeks before it, rather than one three-day week on its own.
 * Each window runs to the end of the period holding the end date.
 */
export const TREND_BACK = { week: 8, month: 12 };
export function trendWindow(period) {
  const to = state.to || todayIso();
  if (period === 'week') {
    const fri = fridayOf(to);
    return { from: isoPlus(fri, -7 * (TREND_BACK.week - 1)), to: isoPlus(fri, 6) };
  }
  if (period === 'month') {
    const [y, m] = to.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - TREND_BACK.month, 1)).toISOString().slice(0, 10);
    return { from: first, to: `${to.slice(0, 7)}-${String(daysIn(to.slice(0, 7))).padStart(2, '0')}` };
  }
  return { from: '', to: `${to.slice(0, 4)}-12-31` };
}

/** Days summed into the same weeks (Friday to Thursday), months and years as Kualitas. */
export function trendPeriods(days, period) {
  const P = Q_PERIOD[period];
  const out = new Map();
  for (const d of days) {
    const k = P.key(d.date);
    let b = out.get(k);
    if (!b) {
      out.set(k, (b = { date: k, first: d.date, last: d.date, produksi: 0, target: 0,
        at_target_rpm: 0, target_as_is: 0, days: 0, short: 0 }));
    }
    b.last = d.date;
    b.produksi += Number(d.produksi) || 0;
    b.target += d.target;
    b.at_target_rpm += Number(d.at_target_rpm) || 0;
    b.target_as_is += Number(d.target_as_is) || 0;
    b.days++;
    if (Number(d.produksi) < d.target) b.short++;
  }
  return [...out.values()];
}

/** How many days a period has on the calendar. */
export const periodDays = (period, key) => (period === 'week' ? 7 : period === 'month' ? daysIn(key)
  : (Number(key) % 4 === 0 ? 366 : 365));

export async function paintTrend() {
  const period = state.trendPeriod;
  const byDay = period === 'day';
  const P = Q_PERIOD[period];
  $('#trendTitle').textContent = TREND_TITLE[period];
  $$('#trendPeriod [data-tperiod]').forEach((b) => b.classList.toggle('is-active', b.dataset.tperiod === period));

  let rows = trendDays;
  if (!byDay) {
    const ticket = takeTicket('trendPeriod');
    const win = trendWindow(period);
    const trend = await api('trend', win);
    if (!isCurrent('trendPeriod', ticket) || state.trendPeriod !== period) return;
    rows = trendPeriods(withTargets(trend), period);
  }

  // The periods the filter itself falls in, marked so they stand out among
  // the ones before; and those the data only partly covers, drawn hollow.
  const lo = state.from && P.key(state.from);
  const hi = state.to && P.key(state.to);
  const inFilter = (d) => !byDay && lo && d.date >= lo && d.date <= hi;
  const partial = (d) => !byDay && d.days < periodDays(period, d.date);

  // Under the two lines: how far off, and the efficiency — output against
  // capability at the RPM target. Shifts with no pick or RPM target have no
  // capability, so their output (target_as_is) is left out of both sides.
  const tipRows = (d) => {
    const gap = Number(d.produksi) - d.target;
    const cap = Number(d.at_target_rpm) || 0;
    return [
      ['Selisih', `${gap >= 0 ? '+' : '−'}${fmt.num(Math.abs(gap))} m`],
      ['Efisiensi', cap ? fmt.pct((Number(d.produksi) - (Number(d.target_as_is) || 0)) / cap * 100) : '—']
    ];
  };

  // Palette slots 1 and 3, which stay apart for colour-blind readers. Target
  // first, as the tooltip reads: what was asked, then what was woven.
  multiLineChart($('#chartTrend'), rows, [
    { name: 'Target', colour: 'var(--series-3)', value: (d) => d.target },
    { name: 'Hasil mesin', colour: 'var(--series-1)', value: (d) => Number(d.produksi) }
  ], {
    unit: ' m',
    label: (d) => (byDay ? fmt.day(d.date) : P.label(d.date, d)),
    title: (d) => (byDay ? fmt.day(d.date) : P.long(d.date, d)),
    highlight: inFilter,
    hollow: partial,
    tipExtra: tipRows
  });

  const short = rows.filter((d) => Number(d.produksi) < d.target).length;
  const lead = byDay ? ''
    : period === 'year' ? `Semua tahun s.d. ${fmt.day(state.to || todayIso())} · `
    : `${TREND_BACK[period]} ${TREND_UNIT[period]} terakhir s.d. ${fmt.day(state.to || todayIso())}${
      rows.length < TREND_BACK[period] ? ` (data baru ada ${rows.length} ${TREND_UNIT[period]})` : ''} · `;
  $('#chartTrendNote').textContent = rows.length
    ? `${lead}${fmt.int(short)} dari ${fmt.int(rows.length)} ${TREND_UNIT[period]} di bawah target` +
      (rows.some(partial) ? ' · titik berlubang: belum penuh' : '') +
      (rows.some(inFilter) ? ' · latar biru: periode filter' : '')
    : '';
}

$$('#trendPeriod [data-tperiod]').forEach((b) => b.addEventListener('click', () => {
  state.trendPeriod = b.dataset.tperiod;
  paintTrend();
}));

export async function loadCharts() {
  const ticket = takeTicket('charts');
  const [trend, effs, byType, byMachine] = await Promise.all([
    api('trend'),
    targets.effs ? Promise.resolve(targets.effs) : api('settings/target-eff'),
    api('efficiency-by-type'),
    api('efficiency-by-machine')
  ]);
  if (!isCurrent('charts', ticket)) return;
  targets.effs = effs;

  // Each family has its own target, and the label says whose it is.
  const effPct = Number(effs[targetFamily()] ?? 80);
  $('#targetEffLabel').textContent = `Target efisiensi ${FAMILY_LABEL[targetFamily()]}`;
  if (document.activeElement !== $('#targetEff')) $('#targetEff').value = effPct;

  trendDays = withTargets(trend);
  await paintTrend();

  renderEffCards(byType, effPct, byMachine);

  const gRange = rangeFor(state.groupRange);
  const sRange = rangeFor(state.shiftRange);
  const [groups, shifts, stops] = await Promise.all([
    api('breakdown/group', gRange), api('breakdown/shift', sRange), api('stoppages')
  ]);
  if (!isCurrent('charts', ticket)) return;

  // A one-bar bar chart says nothing, so when the chosen dimension collapses
  // to a single row, step down a level rather than draw it.
  let groupRows = state.dim === 'group' ? groups : await api(`breakdown/${state.dim}`, gRange);
  let groupTitle = 'Output per';
  if (groupRows.length <= 1) {
    const types = state.dim === 'group' ? await api('breakdown/type', gRange) : groupRows;
    if (types.length > 1) {
      groupRows = types;
      groupTitle = 'Output per tipe';
    } else {
      groupRows = await api('breakdown/machine', { limit: 8, ...gRange });
      groupTitle = 'Mesin teratas';
    }
  }
  if (!isCurrent('charts', ticket)) return;
  $('#chartGroupTitle').textContent = groupTitle;
  $$('.seg[data-dim]').forEach((b) => b.classList.toggle('is-active', b.dataset.dim === state.dim));

  // 32 fabrics will not fit in this card, so say plainly that it is a top slice
  // rather than letting the chart quietly drop the tail.
  const SHOWN = 8;
  $('#chartGroupNote').textContent = [rangeLabel(gRange),
    groupRows.length > SHOWN ? `top ${SHOWN} dari ${fmt.int(groupRows.length)}` : '']
    .filter(Boolean).join(' · ');
  $('#chartShiftNote').textContent = rangeLabel(sRange);
  $$('[data-range-for]').forEach((g) => {
    const cur = g.dataset.rangeFor === 'group' ? state.groupRange : state.shiftRange;
    g.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('is-active', b.dataset.range === cur));
  });

  barChart($('#chartGroup'), groupRows, {
    value: (d) => Number(d.produksi),
    labelWidth: 112,
    tipRows: (d) => [
      ...(d.code ? [['TYPE MC', d.code]] : []),
      ['Output', fmt.num(d.produksi) + ' m'],
      ['Mesin', fmt.int(d.machines)]
    ]
  });

  // Shifts read in their own order (A, B, C), not by size.
  barChart($('#chartShift'), [...shifts].sort((a, b) => String(a.label).localeCompare(String(b.label))), {
    value: (d) => Number(d.produksi),
    labelWidth: 56,
    tipRows: (d) => [
      ['Output', fmt.num(d.produksi) + ' m'],
      ['Shift mesin', fmt.int(d.entries)]
    ]
  });

  barChart($('#chartStop'), stops, {
    value: (d) => Number(d.entries),
    format: fmt.int,
    labelWidth: 108,
    tipRows: (d) => [
      ['Shift terdampak', fmt.int(d.entries)],
      ['Mesin', fmt.int(d.machines)],
      ['Output shift itu', fmt.num(d.produksi) + ' m']
    ]
  });
}

$$('[data-range-for] [data-range]').forEach((b) => b.addEventListener('click', () => {
  const which = b.closest('[data-range-for]').dataset.rangeFor;
  state[which === 'group' ? 'groupRange' : 'shiftRange'] = b.dataset.range;
  loadCharts();
}));

$$('.seg[data-dim]').forEach((b) => b.addEventListener('click', () => {
  state.dim = b.dataset.dim;
  loadCharts();
}));
