/**
 * Cell values: Excel dates, numbers written the Indonesian way, text.
 */


/* ------------------------------------------------------------------ *
 * Value coercion
 * ------------------------------------------------------------------ */

export const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Returns 'YYYY-MM-DD' or null. Accepts Date, Excel serial, or text. */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date && !isNaN(v)) {
    // Spreadsheet date cells carry no time of day, but converters land them a
    // few seconds either side of midnight in whatever zone they assumed.
    // Snapping to the nearest whole UTC day recovers the date that was typed.
    return new Date(Math.round(v.getTime() / 86400000) * 86400000).toISOString().slice(0, 10);
  }

  if (typeof v === 'number' && isFinite(v)) {
    // Excel serials below ~20000 are more likely a stray number than a date.
    if (v < 20000 || v > 80000) return null;
    return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }

  const s = String(v).trim();
  if (!s || /^(saldo|total|jumlah|grand\s*total)$/i.test(s)) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-09-01
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);   // 01/09/2026 (d/m/y)
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    if (Number(mo) > 12 && Number(d) <= 12) [d, mo] = [mo, d];  // tolerate m/d/y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  return isNaN(parsed) ? null : parsed.toISOString().slice(0, 10);
}

/** Returns a finite number or null. Handles "1.234,5" and "1,234.5". */
export function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;

  let s = String(v).trim().replace(/\s/g, '');
  if (!s || s === '-') return null;
  if (/^[#]?(N\/A|NA|DIV\/0!|VALUE!|REF!|NULL!|NAME\?)$/i.test(s.replace('#', ''))) return null;

  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[^\d.,-]/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // whichever separator comes last is the decimal point
    s = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,234" with exactly 3 trailing digits reads as a thousands separator
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

export const toText = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '#N/A' ? null : s;
};
