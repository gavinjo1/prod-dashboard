/**
 * Bar, stacked-bar and column charts.
 */
import { $ } from '../core/dom.js';
import { el, ellipsize, empty, esc, fmt, labelIndices, measurer, mount, rows, ticks, tipOn, UI_FONT } from './core.js';

/* ------------------------------------------------------------------ *
 * Horizontal bars — one measure, nominal categories, one colour
 * ------------------------------------------------------------------ */

export function barChart(host, data, {
  label = (d) => d.label,
  value = (d) => d.value,
  format = fmt.num,
  labelWidth = 110,
  rowHeight = 27,
  tipRows = null,
  max = 8
} = {}) {
  const rowsIn = data.filter((d) => value(d) > 0).slice(0, max);
  if (!rowsIn.length) return empty(host);

  mount(host, (root, w) => {
    const pad = { t: 4, r: 8, b: 4 };
    const gap = 7;                        // >= 2px surface gap between bars
    const barH = rowHeight - gap;

    const measureLabel = measurer(`11px ${UI_FONT}`);
    const measureValue = measurer(`11.5px ${UI_FONT}`);
    const names = rowsIn.map((d) => String(label(d) ?? '—'));
    const texts = rowsIn.map((d) => format(value(d)));

    const wantLabel = Math.max(...names.map(measureLabel)) + 10;
    const valueW = Math.max(...texts.map(measureValue)) + 14;

    // Names like "AJL TOYOTA 2 810 | AJL 2 AIR TUCKER" do not fit beside a bar
    // in a narrow card. When they don't, the label moves onto its own line
    // above a full-width bar rather than being cut where it matters.
    const inlineLabelW = Math.max(labelWidth, wantLabel);
    const stacked = inlineLabelW > (w - valueW) * 0.45;

    const top = Math.max(...rowsIn.map(value));
    const step = stacked ? rowHeight + 15 : rowHeight;
    const trackW = stacked ? w - pad.r : Math.max(30, w - inlineLabelW - valueW - pad.r);
    const total = pad.t + rowsIn.length * step + pad.b;

    const svg = el('svg', { width: w, height: total, role: 'img' });

    rowsIn.forEach((d, i) => {
      const y = pad.t + i * step;
      const bw = Math.max(2, (value(d) / top) * trackW);
      const g = el('g', { class: 'bar-row' });
      const name = names[i];

      const barY = stacked ? y + 16 : y;
      const barX = stacked ? 0 : inlineLabelW;
      const barHeight = stacked ? 7 : barH;
      const textY = stacked ? y + 10 : y + barH / 2 + 4;

      const text = el('text', { class: 'axis-label', x: 0, y: textY },
        stacked ? ellipsize(name, w - valueW - 8, measureLabel)
                : ellipsize(name, inlineLabelW - 10, measureLabel));
      text.append(el('title', {}, name));   // full name on hover

      g.append(
        text,
        // 4px rounded data-end, anchored square to the baseline
        el('rect', { class: 'bar', x: barX, y: barY, width: bw, height: barHeight, rx: 3 }),
        el('text', { class: 'bar-value', x: w - pad.r, y: textY, 'text-anchor': 'end' }, texts[i])
      );

      const hit = el('rect', { class: 'bar-hit', x: 0, y: y - gap / 2, width: w, height: step });
      tipOn(hit, () => `<b>${esc(name)}</b>${rows(tipRows ? tipRows(d) : [['Nilai', format(value(d))]])}`);
      g.append(hit);

      svg.append(g);
    });

    root.append(svg);
  });
}

/* ------------------------------------------------------------------ *
 * Stacked bars — ordered grades, legend always present
 * ------------------------------------------------------------------ */

