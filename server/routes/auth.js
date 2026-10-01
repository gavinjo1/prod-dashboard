/**
 * Sign-in, registration of the first account, own password, captcha.
 */
import { Router } from 'express';
import { query, pool } from '../db.js';
import { send, AppError } from '../errors.js';
import { note, countOf, retryAfter, forget, limit } from '../ratelimit.js';
import { issueCaptcha, solveCaptcha } from '../captcha.js';
import { hashPassword, verifyPassword, setSession, clearSession, readSession, noUsersYet, sessionIssuedAt, sessionPredates } from '../auth.js';
import { newAccount } from '../lib/accounts.js';

// Case-sensitive like the app itself: see the note in index.js.
export const router = Router({ caseSensitive: true });

/* ---- login bombing ----
 *
 * Three separate brakes, because they stop different attacks:
 *   - per IP, a picture challenge then a hard stop: one host guessing many
 *   - per username, across every IP: many hosts guessing one account
 *   - the global limiter above: everything else
 *
 * Failures are counted, successes forgotten, so an ordinary typo costs
 * nothing once the person gets in.
 */
const FAIL_WINDOW = 15 * 60 * 1000;
const CAPTCHA_AFTER = 4;
const IP_BLOCK_AFTER = 15;
const USER_LOCK_AFTER = 8;

const ipFailKey = (req) => `login-fail:${req.ip}`;
const userFailKey = (u) => `login-user:${u}`;
const captchaNeeded = (req) => countOf(ipFailKey(req), FAIL_WINDOW) >= CAPTCHA_AFTER;

/* ------------------------------------------------------------------ *
 * Accounts
 *
 * One account per person, because the point is to be able to say who
 * entered a figure. Passwords are scrypt-hashed in auth.js.
 * ------------------------------------------------------------------ */


router.get('/api/auth/me', (req, res) => send(res, async () => {
  const username = readSession(req);
  if (!username) {
    return res.json({
      user: null,
      first_run: await noUsersYet(),
      captcha_required: captchaNeeded(req)
    });
  }
  const { rows: [u] } = await query(
    'SELECT username, nama, role, pass_changed_at FROM app_user WHERE username = $1', [username]);
  // The account was removed, or its password changed, while the cookie was
  // still valid. /me is outside the guard, so it has to check this itself —
  // otherwise the sign-in page reads the old cookie as signed in and sends the
  // person back to a dashboard that refuses them, round and round.
  if (!u || sessionPredates(sessionIssuedAt(req), u.pass_changed_at)) {
    clearSession(res);
    return res.json({ user: null, first_run: await noUsersYet(), captcha_required: captchaNeeded(req) });
  }
  const { pass_changed_at, ...user } = u;
  res.json({ user, first_run: false });
}));

router.get('/api/auth/captcha',
  limit({ windowMs: 60_000, max: 30, prefix: 'captcha' }),
  (req, res) => {
    const c = issueCaptcha();
    if (!c) return res.status(503).json({ error: 'Sedang sibuk, coba lagi sebentar.' });
    res.json(c);
  });


/**
 * Only for the very first account, which becomes the admin. After that the
 * data is the mill's customer book, so nobody signs themselves up: the admin
 * creates each account from the Pengguna tab.
 */
