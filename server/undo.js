/**
 * Photographs rows before an import overwrites them, so the import can be
 * reversed.
 *
 * An import upserts. Undoing it by deleting what it wrote would throw away
 * whatever it replaced — a corrected 3 Sep would vanish along with the bad
 * file that overwrote it. So each batch records the previous value of every
 * row it touches, and undo puts those values back.
 */

/** The upsert key for each table an import writes. */
export const KEYS = {
  production:      ['family', 'tgl', 'shift', 'no_mc'],
  grade:           ['family', 'tgl', 'mo', 'kode_kain'],
  order_info:      ['mo', 'as_of'],
  saldo:           ['mo'],
  daily_capacity:  ['family', 'tgl'],
  gabungan_harian: ['tgl'],
  machine_type:    ['type_mc'],
  loom_shift:      ['tgl', 'slot', 'loom']
};

/**
 * The real SQL type of each key column.
 *
 * Bound parameters in a VALUES list arrive untyped, so Postgres reads them as
 * text and then refuses to compare one against a date column. Casting the
 * first tuple is enough — the rest of the list follows its types.
 */
const typeCache = new Map();

async function keyTypes(client, table, keyCols) {
  const hit = typeCache.get(table);
  if (hit) return hit;
  const { rows } = await client.query(
    `SELECT column_name, format_type(a.atttypid, a.atttypmod) AS sql_type
     FROM information_schema.columns c
     JOIN pg_attribute a ON a.attrelid = c.table_name::regclass AND a.attname = c.column_name
     WHERE c.table_name = $1 AND c.column_name = ANY($2)`, [table, keyCols]);
  const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.sql_type]));
  const types = keyCols.map((c) => byName[c] ?? 'text');
  typeCache.set(table, types);
  return types;
}

export async function openBatch(client, fileName, importedBy, family = null) {
  const { rows: [b] } = await client.query(
    'INSERT INTO import_batch (file_name, imported_by, family) VALUES ($1,$2,$3) RETURNING id',
    [fileName, importedBy ?? null, family]);
  return b.id;
}

/**
 * Records what `records` are about to replace. Call it inside the import's
 * transaction, before the write, or the photograph is of the wrong moment.
 */
export async function snapshot(client, batchId, table, records) {
  const keyCols = KEYS[table];
  if (!batchId || !keyCols || !records.length) return 0;

  // One row per distinct key: a file listing the same key twice would
  // otherwise store the second photograph after the first write.
  const seen = new Map();
  for (const r of records) {
    const key = keyCols.map((c) => r[c] ?? null);
    const id = JSON.stringify(key);
    if (!seen.has(id)) seen.set(id, key);
  }
  const keys = [...seen.values()];

  const cols = keyCols.join(', ');
  const types = await keyTypes(client, table, keyCols);
  const values = [];
  const tuples = keys.map((key, i) => {
    values.push(...key);
    return `(${key.map((_, c) => {
      const ph = `$${i * keyCols.length + c + 1}`;
      return i === 0 ? `${ph}::${types[c]}` : ph;
    }).join(',')})`;
  });

  // LEFT JOIN so keys with no existing row come back as NULL, which is what
  // tells undo to delete rather than restore.
  const { rows } = await client.query(`
    WITH wanted (${cols}) AS (VALUES ${tuples.join(',')})
    SELECT to_jsonb(w) AS key_json, to_jsonb(t) AS before_json
    FROM wanted w LEFT JOIN ${table} t USING (${cols})`, values);

  const ins = [];
  const p = [];
  rows.forEach((r, i) => {
    p.push(batchId, table, JSON.stringify(r.key_json), r.before_json ? JSON.stringify(r.before_json) : null);
    ins.push(`($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}::jsonb)`);
  });
  if (!ins.length) return 0;

  const CHUNK = 500;
  for (let i = 0; i < ins.length; i += CHUNK) {
    const slice = ins.slice(i, i + CHUNK);
    const args = p.slice(i * 4, (i + CHUNK) * 4);
    // Placeholders were numbered for the whole set; renumber for the chunk.
    const renumbered = slice.map((_, j) =>
      `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}::jsonb, $${j * 4 + 4}::jsonb)`);
    await client.query(
      `INSERT INTO import_undo (batch_id, table_name, key_json, before_json)
       VALUES ${renumbered.join(',')}`, args);
  }
  return rows.length;
}

/**
 * Puts every photographed row back and deletes the ones the import created.
 * Newest batch first is the caller's job; undoing out of order would restore
 * a value an even later import has since replaced.
 */
export async function undoBatch(client, batchId, username) {
  const { rows: [b] } = await client.query(
    'SELECT id, file_name, undone_at FROM import_batch WHERE id = $1 FOR UPDATE', [batchId]);
  if (!b) return { ok: false, reason: 'not_found' };
  if (b.undone_at) return { ok: false, reason: 'already_undone' };

  // One entry per key, and it has to be the first one taken. A workbook can
  // carry the same row on two sheets — GARAP and SOURCE DATA both hold the
  // newest day — and each sheet photographs before it writes. The second
  // photograph is of the first sheet's own write, not of the state before the
  // import; applying it re-inserted exactly the rows undo was meant to remove.
  const { rows: entries } = await client.query(
    `SELECT DISTINCT ON (table_name, key_json) table_name, key_json, before_json
     FROM import_undo WHERE batch_id = $1
     ORDER BY table_name, key_json, id`, [batchId]);

  let restored = 0;
  let deleted = 0;
  for (const e of entries) {
    const keyCols = KEYS[e.table_name];
    if (!keyCols) continue;                       // unknown table: leave it alone
    const where = keyCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
    const args = keyCols.map((c) => e.key_json[c]);

    if (e.before_json === null) {
      const r = await client.query(`DELETE FROM ${e.table_name} WHERE ${where}`, args);
      deleted += r.rowCount;
    } else {
      // jsonb_populate_record rebuilds the whole row from the photograph, so
      // columns added since are simply absent rather than guessed at.
      await client.query(`DELETE FROM ${e.table_name} WHERE ${where}`, args);
      await client.query(
        `INSERT INTO ${e.table_name} SELECT (jsonb_populate_record(NULL::${e.table_name}, $1::jsonb)).*`,
        [JSON.stringify(e.before_json)]);
      restored++;
    }
  }

  await client.query(
    'UPDATE import_batch SET undone_at = now(), undone_by = $2 WHERE id = $1', [batchId, username ?? null]);
  return { ok: true, file_name: b.file_name, restored, deleted };
}
