/**
 * Table cells shared by several tabs.
 */
import { $ } from '../core/dom.js';
import { fmt } from '../charts/core.js';

/** 79,0% with ✓ or ▼ against the target it is judged by. */
export const achievedCell = (v, target) => {
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  const ok = v >= target;
  return `<span class="${ok ? 'is-good' : 'is-bad'}">${ok ? '✓' : '▼'} ${
    Number(v).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>`;
};
export const stopCell = (cnt, min) =>
  `<td class="num">${fmt.int(cnt)}<span class="muted"> · ${fmt.int(min)} mnt</span></td>`;
