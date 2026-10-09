/**
 * Input shift: a whole shift typed in at once, machine by machine, in place
 * of the GARAP sheet. Only what the operator reads off the loom is typed;
 * everything the workbook looked up or worked out is filled in here.
 */
import { Router } from 'express';
import XLSX from 'xlsx';
import { pool, query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { FAMILIES } from '../importer/index.js';
import {
  SHUTTLE_FIXED, outputFromKetik, shiftAfter, shiftBefore, sodokanOf, upsertProduction, widthOf
} from '../lib/shift-entry.js';
import {
  CARD_FIELDS, beamsOn, checkBeam, checkCard, removeCard, writeBeam, writeCard
} from '../lib/loom-card.js';
import { formOf, readField, typeOf } from '../lib/machine-types.js';

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
 * Every active loom of the family in the machine registry, with what the
 * registry says it is (type, group, fabrics, target RPM), and the order it
 * was last on before this shift — carried over until a new beam goes up.
 */
async function machinesBefore(family, tgl, shift) {
  const { rows } = await query(`
    SELECT m.no_mc, m.type_mc, m.kelompok_mesin, m.jml_kain, m.rpm_target, m.width,
           last.mo, last.kode_kain, last.tgl, last.shift
    FROM machine m
    LEFT JOIN LATERAL (
      SELECT p.mo, p.kode_kain, p.tgl::text AS tgl, p.shift FROM production p
      WHERE p.family = m.family AND p.no_mc = m.no_mc AND (p.tgl, p.shift) < ($2::date, $3)
      ORDER BY p.tgl DESC, p.shift DESC LIMIT 1) last ON true
    WHERE m.family = $1 AND m.active`, [family, tgl, shift]);
  return new Map(rows.map((r) => [r.no_mc, r]));
}

/**
 * Fabric, pick and customer of each order on a day: PPIC's master first, the
 * order headers after (the pick in force that day — see mo_pick in schema).
 */
async function ordersFor(mos, tgl) {
  if (!mos.length) return new Map();
  const { rows } = await query(`
    SELECT x.mo, COALESCE(m.kode_kain, o.kode_kain) AS kode_kain, mo_pick(x.mo, $2::date) AS pick,
           COALESCE(m.customer, o.customer) AS customer
    FROM unnest($1::text[]) AS x(mo)
    LEFT JOIN product_master m ON m.mo = x.mo
    LEFT JOIN LATERAL (SELECT kode_kain, customer FROM order_info
                       WHERE mo = x.mo ORDER BY as_of DESC LIMIT 1) o ON true
    WHERE m.mo IS NOT NULL OR o.kode_kain IS NOT NULL`, [mos, tgl]);
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
    // The orders to choose from: those this family wove lately, and every MO
    // in PPIC's master (a new one is in the master before it is on a loom).
    query(`SELECT mo, max(kode_kain) AS kode_kain FROM (
             SELECT mo, kode_kain FROM production
             WHERE family = $1 AND tgl > $2::date - 90 AND mo IS NOT NULL AND mo <> '0'
             UNION ALL SELECT mo, kode_kain FROM product_master
           ) x GROUP BY mo ORDER BY mo`, [family, tgl])
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

  const orders = await ordersFor([...new Set([...machines.map((m) => m.mo), ...recentMos.map((r) => r.mo)].filter(Boolean))], tgl);

  // Shuttle: the SODOKAN table for every fabric and width on the shift, so
  // the page can show METER as the counter is typed.
  let sodokan = {};
  if (family === 'shuttle') {
    const { rows } = await query(`SELECT kode_kain, width, cm, meter FROM shuttle_sodokan ORDER BY cm`);
    for (const r of rows) (sodokan[`${r.kode_kain}|${r.width}`] ??= []).push([Number(r.cm), Number(r.meter)]);
  }

  res.json({
    family, tgl, shift, prev_shift: { tgl: pt, shift: ps },
    // What to draw and check for this family (server/lib/machine-types.js).
    form: formOf(family),
    machines,
    orders: Object.fromEntries(orders),
    mos: recentMos.map((r) => ({ mo: r.mo, kode_kain: orders.get(r.mo)?.kode_kain ?? r.kode_kain })),
    sodokan
  });
}));

/* ---- saving a shift ---- */

