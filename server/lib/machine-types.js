/**
 * Each family of looms: what is read off it at the end of a shift, how its
 * metres are worked out, and which version of that formula is in use.
 *
 * The one place these are defined. The Input Shift form is drawn from it (the
 * GET sends it along), the server checks what is typed against it, and the
 * recalculation check works metres out again with it. A field a family does
 * not measure is listed as not applicable and is always stored as NULL, never
 * as 0; 0 means the loom was read and did not weave.
 */
import { AppError } from '../errors.js';
import { SHUTTLE_RPM } from '../importer/rows.js';
import { widthOf } from './shift-entry.js';

// A free field: a stop code (HB, BB, TY …) or anything the operator needs to say.
const note = { key: 'ket_bb', label: 'KET', kind: 'text', maxLength: 200, required: 'no',
  help: 'Keterangan bebas, misalnya kode berhenti (HB, BB, TY …) atau penjelasan.' };

/**
 * required: 'yes' | 'unless_note' (may be left out when KET says why the loom
 * did not run — it is then 0) | 'no'.
 * auto: worked out when left empty; typing it overrides the working.
 */
export const MACHINE_TYPES = {
  ajl: {
    family: 'ajl', label: 'AJL', calc: 'ajl-1',
    output: 'Output (m) = KETIK PROD × jumlah kain',
    fields: [
      { key: 'ketik', column: 'ketik_prod', label: 'Ketik prod', unit: 'm per kain', kind: 'number',
        min: 0, max: 2000, required: 'unless_note', help: 'Meter per helai kain di layar mesin, untuk shift ini saja.' },
      { key: 'rpm', label: 'RPM', unit: 'rpm', kind: 'number', min: 0, max: 2000, required: 'no',
        help: 'RPM aktual dari layar mesin; RPM target ada di data mesin.' },
      note
    ],
    // Stored columns this family does not measure: always NULL.
    notApplicable: ['ketik', 'sodokan', 'eff', 'pl', 'cmpx_pl', 'pp', 'cmpx_pp']
  },
  rapier: {
    family: 'rapier', label: 'Rapier', calc: 'rapier-1',
    output: 'Output (m) = COUNT × jumlah kain; SULZER: 1000 ÷ pick ÷ 39,37 × COUNT',
    fields: [
      { key: 'rpm', label: 'RPM', unit: 'rpm', kind: 'number', min: 0, max: 2000, required: 'no' },
      { key: 'eff', label: 'EFF', unit: '%', kind: 'number', min: 0, max: 100, required: 'no' },
      { key: 'pl', label: 'PL', unit: 'putus lusi', kind: 'number', min: 0, max: 100000, required: 'no' },
      { key: 'cmpx_pl', label: 'CMPX', unit: 'per 100.000 pick', kind: 'number', min: 0, max: 100000, required: 'no',
        auto: 'PL × 100.000 ÷ (RPM × 480 × EFF)' },
      { key: 'pp', label: 'PP', unit: 'putus pakan', kind: 'number', min: 0, max: 100000, required: 'no' },
      { key: 'cmpx_pp', label: 'CMPX', unit: 'per 100.000 pick', kind: 'number', min: 0, max: 100000, required: 'no',
        auto: 'PP × 100.000 ÷ (RPM × 480 × EFF)' },
      { key: 'ketik', column: 'ketik_prod', label: 'COUNT', unit: 'counter', kind: 'number',
        min: 0, max: 100000, required: 'unless_note', help: 'Counter mesin untuk shift ini (KETIK PROD di laporan harian).' },
      note
    ],
    beam: ['no_beam', 'tgl_kanji', 'kp', 'panjang_beam', 'tgl_naik', 'lusi', 'pakan', 'ket_benang'],
    notApplicable: ['ketik', 'sodokan']
  },
  shuttle: {
    family: 'shuttle', label: 'Shuttle', calc: 'shuttle-2',
    output: 'METER = MT(SODOKAN) − MT(SODOKAN awal) dari tabel SODOKAN kain; ' +
      'bila minus (kain dipotong) METER = MT(SODOKAN)',
    fields: [
      { key: 'sodokan', label: 'Sodokan', unit: 'cm', kind: 'number', min: 0, max: 30,
        required: 'unless_note', help: 'Sodokan gulungan kain di akhir shift, dalam cm (0,5; 1; 1,5 …).' },
      { key: 'sodokan_awal', label: 'Sodokan awal', unit: 'cm', kind: 'number', min: 0, max: 30, required: 'no',
        auto: 'SODOKAN terakhir mesin ini; isi bila beda (cut off), 0 bila gulungan baru' },
      { key: 'produksi', label: 'Meter', unit: 'm', kind: 'number', min: 0, max: 5000, required: 'no',
        auto: 'MT(SODOKAN) − MT(SODOKAN awal) dari tabel SODOKAN', typedCalc: 'typed' },
      note
    ],
    fixed: { jml_kain: 1 },
    notApplicable: ['rpm', 'ketik', 'ketik_prod', 'ketik_rpm', 'hit_rpm', 'eff', 'pl', 'cmpx_pl', 'pp', 'cmpx_pp']
  }
};

