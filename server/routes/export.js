/**
 * Excel and CSV export of the current view.
 */
import { Router } from 'express';
import XLSX from 'xlsx';
import { query } from '../db.js';
import { send } from '../errors.js';
import { requireRole } from '../auth.js';
import { buildFilters } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Export
 *
 * The .xlsx export rebuilds the workbook's own SOURCE DATA sheet, column for
 * column — including the six ID columns the dashboard does not otherwise
 * store, because every formula elsewhere in that workbook looks rows up by
 * them. Paste the result over SOURCE DATA and the daily sheets, BULANAN and
 * GRADE recalculate on their own.
 *
 * Reproducing those sheets and their ~50,000 formulas here would be the wrong
 * way round: they already exist and already work.
 * ------------------------------------------------------------------ */

const SOURCE_HEADERS = ['TGL', 'ID PERSHIFT', 'ID LAP MO', 'ID RPM REAL', 'ID KELOMPOK MESIN',
  'ID LAY OUT', 'ID BB', 'SHIFT', 'NO MC', 'MO', 'KODE KAIN', 'TYPE MC', 'KELOMPOK MESIN',
  'JML KAIN', 'RPM', 'EFF', 'PRODUKSI', 'HIT RPM', 'RPM TARGET', 'KETIK RPM', 'KETIK PROD', 'KET BB',
  // Appended after column V, never inserted among it: the workbook's formulas
  // address SOURCE DATA by column, so A:V has to stay exactly as it was.
  // Rows written before these fields existed leave all three empty.
  'JAM MULAI', 'JAM SELESAI', 'DIINPUT OLEH'];

/** Excel's own day number, which the ID columns are built from. */
const excelSerial = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
};

function sourceRow(r) {
  const ser = excelSerial(r.tgl);
  const shift = r.shift ?? '';
  const type = r.type_mc ?? '';
  return [
    null,                                               // TGL, written below
    `${shift}${ser}`,                                   // ID PERSHIFT
    `${ser}${r.mo ?? ''}${type}`,                       // ID LAP MO
    `${type}${ser}`,                                    // ID RPM REAL
    `${r.kelompok_mesin ?? ''}${shift}${ser}`,          // ID KELOMPOK MESIN
    `${r.no_mc ?? ''}${shift}${ser}`,                   // ID LAY OUT
    `${r.ket_bb ?? ''}${type}${ser}`,                   // ID BB
    shift, r.no_mc,
    // The source writes a numeric 0 for a machine with no order, and the
    // importer keeps it as text; put the number back.
    r.mo === '0' ? 0 : r.mo,
    r.kode_kain, type, r.kelompok_mesin,
    r.jml_kain, r.rpm, null,                            // EFF is empty in the source too
    r.produksi, r.hit_rpm, r.rpm_target, r.ketik_rpm, r.ketik_prod, r.ket_bb,
    r.jam_mulai, r.jam_selesai, r.edited_by
  ];
}

async function exportRows(q) {
  const { clauses, params } = buildFilters(q, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT p.tgl::text AS tgl, p.shift, p.no_mc, p.mo, p.kode_kain, p.type_mc,
           p.kelompok_mesin, p.jml_kain, p.rpm, p.rpm_target, p.hit_rpm,
           p.produksi, p.ketik_rpm, p.ketik_prod, p.ket_bb, o.pick,
           p.edited_by,
           to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
           to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai,
           t.band AS kelompok_layout, t.description AS nama_mesin
    FROM production p
    LEFT JOIN machine_type t ON t.type_mc = p.type_mc
    LEFT JOIN order_info o ON o.mo = p.mo AND o.as_of = p.tgl
    ${where} ORDER BY p.tgl, p.no_mc, p.shift`, params);
  return rows;
}

router.get('/api/export.xlsx', requireRole('operator'), (req, res) => send(res, async () => {
  const rows = await exportRows(req.query);
  const sheet = XLSX.utils.aoa_to_sheet([SOURCE_HEADERS, ...rows.map(sourceRow)]);

  // The date column is written as Excel's own serial with a date format, not
  // as a JS Date: converting a Date lands it a few seconds off midnight, which
  // is invisible on screen but makes an equality test against a date fail.
  const NA = 0x2a;   // SheetJS error code for #N/A

  rows.forEach((r, i) => {
    sheet[XLSX.utils.encode_cell({ r: i + 1, c: 0 })] =
      { t: 'n', v: excelSerial(r.tgl), z: '[$-409]d\\-mmm\\-yy;@' };

    // Every row without a fabric code carries a literal #N/A in the sheet —
    // 72 of them, matching exactly the rows the importer reads as empty.
    // Writing a blank instead would change how the workbook's lookups behave.
    if (r.kode_kain == null) {
      sheet[XLSX.utils.encode_cell({ r: i + 1, c: 10 })] = { t: 'e', v: NA };
    }
  });

  // Excel's AutoFilter on the header row: a dropdown on every column to tick
  // values, sort, search, and use Date or Number Filters. The dates and the
  // figures are real dates and numbers above, which is what those need.
  // Covers exactly the rows written, so nothing below the data is caught up.
  sheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rows.length, c: SOURCE_HEADERS.length - 1 }
    })
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'SOURCE DATA');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const span = rows.length ? `${rows[0].tgl}_${rows[rows.length - 1].tgl}` : 'kosong';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SOURCE DATA ${span}.xlsx"`);
  res.send(buf);
}));

/* ------------------------------------------------------------------ *
 * CSV export of the current view
 * ------------------------------------------------------------------ */

router.get('/api/export.csv', requireRole('operator'), (req, res) => send(res, async () => {
  // Aliased and fully qualified: order_info also has mo and kode_kain, so a
  // bare column name here is ambiguous once it is joined in.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT p.tgl::text AS tgl, p.shift, p.no_mc, p.kelompok_mesin, p.type_mc,
           t.band AS kelompok_layout, t.description AS nama_mesin,
           p.mo, p.kode_kain, o.pick, p.rpm, p.rpm_target, p.produksi, p.ket_bb,
           to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
           to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai,
           p.edited_by
    FROM production p
    LEFT JOIN machine_type t ON t.type_mc = p.type_mc
    LEFT JOIN order_info o ON o.mo = p.mo AND o.as_of = p.tgl
    ${where} ORDER BY p.tgl, p.no_mc, p.shift`, params);

  // A value starting with = + - or @ is run as a formula when the CSV is opened
  // in Excel. The data comes from a spreadsheet, so it can carry one; prefixing
  // an apostrophe makes Excel treat it as text.
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['tgl', 'shift', 'no_mc', 'kelompok_mesin', 'type_mc', 'kelompok_layout',
    'nama_mesin', 'mo', 'kode_kain', 'pick', 'rpm', 'rpm_target', 'produksi', 'ket_bb',
    'jam_mulai', 'jam_selesai', 'edited_by'];
  const csv = [head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="machine-production.csv"');
  res.send('﻿' + csv);
}));
