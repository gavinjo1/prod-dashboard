-- Machine daily report warehouse
-- One row per (date, machine, shift) from the mill's daily report sheet.

CREATE TABLE IF NOT EXISTS production (
  id              bigserial PRIMARY KEY,
  tgl             date        NOT NULL,
  shift           text        NOT NULL,
  no_mc           text        NOT NULL,
  mo              text,
  kode_kain       text,
  type_mc         text,
  kelompok_mesin  text,
  jml_kain        numeric,
  rpm             numeric,
  rpm_target      numeric,
  hit_rpm         numeric,
  produksi        numeric,
  ketik_rpm       numeric,
  ketik_prod      numeric,
  ket_bb          text,
  source_file     text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tgl, shift, no_mc)
);

CREATE INDEX IF NOT EXISTS production_tgl_idx        ON production (tgl);
CREATE INDEX IF NOT EXISTS production_no_mc_idx      ON production (no_mc);
CREATE INDEX IF NOT EXISTS production_kelompok_idx   ON production (kelompok_mesin);
CREATE INDEX IF NOT EXISTS production_type_mc_idx    ON production (type_mc);
CREATE INDEX IF NOT EXISTS production_mo_idx         ON production (mo);

-- Inspection grades, reported per manufacturing order per day.
CREATE TABLE IF NOT EXISTS grade (
  id           bigserial PRIMARY KEY,
  tgl          date        NOT NULL,
  mo           text        NOT NULL,
  kode_kain    text,
  grade_a      numeric     NOT NULL DEFAULT 0,
  grade_b      numeric     NOT NULL DEFAULT 0,
  bs           numeric     NOT NULL DEFAULT 0,
  rk           numeric     NOT NULL DEFAULT 0,
  total        numeric     NOT NULL DEFAULT 0,
  source_file  text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tgl, mo, kode_kain)
);

CREATE INDEX IF NOT EXISTS grade_tgl_idx ON grade (tgl);
CREATE INDEX IF NOT EXISTS grade_mo_idx  ON grade (mo);

-- Which loom family a row belongs to.
--
-- It has to be part of the key, not just a label: Rapier and AJL both number
-- machines A1, A2, B1, so on the old (tgl, shift, no_mc) key importing the
-- Rapier workbook would silently overwrite AJL's rows for the same day.
-- Existing rows are all AJL, which is what the default records.
ALTER TABLE production ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT 'ajl';
ALTER TABLE grade      ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT 'ajl';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'production_family_check') THEN
    ALTER TABLE production ADD CONSTRAINT production_family_check
      CHECK (family IN ('ajl', 'rapier', 'shuttle'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grade_family_check') THEN
    ALTER TABLE grade ADD CONSTRAINT grade_family_check
      CHECK (family IN ('ajl', 'rapier', 'shuttle'));
  END IF;

  -- Swap the uniqueness over to include the family.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'production_tgl_shift_no_mc_key') THEN
    ALTER TABLE production DROP CONSTRAINT production_tgl_shift_no_mc_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'production_family_key') THEN
    ALTER TABLE production ADD CONSTRAINT production_family_key
      UNIQUE (family, tgl, shift, no_mc);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grade_tgl_mo_kode_kain_key') THEN
    ALTER TABLE grade DROP CONSTRAINT grade_tgl_mo_kode_kain_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grade_family_key') THEN
    ALTER TABLE grade ADD CONSTRAINT grade_family_key
      UNIQUE (family, tgl, mo, kode_kain);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS production_family_tgl ON production (family, tgl);
CREATE INDEX IF NOT EXISTS grade_family_tgl      ON grade (family, tgl);

