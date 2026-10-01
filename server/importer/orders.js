/**
 * Order headers from the daily sheets, and the SALDO opening balances.
 */
import { ORDER_FIELDS, SHUTTLE_ORDER_FIELDS, mapColumns, normHeader } from './headers.js';
import { toDate, toNum, toText } from './values.js';
import { sheetRows } from './workbook.js';

/* ------------------------------------------------------------------ *
 * Order header
 *
 * Each daily sheet carries, above its machine grid, one row per order:
 * MO, fabric, customer, ORDER (quantity), COMM (woven so far) and SISA
 * (remaining). It is a running total, so the newest sheet wins.
 * ------------------------------------------------------------------ */

/**
 * The sheet's own date, printed just above the order header.
 *
 * It has to be looked up in the same compacted row list the header was found
 * in: sheetRows drops blank rows, so a raw worksheet coordinate points at the
 * wrong line and the date silently comes back empty — which threw the whole
 * block away without any error.
 */
export function sheetDateFrom(rows, headerIdx) {
  for (let r = Math.max(0, headerIdx - 6); r < headerIdx; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(row.length, 8); c++) {
      const d = toDate(row[c]);
      if (d) return d;
    }
  }
  return null;
}

export function readOrderInfo(ws) {
  const rows = sheetRows(ws);
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const map = mapColumns(rows[r], ORDER_FIELDS);
    if (!['mo', 'total_order', 'akumulasi', 'customer'].every((f) => f in map)) continue;

    const as_of = sheetDateFrom(rows, r);
    const out = [];
    for (let i = r + 1; i < rows.length; i++) {
      const mo = toText(rows[i][map.mo]);
      if (!mo) continue;
      if (!/^MO\//i.test(mo)) continue;      // subtotal or blank line
      out.push({
        mo,
        kode_kain:   toText(rows[i][map.kode_kain]),
        customer:    toText(rows[i][map.customer]),
        pick:        toNum(rows[i][map.pick]),
        total_order: toNum(rows[i][map.total_order]),
        akumulasi:   toNum(rows[i][map.akumulasi]),
        sisa_order:  toNum(rows[i][map.sisa_order]),
        as_of
      });
    }
    if (out.length >= 5) return out;
  }
  return [];
}

/** One row per order per day: the whole progression, not just the last state. */
export async function upsertOrderInfo(client, entries, sourceFile) {
  if (!entries.length) return 0;
  const cols = ['mo', 'kode_kain', 'customer', 'pick', 'total_order', 'akumulasi', 'sisa_order', 'as_of'];
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(...cols.map((c) => e[c]), sourceFile);
    return `(${cols.map((_, c) => `$${i * 9 + c + 1}`).join(',')},$${i * 9 + 9})`;
  });
  const res = await client.query(`
    INSERT INTO order_info (${cols.join(',')}, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (mo, as_of) DO UPDATE SET
      kode_kain   = EXCLUDED.kode_kain,
      customer    = EXCLUDED.customer,
      pick        = EXCLUDED.pick,
      total_order = EXCLUDED.total_order,
      akumulasi   = EXCLUDED.akumulasi,
      sisa_order  = EXCLUDED.sisa_order,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}

/** Last value wins when an order appears twice; the sheet lists each once. */
export async function upsertSaldo(client, entries, sourceFile) {
  const seen = new Map();
  for (const e of entries) seen.set(e.mo, e);
  const list = [...seen.values()];
  if (!list.length) return 0;

  const values = [];
  const tuples = list.map((e, i) => {
    values.push(e.mo, e.kode_kain, e.produksi, sourceFile);
    return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`;
  });
  const res = await client.query(`
    INSERT INTO saldo (mo, kode_kain, produksi, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (mo) DO UPDATE SET
      kode_kain   = EXCLUDED.kode_kain,
      produksi    = EXCLUDED.produksi,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}

/**
 * The shuttle workbook's DATA ORDER sheet: one line per order, with PKN as the
 * pick. It carries no date, so each order is recorded as of `asOf` — the last
 * day of production in the same upload. Found by its PKN column, which the
 * AJL and Rapier sheets do not have.
 */
export function readShuttleOrders(rows, asOf) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    if (!(rows[r] ?? []).map(normHeader).includes('PKN')) continue;
    const map = mapColumns(rows[r], SHUTTLE_ORDER_FIELDS);
    if (!['mo', 'kode_kain', 'pick'].every((f) => f in map)) continue;
    const out = new Map();
    for (const raw of rows.slice(r + 1)) {
      const mo = toText(raw?.[map.mo]);
      if (!mo || !/^MO\//i.test(mo)) continue;
      out.set(mo, {
        mo,
        kode_kain: toText(raw[map.kode_kain]),
        customer: map.customer === undefined ? null : toText(raw[map.customer]),
        pick: toNum(raw[map.pick]),
        total_order: map.total_order === undefined ? null : toNum(raw[map.total_order]),
        akumulasi: null,
        sisa_order: null,
        as_of: asOf
      });
    }
    return [...out.values()];
  }
  return [];
}
