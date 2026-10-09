/**
 * PPIC's MASTER PRODUCT workbook: one line per MO with its fabric, pick and
 * construction, read into product_master.
 */
import XLSX from 'xlsx';
import { readWorkbook } from './workbook.js';
import { toDate, toNum, toText } from './values.js';

/* ------------------------------------------------------------------ *
 * The sheet
 *
 *   MO | SO | KODE | … | LS | x | PKN/PICK | x | LBR | " | LBR MTR | KONTRUKSI
 *   | Lusi | NE | x | Pakan | NE | BENANG | QTY | TOLERANSI | CUST | ANYAMAN
 *   | … | TGL SHARE ORDER
 *
 * Found by its header — MO, KODE and a PICK column on one row — wherever it
 * sits, so a new column or sheet does not break it. NE appears twice; the
 * first follows Lusi and the second Pakan. The workbook repeats some MOs on a
 * second line with the pick left empty: the line with a pick wins.
 * ------------------------------------------------------------------ */

const norm = (v) => String(v ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

function headerOf(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = (rows[i] ?? []).map(norm);
    const mo = h.indexOf('MO');
    const kode = h.findIndex((v) => v === 'KODE' || v === 'KODE KAIN');
    const pick = h.findIndex((v) => /^(PKN\/PICK|PICK|PKN)$/.test(v));
    if (mo >= 0 && kode >= 0 && pick >= 0) {
      const at = (name, from = 0) => h.findIndex((v, j) => j >= from && v === name);
      const lusi = at('LUSI');
      const pakan = at('PAKAN');
      return {
        row: i,
        col: {
          mo, kode, pick, so: at('SO'), ls: at('LS'), lbr: at('LBR'), lbr_mtr: at('LBR MTR'),
          konstruksi: h.findIndex((v) => v === 'KONTRUKSI' || v === 'KONSTRUKSI'),
          lusi, ne_lusi: lusi >= 0 ? at('NE', lusi) : -1,
          pakan, ne_pakan: pakan >= 0 ? at('NE', pakan) : -1,
          benang: at('BENANG'), qty: at('QTY'), toleransi: at('TOLERANSI'),
          cust: h.findIndex((v) => v === 'CUST' || v === 'CUSTOMER'),
          anyaman: at('ANYAMAN'), tgl: h.findIndex((v) => /^TGL SHARE ORDER/.test(v))
        }
      };
    }
  }
  return null;
}

/**
 * Every MO the workbook lists, cleaned: { lines, skipped: [{ row, reason }], sheet }.
 * Nothing is written here.
 */
export function readMasterProduct(buffer, fileName) {
  const wb = readWorkbook(buffer, fileName);
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null, blankrows: false });
    const head = headerOf(rows);
    if (!head) continue;
    const c = head.col;
    const get = (r, k) => (c[k] >= 0 ? r[c[k]] : null);
    const byMo = new Map();
    const skipped = [];
    for (let i = head.row + 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const mo = toText(get(r, 'mo'));
      if (!mo && r.every((v) => v === null || v === '')) continue;
      if (!mo || !/^MO\//i.test(mo)) { skipped.push({ row: i + 1, reason: `bukan nomor MO (${mo ?? 'kosong'})` }); continue; }
      const line = {
        mo: mo.toUpperCase().replace(/\s+/g, ''),
        so: toText(get(r, 'so')),
        kode_kain: toText(get(r, 'kode')),
        pick: toNum(get(r, 'pick')),
        lusi_per_inch: toNum(get(r, 'ls')),
        lebar_inch: toNum(get(r, 'lbr')),
        lebar_cm: toNum(get(r, 'lbr_mtr')),
        konstruksi: toText(get(r, 'konstruksi')),
        lusi: toText(get(r, 'lusi')),
        ne_lusi: toText(get(r, 'ne_lusi')),
        pakan: toText(get(r, 'pakan')),
        ne_pakan: toText(get(r, 'ne_pakan')),
        benang: toText(get(r, 'benang')),
        qty: toNum(get(r, 'qty')),
        toleransi: toNum(get(r, 'toleransi')),
        customer: toText(get(r, 'cust')),
        anyaman: toText(get(r, 'anyaman')),
        tgl_share: toDate(get(r, 'tgl'))
      };
      if (!(line.pick > 0)) line.pick = null;
      if (!line.kode_kain) { skipped.push({ row: i + 1, reason: `${line.mo} tanpa kode kain` }); continue; }
      const had = byMo.get(line.mo);
      // The line with a pick wins over a repeat without one.
      if (!had || (!had.pick && line.pick)) byMo.set(line.mo, line);
      else if (had.pick && line.pick && had.pick !== line.pick) {
        skipped.push({ row: i + 1, reason: `${line.mo} tercatat dua kali dengan pick berbeda (${had.pick} dan ${line.pick}); yang pertama dipakai` });
      }
    }
    return { sheet, lines: [...byMo.values()], skipped };
  }
  return { sheet: null, lines: [], skipped: [] };
}

export const MASTER_FIELDS = ['so', 'kode_kain', 'pick', 'lusi_per_inch', 'lebar_inch', 'lebar_cm', 'konstruksi',
  'lusi', 'ne_lusi', 'pakan', 'ne_pakan', 'benang', 'qty', 'toleransi', 'customer', 'anyaman', 'tgl_share'];