/**
 * Shuttle: a counter corrected on a saved shift changes the next shift's
 * SODOKAN too (next KETIK − this KETIK). Where the next shift is saved and
 * its SODOKAN was the one worked out from the old counter, it is worked out
 * again with its METER, and logged. Where it was typed by hand, it is left
 * and named, for someone to check. Returns what was done, loom by loom.
 */
async function rechainShuttle(db, tgl, shift, ready, saved, tables, user) {
  const [nt, ns] = shiftAfter(tgl, shift);
  const changed = ready.filter((r) => {
    const was = saved.get(r.no_mc)?.ketik;
    return was !== null && was !== undefined && r.ketik !== null && Number(was) !== Number(r.ketik);
  });
  if (!changed.length) return [];
  const { rows: next } = await db.query(
    `SELECT * FROM production WHERE family = 'shuttle' AND tgl = $1 AND shift = $2 AND no_mc = ANY($3) FOR UPDATE`,
    [nt, ns, changed.map((r) => r.no_mc)]);
  const nextBy = new Map(next.map((r) => [r.no_mc, r]));
  const out = [];
  for (const r of changed) {
    const n = nextBy.get(r.no_mc);
    if (!n || n.ketik === null) continue;
    const oldKetik = Number(saved.get(r.no_mc).ketik);
    const auto = sodokanOf(Number(n.ketik), oldKetik);
    if (n.sodokan === null || Math.abs(Number(n.sodokan) - auto) > 1e-9) {
      out.push({ no_mc: r.no_mc, tgl: nt, shift: ns, status: 'periksa',
        message: `SODOKAN shift ${ns} ${nt} (${n.sodokan}) tidak dihitung dari ketik lama, jadi tidak diubah. Periksa.` });
      continue;
    }
    const sodokan = sodokanOf(Number(n.ketik), Number(r.ketik));
    const width = widthOf(n.type_mc);
    const meter = sodokan === 0 ? 0 : tables.get(`${n.kode_kain}|${width}|${sodokan}`);
    // As the workbook's SUMIF: no line in the table counts as 0 m, said here.
    const produksi = meter ?? 0;
    const { rows: [after] } = await db.query(`
      UPDATE production SET sodokan = $2, produksi = $3, edited_by = $4, manual = true, calc = 'shuttle-1'
      WHERE id = $1 RETURNING *`, [n.id, sodokan, produksi, user]);
    await db.query(`
      INSERT INTO edit_log (table_name, row_id, action, before_json, after_json, edited_by, reason)
      VALUES ('production', $1, 'edit', $2, $3, $4, $5)`,
    [n.id, JSON.stringify(n), JSON.stringify(after), user,
      `ketik shift ${shift} ${tgl} dikoreksi ${oldKetik} → ${r.ketik}: sodokan dihitung ulang`]);
    out.push({ no_mc: r.no_mc, tgl: nt, shift: ns, status: 'dihitung ulang',
      sodokan: { before: Number(n.sodokan), after: sodokan },
      meter: { before: n.produksi === null ? null : Number(n.produksi), after: produksi },
      ...(meter === undefined ? { message: `tabel SODOKAN belum punya ${n.kode_kain} / MC ${width} untuk ${sodokan}; METER 0` } : {}) });
  }
  return out;
}

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
    `SELECT no_mc, type_mc, kelompok_mesin, jml_kain, rpm_target, mo, kode_kain, ketik
     FROM production WHERE family = $1 AND tgl = $2 AND shift = $3`, [family, tgl, shift]);
  const saved = new Map(savedRows.map((r) => [r.no_mc, r]));
  const orders = await ordersFor([...new Set([
    ...rows.map((r) => String(r.mo ?? '').trim()),
    ...[...before.values(), ...saved.values()].map((m) => m.mo)
  ].filter(Boolean))], tgl);
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
      // Each reading checked against what the family's form allows; one it
      // does not measure stays NULL whatever was sent.
      const ket_bb = readField(family, 'ket_bb', raw.ket_bb, no_mc);
      let ketik = readField(family, 'ketik', raw.ketik, no_mc);
      const rpm = readField(family, 'rpm', raw.rpm, no_mc);
      let sodokan = readField(family, 'sodokan', raw.sodokan, no_mc);
      let produksi = readField(family, 'produksi', raw.produksi, no_mc);
      // The pick the shift is worked out with is kept on the row, and so is
      // what produced its metres: the family's formula, or metres typed in.
      const row = { tgl, shift, no_mc, family, mo, kode_kain, type_mc: m.type_mc,
        kelompok_mesin: m.kelompok_mesin, ket_bb, edited_by: req.user, jam_mulai, jam_selesai,
        pick_used: order?.pick ?? null,
        calc: produksi !== null ? 'typed' : typeOf(family).calc };

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
    const chained = family === 'shuttle' ? await rechainShuttle(client, tgl, shift, ready, saved, tables, req.user) : [];
    await client.query('COMMIT');
    res.json({ saved: ready.length, inserted, updated: ready.length - inserted, beams: beams.length, chained });
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

