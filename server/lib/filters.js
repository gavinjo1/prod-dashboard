/**
 * Query string -> SQL: the filter whitelist, shift windows and family scope.
 */
import { FAMILIES } from '../importer/index.js';

/* ------------------------------------------------------------------ *
 * Filters -> SQL
 * ------------------------------------------------------------------ */

export const LIST_FILTERS = {
  shift: 'shift',
  machine: 'no_mc',
  group: 'kelompok_mesin',
  type: 'type_mc',
  fabric: 'kode_kain',
  mo: 'mo'
};

/**
 * Turns the query string into SQL clauses. Column names come from the
 * whitelist above, never from the request; values are always bound.
 *
 * `startAt` offsets the placeholder numbers so a second clause set can be
 * appended to the same statement; `dates: false` emits only the dimension
 * filters, which is what the previous-period comparison needs.
 */
/* ------------------------------------------------------------------ *
 * Shift windows
 *
 * The mill runs three: 06:00–14:00, 14:00–22:00, 22:00–06:00. The crew letter
 * on a row is not the window — A/B/C rotate every Friday — so filtering by
 * clock time has to go through the hours actually recorded on the row.
 * ------------------------------------------------------------------ */

export const SHIFT_WINDOWS = [
  { value: 'pagi',  label: '06:00–14:00', start: '06:00', end: '14:00' },
  { value: 'siang', label: '14:00–22:00', start: '14:00', end: '22:00' },
  { value: 'malam', label: '22:00–06:00', start: '22:00', end: '06:00' }
];

/**
 * Which window a row belongs to, by whichever of 06:00 / 14:00 / 22:00 its
 * start time is nearest. The boundaries are the midpoints between them, so a
 * week that starts the morning shift at 05:30 or 06:30 still reads as pagi —
 * which matters, because these hours are re-set most weeks.
 *
 * A row with no hours belongs to no window and is simply never matched.
 */
export const shiftWindowSql = (prefix) => `CASE
    WHEN ${prefix}jam_mulai >= TIME '02:00' AND ${prefix}jam_mulai < TIME '10:00' THEN 'pagi'
    WHEN ${prefix}jam_mulai >= TIME '10:00' AND ${prefix}jam_mulai < TIME '18:00' THEN 'siang'
    WHEN ${prefix}jam_mulai IS NOT NULL THEN 'malam'
  END`;

/** Falls back to AJL, which is what every row imported before this existed is. */
export const familyOf = (q) => {
  const f = String(q?.family ?? '').trim().toLowerCase();
  return FAMILIES.includes(f) ? f : 'ajl';
};

/**
 * Grades are reported per MO, so only the date / MO / fabric filters apply —
 * a machine filter would claim BS the grade sheet never tied to a machine.
 */
export function gradeWhere(query, { prefix = '' } = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, v) => { params.push(v); clauses.push(sql.replace('?', `$${params.length}`)); };
  add(`${prefix}family = ?`, familyOf(query));
  if (query.from) add(`${prefix}tgl >= ?`, query.from);
  if (query.to) add(`${prefix}tgl <= ?`, query.to);
  if (query.mo) add(`${prefix}mo = ANY(?)`, String(query.mo).split(','));
  if (query.fabric) add(`${prefix}kode_kain = ANY(?)`, String(query.fabric).split(','));
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

export function buildFilters(q, { prefix = '', startAt = 0, dates = true } = {}) {
  const clauses = [];
  const params = [];
  const bind = (v) => { params.push(v); return `$${startAt + params.length}`; };

  // A scope rather than a filter: every production row belongs to exactly one
  // family, and leaving it out would mix Rapier's A1 with AJL's A1 — they are
  // different machines that happen to share a number.
  clauses.push(`${prefix}family = ${bind(familyOf(q))}`);

  if (dates && q.from) clauses.push(`${prefix}tgl >= ${bind(q.from)}`);
  if (dates && q.to)   clauses.push(`${prefix}tgl <= ${bind(q.to)}`);

  for (const [key, col] of Object.entries(LIST_FILTERS)) {
    const vals = String(q[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (vals.length) clauses.push(`${prefix}${col} = ANY(${bind(vals)})`);
  }

  // Not in LIST_FILTERS: this one is a computed window, not a stored column.
  const jam = String(q.jam ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (jam.length) clauses.push(`${shiftWindowSql(prefix)} = ANY(${bind(jam)})`);

  return { clauses, params };
}

/** Builds a WHERE clause from the query string. Multi-values arrive comma-separated. */
export function whereFrom(q) {
  const { clauses, params } = buildFilters(q);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * How a loom type is shown: the layout band and the mill's name for it, as the
 * workbook header reads them — "AJL TOYOTA 1 | E SHADE". Falls back to the
 * TYPE MC code when a type has no entry in the legend.
 */
export const TYPE_LABEL = `COALESCE(NULLIF(concat_ws(' | ', t.band, t.description), ''), p.type_mc)`;


/** A calendar date as the API takes it. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
