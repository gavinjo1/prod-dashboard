/**
 * Line charts: one series, or several on one axis.
 */
import { $ } from '../core/dom.js';
import { crosshair, el, empty, esc, fmt, labelIndices, measurer, mount, rows, ticks, ticksBetween, UI_FONT } from './core.js';

/* ------------------------------------------------------------------ *
 * Line / area — one series, one axis
 * ------------------------------------------------------------------ */

export function lineChart(host, data, {
  x = (d) => d.date,
  y = (d) => d.value,
  format = fmt.num,
  unit = '',
  height = 210,
  colour = 'var(--series-1)',
  fill = 'var(--series-1-fill)',
  tipRows = null,
  baseZero = true,
  reference = null,          // a number drawn as a line, kept inside the domain
  referenceLabel = ''        // and the text written on that line
} = {}) {
  const pts = data.filter((d) => y(d) !== null && y(d) !== undefined && !isNaN(y(d)));
  if (pts.length < 2) return empty(host, pts.length ? 'Hanya satu hari dalam rentang ini.' : undefined);

  mount(host, (root, w) => {
    // The endpoint carries a direct label, so reserve exactly its width —
    // a fixed margin clips "56.160,4 m" while wasting space on "98,3%".
    const measureLabel = measurer(`11.5px ${UI_FONT}`);
    const measureAxis = measurer(`11px ${UI_FONT}`);
    const endLabel = format(y(pts[pts.length - 1])) + unit;

    const vals = pts.map(y);
    // A target line only tells you anything if it is inside the plotted range.
    const rawMin = Math.min(...vals, reference ?? Infinity);
    const rawMax = Math.max(...vals, reference ?? -Infinity);
    const span = rawMax - rawMin || Math.abs(rawMax) * 0.02 || 1;
    const lo = baseZero ? 0 : rawMin - span * 0.35;
    const tk = baseZero ? ticks(rawMax) : null;
    const top = baseZero ? tk[tk.length - 1] : rawMax + span * 0.3;

    // Both margins are sized from the text that actually goes in them: a fixed
    // left margin clips "300.000" and a fixed right one clips "56.160,4 m".
    const axisTexts = (tk || ticksBetween(lo, top)).map((v) => (baseZero ? fmt.short(v) : format(v)));
    const m = {
      t: 14,
      r: Math.ceil(measureLabel(endLabel)) + 18,
      b: 26,
      l: Math.ceil(Math.max(...axisTexts.map(measureAxis))) + 12
    };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;

    const scaleY = (v) => m.t + ih - ((v - lo) / (top - lo || 1)) * ih;
    const scaleX = (i) => m.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);

    const svg = el('svg', { width: w, height, role: 'img' });

    // recessive solid hairline grid
    for (const v of (tk || ticksBetween(lo, top))) {
      const gy = scaleY(v);
      if (gy < m.t - 1 || gy > m.t + ih + 1) continue;
      svg.append(el('line', { class: v === lo && baseZero ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' },
        baseZero ? fmt.short(v) : format(v)));
    }

    if (reference !== null) {
      const ry = scaleY(reference);
      svg.append(el('line', { x1: m.l, x2: m.l + iw, y1: ry, y2: ry, stroke: 'var(--axis)', 'stroke-width': 1 }));
      svg.append(el('text', { class: 'axis-label', x: m.l + iw, y: ry - 6, 'text-anchor': 'end' }, referenceLabel));
    }

    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${scaleX(i).toFixed(1)},${scaleY(y(p)).toFixed(1)}`).join(' ');
    svg.append(el('path', {
      d: `${d} L${scaleX(pts.length - 1).toFixed(1)},${m.t + ih} L${scaleX(0).toFixed(1)},${m.t + ih} Z`,
      fill, stroke: 'none'
    }));
    svg.append(el('path', { d, fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // x labels thinned to whatever fits
    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));
    pts.forEach((p, i) => {
      if (!keep.has(i)) return;
      svg.append(el('text', { class: 'axis-label', x: scaleX(i), y: height - 8, 'text-anchor': 'middle' }, fmt.day(x(p))));
    });

    // direct-label the endpoint only
    const last = pts.length - 1;
    const lx = scaleX(last), ly = scaleY(y(pts[last]));
    svg.append(el('circle', { cx: lx, cy: ly, r: 4.5, fill: colour, stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.append(el('text', { class: 'point-label', x: lx + 8, y: ly + 4 }, endLabel));

    const dot = el('circle', { r: 4.5, fill: colour, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
    svg.append(dot);
    crosshair(svg, {
      m, iw, ih, n: pts.length,
      xAt: scaleX,
      valueAtY: (py) => lo + ((m.t + ih - py) / ih) * (top - lo),
      yText: (v) => format(v) + unit,
      xText: (i) => fmt.day(x(pts[i])),
      onDay: (i) => {
        if (i < 0) { dot.setAttribute('opacity', 0); return; }
        dot.setAttribute('cx', scaleX(i)); dot.setAttribute('cy', scaleY(y(pts[i]))); dot.setAttribute('opacity', 1);
      },
      tipHtml: (i) => `<b>${esc(fmt.day(x(pts[i])))}</b>${rows(tipRows ? tipRows(pts[i]) : [['Nilai', format(y(pts[i])) + unit]])}`
    });

    root.append(svg);
  });
}

/* ------------------------------------------------------------------ *
 * Several lines on one axis — output, target and a running average
 *
 * Straight segments between the days with a dot on each, since a day is a
 * point and nothing lies between two of them. All series share one unit, so
 * one axis; it hugs the data rather than starting at zero, because the story
 * is the few percent between output and target. Identity is never colour
 * alone: the legend names each line, and the tooltip lists every series.
 * ------------------------------------------------------------------ */

export function multiLineChart(host, data, series, {
  x = (d) => d.date,
  // Axis text, and the tooltip's heading (a week reads "11 – 17 Sep").
  label = (d) => fmt.day(x(d)),
  title = label,
  height = 280,
  format = fmt.num,
  unit = '',
  tipExtra = () => [],
  highlight = () => false,   // points to set on a tinted band
  hollow = () => false       // points drawn as rings: an incomplete period
} = {}) {
  const pts = data.filter((d) => series.some((s) => Number.isFinite(s.value(d))));
  // One point is still worth showing — a month view of one month — as dots.
  if (!pts.length) return empty(host);

  mount(host, (root, w) => {
    const measureAxis = measurer(`11px ${UI_FONT}`);
    const vals = pts.flatMap((d) => series.map((s) => s.value(d))).filter(Number.isFinite);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const pad = (rawMax - rawMin || Math.abs(rawMax) * 0.02 || 1) * 0.12;
    const tk = ticksBetween(rawMin - pad, rawMax + pad, 4);
    const step = tk.length > 1 ? tk[1] - tk[0] : 1;
    // Snapped out to whole ticks, so the frame starts and ends on a gridline
    // and no line runs into its edge.
    const lo = Math.floor((rawMin - pad) / step) * step;
    const hi = Math.ceil((rawMax + pad) / step) * step;
    const grid = [];
    for (let v = lo; v <= hi + step / 1e6; v += step) grid.push(Number(v.toFixed(10)));

    // The last date label is centred on the last day, so half of it hangs past
    // the plot: the right margin makes room for that half.
    const lastLabel = Math.ceil(measureAxis(label(pts[pts.length - 1])) / 2) + 4;
    const m = { t: 12, r: Math.max(14, lastLabel), b: 26,
      l: Math.ceil(Math.max(...grid.map((v) => measureAxis(fmt.short(v))))) + 14 };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;
    const scaleY = (v) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const scaleX = (i) => m.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);

    const svg = el('svg', { width: w, height, role: 'img' });
    for (const v of grid) {
      const gy = scaleY(v);
      if (gy < m.t - 1 || gy > m.t + ih + 1) continue;
      svg.append(el('line', { class: 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy, 'stroke-dasharray': '3 4' }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 10, y: gy + 4, 'text-anchor': 'end' }, fmt.short(v)));
    }

    // A band behind each highlighted point, as wide as its share of the axis.
    const half = pts.length === 1 ? iw / 2 : iw / (pts.length - 1) / 2;
    pts.forEach((p, i) => {
      if (!highlight(p)) return;
      const x0 = Math.max(m.l - 6, scaleX(i) - half), x1 = Math.min(m.l + iw + 6, scaleX(i) + half);
      svg.append(el('rect', { x: x0, y: m.t, width: x1 - x0, height: ih, fill: 'var(--series-1-fill)', rx: 3 }));
    });

    const dots = pts.length <= 45;
    for (const s of series) {
      const at = pts.map((p, i) => [i, s.value(p)]).filter(([, v]) => Number.isFinite(v));
      const d = at.map(([i, v], k) => `${k ? 'L' : 'M'}${scaleX(i).toFixed(1)},${scaleY(v).toFixed(1)}`).join(' ');
      svg.append(el('path', { d, fill: 'none', stroke: s.colour, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (dots) {
        for (const [i, v] of at) {
          svg.append(el('circle', hollow(pts[i])
            ? { cx: scaleX(i), cy: scaleY(v), r: 3.5, fill: 'var(--surface)', stroke: s.colour, 'stroke-width': 2 }
            : { cx: scaleX(i), cy: scaleY(v), r: 3.5, fill: s.colour, stroke: 'var(--surface)', 'stroke-width': 1.5 }));
        }
      }
    }

    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));
    pts.forEach((p, i) => {
      if (keep.has(i)) svg.append(el('text', { class: 'axis-label', x: scaleX(i), y: height - 8, 'text-anchor': 'middle' }, label(p)));
    });

    // Crosshair with one ring per series on the chosen day.
    const rings = series.map((s) => el('circle', { r: 5.5, fill: s.colour, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }));
    svg.append(...rings);
    crosshair(svg, {
      m, iw, ih, n: pts.length,
      xAt: scaleX,
      valueAtY: (py) => lo + ((m.t + ih - py) / ih) * (hi - lo),
      yText: (v) => fmt.int(v) + unit,
      xText: (i) => label(pts[i]),
      onDay: (i) => series.forEach((s, k) => {
        const v = i < 0 ? NaN : s.value(pts[i]);
        rings[k].setAttribute('opacity', Number.isFinite(v) ? 1 : 0);
        if (Number.isFinite(v)) { rings[k].setAttribute('cx', scaleX(i)); rings[k].setAttribute('cy', scaleY(v)); }
      }),
      tipHtml: (i) => `<b>${esc(title(pts[i]))}</b>${rows([
        ...series.map((s) => [s.name, Number.isFinite(s.value(pts[i])) ? format(s.value(pts[i])) + unit : '—', s.colour]),
        ...tipExtra(pts[i])
      ])}`
    });
    root.append(svg);

    const legend = document.createElement('div');
    legend.className = 'legend legend-dots';
    for (const s of series) {
      const item = document.createElement('span');
      item.innerHTML = `<i style="color:${esc(s.colour)}"></i>${esc(s.name)}`;
      legend.append(item);
    }
    root.append(legend);
  });
}
