/**
 * Admin: other people's accounts.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { send, AppError } from '../errors.js';
import { hashPassword, requireRole } from '../auth.js';
import { newAccount } from '../lib/accounts.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ------------------------------------------------------------------ *
 * Account management
 *
 * Admin only. Two rails throughout: an admin cannot strip their own rights,
 * and the last admin cannot be removed or demoted — either would leave the
 * mill with an installation nobody can administer short of opening psql.
 * ------------------------------------------------------------------ */

const ROLES = ['viewer', 'operator', 'admin'];

const adminCount = async () =>
  (await query(`SELECT count(*)::int AS n FROM app_user WHERE role = 'admin'`)).rows[0].n;

router.get('/api/admin/users', requireRole('admin'), (req, res) => send(res, async () => {
  const { rows } = await query(
    `SELECT username, nama, role,
            to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
            to_char(last_login,  'YYYY-MM-DD HH24:MI') AS last_login
     FROM app_user ORDER BY role DESC, username`);
  res.json({ users: rows, me: req.user });
}));

router.post('/api/admin/users', requireRole('admin'), (req, res) => send(res, async () => {
  const { username, nama, password } = newAccount(req.body);
  const role = String(req.body?.role ?? 'viewer');
  if (!ROLES.includes(role)) throw new AppError('Peran tidak dikenal.');

  const { salt, hash } = await hashPassword(password);
  try {
    await query(
      `INSERT INTO app_user (username, nama, pass_hash, pass_salt, role)
       VALUES ($1,$2,$3,$4,$5)`,
      [username, nama, hash, salt, role]);
  } catch (err) {
    if (err.code === '23505') throw new AppError('Nama pengguna sudah dipakai.', 409);
    throw err;
  }
  res.json({ username, nama, role });
}));

router.patch('/api/admin/users/:username', requireRole('admin'), (req, res) => send(res, async () => {
  const target = String(req.params.username).toLowerCase();
  const role = String(req.body?.role ?? '');
  if (!ROLES.includes(role)) throw new AppError('Peran tidak dikenal.');

  if (target === req.user && role !== 'admin') {
    throw new AppError('Anda tidak bisa menurunkan peran akun Anda sendiri. Minta admin lain.');
  }
  const { rows: [u] } = await query('SELECT role FROM app_user WHERE username = $1', [target]);
  if (!u) throw new AppError('Akun tidak ditemukan.', 404);
  if (u.role === 'admin' && role !== 'admin' && await adminCount() <= 1) {
    throw new AppError('Ini satu-satunya admin. Angkat admin lain dulu.');
  }

  await query('UPDATE app_user SET role = $2 WHERE username = $1', [target, role]);
  res.json({ username: target, role });
}));

router.delete('/api/admin/users/:username', requireRole('admin'), (req, res) => send(res, async () => {
  const target = String(req.params.username).toLowerCase();
  if (target === req.user) throw new AppError('Anda tidak bisa menghapus akun Anda sendiri.');

  const { rows: [u] } = await query('SELECT role FROM app_user WHERE username = $1', [target]);
  if (!u) throw new AppError('Akun tidak ditemukan.', 404);
  if (u.role === 'admin' && await adminCount() <= 1) {
    throw new AppError('Ini satu-satunya admin. Angkat admin lain dulu.');
  }

  // edited_by is plain text, not a reference, so the audit trail on every row
  // this person entered survives the account being removed. That is deliberate.
  await query('DELETE FROM app_user WHERE username = $1', [target]);
  res.json({ deleted: target });
}));

router.post('/api/admin/users/:username/password', requireRole('admin'), (req, res) => send(res, async () => {
  const target = String(req.params.username).toLowerCase();
  const password = String(req.body?.password ?? '');
  if (password.length < 8) throw new AppError('Kata sandi minimal 8 karakter.');
  // Your own goes through /api/auth/password, which asks for the old one.
  // Resetting it here would let anyone at an unattended admin session take
  // the account over without knowing a thing.
  if (target === req.user) {
    throw new AppError('Untuk akun Anda sendiri, pakai "Ganti sandi" di pojok kanan atas.');
  }

  const { salt, hash } = await hashPassword(password);
  const { rowCount } = await query(
    `UPDATE app_user SET pass_hash = $2, pass_salt = $3, pass_changed_at = now()
     WHERE username = $1`, [target, hash, salt]);
  if (!rowCount) throw new AppError('Akun tidak ditemukan.', 404);

  // The old session stays valid: the cookie is signed, not derived from the
  // password. Deleting the account is the way to cut someone off — requireLogin
  // looks the account up on every request, so that takes effect at once.
  res.json({ username: target, reset: true });
}));
