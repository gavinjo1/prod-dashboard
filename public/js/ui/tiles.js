/**
 * Headline tiles and status dots.
 */
import { $ } from '../core/dom.js';

/* ------------------------------------------------------------------ *
 * Stat tiles
 * ------------------------------------------------------------------ */

export const tile = (label, value, unit, foot) => `
  <div class="stat">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    ${foot ? `<div class="stat-foot">${foot}</div>` : ''}
  </div>`;

/**
 * The words are passed in rather than derived, because "below target" reads as
 * good for a defect rate and bad for an output figure — colour must never be
 * the only thing carrying that distinction.
 */
export function statusDot(pct, { good, warn, invert = false, words }) {
  if (pct === null || pct === undefined || isNaN(pct)) return '';
  const ok = invert ? pct <= good : pct >= good;
  const mid = invert ? pct <= warn : pct >= warn;
  const cls = ok ? 'good' : mid ? 'warning' : 'critical';
  const word = ok ? words[0] : mid ? words[1] : words[2];
  return `<span class="dot dot-${cls}" aria-hidden="true"></span>${word}`;
}
