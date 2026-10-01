/**
 * Chart plumbing: drawing, number formats, tooltips and the crosshair.
 */
import { $ } from '../core/dom.js';

/* ------------------------------------------------------------------ *
 * Small SVG chart set. Everything is drawn at the container's real pixel
 * width and redrawn on resize, so text never scales with a viewBox.
 * ------------------------------------------------------------------ */

export const NS = 'http://www.w3.org/2000/svg';
export const tip = () => document.getElementById('tooltip');

/**
 * Everything that reaches a chart label or tooltip came out of a spreadsheet
 * cell, and a cell can hold "<img src=x onerror=...>". Anything interpolated
 * into innerHTML goes through this first.
 */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Indonesian convention throughout: "." groups thousands, "," is the decimal
// point, so 2019419.4 reads 2.019.419,4 — the same way the source workbook does.
export const LOCALE = 'id-ID';
export const blank = (n) => n === null || n === undefined || n === '' || isNaN(n);

export const fmt = {
  /** Measurements — metres, RPM, grades. Keeps the decimals the data has. */
  num:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 2 })),
  /** Counts — machines, shifts, orders. Never fractional. */
  int:  (n) => (blank(n) ? '—' : Math.round(n).toLocaleString(LOCALE)),
  one:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 1 })),
  pct:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + '%'),
  /** 1,2rb / 340rb / 2M — axis ticks only, never a figure the reader must trust. */
  short: (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + 'M';
    if (a >= 1e3) return (n / 1e3).toLocaleString(LOCALE, { maximumFractionDigits: a >= 1e5 ? 0 : 1 }) + 'rb';
    return fmt.int(n);
  },
  day: (iso) => {
    const [, m, d] = iso.split('-');
    return `${Number(d)} ${['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'][Number(m) - 1]}`;
  }
};

export function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "Nice" round tick steps, so the axis reads 0 / 200k / 400k rather than 0 / 183k. */
export function ticks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= rough) * mag;
  const out = [];
  // Run past max, not up to it: the top tick must sit at or above the tallest mark.
  for (let v = 0; ; v += step) {
    out.push(Number(v.toFixed(10)));
    if (v >= max) break;
  }
  return out;
}

/** Round ticks for a domain that does not start at zero (rates, percentages). */
export function ticksBetween(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= span / count) * mag;
  const first = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = first; v <= hi + step / 1e6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Indices to label, walking back from the last point so it is always shown. */
export function labelIndices(n, every) {
  const keep = new Set();
  for (let i = n - 1; i >= 0; i -= every) keep.add(i);
  return keep;
}

/**
 * Real text widths, so label and value columns fit what is actually drawn
 * rather than a guess at average character width. Cached per font.
 */
export const measurers = new Map();
export function measurer(font) {
  if (!measurers.has(font)) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    measurers.set(font, (t) => ctx.measureText(String(t)).width);
  }
  return measurers.get(font);
}

export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Shortens `text` with an ellipsis until it fits `maxWidth`. */
export function ellipsize(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '…') <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

export function mount(host, render) {
  const draw = () => {
    const w = host.clientWidth;
    if (w > 0) { host.replaceChildren(); render(host, w); }
  };
  if (host._ro) host._ro.disconnect();
  host._ro = new ResizeObserver(draw);
  host._ro.observe(host);
  draw();
}

export function empty(host, msg = 'Tidak ada data untuk pilihan ini.') {
  // Drop the previous render's observer first. Without this it survives the
  // emptying and redraws the OLD data on the next layout change, so a card
  // with nothing to show silently comes back with stale numbers.
  if (host._ro) { host._ro.disconnect(); host._ro = null; }
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = msg;
  host.replaceChildren(p);
}

/* ---- tooltip plumbing ---- */

export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const x = Math.min(evt.clientX + 14, window.innerWidth - r.width - 8);
  const y = Math.max(8, evt.clientY - r.height - 12);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
/** Hides the tooltip and any crosshair a finger left up. */
export const hideTip = () => { tip().hidden = true; clearActive?.(); };

/**
 * For a finger: the box goes above the plot, or below it where the page leaves
 * no room above — over the legend rather than the lines — on the side away
 * from the finger, so neither the thumb nor the box hides the day being read.
 */