router.post('/api/auth/register',
  limit({ windowMs: 60 * 60 * 1000, max: 5, prefix: 'register',
          message: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.' }),
  (req, res) => send(res, async () => {
  const { username, nama, password } = newAccount(req.body);
  const { salt, hash } = await hashPassword(password);

  // The table is locked for the check and the insert together, so two people
  // opening a fresh install at the same moment cannot both come out admin.
  const client = await pool.connect();
  let created;
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE app_user IN EXCLUSIVE MODE');
    const { rowCount } = await client.query(
      `INSERT INTO app_user (username, nama, pass_hash, pass_salt, role)
       SELECT $1, $2, $3, $4, 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM app_user)`,
      [username, nama, hash, salt]);
    await client.query('COMMIT');
    created = rowCount === 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!created) {
    return res.status(403).json({ error: 'Pendaftaran ditutup. Minta akun ke admin.' });
  }
  setSession(res, username);
  res.json({ user: { username, nama, role: 'admin' } });
}));

router.post('/api/auth/login', (req, res) => send(res, async () => {
  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const ipKey = ipFailKey(req);
  const userKey = userFailKey(username);

  const tooMany = (key, msg) => {
    const wait = retryAfter(key, FAIL_WINDOW);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `${msg} Coba lagi dalam ${Math.ceil(wait / 60)} menit.` });
  };

  if (countOf(ipKey, FAIL_WINDOW) >= IP_BLOCK_AFTER) {
    return tooMany(ipKey, 'Terlalu banyak percobaan masuk dari jaringan ini.');
  }
  // Counted across every address, so spreading the guessing over many hosts
  // does not buy an attacker more tries at one account.
  if (username && countOf(userKey, FAIL_WINDOW) >= USER_LOCK_AFTER) {
    return tooMany(userKey, 'Akun ini dikunci sementara karena terlalu banyak percobaan.');
  }

  if (captchaNeeded(req) && !solveCaptcha(req.body?.captcha_id, req.body?.captcha)) {
    return res.status(400).json({
      error: 'Kode gambar salah atau sudah kedaluwarsa.',
      captcha_required: true
    });
  }

  const { rows: [u] } = await query(
    'SELECT username, nama, role, pass_hash, pass_salt FROM app_user WHERE username = $1', [username]);

  // Same message either way: a distinct "no such user" tells an outsider which
  // names exist.
  const ok = u && await verifyPassword(password, u.pass_salt, u.pass_hash);
  if (!ok) {
    note(ipKey, FAIL_WINDOW);
    if (username) note(userKey, FAIL_WINDOW);
    return res.status(401).json({
      error: 'Nama pengguna atau kata sandi salah.',
      captcha_required: captchaNeeded(req)
    });
  }

  // A person who gets in was not the attacker; clear their slate so an earlier
  // typo does not follow them around for the next quarter of an hour.
  forget(ipKey);
  forget(userKey);

  await query('UPDATE app_user SET last_login = now() WHERE username = $1', [username]);
  setSession(res, u.username);
  res.json({ user: { username: u.username, nama: u.nama, role: u.role } });
}));

router.post('/api/auth/password',
  limit({ windowMs: 15 * 60 * 1000, max: 10, prefix: 'passwd',
          message: 'Terlalu banyak percobaan ganti sandi. Coba lagi nanti.' }),
  (req, res) => send(res, async () => {
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.password ?? '');
    if (next.length < 8) throw new AppError('Kata sandi baru minimal 8 karakter.');
    if (next === current) throw new AppError('Kata sandi baru harus berbeda dari yang lama.');

    const { rows: [u] } = await query(
      'SELECT pass_hash, pass_salt FROM app_user WHERE username = $1', [req.user]);
    // The current password is asked for even though the person is signed in:
    // a browser left open at the mill must not be enough to lock its owner out.
    if (!u || !await verifyPassword(current, u.pass_salt, u.pass_hash)) {
      throw new AppError('Kata sandi lama salah.', 401);
    }

    const { salt, hash } = await hashPassword(next);
    // Taken from this clock, before the new cookie is made, so the cookie
    // below is never mistaken for one issued before the change.
    const at = Date.now();
    await query(
      `UPDATE app_user SET pass_hash = $2, pass_salt = $3, pass_changed_at = to_timestamp($4 / 1000.0)
       WHERE username = $1`, [req.user, hash, salt, at]);

    // This device stays signed in; every other one is sent to the sign-in page.
    setSession(res, req.user);
    res.json({ ok: true });
  }));

router.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
