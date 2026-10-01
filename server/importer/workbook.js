/**
 * Opening an upload: file type, magic bytes, sheets and their header row.
 */
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import XLSX from 'xlsx';
import path from 'node:path';
import { AppError } from '../errors.js';
import { GRADE_FIELDS, PRODUCTION_FIELDS, SHUTTLE_FIELDS, mapColumns } from './headers.js';

// SheetJS 0.20 ships the codepage tables separately and warns without them.
// Legacy .xls and non-UTF-8 CSV carry a codepage, and the mill's loom export
// is .xls — without this, any non-ASCII byte in it decodes wrongly.
XLSX.set_cptable(cptable);

/* ------------------------------------------------------------------ *
 * Workbook reading
 * ------------------------------------------------------------------ */

export const EXTS = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv', '.txt', '.json']);
export const isSupported = (name) => EXTS.has(path.extname(name).toLowerCase());

/** Spreadsheet containers start with a recognisable signature. */
export const SIGNATURES = [
  { magic: [0x50, 0x4b, 0x03, 0x04], kind: 'zip' },                          // xlsx/xlsm/ods
  { magic: [0x50, 0x4b, 0x05, 0x06], kind: 'zip' },                          // empty zip
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], kind: 'ole' },  // legacy xls
  { magic: [0x09, 0x08], kind: 'biff' }                                      // very old xls
];

export const startsWith = (buf, magic) => magic.every((b, i) => buf[i] === b);

/**
 * Guards the parser against files that are not what their extension claims.
 * An extension is a label anyone can rename; this looks at the bytes.
 *
 * Text formats have no signature, so they are checked the other way round —
 * by ruling out the executable and archive headers a .csv must never have, and
 * by rejecting content that is mostly non-text.
 */
export function checkFileBytes(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (!buffer || !buffer.length) throw new AppError('File kosong.');

  const binaryExt = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods'];
  if (binaryExt.includes(ext)) {
    if (!SIGNATURES.some((s) => startsWith(buffer, s.magic))) {
      throw new AppError(`${fileName} is not a real spreadsheet — its contents do not match a ${ext} file.`);
    }
    return;
  }

  // .csv / .tsv / .txt / .json must be text.
  const forbidden = [
    { magic: [0x4d, 0x5a], name: 'a Windows program' },
    { magic: [0x7f, 0x45, 0x4c, 0x46], name: 'a Linux program' },
    { magic: [0xcf, 0xfa, 0xed, 0xfe], name: 'a macOS program' },
    { magic: [0x25, 0x50, 0x44, 0x46], name: 'a PDF' },
    { magic: [0x50, 0x4b, 0x03, 0x04], name: 'a zip archive' },
    { magic: [0xd0, 0xcf, 0x11, 0xe0], name: 'an Office binary' }
  ];
  const hit = forbidden.find((f) => startsWith(buffer, f.magic));
  if (hit) throw new AppError(`${fileName} is named like a text file but is ${hit.name}.`);

  // A NUL byte early on means binary, whatever the name says.
  const head = buffer.subarray(0, 8192);
  if (head.includes(0)) {
    throw new AppError(`${fileName} is named like a text file but contains binary data.`);
  }
}

/** Rows as arrays, with the ragged tail padded so column indexes line up. */
export function sheetRows(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: null });
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill(null)]));
}

export function readWorkbook(buffer, fileName) {
  checkFileBytes(buffer, fileName);
  if (path.extname(fileName).toLowerCase() === '.json') {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const arr = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.data ?? []);
    if (!Array.isArray(arr) || !arr.length) throw new AppError('JSON file holds no array of rows');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(arr), 'data');
    return wb;
  }
  // Keep date cells as Excel serials: converting them here would apply the
  // host machine's timezone and can shift a report a day backwards.
  return XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true, codepage: 65001 });
}

/**
 * Find the header row and figure out which dataset a sheet holds.
 * Report sheets often carry a title or two above the real header, so scan down.
 */
export function inspectSheet(ws) {
  const rows = sheetRows(ws);
  let best = null;

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    for (const [dataset, fields, required] of [
      ['production', PRODUCTION_FIELDS, ['tgl', 'no_mc', 'produksi']],
      ['shuttle', SHUTTLE_FIELDS, ['tgl', 'no_mc', 'sodokan', 'produksi']],
      ['grade', GRADE_FIELDS, ['tgl', 'mo', 'grade_a']]
    ]) {
      const map = mapColumns(rows[i], fields);
      if (!required.every((f) => f in map)) continue;
      const score = Object.keys(map).length;
      if (!best || score > best.score) best = { dataset, headerRow: i, map, score, rows };
    }
  }
  return best; // null when the sheet is not a recognised report
}
