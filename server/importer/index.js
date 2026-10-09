/**
 * Import of an uploaded workbook: finds every sheet it recognises and writes it.
 */
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { openBatch, snapshot } from '../undo.js';
import { inspectSheet, readWorkbook, sheetRows } from './workbook.js';
import { readDailyCapacity, upsertCapacity } from './capacity.js';
import { readGabungan, upsertGabungan } from './gabungan.js';
import { readOrderInfo, readShuttleOrders, upsertOrderInfo, upsertSaldo } from './orders.js';
import { FIELD_LABEL, diagnose } from './diagnose.js';
import { readTypeLegend, upsertTypes } from './legend.js';
import { readSodokanTable, upsertSodokan } from './sodokan.js';
import { FAMILIES, buildRows, dedupe, planRows, recordConflicts, shuttleGaps, upsert } from './rows.js';
export { isSupported } from './workbook.js';
export { FAMILIES } from './rows.js';

/**
 * The whole file is one transaction: if any part of it cannot be written,
 * none of it is, and the reason is reported. `dryRun` does everything but the
 * final commit, so the result says exactly what an import would do — rows new,
 * changed, unchanged, and refused because they were typed on the dashboard.
 */
export async function importBuffer(buffer, fileName,
  { only = null, dataset = null, editedBy = null, family = 'ajl', dryRun = false } = {}) {
  // Semua takes the combined report only. Everything else in a workbook — the
  // daily sheets, order headers, capacity, the type legend — belongs to one
  // family, and filed under Semua it would land under none, or the wrong one.
  const combined = family === 'semua';
  if (!combined && !FAMILIES.includes(family)) throw new AppError(`Jenis mesin tidak dikenal: ${family}`);
  const wb = readWorkbook(buffer, fileName);
  const results = [];
  const client = await pool.connect();
  await client.query('BEGIN');
  let batchId = null;
  let dropped = 0;
  // Which part was being written when something failed, for the message.
  let part = null;
  // Any failure while writing stops the whole file.
  const fail = (where, err) => {
    part = where;
    throw err;
  };

  // The shuttle order list has no date of its own; it is recorded as of the
  // last day of shuttle production in the same file.
  let shuttleLastDay = null;

  try {
    // One batch per uploaded file, covering every sheet in it: undoing half a
    // workbook would leave the daily sheets disagreeing with BULANAN.
    batchId = await openBatch(client, fileName, editedBy, combined ? null : family);
    for (const name of wb.SheetNames) {
      if (only && !only.includes(name)) continue;

      let found;
      try {
        found = inspectSheet(wb.Sheets[name]);
      } catch (err) {
        results.push({ sheet: name, status: 'error', message: err.message });
        continue;
      }
      if (!found) continue;
      if (dataset && found.dataset !== dataset) continue;

      if (combined) {
        results.push({ sheet: name, dataset: found.dataset, status: 'error',
          message: 'Sheet ini laporan harian. Pilih AJL, Rapier atau Shuttle dulu, lalu upload lagi.' });
        continue;
      }
      // A shuttle sheet measures in sodokan and METER; filed under AJL or
      // Rapier its looms would mix with theirs. Refused, not guessed.
      if (found.dataset === 'shuttle' && family !== 'shuttle') {
        results.push({ sheet: name, dataset: 'shuttle', status: 'error',
          message: 'Sheet ini laporan Shuttle (KETIK, SODOKAN, METER). Pilih Shuttle dulu, lalu upload lagi.' });
        continue;
      }
      // Shuttle rows are production rows, in the same table.
      const table = found.dataset === 'shuttle' ? 'production' : found.dataset;

      const { records, saldo, skipped } = buildRows(found);
      // Stamped here rather than in buildRows: the sheet itself never says
      // which family it is, the person uploading it does.
      for (const r of records) r.family = family;
      const warning = found.dataset === 'shuttle' ? shuttleGaps(records) : null;
      if (found.dataset === 'shuttle') {
        for (const r of records) if (!shuttleLastDay || r.tgl > shuttleLastDay) shuttleLastDay = r.tgl;
      }
      const keyOf = table === 'production'
        ? (r) => `${family}|${r.tgl}|${r.shift}|${r.no_mc}`
        : (r) => `${family}|${r.tgl}|${r.mo}|${r.kode_kain}`;
      const unique = dedupe(records, keyOf);

      try {
        // Only what is new or changed is written; a row typed on the
        // dashboard is never overwritten, only recorded as a conflict.
        const plan = await planRows(client, table, unique);
        await snapshot(client, batchId, table, plan.write);
        await snapshot(client, batchId, 'saldo', saldo);
        const { inserted, updated, written } = await upsert(client, table, plan.write, fileName, editedBy, batchId);
        const conflicts = await recordConflicts(client, batchId, table, plan.conflicts, fileName);
        const saldoWritten = await upsertSaldo(client, saldo, fileName);
        await client.query(
          `INSERT INTO import_log (file_name, sheet_name, dataset, rows_read, rows_written, rows_skipped, status, message, imported_by, family, batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,'ok',$7,$8,$9,$10)`,
          [fileName, name, found.dataset, records.length + skipped, written, skipped, warning, editedBy, family, batchId]
        );
        results.push({
          sheet: name, dataset: found.dataset, status: 'ok',
          read: records.length + skipped, written, inserted, updated, skipped,
          // Rows refused because they were typed on the dashboard, and how
          // many of them are newly recorded (the rest are already open).
          unchanged: plan.unchanged, conflicts: plan.conflicts.length, conflicts_recorded: conflicts,
          conflict_sample: plan.conflicts.slice(0, 5).map((c) => ({
            tgl: c.rec.tgl, shift: c.rec.shift, no_mc: c.rec.no_mc, mo: c.rec.mo, fields: c.differs })),
          saldo: saldoWritten,
          duplicates: records.length - unique.length,
          ...(warning ? { warning } : {})
        });
      } catch (err) {
        fail(name, err);
      }
    }
    // The legend lives on the formatted daily sheets, which carry no data rows.
    // It runs last so it can be checked against the TYPE MC codes just imported.
    if (!dataset) {
      // Order headers: collect every sheet's block, keep the latest per order.
      // Keyed on order + date: every daily sheet contributes its own snapshot,
      // so the order's day-by-day progression is preserved.
      //
      // Only sheets named for a day of the month count, and the date printed on
      // the sheet has to agree with that name. Workbooks accumulate copies and
      // templates — "4 (2)", "10 (3)", "FORMAT" — that keep an old date while
      // their formulas show today's totals. Taken at face value they overwrite
      // real history with the latest figures.
      const orders = new Map();
      for (const name of combined ? [] : wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        const day = /^\s*(\d{1,2})\s*$/.exec(name);
        if (!day || Number(day[1]) < 1 || Number(day[1]) > 31) continue;
        try {
          for (const e of readOrderInfo(wb.Sheets[name])) {
            if (!e.as_of) continue;
            if (Number(e.as_of.slice(8, 10)) !== Number(day[1])) continue;
            orders.set(`${e.mo}|${e.as_of}`, e);
          }
        } catch { /* a sheet that will not parse simply has no order block */ }
      }
      // The shuttle order list, dated by the production it came with.
      if (family === 'shuttle' && shuttleLastDay) {
        for (const name of wb.SheetNames) {
          if (only && !only.includes(name)) continue;
          for (const e of readShuttleOrders(sheetRows(wb.Sheets[name]), shuttleLastDay)) {
            orders.set(`${e.mo}|${e.as_of}`, e);
          }
        }
      }
      if (orders.size) {
        try {
          await snapshot(client, batchId, 'order_info', [...orders.values()]);
          const written = await upsertOrderInfo(client, [...orders.values()], fileName);
          results.push({ sheet: '(order headers)', dataset: 'order_info', status: 'ok',
            read: orders.size, written, skipped: orders.size - written });
        } catch (err) {
          fail('(order headers)', err);
        }
      }

      // The shuttle SODOKAN table, so a shift typed in by hand gets its METER
      // the way the workbook works it out.
      if (family === 'shuttle') {
        for (const name of wb.SheetNames) {
          if (only && !only.includes(name)) continue;
          let table;
          try { table = readSodokanTable(wb.Sheets[name]); } catch { continue; }
          if (!table.entries.length) continue;
          const warning = table.doubled.size
            ? 'Tabel SODOKAN punya baris ganda untuk ' +
              [...table.doubled].map(([f, n]) => `${f} (${n} ukuran)`).join(', ') +
              '. Excel menjumlahkan keduanya, jadi METER kain itu dobel.'
            : null;
          try {
            await snapshot(client, batchId, 'shuttle_sodokan', table.entries);
            const written = await upsertSodokan(client, table.entries, fileName);
            results.push({ sheet: name, dataset: 'sodokan', status: 'ok',
              read: table.entries.length, written, skipped: 0, ...(warning ? { warning } : {}) });
          } catch (err) {
            fail(name, err);
          }
          break;
        }
      }

      // Daily capacity, from whichever sheet carries the monthly efficiency grid.
      for (const name of combined ? [] : wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        let cap = [];
        try { cap = readDailyCapacity(wb.Sheets[name]); } catch { continue; }
        if (!cap.length) continue;
        try {
          for (const c of cap) c.family = family;
          await snapshot(client, batchId, 'daily_capacity', cap);
          const written = await upsertCapacity(client, cap, fileName, family);
          results.push({ sheet: `(daily capacity · ${name})`, dataset: 'daily_capacity',
            status: 'ok', read: cap.length, written, skipped: 0 });
        } catch (err) {
          fail(`(daily capacity · ${name})`, err);
        }
        break;
      }

      // The combined report across every loom family, from whichever sheet
      // carries it. It is its own workbook at the mill, but may be pasted in.
      for (const name of wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        let gab = [];
        try { gab = readGabungan(wb.Sheets[name]); } catch { continue; }
        if (!gab.length) continue;
        const unique = dedupe(gab, (e) => e.tgl);
        try {
          await snapshot(client, batchId, 'gabungan_harian', unique);
          const w = await upsertGabungan(client, unique, fileName);
          // Logged under no family: the combined report belongs to all of
          // them, so it is listed under Semua only.
          await client.query(
            `INSERT INTO import_log (file_name, sheet_name, dataset, rows_read, rows_written, rows_skipped, status, imported_by, family, batch_id)
             VALUES ($1,$2,'gabungan',$3,$4,0,'ok',$5,NULL,$6)`,
            [fileName, name, gab.length, w.written, editedBy, batchId]);
          results.push({ sheet: name, dataset: 'gabungan', status: 'ok',
            read: gab.length, written: w.written, inserted: w.inserted, updated: w.updated,
            skipped: 0, duplicates: gab.length - unique.length });
        } catch (err) {
          fail(name, err);
        }
      }

      const legend = new Map();
      for (const name of combined ? [] : wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        try {
          for (const e of readTypeLegend(wb.Sheets[name])) legend.set(e.type_mc, e);
        } catch { /* a sheet that will not parse simply has no legend */ }
      }
      if (legend.size) {
        try {
          await snapshot(client, batchId, 'machine_type', [...legend.values()]);
          const written = await upsertTypes(client, [...legend.values()], fileName);
          if (written) {
            results.push({ sheet: '(machine type names)', dataset: 'machine_type', status: 'ok',
              read: legend.size, written, skipped: legend.size - written });
          }
        } catch (err) {
          fail('(machine type names)', err);
        }
      }
    }
    // A batch that recorded nothing — the file held no recognisable sheet, or
    // nothing in it differed from what is stored — is not an import anyone
    // can undo. Left in place it became the newest batch, and the real import
    // before it could no longer be undone until this empty one was.
    ({ rowCount: dropped } = await client.query(
      `DELETE FROM import_batch b WHERE b.id = $1
         AND NOT EXISTS (SELECT 1 FROM import_undo u WHERE u.batch_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM import_conflict c WHERE c.batch_id = b.id)`, [batchId]));
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Logged outside the rolled-back transaction, so the failure is on record.
    await pool.query(
      `INSERT INTO import_log (file_name, sheet_name, dataset, status, message, imported_by, family)
       VALUES ($1,$2,'file','error',$3,$4,$5)`,
      [fileName, part, err.message, editedBy, combined ? null : family]).catch(() => {});
    throw new AppError(`Import dibatalkan, tidak ada yang tersimpan. ${part ? `Sheet ${part}: ` : ''}${err.message}`);
  } finally {
    client.release();
  }

  if (combined && !results.some((r) => r.dataset === 'gabungan' && r.status === 'ok')) {
    // Nothing combined in it: say where a daily report goes rather than list
    // each of its sheets as a failure.
    if (results.length) {
      throw new AppError('File ini laporan harian, bukan LAPORAN PRODUKSI GABUNGAN. ' +
        'Pilih AJL, Rapier atau Shuttle dulu, lalu upload lagi.');
    }
    throw new AppError('Tidak ada LAPORAN PRODUKSI GABUNGAN di file ini. Butuh kolom TGL, ' +
      'ACTUAL HASIL KAIN dan PRODUKSI di bawah judul PICK MESIN/BULAN.');
  }
  if (!results.length) {
    const near = diagnose(wb, only);
    if (near) {
      const label = (f) => FIELD_LABEL[f] ?? f;
      throw new AppError(
        `Sheet "${near.sheet}" mirip laporan ${near.dataset}, tapi kolom ` +
        `${near.missing.map(label).join(' dan ')} tidak ada. ` +
        `Yang ditemukan: ${near.have.map(label).join(', ')}. ` +
        `Judul kolom di baris itu: ${near.headers.join(', ')}. ` +
        `Ganti nama kolom yang kurang, atau periksa ejaan judulnya.`
      );
    }
    throw new AppError(
      'Tidak ada sheet yang dikenali. Laporan harian butuh kolom TGL, NO MC dan PRODUKSI; ' +
      'grade butuh TGL, MO dan A; laporan gabungan butuh TGL, ACTUAL HASIL KAIN dan ' +
      'PRODUKSI di bawah judul PICK MESIN/BULAN.'
    );
  }
  // Attached rather than wrapped: callers already treat this as the array of
  // per-sheet results, and one of them is the client.
  results.batch_id = dropped || dryRun ? null : batchId;
  results.dry_run = dryRun;
  return results;
}

/** Sheet listing for the upload preview, without writing anything. */
export function previewBuffer(buffer, fileName) {
  const wb = readWorkbook(buffer, fileName);
  return wb.SheetNames.map((name) => {
    const found = inspectSheet(wb.Sheets[name]);
    if (!found) {
      const gab = readGabungan(wb.Sheets[name]);
      return { sheet: name, dataset: gab.length ? 'gabungan' : null, rows: gab.length };
    }
    const { records } = buildRows(found);
    return { sheet: name, dataset: found.dataset, rows: records.length };
  });
}