export function stackedBars(host, data, series, {
  x = (d) => d.date,
  // Axis text; the tooltip title can be longer ("11–17 Sep" under "11 Sep").
  label = (d) => fmt.day(x(d)),
  title = label,
  tipExtra = () => [],
  height = 230,
  format = fmt.num
} = {}) {
  const pts = data.filter((d) => series.some((s) => s.value(d) > 0));
  if (!pts.length) return empty(host);

  mount(host, (root, w) => {
    const m = { t: 14, r: 10, b: 26, l: 48 };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;
    const totals = pts.map((d) => series.reduce((s, ser) => s + (ser.value(d) || 0), 0));
    const tk = ticks(Math.max(...totals));
    const top = tk[tk.length - 1];
    const scaleY = (v) => m.t + ih - (v / (top || 1)) * ih;

    const slot = iw / pts.length;
    const barW = Math.max(3, Math.min(22, slot - 8));

    const svg = el('svg', { width: w, height, role: 'img' });

    for (const v of tk) {
      const gy = scaleY(v);
      svg.append(el('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, fmt.short(v)));
    }

    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));

    pts.forEach((d, i) => {
      const cx = m.l + slot * i + slot / 2;
      let cursor = 0;
      const g = el('g');

      for (const ser of series) {
        const v = ser.value(d) || 0;
        if (v <= 0) { cursor += v; continue; }
        const y0 = scaleY(cursor + v);
        const y1 = scaleY(cursor);
        // 2px surface gap between segments instead of a stroke
        const h = Math.max(1, y1 - y0 - 2);
        g.append(el('rect', { x: cx - barW / 2, y: y0, width: barW, height: h, fill: ser.colour, rx: 1.5 }));
        cursor += v;
      }

      const hit = el('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ih, fill: 'transparent' });
      tipOn(hit, () => `<b>${esc(title(d))}</b>` +
        rows([...series.map((s) => [s.name, format(s.value(d) || 0), s.colour]),
          ['Total', format(series.reduce((t, s) => t + (s.value(d) || 0), 0))], ...tipExtra(d)]));
      g.append(hit);

      if (keep.has(i)) {
        g.append(el('text', { class: 'axis-label', x: cx, y: height - 8, 'text-anchor': 'middle' }, label(d)));
      }
      svg.append(g);
    });

    root.append(svg);

    const legend = document.createElement('div');
    legend.className = 'legend';
    const grand = series.map((s) => pts.reduce((t, d) => t + (s.value(d) || 0), 0));
    series.forEach((s, i) => {
      const item = document.createElement('span');
      item.innerHTML = `<i style="color:${esc(s.colour)}"></i>${esc(s.name)} <span class="n">${esc(format(grand[i]))}</span>`;
      legend.append(item);
    });
    root.append(legend);
  });
}

/* ------------------------------------------------------------------ *
 * Columns — one measure over discrete days, anchored at zero
 * ------------------------------------------------------------------ */

export function columnChart(host, data, {
  x = (d) => d.date,
  y = (d) => d.value,
  format = fmt.num,
  unit = '',
  height = 230,
  tipRows = null,
  // Optional target zone drawn behind the columns, per day: [low, high].
  // Returning null for a day leaves that day blank rather than guessing.
  band = null,
  bandColour = '#eb6834',
  // Up to two short lines printed above every column. Returning null for a
  // line omits it. Dropped entirely when the columns are too close together
  // for the text to stay apart — a row of overlapping numbers reads as noise.
  labels = null
} = {}) {
  const pts = data.filter((d) => y(d) !== null && !isNaN(y(d)));
  if (!pts.length) return empty(host);

  mount(host, (root, w) => {
    const measureTop = measurer(`11.5px ${UI_FONT}`);
    const measureSub = measurer(`10.5px ${UI_FONT}`);

    // Decide up front whether the per-column labels fit, because the top
    // margin has to make room for them.
    const drawn = labels ? pts.map(labels) : [];
    const widest = drawn.length
      ? Math.max(...drawn.map((l) => Math.max(
          l?.[0] ? measureTop(l[0]) : 0, l?.[1] ? measureSub(l[1]) : 0)))
      : 0;
    const slotW = Math.max(40, w - 58 - 10) / pts.length;
    // A clear gap, not a hairline: labels that only just avoid touching still
    // read as one run of digits.
    const showLabels = labels && widest + 16 <= slotW;
    const twoLines = showLabels && drawn.some((l) => l?.[1]);

    const m = { t: showLabels ? (twoLines ? 40 : 26) : 22, r: 10, b: 26, l: 48 };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;
    const bandOf = band ? (d) => { const b = band(d); return b && b[1] > 0 ? b : null; } : () => null;
    const bandTop = band ? Math.max(0, ...pts.map((d) => bandOf(d)?.[1] ?? 0)) : 0;
    const tk = ticks(Math.max(...pts.map(y), bandTop));
    const top = tk[tk.length - 1];
    const scaleY = (v) => m.t + ih - (v / (top || 1)) * ih;

    const slot = iw / pts.length;
    const barW = Math.max(3, Math.min(22, slot - 6));   // >= 2px surface gap
    const svg = el('svg', { width: w, height, role: 'img' });

    for (const v of tk) {
      const gy = scaleY(v);
      svg.append(el('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, fmt.short(v)));
    }

    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));
    const peak = pts.reduce((best, d) => (y(d) > y(best) ? d : best), pts[0]);

    // The target zone goes down first so the columns read on top of it.
    if (band) {
      pts.forEach((d, i) => {
        const b = bandOf(d);
        if (!b) return;
        const cx = m.l + slot * i + slot / 2;
        // Full slot width so consecutive days meet and the zone reads as one
        // continuous strip rather than a row of floating caps.
        const w = slot;
        const yHi = scaleY(b[1]);
        svg.append(el('rect', {
          x: cx - w / 2, y: yHi, width: w, height: Math.max(1, scaleY(b[0]) - yHi),
          fill: bandColour, opacity: 0.14
        }));
        svg.append(el('line', {
          x1: cx - w / 2, x2: cx + w / 2, y1: yHi, y2: yHi,
          stroke: bandColour, 'stroke-width': 1.5, opacity: 0.85
        }));
      });
    }

    pts.forEach((d, i) => {
      const cx = m.l + slot * i + slot / 2;
      const yTop = scaleY(y(d));
      const g = el('g', { class: 'bar-row' });
      g.append(el('rect', { class: 'bar', x: cx - barW / 2, y: yTop, width: barW, height: Math.max(1, m.t + ih - yTop), rx: 3 }));

      if (showLabels) {
        const [main, sub] = drawn[i] ?? [];
        if (sub) g.append(el('text', { class: 'col-sub', x: cx, y: yTop - 20, 'text-anchor': 'middle' }, sub));
        if (main) g.append(el('text', { class: 'col-value', x: cx, y: yTop - 8, 'text-anchor': 'middle' }, main));
      } else if (d === peak) {
        // No room for every column, so only the peak is named; the axis and
        // the tooltip carry the rest.
        g.append(el('text', { class: 'point-label', x: cx, y: yTop - 7, 'text-anchor': 'middle' }, format(y(d)) + unit));
      }

      const hit = el('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ih, fill: 'transparent' });
      tipOn(hit, () => `<b>${esc(fmt.day(x(d)))}</b>${rows(tipRows ? tipRows(d) : [['Nilai', format(y(d)) + unit]])}`);
      g.append(hit);

      if (keep.has(i)) {
        g.append(el('text', { class: 'axis-label', x: cx, y: height - 8, 'text-anchor': 'middle' }, fmt.day(x(d))));
      }
      svg.append(g);
    });

    root.append(svg);
  });
}
