/**
 * The mill's fabric groups ("NE LAY OUT") from the KODE KAIN sheet of its
 * EFFISIENSI workbook.
 */
import XLSX from 'xlsx';
import { normHeader } from './headers.js';
import { toText } from './values.js';
import { checkFileBytes, sheetRows } from './workbook.js';

/* ------------------------------------------------------------------ *
 * The sheet holds several small tables side by side; the one wanted is
 *
 *   … | KODE     | KONTRUKSI | PICK | …
 *       C401 AJL | CD40      | 70
 *
 * found by its two headings standing next to each other.
 * ------------------------------------------------------------------ */

export function readFabricGroups(ws) {
  const rows = sheetRows(ws);
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const head = rows[r].map(normHeader);
    const c = head.findIndex((h, i) => h === 'KODE' && head[i + 1] === 'KONTRUKSI');
    if (c < 0) continue;
    const out = new Map();
    for (const raw of rows.slice(r + 1)) {
      const kode_kain = toText(raw[c]);
      const ne = toText(raw[c + 1]);
      if (kode_kain && ne) out.set(kode_kain, { kode_kain, ne });
    }
    return [...out.values()];
  }
  return [];
}

/**
 * Reads only what it needs: the EFFISIENSI workbook runs to 27 MB, most of it
 * loom data. The sheet named KODE KAIN is tried first, then any other.
 */
export function readFabricGroupFile(buffer, fileName) {
  checkFileBytes(buffer, fileName);
  const names = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  const order = [...names.filter((n) => /kode/i.test(n)), ...names.filter((n) => !/kode/i.test(n))];
  for (const name of order) {
    const wb = XLSX.read(buffer, { type: 'buffer', sheets: [name], raw: true, cellDates: false });
    const groups = readFabricGroups(wb.Sheets[name]);
    if (groups.length) return { sheet: name, groups };
  }
  return { sheet: null, groups: [] };
}

export async function upsertFabricGroups(client, groups, sourceFile) {
  let written = 0;
  for (let at = 0; at < groups.length; at += 1000) {
    const part = groups.slice(at, at + 1000);
    const values = [];
    const tuples = part.map((g, i) => {
      values.push(g.kode_kain, g.ne, sourceFile);
      return `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`;
    });
    const res = await client.query(`
      INSERT INTO fabric_group (kode_kain, ne, source_file) VALUES ${tuples.join(',')}
      ON CONFLICT (kode_kain) DO UPDATE SET
        ne = EXCLUDED.ne, source_file = EXCLUDED.source_file, imported_at = now()
      WHERE NOT fabric_group.fixed`, values);   // the mill's fixed groups stay as they are
    written += res.rowCount;
  }
  return written;
}
