/**
 * Entry point. Every feature wires itself up when imported; sign-in comes
 * last because it removes the controls a viewer may not use, after the
 * features have attached to them. Then the saved family and its filters load.
 */
import './js/core/dom.js';
import './js/core/state.js';
import './js/ui/picker.js';
import './js/ui/tiles.js';
import './js/features/production/summary.js';
import './js/features/production/orders.js';
import './js/features/production/effcards.js';
import './js/features/production/targets.js';
import './js/features/production/charts.js';
import './js/features/production/machines.js';
import './js/features/production/edit.js';
import './js/features/quality.js';
import './js/features/entry.js';
import './js/features/users.js';
import './js/features/import.js';
import './js/features/gabungan.js';
import './js/features/family.js';
import './js/features/pabrik.js';
import './js/features/efisiensi.js';
import './js/features/search.js';
import './js/features/filters.js';
import './js/features/shell.js';
import './js/session.js';
import { state } from './js/core/state.js';
import { loadFilters } from './js/features/filters.js';
import { applyFamily } from './js/features/family.js';

// The family first, then the filters: the lists, the date range and the
// header count all belong to one family.
let savedFamily = 'ajl';
try { savedFamily = localStorage.getItem('mr.family') || 'ajl'; } catch { /* private window */ }
state.family = savedFamily;
await loadFilters();
applyFamily(savedFamily);
