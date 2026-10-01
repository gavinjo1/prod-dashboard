/**
 * The efficiency target, one per family.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send, AppError } from '../errors.js';
import { requireRole } from '../auth.js';
import { familyOf } from '../lib/filters.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ---- mill settings ---- */

router.get('/api/settings/target-eff', (req, res) => send(res, async () => {
  const { rows: [s] } = await query(`SELECT value FROM app_setting WHERE key = 'target_eff'`);
  res.json(s?.value ?? { ajl: 85, rapier: 80, shuttle: 85 });
}));

// A management number that changes what everyone sees, so admin only.
router.put('/api/settings/target-eff', requireRole('admin'), (req, res) => send(res, async () => {
  const family = familyOf(req.body);
  const v = Number(req.body?.value);
  if (!Number.isFinite(v) || v <= 0 || v > 100) throw new AppError('Efektivitas harus antara 1 dan 100%.');
  const { rows: [s] } = await query(`
    INSERT INTO app_setting (key, value, updated_by, updated_at)
    VALUES ('target_eff', jsonb_build_object($1::text, $2::numeric), $3, now())
    ON CONFLICT (key) DO UPDATE SET
      value = app_setting.value || jsonb_build_object($1::text, $2::numeric),
      updated_by = $3, updated_at = now()
    RETURNING value`, [family, v, req.user]);
  res.json(s.value);
}));
