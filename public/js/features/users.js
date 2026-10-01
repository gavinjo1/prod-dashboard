/**
 * Pengguna: accounts.
 */
import { $ } from '../core/dom.js';
import { api } from '../core/state.js';
import { esc } from '../charts/core.js';

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export const ROLES = ['viewer', 'operator', 'admin'];

export async function loadUsers() {
  const { users, me: myName } = await api('admin/users');
  $('#usersTable tbody').innerHTML = users.map((u) => {
    const self = u.username === myName;
    return `<tr>
      <td>${esc(u.username)}${self ? ' <span class="muted">(Anda)</span>' : ''}</td>
      <td class="muted">${esc(u.nama ?? '—')}</td>
      <td><select class="role-pick" data-user="${esc(u.username)}">${
        ROLES.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${r}</option>`).join('')
      }</select></td>
      <td class="muted nowrap">${esc(u.created_at ?? '—')}</td>
      <td class="muted nowrap">${esc(u.last_login ?? 'belum pernah')}</td>
      <td>${self
        ? '<span class="muted">pakai "Ganti sandi" di atas</span>'
        : `<span class="row-actions">
            <button class="row-action" data-reset="${esc(u.username)}">reset sandi</button>
            <button class="row-danger" data-del="${esc(u.username)}">hapus</button>
          </span>`}</td>
    </tr>`;
  }).join('');
}

export const usersSay = (text, bad) => {
  const el = $('#usersTable').closest('.card').querySelector('.note-line');
  el.textContent = text;
  el.style.color = bad ? 'var(--critical)' : '';
};

$('#usersTable').addEventListener('change', async (e) => {
  const pick = e.target.closest('.role-pick');
  if (!pick) return;
  const was = [...pick.options].find((o) => o.defaultSelected)?.value;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(pick.dataset.user)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: pick.value })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    usersSay(`${pick.dataset.user} sekarang ${pick.value}.`);
    await loadUsers();
  } catch (err) {
    pick.value = was;          // put the control back where it was
    usersSay(err.message, true);
  }
});

$('#usersTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const who = btn.dataset.del;
  if (!confirm(`Hapus akun ${who}? Baris yang pernah diinputnya tetap menyimpan namanya.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(who)}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    usersSay(`${who} dihapus.`);
    await loadUsers();
  } catch (err) {
    usersSay(err.message, true);
  }
});

/* ---- creating an account ---- */

export const nuSay = (text, bad) => {
  const el = $('#nuMsg');
  el.textContent = text;
  el.style.color = bad ? 'var(--critical)' : '';
};

// No 0/O or 1/l/I: the password is read out or copied by hand to the person.
export const newPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = crypto.getRandomValues(new Uint32Array(12));
  return [...pick].map((n) => chars[n % chars.length]).join('');
};
$('#nuGen').addEventListener('click', () => { $('#nuPass').value = newPassword(); });

// Admin resets someone else's password. A fresh one is generated rather than
// typed, so it is never something easy, and it is shown once to be passed on.
$('#usersTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reset]');
  if (!btn) return;
  const who = btn.dataset.reset;
  if (!confirm(`Reset kata sandi ${who}? Sesinya di semua perangkat akan diakhiri.`)) return;

  const password = newPassword();
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(who)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    usersSay(`Kata sandi baru untuk ${who}: ${password} — sampaikan langsung ke orangnya. ` +
      'Tidak akan ditampilkan lagi.');
  } catch (err) {
    usersSay(err.message, true);
  }
});

$('#newUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#nuSave').disabled = true;
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#nuUser').value,
        nama: $('#nuNama').value,
        password: $('#nuPass').value,
        role: $('#nuRole').value
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    // Shown once, so the admin can pass it on; it is not stored anywhere readable.
    nuSay(`Akun ${d.username} (${d.role}) dibuat. Kata sandinya: ${$('#nuPass').value}`);
    $('#newUserForm').reset();
    await loadUsers();
  } catch (err) {
    nuSay(err.message, true);
  } finally {
    $('#nuSave').disabled = false;
  }
});