-- Settings that belong to the mill rather than to a person.
-- target_eff: the effectiveness a loom is expected to reach at its target RPM,
-- per family. It turns "RPM target met" into metres for the daily chart.
CREATE TABLE IF NOT EXISTS app_setting (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 80% for every family: the factor in the mill's own capability formula
-- (base * 0.8 in its completion-date calculation).
INSERT INTO app_setting (key, value) VALUES ('target_eff', '{"ajl": 80, "rapier": 80, "shuttle": 80}')
ON CONFLICT (key) DO NOTHING;
-- Installs that took the earlier defaults move to 80%, unless an admin has
-- already set a value of their own.
UPDATE app_setting SET value = '{"ajl": 80, "rapier": 80, "shuttle": 80}'
 WHERE key = 'target_eff' AND updated_by IS NULL
   AND value = '{"ajl": 85, "rapier": 80, "shuttle": 85}';

-- The efficiency PPIC sets for a day, per family. A day without one falls
-- back to the family's default in app_setting. Every change is kept with who
-- made it, so a target moved after the fact can be seen and explained.
CREATE TABLE IF NOT EXISTS daily_target (
  family      text        NOT NULL CHECK (family IN ('ajl', 'rapier', 'shuttle')),
  tgl         date        NOT NULL,
  eff_pct     numeric     NOT NULL CHECK (eff_pct > 0 AND eff_pct <= 100),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family, tgl)
);
CREATE TABLE IF NOT EXISTS daily_target_log (
  id          bigserial PRIMARY KEY,
  family      text        NOT NULL,
  tgl         date        NOT NULL,
  before_pct  numeric,                 -- NULL: the day had no target of its own
  after_pct   numeric,                 -- NULL: the day went back to the default
  changed_by  text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daily_target_log_day ON daily_target_log (family, tgl);

-- Every correction made by hand to a production row, before and after.
-- An edit overwrites the figure in place, so without this there would be no
-- way to see what the row said before, or who changed it and when.
CREATE TABLE IF NOT EXISTS edit_log (
  id          bigserial PRIMARY KEY,
  table_name  text        NOT NULL,
  row_id      bigint      NOT NULL,
  action      text        NOT NULL CHECK (action IN ('edit', 'delete')),
  before_json jsonb       NOT NULL,
  after_json  jsonb,
  edited_by   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edit_log_row ON edit_log (table_name, row_id);

-- Undo for an import.
--
-- An import upserts: it overwrites rows that were already there. Deleting what
-- it wrote would therefore lose whatever it replaced, so undo restores instead.
-- Before writing, every row the import is about to touch is photographed here —
-- its whole previous value, or NULL where the row did not exist yet.
CREATE TABLE IF NOT EXISTS import_batch (
  id          bigserial PRIMARY KEY,
  file_name   text        NOT NULL,
  imported_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  undone_at   timestamptz,
  undone_by   text
);

CREATE TABLE IF NOT EXISTS import_undo (
  id          bigserial PRIMARY KEY,
  batch_id    bigint      NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  table_name  text        NOT NULL,
  key_json    jsonb       NOT NULL,
  before_json jsonb                     -- NULL: the row is new, undo deletes it
);
CREATE INDEX IF NOT EXISTS import_undo_batch ON import_undo (batch_id);

-- Which import wrote a given production row, so the table can say so.
ALTER TABLE production ADD COLUMN IF NOT EXISTS batch_id bigint;

-- Who may open the dashboard. Passwords are stored as a scrypt hash with a
-- per-user salt; the plain text is never written anywhere.
CREATE TABLE IF NOT EXISTS app_user (
  username    text PRIMARY KEY,
  nama        text,
  pass_hash   text NOT NULL,
  pass_salt   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

-- When the password last changed. A session cookie issued before this moment
-- is refused: changing a password that someone else may know has to throw
-- them out, not just stop their next sign-in.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS pass_changed_at timestamptz;

-- Three levels, because the mill makes three distinctions and no more:
--   viewer   reads the dashboard
--   operator also imports files and types shifts in
--   admin    also manages accounts
-- There is deliberately no per-machine assignment: everyone at the mill reads
-- the whole report, and modelling otherwise would mean a table and a UI for a
-- distinction nobody there makes.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_role_check') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_role_check
      CHECK (role IN ('viewer', 'operator', 'admin'));
  END IF;
END $$;

-- An existing install has accounts but no roles yet, and the column default
-- would leave every one of them a viewer with nobody able to promote anyone.
-- The first account created gets the keys.
UPDATE app_user SET role = 'admin'
 WHERE username = (SELECT username FROM app_user ORDER BY created_at, username LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM app_user WHERE role = 'admin');

-- Recorded from the new columns onwards. Rows imported before this existed
-- keep NULL rather than being credited to whoever ran the first import after.
ALTER TABLE production ADD COLUMN IF NOT EXISTS edited_by   text;
ALTER TABLE production ADD COLUMN IF NOT EXISTS jam_mulai   time;
ALTER TABLE production ADD COLUMN IF NOT EXISTS jam_selesai time;

-- Opening balance per order, from the rows in the source sheet whose date
-- column reads SALDO instead of a date: production booked against that order
-- before this report period began.
CREATE TABLE IF NOT EXISTS saldo (
  mo          text PRIMARY KEY,
  kode_kain   text,
  produksi    numeric NOT NULL DEFAULT 0,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Daily capacity from the monthly efficiency sheet: what the mill would have
-- woven that day at 100% efficiency. Only the sheet's own TOTAL column is
-- taken — its eight per-type bands sum to a slightly different figure because
-- the total is computed from its own average pick, and mixing the two would
-- give two different answers to the same question.
CREATE TABLE IF NOT EXISTS daily_capacity (
  tgl         date PRIMARY KEY,
  prod        numeric,   -- actual, kept only to verify the row lines up
  prod100     numeric,   -- output at 100% efficiency
  pick_rata2  numeric,
  eff_pct     numeric,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- After the CREATE above, never before it: on a fresh database the table does
-- not exist yet, and setup stopped here.
-- The efficiency band comes from here, and it is per family: Rapier's
-- capacity on AJL's chart is simply the wrong line. Keyed on tgl alone, the
-- second workbook imported silently replaced the first one's whole month.
ALTER TABLE daily_capacity ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT 'ajl';

DO $$
BEGIN
  -- By name, not "any primary key": once the swap has run the table does have
  -- a primary key — the new one — and dropping the old name then failed, which
  -- made every second run of this file abort. The Docker entrypoint runs it
  -- on every boot.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_capacity_pkey') THEN
    ALTER TABLE daily_capacity DROP CONSTRAINT daily_capacity_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_capacity_family_key') THEN
    ALTER TABLE daily_capacity ADD CONSTRAINT daily_capacity_family_key
      PRIMARY KEY (family, tgl);
  END IF;
END $$;

-- Order header from the daily report sheets: who it is for, how much was
-- ordered, how much has been woven so far and what is left. Keyed on the order,
-- holding whichever daily sheet is most recent (`as_of`).
-- Migration: order_info once held only the newest snapshot, keyed on mo alone.
-- It now keeps one row per order per day, so the table is rebuilt when the old
-- single-column key is found. The contents are re-read from the workbook.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'order_info' AND c.contype = 'p' AND array_length(c.conkey, 1) = 1
  ) THEN
    DROP TABLE order_info;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_info (
  mo          text NOT NULL,
  kode_kain   text,
  customer    text,
  pick        numeric,
  total_order numeric,
  akumulasi   numeric,
  sisa_order  numeric,
  as_of       date NOT NULL,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mo, as_of)
);

CREATE INDEX IF NOT EXISTS order_info_kode_idx  ON order_info (kode_kain);
CREATE INDEX IF NOT EXISTS order_info_as_of_idx ON order_info (as_of);

-- Machine-type legend, read from the banded header on the daily report sheets:
-- the mill's own name for each loom type ("E SHADE", "AJL 2 AIR TUCKER")
-- alongside the technical TYPE MC code used in the data rows.
CREATE TABLE IF NOT EXISTS machine_type (
  type_mc     text PRIMARY KEY,
  description text NOT NULL,
  band        text,
  -- Column position in the sheet, so lists read left-to-right as the report
  -- does (E SHADE first) instead of alphabetically.
  sort_order  integer,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE machine_type ADD COLUMN IF NOT EXISTS sort_order integer;

-- Import audit trail.
CREATE TABLE IF NOT EXISTS import_log (
  id           bigserial PRIMARY KEY,
  file_name    text        NOT NULL,
  sheet_name   text,
  dataset      text        NOT NULL,
  rows_read    integer     NOT NULL DEFAULT 0,
  rows_written integer     NOT NULL DEFAULT 0,
  rows_skipped integer     NOT NULL DEFAULT 0,
  status       text        NOT NULL,
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  imported_by  text
);

ALTER TABLE import_log ADD COLUMN IF NOT EXISTS imported_by text;

-- The combined monthly report across every loom family ("LAPORAN PRODUKSI
-- GABUNGAN ... SHUTTLE - RAPIER - AJL TOYOTA"), one row per day.
--
-- Only the figures that are measured are kept. Everything else on that sheet —
-- BS %, efficiency %, PICK MESIN, PICK MC X PROD, PICK INSPECT PERHARI — is a
-- ratio or a sum of these, and is recomputed by the dashboard, so the same
-- formula serves one day, a month, or any range in between.
CREATE TABLE IF NOT EXISTS gabungan_harian (
  tgl           date PRIMARY KEY,
  bs_pjg        numeric,   -- BS length, m
  actual_meter  numeric,   -- ACTUAL HASIL KAIN GABUNGAN (A+B), m
  prod100       numeric,   -- PRODUKSI at 100%, m
  pm_shuttle    numeric,   -- PICK MESIN/BULAN, per family (pick × metres)
  pm_rapier     numeric,
  pm_ajl        numeric,
  pi_shuttle    numeric,   -- PICK KAIN INSPECT/BULAN, per family
  pi_rapier     numeric,
  pi_ajl        numeric,
  source_file   text,
  imported_at   timestamptz NOT NULL DEFAULT now()
);

-- Which family an import was filed under, so each family lists and undoes its
-- own. NULL is listed under Semua only: the combined report, which belongs to
-- no one family, and anything older whose family cannot be told.
ALTER TABLE import_log   ADD COLUMN IF NOT EXISTS family text;
ALTER TABLE import_batch ADD COLUMN IF NOT EXISTS family text;

-- Imports from before the column, given their family after the fact: the one
-- family the file's rows were written under, else the one its name says.
-- Only rows still NULL are touched, so running this again changes nothing.
UPDATE import_log l SET family = COALESCE(
  (SELECT min(family) FROM production p WHERE p.source_file = l.file_name
   HAVING count(DISTINCT family) = 1),
  (SELECT min(family) FROM grade g WHERE g.source_file = l.file_name
   HAVING count(DISTINCT family) = 1),
  CASE WHEN l.file_name ILIKE '%rapier%'  THEN 'rapier'
       WHEN l.file_name ILIKE '%shuttle%' THEN 'shuttle'
       WHEN l.file_name ILIKE '%ajl%'     THEN 'ajl' END)
WHERE l.family IS NULL AND l.dataset <> 'gabungan';
UPDATE import_batch b SET family = COALESCE(
  (SELECT min(family) FROM production p WHERE p.batch_id = b.id
   HAVING count(DISTINCT family) = 1),
  CASE WHEN b.file_name ILIKE '%rapier%'  THEN 'rapier'
       WHEN b.file_name ILIKE '%shuttle%' THEN 'shuttle'
       WHEN b.file_name ILIKE '%ajl%'     THEN 'ajl' END)
WHERE b.family IS NULL;

-- Which upload a log line came from, so a line whose import was undone says
-- so. Older lines are matched to the latest upload of the same file that
-- opened before them, within the hour. Only lines that wrote something: a
-- failed sheet's upload may have been dropped as empty, and must not borrow
-- an earlier one's.
ALTER TABLE import_log ADD COLUMN IF NOT EXISTS batch_id bigint;
UPDATE import_log l SET batch_id = (
  SELECT b.id FROM import_batch b
  WHERE b.file_name = l.file_name
    AND b.created_at <= l.created_at AND b.created_at > l.created_at - interval '1 hour'
  ORDER BY b.created_at DESC LIMIT 1)
WHERE l.batch_id IS NULL AND l.status = 'ok';

-- The shuttle shed measures differently: KETIK is the counter read at the end
-- of the shift, SODOKAN its advance over the shift before, and METER (stored in
-- produksi as for every family) is SODOKAN through the fabric's table. Kept so
-- a METER of 0 against a real SODOKAN can be seen and put right.
ALTER TABLE production ADD COLUMN IF NOT EXISTS ketik   numeric;
ALTER TABLE production ADD COLUMN IF NOT EXISTS sodokan numeric;

-- The shuttle workbook's SODOKAN table: metres of fabric per advance of the
-- counter (CM), by fabric and loom width. A shift typed in by hand finds its
-- METER here, as the daily sheets do with SUMIF.
CREATE TABLE IF NOT EXISTS shuttle_sodokan (
  kode_kain   text        NOT NULL,
  width       integer     NOT NULL,   -- loom width: 75 or 56
  cm          numeric     NOT NULL,   -- SODOKAN, rounded to 2 places
  meter       numeric     NOT NULL,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kode_kain, width, cm)
);

-- How the mill groups fabrics in its efficiency report — "NE LAY OUT": CD30,
-- CD40, RY 72, RY 84 … — read from the KODE KAIN sheet of its EFFISIENSI
-- workbook. Not derivable from the yarn: UMR 04 and UMR 07 are both RY30,
-- yet one is filed under RY 72 and the other under RY 84.
CREATE TABLE IF NOT EXISTS fabric_group (
  kode_kain   text PRIMARY KEY,
  ne          text NOT NULL,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- The groups the mill fixes for its AJL fabrics, in the order its "MAS VENAN
-- 3 HARI SEKALI" sheet lists them (RY 80 last, as there). A fabric's group
-- follows from its construction and does not change, so these are kept as
-- fixed: an upload adds fabrics that are missing, and never moves these.
ALTER TABLE fabric_group ADD COLUMN IF NOT EXISTS fixed     boolean NOT NULL DEFAULT false;
ALTER TABLE fabric_group ADD COLUMN IF NOT EXISTS sort_ne   integer;
ALTER TABLE fabric_group ADD COLUMN IF NOT EXISTS sort_kode integer;
INSERT INTO fabric_group (kode_kain, ne, sort_ne, sort_kode, fixed, source_file) SELECT v.*, true, 'tetap (MAS VENAN)' FROM (VALUES
  ('UMC 305 AJL', 'CD30', 1, 1),
  ('C12072 AJL', 'CD40', 2, 2),
  ('C415 AJL', 'CD40', 2, 3),
  ('UMC 401 P AJL', 'CD40', 2, 4),
  ('UMC 405 AJL', 'CD40', 2, 5),
  ('PE408 AJL', 'PE40', 3, 6),
  ('UMR 3144 AJL', 'RY 68', 4, 7),
  ('RY 3100N AJL', 'RY 72', 5, 8),
  ('UMR 04 AJL', 'RY 72', 5, 9),
  ('UMR 05 AJL', 'RY 72', 5, 10),
  ('UMR 06 AJL', 'RY 72', 5, 11),
  ('UMR 09 AJL', 'RY 72', 5, 12),
  ('UMR 14 AJL', 'RY 72', 5, 13),
  ('UMR 19 AJL', 'RY 72', 5, 14),
  ('RY3100 N AJL', 'RY 72', 5, 15),
  ('R3120 AJL', 'RY 84', 6, 16),
  ('R396 AJL', 'RY 84', 6, 17),
  ('RY 364 AJL', 'RY 84', 6, 18),
  ('UMR 07 AJL', 'RY 84', 6, 19),
  ('UMR 08 AJL', 'RY 84', 6, 20),
  ('UMR 13 AJL', 'RY 84', 6, 21),
  ('UMR 3151 AJL', 'RY 84', 6, 22),
  ('UMR 12 AJL', 'RY 84', 6, 23),
  ('R3111-SB-UR AJL 2', 'RY 84', 6, 24),
  ('R3111-SB R UR AJL 2', 'RY 84', 6, 25),
  ('R3111-AJL', 'RY 84', 6, 26),
  ('RY.364 AJL', 'RY 84', 6, 27),
  ('R382 AJL', 'RY 84', 6, 28),
  ('TR35625 T-SB-UR 2', 'TR30', 7, 29),
  ('TR3746-MAKLOON AJL', 'TR30', 7, 30),
  ('UMTR01 AJL', 'TR30', 7, 31),
  ('DTR 3 001', 'TR30', 7, 32),
  ('TR78 - 2', 'TR45', 8, 33),
  ('TR7860-2 AJL', 'TR45', 8, 34),
  ('R3152 AJL', 'RY 80', 9, 35),
  ('R3138 AJL', 'RY 80', 9, 36)
) AS v(kode_kain, ne, sort_ne, sort_kode)
ON CONFLICT (kode_kain) DO UPDATE SET
  ne = EXCLUDED.ne, sort_ne = EXCLUDED.sort_ne, sort_kode = EXCLUDED.sort_kode,
  fixed = true, source_file = EXCLUDED.source_file;
