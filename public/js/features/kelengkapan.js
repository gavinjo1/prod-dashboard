/**
 * Kelengkapan data: which sources are in for each day of a month, per loom
 * family, and in plain sentences what is still missing and how to get it.
 */
import { $ } from '../core/dom.js';
import { api, isCurrent, state, takeTicket } from '../core/state.js';
import { esc, fmt } from '../charts/core.js';
import { FAMILY_LABEL } from './family.js';
import { monthName } from './gabungan.js';

const kl = { month: null, d: null };
const label = (f) => FAMILY_LABEL[f] ?? f;

/** Dates as runs of consecutive days: "23 Sep – 30 Sep, 2 Okt". */
function runs(dates) {
  const out = [];
  for (const t of dates) {
    const last = out[out.length - 1];
    const next = last && new Date(`${last[1]}T00:00:00Z`);
    if (next) next.setUTCDate(next.getUTCDate() + 1);
    if (last && next.toISOString().slice(0, 10) === t) last[1] = t;
    else out.push([t, t]);
  }
  return out.map(([a, b]) => (a === b ? fmt.day(a) : `${fmt.day(a)} – ${fmt.day(b)}`)).join(', ');
}

/** What one family has on one day, for the table and the sentences. */
function stateOf(d, f, expected, today) {
  const x = d.fam[f];
  const want = expected[f];
  return {
    shifts: x.shifts,
    want,
    full: want ? x.shifts >= want : x.shifts > 0,
    empty: x.shifts === 0,
    today: d.tgl === today,
    grade: x.grade > 0,
    capacity: x.capacity
  };
}

export async function loadKelengkapan() {
  const ticket = takeTicket('kelengkapan');
  const d = await api('kelengkapan', kl.month ? { month: kl.month } : {});
  if (!isCurrent('kelengkapan', ticket)) return;
  kl.d = d;
  kl.month = d.month;
  $('#klMonth').innerHTML = d.months.map((m) => `<option value="${m}"${m === d.month ? ' selected' : ''}>${monthName(m)}</option>`).join('');
  const families = state.family === 'semua' || !d.families.includes(state.family) ? d.families : [state.family];
  paintPrev(d);
  paintSummary(d, families);
  paintGaps(d, families);
  paintTable(d, families);
}

$('#klMonth').addEventListener('change', (e) => { kl.month = e.target.value; loadKelengkapan(); });
$('#klPrev').addEventListener('click', (e) => {
  const b = e.target.closest('[data-month]');
  if (!b) return;
  kl.month = b.dataset.month;
  loadKelengkapan();
});

function paintPrev(d) {
  $('#klPrev').innerHTML = d.prev?.gaps
    ? `<p class="kl-prev">${esc(monthName(d.prev.month))} masih ada yang kurang (${fmt.int(d.prev.gaps)} hari per jenis mesin).
       File akhir bulan sering belum diupload ulang. <button class="mm-link" data-month="${d.prev.month}">Lihat ${esc(monthName(d.prev.month))}</button></p>`
    : '';
}

/* ---- per family, the month in one line ---- */

function paintSummary(d, families) {
  const row = (f) => {
    const states = d.days.map((day) => stateOf(day, f, d.expected, d.today));
    const past = states.filter((s) => !s.today);
    const full = past.filter((s) => s.full).length;
    const part = past.filter((s) => !s.full && !s.empty).length;
    const none = past.filter((s) => s.empty).length;
    const now = states.find((s) => s.today);
    const count = (k) => (d.has[f]?.[k] ? `${fmt.int(past.filter((s) => s[k]).length)} dari ${fmt.int(past.length)} hari`
      : '<span class="muted">tidak ada laporan</span>');
    const m = d.master[f];
    return `<tr><td class="mc-name">${esc(label(f))}</td>
      <td>${fmt.int(full)} lengkap${part ? ` · <span class="kl-t-part">${fmt.int(part)} sebagian</span>` : ''}${
        none ? ` · <span class="kl-t-miss">${fmt.int(none)} kosong</span>` : ''}${
        now ? `<br><span class="muted">hari ini: ${fmt.int(now.shifts)} dari ${fmt.int(now.want)} shift</span>` : ''}</td>
      <td>${count('grade')}</td><td>${count('capacity')}</td>
      <td>${m ? `${fmt.int(m.in_master)} dari ${fmt.int(m.mos)} MO` : '<span class="muted">—</span>'}</td></tr>`;
  };
  $('#klSummary').innerHTML = `<div class="table-wrap"><table class="data kl-sum"><thead><tr>
      <th>Jenis</th><th>Laporan harian (shift)</th><th>Kualitas</th><th>Produksi 100%</th><th>Ada di Master MO</th>
    </tr></thead><tbody>${families.map(row).join('')}</tbody></table></div>
    <p class="note-line">Hari dihitung sampai kemarin. Lengkap = semua mesin aktif di Data Mesin × 3 shift.</p>`;
}

/* ---- what is missing, said plainly ---- */

