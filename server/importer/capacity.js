/**
 * The monthly efficiency sheet: production at 100% per day.
 */
import { normHeader } from './headers.js';
import { toDate, toNum } from './values.js';
import { sheetRows } from './workbook.js';

/* ------------------------------------------------------------------ *
 * Daily capacity — the monthly efficiency sheet
 *
 *   row 3   ... | TOTAL AJL 1,2,3,4 |          (merged over the group)
 *   row 4   E SHADE | E SHADE190 | ...         (per-type bands)
 *   row 5   TGL | PROD | % | PICK RATA2 | prod100% | PROD | % | ...
 *   row 7+  one row per day of the month
 *
 * Only the TOTAL group is read. The sheet also carries the same four columns
 * per machine type, but those bands sum to a different number than TOTAL
 * (the total uses its own average pick), so taking both would put two
 * conflicting capacities in the same chart.
 * ------------------------------------------------------------------ */

export function readDailyCapacity(ws) {
  const rows = sheetRows(ws);

  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const head = rows[r].map(normHeader);
    if (head[0] !== 'TGL') continue;

    // Each group is PROD | % | PICK RATA2 | prod100%, so prod100% closes it.
    const ends = head.map((h, c) => (h === 'PROD100' ? c : -1)).filter((c) => c >= 3);
    if (ends.length < 2) continue;

    // The group labelled TOTAL, from the band row above (row 4) or the one
    // above that (row 3) — whichever carries the word.
    const total = ends.find((c) => [r - 1, r - 2]
      .some((br) => br >= 0 && /TOTAL/i.test(String(rows[br]?.[c - 3] ?? ''))));
    if (total === undefined) continue;

    const [cProd, cEff, cPick, cCap] = [total - 3, total - 2, total - 1, total];
    const out = [];
    for (let i = r + 1; i < rows.length; i++) {
      const tgl = toDate(rows[i][0]);
      const prod100 = toNum(rows[i][cCap]);
      // Days the sheet has not been filled in yet are left out rather than
      // carried forward or guessed.
      if (!tgl || !prod100) continue;
      out.push({
        tgl,
        prod: toNum(rows[i][cProd]),
        prod100,
        pick_rata2: toNum(rows[i][cPick]),
        eff_pct: toNum(rows[i][cEff])
      });
    }
    if (out.length) return out;
  }
  return [];
}

export async function upsertCapacity(client, entries, sourceFile, family = 'ajl') {
  if (!entries.length) return 0;
  const cols = ['family', 'tgl', 'prod', 'prod100', 'pick_rata2', 'eff_pct'];
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(...cols.map((c) => (c === 'family' ? family : e[c])), sourceFile);
    return `(${cols.map((_, c) => `$${i * 7 + c + 1}`).join(',')},$${i * 7 + 7})`;
  });
  const res = await client.query(`
    INSERT INTO daily_capacity (${cols.join(',')}, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (family, tgl) DO UPDATE SET
      prod = EXCLUDED.prod, prod100 = EXCLUDED.prod100,
      pick_rata2 = EXCLUDED.pick_rata2, eff_pct = EXCLUDED.eff_pct,
      source_file = EXCLUDED.source_file, imported_at = now()`, values);
  return res.rowCount;
}