export function showTipBeside(svgBox, plotTop, plotBottom, cx, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const leftSide = cx > svgBox.width / 2;
  let x = leftSide ? svgBox.left + 4 : svgBox.right - r.width - 4;
  x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  let y = svgBox.top + plotTop - r.height - 6;
  if (y < 8) y = svgBox.top + plotBottom + 6;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, svgBox.top + plotTop + 4);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

// A tap anywhere outside a chart puts away what a finger left showing.
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.target.closest?.('.chart svg')) return;
  hideTip();
}, true);

/** A value pill on an axis: dark rounded box, white text. */
export function pill(svg) {
  const g = el('g', { class: 'xh-pill', opacity: 0 });
  const box = el('rect', { rx: 3 });
  const text = el('text', {});
  g.append(box, text);
  svg.append(g);
  return {
    set(label, x, y, anchor) {
      text.textContent = label;
      text.setAttribute('text-anchor', anchor);
      text.setAttribute('x', x);
      text.setAttribute('y', y + 4);
      const b = text.getBBox();
      box.setAttribute('x', b.x - 5); box.setAttribute('y', b.y - 3);
      box.setAttribute('width', b.width + 10); box.setAttribute('height', b.height + 6);
      g.setAttribute('opacity', 1);
    },
    hide() { g.setAttribute('opacity', 0); }
  };
}

/**
 * Crosshair in the manner of a trading chart: a dashed line down through the
 * nearest day, a dashed line across at the pointer's height, and each one's
 * value in a pill on its axis.
 *
 * Mouse: follows the pointer. Finger: touching the plot shows it at once and
 * dragging sideways walks it from day to day. The plot only claims sideways
 * movement (touch-action: pan-y), so a swipe up or down still scrolls the
 * dashboard — the browser takes that gesture over and the crosshair goes.
 * Lifting the finger leaves it up to be read; a tap elsewhere clears it.
 */
export let clearActive = null;
export function crosshair(svg, { m, iw, ih, n, xAt, valueAtY, yText, xText, onDay = () => {}, tipHtml }) {
  const vline = el('line', { class: 'xh-line', y1: m.t, y2: m.t + ih, opacity: 0 });
  const hline = el('line', { class: 'xh-line', x1: m.l, x2: m.l + iw, opacity: 0 });
  svg.append(vline, hline);
  const yPill = pill(svg);
  const xPill = pill(svg);
  const surface = el('rect', { class: 'xh-surface', x: m.l - 6, y: m.t, width: iw + 12, height: ih, fill: 'transparent' });

  let dragging = false;
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const py = Math.max(m.t, Math.min(m.t + ih, e.clientY - box.top));
    const i = n === 1 ? 0
      : Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left - m.l) / iw) * (n - 1))));
    const cx = xAt(i);
    vline.setAttribute('x1', cx); vline.setAttribute('x2', cx); vline.setAttribute('opacity', 1);
    hline.setAttribute('y1', py); hline.setAttribute('y2', py); hline.setAttribute('opacity', 1);
    // Inside the plot's left edge: a value wider than the axis labels would
    // otherwise run off the chart.
    yPill.set(yText(valueAtY(py)), m.l + 6, py, 'start');
    xPill.set(xText(i), cx, m.t + ih + 14, 'middle');
    onDay(i);
    if (e.pointerType === 'mouse') showTip(e, tipHtml(i));
    else showTipBeside(box, m.t, m.t + ih + 22, cx, tipHtml(i));
  };
  const hide = () => {
    vline.setAttribute('opacity', 0); hline.setAttribute('opacity', 0);
    yPill.hide(); xPill.hide(); onDay(-1);
    tip().hidden = true;
    if (clearActive === hide) clearActive = null;
  };

  surface.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (clearActive && clearActive !== hide) clearActive();
    clearActive = hide;
    dragging = true;
    show(e);
  });
  surface.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || dragging) show(e);
  });
  surface.addEventListener('pointerup', () => { dragging = false; });
  // The browser took the gesture for a scroll.
  surface.addEventListener('pointercancel', () => { dragging = false; hide(); });
  surface.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  svg.append(surface);
}

/** Bars and columns: hover with a mouse, tap with a finger. */
export function tipOn(hit, html) {
  hit.addEventListener('pointermove', (e) => showTip(e, html()));
  hit.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') showTip(e, html()); });
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
}

export const rows = (pairs) => pairs
  .map(([k, v, colour]) =>
    `<div class="row"><span>${colour ? `<i class="swatch" style="color:${esc(colour)}"></i>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`)
  .join('');