/* ---- downloading a day as Excel ---- */

const CALC_LABEL = { excel: 'dari Excel', typed: 'diketik', '-': '' };
const calcLabel = (c) => CALC_LABEL[c ?? '-'] ?? `rumus dashboard (${c})`;
const BEAM_HEAD = [['no_beam', 'No. Beam'], ['tgl_kanji', 'TGL KANJI'], ['kp', 'KP'], ['panjang_beam', 'PANJANG BEAM'],
  ['tgl_naik', 'TGL NAIK'], ['lusi', 'Lusi'], ['pakan', 'Pakan'], ['ket_benang', 'KET BENANG']];
const excelSerial = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
};

/**
 * One date as typed on Input Shift, in a workbook: every active loom on every
 * shift asked for, with the family's own columns, what its metres came from,
 * and who saved it. A loom with nothing saved is listed as "belum diisi" with
 * its figures empty — never as 0, which would claim it did not weave.
 */
router.get('/api/input-shift/export.xlsx', requireRole('operator'), (req, res) => send(res, async () => {
  const family = String(req.query.family ?? '').toLowerCase();
  const tgl = String(req.query.tgl ?? '').trim();
  const only = String(req.query.shift ?? '').trim().toUpperCase();
  if (!FAMILIES.includes(family)) throw new AppError('Pilih jenis mesin (AJL, Rapier atau Shuttle) dulu.');
  if (!ISO.test(tgl)) throw new AppError('Tanggal harus berformat YYYY-MM-DD.');
  if (only && !['A', 'B', 'C'].includes(only)) throw new AppError('Shift harus A, B atau C.');
  const shifts = only ? [only] : ['A', 'B', 'C'];

  const [{ rows: saved }, { rows: machines }, cards, beams] = await Promise.all([
    query(`SELECT p.*, p.tgl::text AS tgl, to_char(p.jam_mulai, 'HH24:MI') AS jam_mulai,
                  to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai,
                  to_char(p.imported_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS saved_at
           FROM production p WHERE p.family = $1 AND p.tgl = $2 AND p.shift = ANY($3)`, [family, tgl, shifts]),
    query(`SELECT no_mc, type_mc, kelompok_mesin, jml_kain, rpm_target FROM machine
           WHERE family = $1 AND active`, [family]),
    family === 'rapier'
      ? query(`SELECT shift, no_mc, eff, pl, cmpx_pl, pp, cmpx_pp FROM loom_card
               WHERE family = $1 AND tgl = $2`, [family, tgl]).then(({ rows }) => new Map(rows.map((r) => [`${r.shift}|${r.no_mc}`, r])))
      : new Map(),
    family === 'rapier' ? beamsOn(query, family, tgl) : new Map()
  ]);
  const savedBy = new Map(saved.map((r) => [`${r.shift}|${r.no_mc}`, r]));
  const registry = new Map(machines.map((m) => [m.no_mc, m]));
  const names = [...new Set([...machines.map((m) => m.no_mc), ...saved.map((r) => r.no_mc)])];
  const order = (a, b) => {
    const ka = String((savedBy.get(`A|${a}`) ?? registry.get(a))?.kelompok_mesin ?? '');
    const kb = String((savedBy.get(`A|${b}`) ?? registry.get(b))?.kelompok_mesin ?? '');
    return ka.localeCompare(kb, 'id', { numeric: true }) || a.localeCompare(b, 'id', { numeric: true });
  };
  names.sort(order);

  // The family's own columns, between the loom and the status.
  const fam = family === 'rapier'
    ? [['rpm', 'RPM'], ['eff', 'EFF %'], ['pl', 'PL'], ['cmpx_pl', 'CMPX lusi'], ['pp', 'PP'], ['cmpx_pp', 'CMPX pakan'],
      ['ketik_prod', 'COUNT']]
    : family === 'shuttle' ? [['ketik', 'Ketik'], ['sodokan', 'Sodokan']]
      : [['ketik_prod', 'Ketik prod'], ['rpm', 'RPM']];
  const head = ['Tanggal', 'Shift', 'Jam', 'Mesin', 'Tipe', 'Kelompok', 'MO', 'Kode kain', 'Pick',
    ...(family === 'shuttle' ? [] : ['Jumlah kain']), ...fam.map(([, l]) => l),
    'Output (m)', 'RPM target', 'Kapasitas (m)', 'Efisiensi %', 'KET',
    ...(family === 'rapier' ? BEAM_HEAD.map(([, l]) => l) : []),
    'Status', 'Asal angka', 'Diinput oleh', 'Disimpan'];

  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
  const body = [];
  const totals = shifts.map((s) => ({ shift: s, machines: 0, filled: 0, meter: 0, out: 0, cap: 0 }));
  for (const s of shifts) {
    const t = totals.find((x) => x.shift === s);
    for (const no_mc of names) {
      const r = savedBy.get(`${s}|${no_mc}`);
      const m = registry.get(no_mc);
      if (!r && !m) continue;
      t.machines++;
      const card = cards.get(`${s}|${no_mc}`) ?? {};
      const at = r ?? m;
      const pick = num(r?.pick_used);
      const jml = num(at.jml_kain);
      const target = num(at.rpm_target);
      const cap = r && pick > 0 && target > 0 && jml > 0 ? (target * 480 * 2.54) / (pick * 100) * jml : null;
      const out = num(r?.produksi);
      if (r) { t.filled++; t.meter += out ?? 0; if (cap) { t.out += out ?? 0; t.cap += cap; } }
      const beam = beams.get(no_mc) ?? {};
      body.push([
        excelSerial(tgl), s, r?.jam_mulai ? `${r.jam_mulai}–${r.jam_selesai ?? ''}` : null, no_mc,
        at.type_mc ?? null, at.kelompok_mesin ?? null, r?.mo ?? null, r?.kode_kain ?? null, pick,
        ...(family === 'shuttle' ? [] : [jml]),
        ...fam.map(([k]) => num(['eff', 'pl', 'cmpx_pl', 'pp', 'cmpx_pp'].includes(k) ? card[k] : r?.[k])),
        r2(out), target, cap === null ? null : r2(cap),
        cap && out !== null ? Math.round((out / cap) * 10000) / 100 : null,
        r?.ket_bb ?? null,
        ...(family === 'rapier' ? BEAM_HEAD.map(([k]) => (k.startsWith('tgl_') && beam[k] ? excelSerial(beam[k]) : beam[k] ?? null)) : []),
        r ? 'tersimpan' : 'belum diisi', r ? calcLabel(r.calc) : null, r?.edited_by ?? null, r?.saved_at ?? null
      ]);
    }
  }

  const sheet = XLSX.utils.aoa_to_sheet([head, ...body]);
  const dates = [0, ...['TGL KANJI', 'TGL NAIK'].map((h) => head.indexOf(h)).filter((c) => c >= 0)];
  body.forEach((_, i) => {
    for (const c of dates) {
      const cell = sheet[XLSX.utils.encode_cell({ r: i + 1, c })];
      if (cell && cell.t === 'n') cell.z = 'd-mmm-yy';
    }
  });
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: body.length, c: head.length - 1 } }) };
  sheet['!cols'] = head.map((h) => ({ wch: Math.max(8, Math.min(24, h.length + 2)) }));

  // A summary per shift: how complete it is, and what it came to.
  const summary = XLSX.utils.aoa_to_sheet([
    ['Tanggal', 'Shift', 'Mesin aktif', 'Sudah diisi', 'Belum diisi', 'Total meter', 'Efisiensi %'],
    ...totals.map((t) => [excelSerial(tgl), t.shift, t.machines, t.filled, t.machines - t.filled,
      Math.round(t.meter * 100) / 100, t.cap ? Math.round((t.out / t.cap) * 10000) / 100 : null])
  ]);
  totals.forEach((_, i) => { const c = summary[XLSX.utils.encode_cell({ r: i + 1, c: 0 })]; if (c) c.z = 'd-mmm-yy'; });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Input Shift');
  XLSX.utils.book_append_sheet(wb, summary, 'Ringkasan');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const name = `Input Shift ${family.toUpperCase()} ${tgl}${only ? ` shift ${only}` : ''}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
}));
