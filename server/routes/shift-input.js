/**
 * Input shift: a whole shift typed in at once, machine by machine, in place
 * of the GARAP sheet. Only what the operator reads off the loom is typed;
 * everything the workbook looked up or worked out is filled in here.
 */
import { Router } from 'express';
import { pool, query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { FAMILIES } from '../importer/index.js';
import {
  SHUTTLE_FIXED, outputFromKetik, shiftBefore, sodokanOf, upsertProduction, widthOf
} from '../lib/shift-entry.js';
import {
  CARD_FIELDS, beamsOn, checkBeam, checkCard, removeCard, writeBeam, writeCard
} from '../lib/loom-card.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * What the operator types, per machine and shift
 *
 *   AJL      KETIK PROD (metres per fabric), RPM, note   → output = KETIK × fabrics
 *   Rapier   the EFFISIENSI RAPIER columns: RPM, EFF, PL, CMPX, PP, CMPX,
 *            COUNT (the counter), KET                    → as AJL; SULZER from picks
 *            and the beam on the loom (No. Beam … KET), see lib/loom-card.js
 *   Shuttle  KETIK (counter reading), note               → SODOKAN → METER (table)
 *
 * The order (MO) carries over from the shift before and is changed only when
 * a beam is. Machine type, group, fabrics woven at once and target RPM come
 * from the machine's latest row; fabric and pick from the order.
 * ------------------------------------------------------------------ */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function readShift(q) {
  const family = String(q.family ?? '').toLowerCase();
  const tgl = String(q.tgl ?? '').trim();
  const shift = String(q.shift ?? '').trim().toUpperCase();
  if (!FAMILIES.includes(family)) throw new AppError('Pilih jenis mesin (AJL, Rapier atau Shuttle) dulu.');
  if (!ISO.test(tgl)) throw new AppError('Tanggal harus berformat YYYY-MM-DD.');
  if (!['A', 'B', 'C'].includes(shift)) throw new AppError('Shift harus A, B atau C.');
  return { family, tgl, shift };
}

/** "A2" before "A10", and A before B. */
const machineOrder = (a, b) => {
  const [, pa, na] = /^([A-Za-z]*)(\d*)/.exec(a) ?? [];
  const [, pb, nb] = /^([A-Za-z]*)(\d*)/.exec(b) ?? [];
  return pa.localeCompare(pb) || Number(na || 0) - Number(nb || 0) || a.localeCompare(b);
};

/**
 * Every machine the family has run in the last 60 days, as it stood before
 * this shift: its latest row before it, which is the shift before for any
 * loom that ran then.
 */
async function machinesBefore(family, tgl, shift) {
  const { rows } = await query(`
    SELECT DISTINCT ON (no_mc) no_mc, type_mc, kelompok_mesin, jml_kain, rpm_target, mo, kode_kain,
           tgl::text AS tgl, shift
    FROM production
    WHERE family = $1 AND no_mc IS NOT NULL AND no_mc <> ''
      AND tgl > $2::date - 60 AND (tgl, shift) < ($2::date, $3)
    ORDER BY no_mc, tgl DESC, shift DESC`, [family, tgl, shift]);
  return new Map(rows.map((r) => [r.no_mc, r]));
}

/** Fabric, pick and customer for each order, from its latest header. */
async function ordersFor(mos) {
  if (!mos.length) return new Map();
  const { rows } = await query(`
    SELECT DISTINCT ON (mo) mo, kode_kain, pick, customer
    FROM order_info WHERE mo = ANY($1) ORDER BY mo, as_of DESC`, [mos]);
  return new Map(rows.map((r) => [r.mo, r]));
}

router.get('/api/input-shift', requireRole('operator'), (req, res) => send(res, async () => {
  const { family, tgl, shift } = readShift(req.query);
  const [pt, ps] = shiftBefore(tgl, shift);
  const [before, { rows: saved }, { rows: prev }, { rows: recentMos }] = await Promise.all([
    machinesBefore(family, tgl, shift),
    query(`SELECT no_mc, mo, kode_kain, type_mc, kelompok_mesin, jml_kain, rpm_target, rpm, produksi,
                  ketik_prod, ketik, sodokan, ket_bb, edited_by, source_file
           FROM production WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, tgl, shift]),
    query(`SELECT no_mc, ketik, ketik_prod, rpm, produksi
           FROM production WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, pt, ps]),
    query(`SELECT mo, max(kode_kain) AS kode_kain FROM production
           WHERE family = $1 AND tgl > $2::date - 90 AND mo IS NOT NULL AND mo <> '0'
           GROUP BY mo ORDER BY mo`, [family, tgl])
  ]);
  const savedBy = new Map(saved.map((r) => [r.no_mc, r]));
  const prevBy = new Map(prev.map((r) => [r.no_mc, r]));
  // Rapier: the loom display's readings for the shift, and the beam on each loom.
  const [cards, beams] = family === 'rapier' ? await Promise.all([
    query(`SELECT no_mc, eff, pl, cmpx_pl, pp, cmpx_pp FROM loom_card
           WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, tgl, shift])
      .then(({ rows }) => new Map(rows.map((r) => [r.no_mc, r]))),
    beamsOn(query, family, tgl)
  ]) : [new Map(), new Map()];
  const names = [...new Set([...before.keys(), ...savedBy.keys()])];

  const machines = names.map((no_mc) => {
    const m = savedBy.get(no_mc) ?? before.get(no_mc);
    return {
      no_mc,
      type_mc: m.type_mc, kelompok_mesin: m.kelompok_mesin,
      jml_kain: family === 'shuttle' ? 1 : m.jml_kain,
      rpm_target: family === 'shuttle' ? SHUTTLE_FIXED.rpm_target : m.rpm_target,
      width: family === 'shuttle' ? widthOf(m.type_mc) : null,
      mo: m.mo, kode_kain: m.kode_kain,
      prev: prevBy.get(no_mc) ?? null,
      saved: savedBy.get(no_mc) ?? null,
      card: cards.get(no_mc) ?? null,
      beam: beams.get(no_mc) ?? null
    };
  }).sort((a, b) => String(a.kelompok_mesin ?? '').localeCompare(String(b.kelompok_mesin ?? ''), 'id', { numeric: true })
    || machineOrder(a.no_mc, b.no_mc));

  const orders = await ordersFor([...new Set([...machines.map((m) => m.mo), ...recentMos.map((r) => r.mo)].filter(Boolean))]);

  // Shuttle: the SODOKAN table for every fabric and width on the shift, so
  // the page can show METER as the counter is typed.
  let sodokan = {};
  if (family === 'shuttle') {
    const { rows } = await query(`SELECT kode_kain, width, cm, meter FROM shuttle_sodokan ORDER BY cm`);
    for (const r of rows) (sodokan[`${r.kode_kain}|${r.width}`] ??= []).push([Number(r.cm), Number(r.meter)]);
  }

  res.json({
    family, tgl, shift, prev_shift: { tgl: pt, shift: ps },
    machines,
    orders: Object.fromEntries(orders),
    mos: recentMos.map((r) => ({ mo: r.mo, kode_kain: orders.get(r.mo)?.kode_kain ?? r.kode_kain })),
    sodokan
  });
}));

/* ---- saving a shift ---- */

const num = (v, name, no_mc) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${no_mc}: ${name} harus angka, bukan "${v}".`);
  return n;
};

router.post('/api/input-shift', requireRole('operator'), (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const { family, tgl, shift } = readShift(b);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const beamsIn = family === 'rapier' && Array.isArray(b.beams) ? b.beams : [];
  if (!rows.length && !beamsIn.length) throw new AppError('Tidak ada mesin yang diisi.');
  if (rows.length > 500 || beamsIn.length > 500) throw new AppError('Terlalu banyak baris dalam satu simpan.');
  const hour = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new AppError('Jam shift harus format 24 jam, contoh 06:00.');
    return t;
  };
  const jam_mulai = hour(b.jam_mulai);
  const jam_selesai = hour(b.jam_selesai);

  const before = await machinesBefore(family, tgl, shift);
  const { rows: savedRows } = await query(
    `SELECT no_mc, type_mc, kelompok_mesin, jml_kain, rpm_target, mo, kode_kain
     FROM production WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, tgl, shift]);
  const saved = new Map(savedRows.map((r) => [r.no_mc, r]));
  const orders = await ordersFor([...new Set([
    ...rows.map((r) => String(r.mo ?? '').trim()),
    ...[...before.values(), ...saved.values()].map((m) => m.mo)
  ].filter(Boolean))]);
  const [pt, ps] = shiftBefore(tgl, shift);
  const { rows: prev } = await query(
    `SELECT no_mc, ketik FROM production WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, pt, ps]);
  const prevKetik = new Map(prev.map((r) => [r.no_mc, r.ketik === null ? null : Number(r.ketik)]));
  const tables = family === 'shuttle'
    ? new Map((await query(`SELECT kode_kain, width, cm, meter FROM shuttle_sodokan`)).rows
      .map((r) => [`${r.kode_kain}|${r.width}|${Number(r.cm)}`, Number(r.meter)]))
    : null;

  // Everything is checked before anything is written: a shift is saved whole
  // or not at all, and every row that cannot be is named.
  const errors = [];
  const ready = [];
  for (const raw of rows) {
    const no_mc = String(raw.no_mc ?? '').trim();
    try {
      if (!no_mc) throw new AppError('Ada baris tanpa nomor mesin.');
      const m = saved.get(no_mc) ?? before.get(no_mc);
      if (!m) throw new AppError(`${no_mc}: mesin tidak dikenal untuk ${family.toUpperCase()}.`);
      // Not sent at all: the order carried over from the shift before.
      const mo = raw.mo === undefined || raw.mo === null ? m.mo ?? null : String(raw.mo).trim() || null;
      const order = mo ? orders.get(mo) : null;
      const kode_kain = order?.kode_kain ?? (mo === m.mo ? m.kode_kain : null);
      const ket_bb = String(raw.ket_bb ?? '').trim() || null;
      let ketik = num(raw.ketik, 'KETIK', no_mc);
      const rpm = num(raw.rpm, 'RPM', no_mc);
      let sodokan = num(raw.sodokan, 'SODOKAN', no_mc);
      let produksi = num(raw.produksi, 'METER', no_mc);
      const row = { tgl, shift, no_mc, family, mo, kode_kain, type_mc: m.type_mc,
        kelompok_mesin: m.kelompok_mesin, ket_bb, edited_by: req.user, jam_mulai, jam_selesai };

      if (family === 'shuttle') {
        if (sodokan === null && ketik !== null) {
          const p = prevKetik.get(no_mc);
          if (p === null || p === undefined) {
            throw new AppError(`${no_mc}: KETIK shift ${ps} ${pt} belum ada, jadi SODOKAN tidak bisa dihitung. Isi SODOKAN langsung.`);
          }
          sodokan = sodokanOf(ketik, p);
        }
        if (produksi === null && sodokan !== null) {
          const width = widthOf(m.type_mc);
          if (!kode_kain) throw new AppError(`${no_mc}: MO belum diisi, jadi kain dan METER tidak diketahui. Isi MO.`);
          produksi = sodokan === 0 ? 0 : tables.get(`${kode_kain}|${width}|${Math.round(sodokan * 100) / 100}`) ?? null;
          if (produksi === null) {
            throw new AppError(`${no_mc}: tabel SODOKAN belum punya ${kode_kain ?? '(kain?)'} / MC ${width} untuk sodokan ${sodokan}. Isi METER langsung.`);
          }
        }
        // A note alone means the loom did not run.
        if (produksi === null && ket_bb) produksi = 0;
        if (produksi === null) throw new AppError(`${no_mc}: isi KETIK, atau catatan kalau mesin tidak jalan.`);
        Object.assign(row, SHUTTLE_FIXED, { ketik, sodokan, produksi });
      } else {
        const jml_kain = m.jml_kain;
        if (ketik === null && ket_bb) ketik = 0;
        if (ketik === null) throw new AppError(`${no_mc}: isi KETIK, atau catatan kalau mesin tidak jalan.`);
        produksi = ketik === 0 ? 0 : outputFromKetik(family, m.type_mc, jml_kain, order?.pick ?? null, ketik);
        if (produksi === null) {
          throw new AppError(`${no_mc}: output tidak bisa dihitung — ${
            /SULZER/i.test(m.type_mc ?? '') ? 'pick order belum diketahui' : 'jumlah kain mesin belum diketahui'}.`);
        }
        Object.assign(row, { jml_kain, rpm, rpm_target: m.rpm_target, produksi, ketik_prod: ketik });
        // Rapier's other readings; a form without them leaves any saved ones be.
        if (family === 'rapier' && CARD_FIELDS.some((f) => f in raw)) row.card = { v: checkCard(raw, rpm, no_mc) };
      }
      ready.push(row);
    } catch (err) {
      if (!err.expose) throw err;
      errors.push({ no_mc, error: err.message });
    }
  }
  const beams = [];
  if (beamsIn.length) {
    const { rows: [t] } = await query(`SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date::text AS d`);
    for (const raw of beamsIn) {
      const no_mc = String(raw.no_mc ?? '').trim();
      try {
        if (!saved.has(no_mc) && !before.has(no_mc)) throw new AppError(`${no_mc}: mesin tidak dikenal untuk RAPIER.`);
        beams.push(checkBeam(raw, no_mc, t.d));
      } catch (err) {
        if (!err.expose) throw err;
        errors.push({ no_mc, error: err.message });
      }
    }
  }
  if (errors.length) {
    return res.status(400).json({ error: `${errors.length} mesin belum bisa disimpan. Tidak ada yang tersimpan.`, errors });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const row of ready) {
      if ((await upsertProduction(client, row)).inserted) inserted++;
      if (row.card) {
        if (row.card.v) await writeCard(client, family, tgl, shift, row.no_mc, row.card.v, req.user);
        else await removeCard(client, family, tgl, shift, row.no_mc);
      }
    }
    for (const beam of beams) await writeBeam(client, family, beam, req.user);
    await client.query('COMMIT');
    res.json({ saved: ready.length, inserted, updated: ready.length - inserted, beams: beams.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

/* ---- taking a machine off a shift ---- */

/**
 * Deletes one machine's row for the shift, whether typed here or imported,
 * and Rapier's readings with it. The whole row goes to edit_log first, so a
 * deletion can be put back from there.
 */
router.delete('/api/input-shift', requireRole('operator'), (req, res) => send(res, async () => {
  const { family, tgl, shift } = readShift(req.query);
  const no_mc = String(req.query.no_mc ?? '').trim();
  if (!no_mc) throw new AppError('Mesin belum dipilih.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [before] } = await client.query(
      `SELECT * FROM production WHERE family = $1 AND tgl = $2 AND shift = $3 AND no_mc = $4`,
      [family, tgl, shift, no_mc]);
    if (!before) throw new AppError(`${no_mc} shift ${shift} tidak ada — mungkin sudah dihapus.`, 404);
    const { rows: [card] } = await client.query(
      `DELETE FROM loom_card WHERE family = $1 AND tgl = $2 AND shift = $3 AND no_mc = $4 RETURNING *`,
      [family, tgl, shift, no_mc]);
    await client.query('DELETE FROM production WHERE id = $1', [before.id]);
    await client.query(
      `INSERT INTO edit_log (table_name, row_id, action, before_json, edited_by)
       VALUES ('production', $1, 'delete', $2, $3)`,
      [before.id, JSON.stringify(card ? { ...before, loom_card: card } : before), req.user]);
    await client.query('COMMIT');
    res.json({ ok: true, no_mc });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));
