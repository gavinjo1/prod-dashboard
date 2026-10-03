/**
 * Sign-in state: who is here, what they may touch, their own password.
 */
import { $ } from './core/dom.js';
import { session, toLogin } from './core/state.js';

/* ------------------------------------------------------------------ *
 * Sign-in
 *
 * Checked before the first query, so an expired session shows the sign-in
 * page rather than a dashboard full of failed panels.
 * ------------------------------------------------------------------ */

const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({ user: null }));
if (!me.user) await toLogin();

const ROLE_LABEL = { viewer: 'viewer', operator: 'operator', admin: 'admin' };
const role = me.user.role || 'viewer';
const canWrite = role === 'operator' || role === 'admin';
session.role = role;
session.canWrite = canWrite;

$('#whoamiName').textContent = me.user.nama || me.user.username;
$('#whoamiRole').textContent = ROLE_LABEL[role] ?? role;
$('#whoamiRole').dataset.role = role;
$('#whoami').hidden = false;

// The API refuses these anyway; hiding them keeps a viewer from filling in a
// form that was only ever going to be rejected.
if (!canWrite) {
  // Exports are for operators and admins; the API refuses viewers anyway.
  $('#gabExport')?.remove();
  $('#entryForm')?.closest('.card')?.remove();
  $('#drop')?.closest('.card')?.remove();
  $('#loomDrop')?.closest('.card')?.remove();
  // The export carries every customer and order in one file, so it is for
  // the people who work with the data, not everyone who can look at it.
  $('#btnExport')?.remove();
  $('#btnExportXlsx')?.remove();
}
// The target effectiveness is the mill's number: an admin sets it, everyone
// else reads it in the same place.
if (role !== 'admin') { $('#targetEff').readOnly = true; $('#targetEff').tabIndex = -1; }
// Everyone gets the tab for their own password; managing others stays admin.
$('#tabUsers').hidden = false;
$('#usersAdmin').hidden = role !== 'admin';
// Efisiensi kain is the admin's alone; removed rather than hidden, since
// switching family would show it again.
if (role !== 'admin') {
  $('.tab[data-tab="efisiensi"]')?.remove();
  $('#panel-efisiensi')?.remove();
}
$('#myAccount').textContent =
  `${me.user.nama || me.user.username} · masuk sebagai ${me.user.username} · peran ${role}`;
const pwSay = (text, kind) => {
  $('#pwMsg').textContent = text;
  $('#pwMsg').className = `pw-msg ${kind ? `is-${kind}` : ''}`;
};

$('#btnPassword').addEventListener('click', () => {
  $('#pwForm').reset();
  // Lets the browser's password manager tie the new password to this account.
  $('#pwUser').value = me.user.username;
  pwSay('');
  $('#pwDialog').showModal();
  $('#pwCurrent').focus();
});
$('#pwCancel').addEventListener('click', () => $('#pwDialog').close());

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#pwNew').value !== $('#pwConfirm').value) {
    return pwSay('Kata sandi baru dan ulangannya tidak sama.', 'err');
  }
  $('#pwSave').disabled = true;
  pwSay('…');
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: $('#pwCurrent').value, password: $('#pwNew').value })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Gagal.');
    pwSay('Tersimpan. Perangkat lain sudah dikeluarkan.', 'ok');
    setTimeout(() => $('#pwDialog').close(), 1400);
  } catch (err) {
    pwSay(err.message, 'err');
  } finally {
    $('#pwSave').disabled = false;
  }
});

$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('login.html');
});