export const typeOf = (family) => {
  const t = MACHINE_TYPES[family];
  if (!t) throw new AppError(`Jenis mesin tidak dikenal: ${family}`);
  return t;
};

/**
 * A typed number checked against its field: null when left empty, else the
 * number, refused (with the machine named) when it is not one or is outside
 * what the field allows.
 */
export function readField(family, key, raw, no_mc) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const f = typeOf(family).fields.find((x) => x.key === key);
  if (!f) return null;
  if (f.kind === 'text') {
    const t = String(raw).trim();
    if (f.maxLength && t.length > f.maxLength) throw new AppError(`${no_mc}: ${f.label} terlalu panjang.`);
    return t || null;
  }
  const n = Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw new AppError(`${no_mc}: ${f.label} harus angka, bukan "${raw}".`);
  if (n < f.min) throw new AppError(`${no_mc}: ${f.label} tidak boleh di bawah ${f.min}.`);
  if (n > f.max) throw new AppError(`${no_mc}: ${f.label} ${n} di luar batas wajar (maksimal ${f.max}${f.unit === '%' ? '%' : ''}).`);
  return n;
}

/** What the form needs to draw itself, without the server's internals. */
export const formOf = (family) => {
  const t = typeOf(family);
  return { family: t.family, label: t.label, calc: t.calc, output: t.output, fields: t.fields,
    beam: t.beam ?? null, notApplicable: t.notApplicable };
};

/** Target RPM of a shuttle loom by its type, as UJM's SODOKAN PER SHIFT sheet prices it. */
const SHUTTLE_RPM_BY_TYPE = { 56: 167, 75: 150, 562: 140, 752: 140 };

/** 56 → 167, 75 → 150, 562 and 752 → 140; any other type the registry's, else the old flat 165. */
export const shuttleRpm = (type_mc, fallback = null) =>
  SHUTTLE_RPM_BY_TYPE[widthOf(type_mc)] ?? (Number(fallback) || SHUTTLE_RPM);

/** A SODOKAN reading as the table is keyed: cm to 2 places. */
export const cmKey = (cm) => Math.round(Number(cm) * 100) / 100;

/**
 * Metres on the roll at a SODOKAN reading, from the fabric's table (a Map
 * keyed "kode|width|cm"); width 0 is a table for every loom width, as UJM's
 * VLOOKUP SODOKAN is. A reading of 0 is an empty roll. null when the table
 * has no such reading.
 */
export function rollMeter(tables, kode_kain, width, cm) {
  if (cm === null || cm === undefined) return null;
  const k = cmKey(cm);
  const m = tables.get(`${kode_kain}|${width}|${k}`) ?? tables.get(`${kode_kain}|0|${k}`);
  if (m === undefined) return k === 0 ? 0 : null;
  return Number(m);
}

/**
 * METER of a shift from the metres on the roll now and at the start of the
 * shift. Less than at the start means the roll was cut and a new one begun,
 * so the shift wove what is on the new roll.
 */
export function shuttleMeter(mNow, mAwal) {
  if (mNow === null || mAwal === null) return null;
  const d = mNow - mAwal;
  return Math.round((d < 0 ? mNow : d) * 100) / 100;
}

/** A shift's METER from its two readings, or null where the table lacks one. */
export function shuttleOutput(tables, kode_kain, type_mc, sodokan, sodokan_awal) {
  if (sodokan === null || sodokan === undefined || sodokan_awal === null || sodokan_awal === undefined) return null;
  const width = widthOf(type_mc);
  return shuttleMeter(rollMeter(tables, kode_kain, width, sodokan), rollMeter(tables, kode_kain, width, sodokan_awal));
}

/**
 * A saved row's metres worked out again from its own readings with the
 * current formula, or null where it cannot be (a reading missing, no line in
 * the SODOKAN table). `tables` is shuttle_sodokan keyed "kode|width|cm".
 */
export function outputOf(row, tables = null) {
  if (row.family === 'shuttle') {
    return shuttleOutput(tables ?? new Map(), row.kode_kain, row.type_mc,
      row.sodokan === null ? null : Number(row.sodokan), row.sodokan_awal === null ? null : Number(row.sodokan_awal));
  }
  if (row.ketik_prod === null || row.ketik_prod === undefined) return null;
  const ketik = Number(row.ketik_prod);
  if (ketik === 0) return 0;
  if (row.family === 'rapier' && /SULZER/i.test(row.type_mc ?? '')) {
    return row.pick_used > 0 ? (1000 / Number(row.pick_used) / 39.37) * ketik : null;
  }
  return row.jml_kain > 0 ? ketik * Number(row.jml_kain) : null;
}
