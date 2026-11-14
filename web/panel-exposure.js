// Exposure KPI (B3): people living within about 1-2 km of a detected landscape fire, in the busiest month of the
// selected period. Listens for fc:results like the other panels.
import * as q from './queries.js';

const fmt = (v) => Math.round(v).toLocaleString('en-US');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pure: the busiest month and the latest month from the monthly rows.
export function exposureSummary(rows) {
  if (!rows || !rows.length) return null;
  const peak = rows.reduce((a, b) => (b.people > a.people ? b : a));
  const latest = rows[rows.length - 1];
  return { peak, latest, months: rows.length };
}

export function exposureText(s, meta) {
  if (!s) return { value: '0', note: 'No landscape fires detected in this area and period.' };
  const when = (r) => `${MONTHS[r.month - 1]} ${r.year}`;
  return {
    value: fmt(s.peak.people),
    note: `in ${when(s.peak)}, the busiest month of the period. ${when(s.latest)}: ${fmt(s.latest.people)}. `
      + `Population ${meta && meta.population_source ? 'from GHS-POP 2020' : 'year 2020'}; landscape fires only. `
      + 'Before 2012 the satellites (MODIS) detected fewer small fires, so earlier months are not directly comparable.',
  };
}

function tile() {
  let el = document.getElementById('kpi-exposure');
  if (!el) {
    el = document.createElement('div');
    el.className = 'kpi';
    el.id = 'kpi-exposure';
    el.innerHTML = '<div class="kpi-label">People within about 1–2 km of a fire</div><div class="kpi-value"></div><p class="muted kpi-note"></p>';
    document.querySelector('.kpi-row')?.append(el);
  }
  return el;
}

if (typeof document !== 'undefined') {
  let seq = 0;
  document.addEventListener('fc:results', async (ev) => {
    const ctx = ev.detail;
    const my = ++seq;
    const el = tile();
    el.querySelector('.kpi-value').textContent = '…';
    el.querySelector('.kpi-note').textContent = 'Loading…';
    try {
      const rows = await q.exposure(ctx.db, ctx.area, ctx.range);
      if (my !== seq) return;
      if (rows === null) { el.hidden = true; return; }
      el.hidden = false;
      const t = exposureText(exposureSummary(rows), ctx.meta);
      el.querySelector('.kpi-value').textContent = t.value;
      el.querySelector('.kpi-note').textContent = t.note;
    } catch (e) {
      if (my !== seq) return;
      el.querySelector('.kpi-value').textContent = '—';
      el.querySelector('.kpi-note').textContent = e && e.message ? e.message : String(e);
    }
  });
}
