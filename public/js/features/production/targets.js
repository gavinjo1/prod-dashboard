/**
 * Produksi: the efficiency target. Each family keeps its own; an admin sets it.
 */
import { $ } from '../../core/dom.js';
import { session, state, toLogin } from '../../core/state.js';
import { loadCharts } from './charts.js';

/** The efficiency targets per family, from the mill's settings. */
export const targets = { effs: null };

/** The family whose target applies; Semua has no daily report of its own. */
export const targetFamily = () => (state.family === 'semua' ? 'ajl' : state.family);
/** The efficiency a shift is judged by: its family's target. */
export const defaultTarget = () => Number(targets.effs?.[targetFamily()] ?? 80);

$('#targetEff').addEventListener('change', async (e) => {
  if (session.role !== 'admin') return;
  try {
    const res = await fetch('/api/settings/target-eff', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: targetFamily(), value: Number(e.target.value) })
    });
    if (res.status === 401) return toLogin();
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal menyimpan.');
    targets.effs = d;
    loadCharts();
  } catch (err) {
    $('#chartTrendNote').textContent = err.message;
  }
});
