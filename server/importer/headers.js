/**
 * Header spellings: how a sheet's column titles map onto our fields.
 */


/* ------------------------------------------------------------------ *
 * Header handling
 * ------------------------------------------------------------------ */

// "Kelompok Mesin" / "KELOMPOK  MESIN" / "kelompok_mesin" all collapse to
// KELOMPOKMESIN, so the sheet can be relabelled without breaking the import.
export const normHeader = (h) =>
  String(h ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// For matching a column to a field, "%" is kept, as PCT. Dropped, "% A" read
// as the grade column "A" and "PROD %" as the output column "PROD" — both are
// percentages sitting beside the real thing. normHeader itself stays as it
// was: the capacity sheet finds "PROD 100%" as PROD100.
const fieldHeader = (h) =>
  String(h ?? '').toUpperCase().replace(/%/g, 'PCT').replace(/[^A-Z0-9]/g, '');

// field -> accepted header spellings (already normalised)
export const PRODUCTION_FIELDS = {
  tgl:            ['TGL', 'TANGGAL', 'DATE', 'TANGGALPRODUKSI', 'TGLPRODUKSI', 'TANGGALLAPORAN'],
  shift:          ['SHIFT', 'REGU', 'GILIRAN'],
  no_mc:          ['NOMC', 'NOMESIN', 'MESIN', 'MACHINE', 'MC', 'MACHINENO',
                   'NOMORMESIN', 'NOMORMC', 'NOMRMESIN', 'MCNO', 'NOLOOM'],
  mo:             ['MO', 'NOMO', 'ORDER', 'NOORDER', 'NOMORMO', 'NOMORORDER', 'MONO'],
  kode_kain:      ['KODEKAIN', 'KODE', 'KAIN', 'FABRIC', 'FABRICCODE', 'JENISKAIN'],
  type_mc:        ['TYPEMC', 'TIPEMC', 'TYPEMESIN', 'MACHINETYPE', 'TIPEMESIN', 'JENISMESIN'],
  kelompok_mesin: ['KELOMPOKMESIN', 'GROUPMESIN', 'MACHINEGROUP', 'KELOMPOK', 'GRUPMESIN', 'GRUP'],
  jml_kain:       ['JMLKAIN', 'JUMLAHKAIN', 'JMLHKAIN', 'JUMLAHLEMBAR', 'LEMBAR'],
  rpm:            ['RPM', 'RPMREAL', 'RPMAKTUAL'],
  rpm_target:     ['RPMTARGET', 'TARGETRPM', 'RPMPLAN'],
  hit_rpm:        ['HITRPM'],
  produksi:       ['PRODUKSI', 'PROD', 'PRODUCTION', 'HASIL', 'HASILPRODUKSI', 'OUTPUT'],
  ketik_rpm:      ['KETIKRPM'],
  ketik_prod:     ['KETIKPROD', 'KETIKPRODUKSI', 'KETIKCOUNTER'],
  ket_bb:         ['KETBB', 'KETERANGANBB', 'KETBEAMBARU', 'KETERANGAN', 'KET', 'CATATAN']
};

// The order header block on each daily sheet. Both "MO" and "KODE KAIN" appear
// twice on those sheets; mapColumns takes the first, which is the one carrying
// the full MO/UW/... code rather than the shortened KP reference.
export const ORDER_FIELDS = {
  mo:          ['MO'],
  kode_kain:   ['KODEKAIN'],
  pick:        ['PICK'],
  customer:    ['CUSTOMER'],
  total_order: ['ORDER', 'TOTALORDER'],
  akumulasi:   ['COMM', 'AKUMULASIPRODUKSI'],
  sisa_order:  ['SISA', 'SISAORDER']
};

/**
 * The shuttle shed's DATA sheet: one row per loom per shift, like SOURCE
 * DATA, but measured differently. KETIK is the counter as read at the end of
 * the shift, SODOKAN the advance over the shift before, and METER is SODOKAN
 * converted through the fabric's table — that is the output. BLOK is the line
 * number (the first of two BLOK columns), MC the loom width, 75 or 56.
 * No "MC" alias for the machine: here MC is the width.
 */
export const SHUTTLE_FIELDS = {
  tgl:       ['TGL', 'TANGGAL', 'DATE'],
  shift:     ['SHIFT', 'REGU'],
  no_mc:     ['NOMC', 'NOMESIN', 'NOMORMESIN'],
  mo:        ['MO', 'NOMO'],
  kode_kain: ['KODEKAIN', 'KODE'],
  pick:      ['PICK'],
  counter:   ['KETIK'],
  sodokan:   ['SODOKAN'],
  produksi:  ['METER'],
  line:      ['BLOK', 'LINE'],
  width:     ['MC'],
  ket_bb:    ['KET', 'KETERANGAN']
};

/** The shuttle order list: PKN is the pick, QTY the order quantity. */
export const SHUTTLE_ORDER_FIELDS = {
  mo:          ['MO'],
  kode_kain:   ['KODE', 'KODEKAIN'],
  pick:        ['PKN', 'PICK'],
  total_order: ['QTY'],
  customer:    ['CUST', 'CUSTOMER']
};

export const GRADE_FIELDS = {
  tgl:       ['TGL', 'TANGGAL', 'DATE'],
  mo:        ['MO', 'NOMO'],
  kode_kain: ['KODE', 'KODEKAIN', 'KAIN', 'FABRIC'],
  grade_a:   ['A', 'GRADEA'],
  grade_b:   ['B', 'GRADEB'],
  bs:        ['BS', 'BADSTOCK'],
  rk:        ['RK', 'REJECT'],
  total:     ['TOTAL', 'JUMLAH']
};

/**
 * Map each field to a column index. Headers can repeat (the GRADE sheet has
 * two "BS" columns); first occurrence wins, which is the one that holds data.
 */
export function mapColumns(headerRow, fields) {
  const norm = headerRow.map(fieldHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(fields)) {
    for (const alias of aliases) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}
