/**
 * The shuttle workbook's SODOKAN table: how many metres of fabric a given
 * advance of the counter makes, per fabric and loom width.
 */
import { normHeader } from './headers.js';
import { toNum, toText } from './values.js';
import { sheetRows } from './workbook.js';

/* ------------------------------------------------------------------ *
 *   KODE | MC | CM | LUSI | KAIN | ID
 *   C401 | 75 | 0.1 |     | 2.2  | C401750,1
 *
 * The daily sheets find a shift's METER with SUMIF over ID = KODE & MC & CM,
 * summing KAIN. So a fabric listed twice counts twice: kept that way here,
 * since the imported METER was worked out like that, and reported.
 * Rows with no number in KAIN add nothing to SUMIF and are left out.
 * ------------------------------------------------------------------ */

export function readSodokanTable(ws) {
  const rows = sheetRows(ws);
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const head = rows[r].map(normHeader);
    const col = (h) => head.indexOf(h);
    const [cKode, cMc, cCm, cKain] = [col('KODE'), col('MC'), col('CM'), col('KAIN')];
    if ([cKode, cMc, cCm, cKain].some((c) => c < 0)) continue;

    const sums = new Map();
    const listed = new Map();
    for (const raw of rows.slice(r + 1)) {
      const kode_kain = toText(raw[cKode]);
      const width = toNum(raw[cMc]);
      const cm = toNum(raw[cCm]);
      const meter = toNum(raw[cKain]);
      if (!kode_kain || width === null || cm === null || meter === null) continue;
      // Rounded as the daily sheets round SODOKAN before building the ID.
      const e = { kode_kain, width, cm: Math.round(cm * 100) / 100 };
      const k = `${e.kode_kain}|${e.width}|${e.cm}`;
      const had = sums.get(k);
      sums.set(k, { ...e, meter: (had?.meter ?? 0) + meter });
      listed.set(k, (listed.get(k) ?? 0) + 1);
    }

    // Which fabrics are listed more than once, and how many lengths of each.
    const doubled = new Map();
    for (const [k, n] of listed) {
      if (n < 2) continue;
      const fabric = k.split('|').slice(0, 2).join(' / MC ');
      doubled.set(fabric, (doubled.get(fabric) ?? 0) + 1);
    }
    return { entries: [...sums.values()], doubled };
  }
  return { entries: [], doubled: new Map() };
}

export async function upsertSodokan(client, entries, sourceFile) {
  let written = 0;
  // In slices, so a long table stays inside Postgres's parameter limit.
  for (let at = 0; at < entries.length; at += 1000) {
    const part = entries.slice(at, at + 1000);
    const values = [];
    const tuples = part.map((e, i) => {
      values.push(e.kode_kain, e.width, e.cm, e.meter, sourceFile);
      return `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`;
    });
    const res = await client.query(`
      INSERT INTO shuttle_sodokan (kode_kain, width, cm, meter, source_file)
      VALUES ${tuples.join(',')}
      ON CONFLICT (kode_kain, width, cm) DO UPDATE SET
        meter = EXCLUDED.meter, source_file = EXCLUDED.source_file, imported_at = now()`, values);
    written += res.rowCount;
  }
  return written;
}
