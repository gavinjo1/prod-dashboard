/**
 * Filter state, the API client and the guard against stale responses.
 */
import { $ } from './dom.js';

/* ------------------------------------------------------------------ *
 * Filter state
 * ------------------------------------------------------------------ */

export const state = {
  from: '', to: '',
  shift: [], jam: [], group: [], type: [], machine: [], fabric: [], mo: [],
  qPeriod: 'day',
  trendPeriod: 'day',
  sort: 'produksi', dir: 'desc',
  groupRange: 'month', shiftRange: 'month',
  dim: 'group',
  search: '',
  tab: 'production',
  family: 'ajl',
  gabMonth: '',
  gabSource: ''
};

export function params() {
  const p = new URLSearchParams();
  // On every request: the server scopes production and grade by it, and AJL's
  // A1 is a different machine from Rapier's A1.
  p.set('family', state.family === 'semua' ? 'ajl' : state.family);
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  for (const k of ['shift', 'jam', 'group', 'type', 'machine', 'fabric', 'mo']) {
    if (state[k].length) p.set(k, state[k].join(','));
  }
  return p;
}

/**
 * Every loader is async, so a second call can overtake the first and paint
 * stale data over fresh — clicking the Group/Type toggle while a load is
 * still in flight did exactly that. Each loader takes a ticket and only paints
 * if it is still the most recent caller.
 */
export const tickets = {};
export const takeTicket = (name) => (tickets[name] = (tickets[name] || 0) + 1);
export const isCurrent = (name, ticket) => tickets[name] === ticket;

export const api = async (path, extra = {}) => {
  // Query values belong in `extra`; a '?' in the path would produce a second
  // one and the server would read the first parameter with the rest glued on.
  if (path.includes('?')) throw new Error(`api(): pass query values as the second argument, not in "${path}"`);
  const p = params();
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const res = await fetch(`/api/${path}?${p}`);
  if (res.status === 401) return toLogin();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

/**
 * A session lasts a working day, so it can lapse with the tab still open.
 * Returns a promise that never settles: callers are mid-render, and letting
 * them carry on would paint an empty dashboard over the redirect.
 */
export const toLogin = () => {
  location.replace('login.html');
  return new Promise(() => {});
};


/**
 * Who is signed in, as far as the screens need to know. Filled in once by
 * session.js; read anywhere, never set anywhere else.
 */
export const session = { role: 'viewer', canWrite: false };
