/**
 * The rules an account is held to, however it is created.
 */
import { AppError } from '../errors.js';

export const USERNAME = /^[a-z0-9._-]{3,32}$/i;

/** The rules every new account is held to, however it is created. */
export function newAccount(body) {
  const username = String(body?.username ?? '').trim().toLowerCase();
  const nama = String(body?.nama ?? '').trim() || null;
  const password = String(body?.password ?? '');
  if (!USERNAME.test(username)) {
    throw new AppError('Nama pengguna 3–32 karakter: huruf, angka, titik, garis.');
  }
  if (password.length < 8) throw new AppError('Kata sandi minimal 8 karakter.');
  return { username, nama, password };
}
