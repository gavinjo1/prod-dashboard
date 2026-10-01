/**
 * Day, week, month and year buckets, shared by Kualitas and the output chart.
 */
import { $ } from './dom.js';
import { fmt } from '../charts/core.js';
import { fridayOf, MONTHS } from './dates.js';

export const Q_PERIOD = {
  day: { title: 'Grade per hari', table: 'Detail per hari', head: 'Tanggal',
    key: (iso) => iso, label: (k) => fmt.day(k), long: (k) => fmt.day(k) },
  // Labelled by the days that have grades, so a week cut by the start of the
  // data reads "1 – 3 Sep" rather than a Friday in August.
  week: { title: 'Grade per minggu', table: 'Detail per minggu', head: 'Minggu (Jumat–Kamis)',
    key: fridayOf, label: (k, b) => fmt.day(b.first),
    long: (k, b) => (b.first === b.last ? fmt.day(b.first) : `${fmt.day(b.first)} – ${fmt.day(b.last)}`) },
  month: { title: 'Grade per bulan', table: 'Detail per bulan', head: 'Bulan',
    key: (iso) => iso.slice(0, 7),
    label: (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`,
    long: (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` },
  year: { title: 'Grade per tahun', table: 'Detail per tahun', head: 'Tahun',
    key: (iso) => iso.slice(0, 4), label: (k) => k, long: (k) => k }
};