function paintGaps(d, families) {
  const items = [];
  for (const f of families) {
    const L = esc(label(f));
    const states = d.days.map((day) => ({ tgl: day.tgl, loom: day.loom, ...stateOf(day, f, d.expected, d.today) }));
    const past = states.filter((s) => !s.today);
    const empty = past.filter((s) => s.empty).map((s) => s.tgl);
    const part = past.filter((s) => !s.full && !s.empty);
    if (empty.length) {
      items.push(['miss', `<b>${L}</b>: laporan harian belum ada untuk ${runs(empty)}.`,
        `Upload laporan harian ${L} di tab Import, atau isi lewat Input Shift.`]);
    }
    if (part.length) {
      const shown = part.slice(0, 6).map((s) => `${fmt.day(s.tgl)} (${fmt.int(s.shifts)}/${fmt.int(s.want)})`).join(', ');
      items.push(['part', `<b>${L}</b>: ${fmt.int(part.length)} hari baru sebagian shift terisi: ${shown}${part.length > 6 ? ', …' : ''}.`,
        'Lengkapi di Input Shift, atau upload ulang laporan harian hari itu.']);
    }
    if (d.has[f]?.capacity) {
      const noCap = past.filter((s) => !s.capacity).map((s) => s.tgl);
      if (noCap.length) {
        items.push(['miss', `<b>${L}</b>: produksi 100% (grid efisiensi) belum ada untuk ${runs(noCap)}.`,
          'Biasanya terisi kalau file bulan itu diupload ulang setelah bulan selesai. Tanpa ini, kolom pick mesin di Laporan Gabungan kosong.']);
      }
    }
    if (d.has[f]?.grade) {
      const noGrade = past.filter((s) => !s.grade).map((s) => s.tgl);
      if (noGrade.length) {
        items.push(['part', `<b>${L}</b>: laporan kualitas belum ada untuk ${runs(noGrade)}.`,
          'Inspeksi sering menyusul: kualitas sebuah tanggal bisa baru masuk dari file bulan berikutnya.']);
      }
    }
    if (!d.has[f]?.grade || !d.has[f]?.capacity) {
      const what = [!d.has[f]?.grade && 'laporan kualitas', !d.has[f]?.capacity && 'grid produksi 100%'].filter(Boolean).join(' dan ');
      items.push(['na', `<b>${L}</b>: belum pernah ada ${what}.`,
        `Kolom ${L} di Laporan Gabungan tetap kosong sampai laporan itu ada. Tanyakan ke QC/PPIC apakah ada.`]);
    }
    const m = d.master[f];
    if (m && m.in_master < m.mos) {
      items.push(['part', `<b>${L}</b>: ${fmt.int(m.mos - m.in_master)} dari ${fmt.int(m.mos)} MO yang ditenun bulan ini belum ada di Master MO${
        m.missing?.length ? ` (misalnya ${m.missing.slice(0, 3).map(esc).join(', ')})` : ''}.`,
        'Pick dan kode kain MO itu masih diambil dari laporan harian. Minta PPIC melengkapi master.']);
    }
    if (f === 'ajl' && d.loom) {
      const noLoom = past.filter((s) => !s.loom).map((s) => s.tgl);
      if (noLoom.length) {
        items.push(['part', `<b>AJL</b>: data monitoring mesin (tab Pabrik) belum ada untuk ${runs(noLoom)}.`,
          'Upload export Shift Report mesin di tab Pabrik.']);
      }
    }
  }
  $('#klGaps').innerHTML = items.length
    ? items.map(([kind, what, how]) => `<li class="kl-gap kl-gap-${kind}"><span>${what}</span><span class="kl-how">${how}</span></li>`).join('')
    : `<li class="kl-gap kl-gap-ok"><span>Tidak ada yang kurang di ${esc(monthName(d.month))}.</span></li>`;
}

/* ---- day by day ---- */

function paintTable(d, families) {
  const loom = d.loom && families.includes('ajl');
  const cols = (f) => 3 + (loom && f === 'ajl' ? 1 : 0);
  $('#klTable thead').innerHTML = `<tr><th rowspan="2">Tanggal</th>${families.map((f) =>
    `<th colspan="${cols(f)}" class="kl-fam">${esc(label(f))}</th>`).join('')}</tr>
    <tr>${families.map((f) => `<th class="num kl-first">Shift</th><th>Kualitas</th><th>Prod. 100%</th>${
      loom && f === 'ajl' ? '<th>Monitor</th>' : ''}`).join('')}</tr>`;
  const mark = (on, applies = true) => (!applies ? '<td class="kl-na"></td>'
    : on ? '<td class="kl-ok">✓</td>' : '<td class="kl-miss">—</td>');
  $('#klTable tbody').innerHTML = d.days.slice().reverse().map((day) => `<tr${day.tgl === d.today ? ' class="kl-today"' : ''}>
    <td class="nowrap">${esc(fmt.day(day.tgl))}${day.tgl === d.today ? ' <span class="muted">hari ini</span>' : ''}</td>
    ${families.map((f) => {
      const s = stateOf(day, f, d.expected, d.today);
      const shift = s.full ? `<td class="num kl-first kl-ok">✓ ${fmt.int(s.shifts)}</td>`
        : s.empty ? `<td class="num kl-first ${s.today ? 'kl-na' : 'kl-miss'}">—</td>`
          : `<td class="num kl-first ${s.today ? 'kl-na' : 'kl-part'}">${fmt.int(s.shifts)}/${fmt.int(s.want)}</td>`;
      return shift + mark(s.grade, d.has[f]?.grade) + mark(s.capacity, d.has[f]?.capacity)
        + (loom && f === 'ajl' ? mark(day.loom > 0) : '');
    }).join('')}</tr>`).join('');
  $('#klLegend').textContent = 'Terbaru di atas. ✓ ada · angka = shift terisi dari yang seharusnya · — belum ada · '
    + 'kosong abu-abu = jenis mesin ini tidak punya laporan itu, atau hari ini masih berjalan.';
}
