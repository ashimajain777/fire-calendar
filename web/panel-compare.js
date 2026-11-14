// Compare tab: side A is the main selection (from fc:results), side B is another bounding box or another
// span of months for the same area. Both calendars share one colour scale; the pure helpers are unit-tested.

import { renderCalendar } from './calendar.js';
import { cellsFromBBox, cellsToRanges, cellCenter } from './cells.js';
import { rankings } from './stats.js';
import * as q from './queries.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIT = { harm_n: 'hotspots', harm_fd: 'fire-days' };

// ---------- pure ----------

export const periodTotal = (rows) => rows.reduce((t, r) => t + r.value, 0);

export function monthOfYearTotals(rows) {
  const out = new Array(12).fill(0);
  for (const r of rows) out[r.month - 1] += r.value;
  return out;
}

// All non-zero monthly values of both sides; passed to both calendars as scaleValues.
// shortcut: months with an unfilled data gap are included here (each calendar alone leaves them out); fine while gaps are rare.
export const sharedScale = (rowsA, rowsB) => [...rowsA, ...rowsB].map((r) => r.value).filter((v) => v > 0);

// Rows of the difference table: {label, a, b, aNote, bNote, diff, pct}. pct is null when A is 0.
export function diffRows(calA, calB) {
  const row = (label, a, b, aNote = null, bNote = null) => ({ label, a, b, aNote, bNote, diff: b - a, pct: a ? ((b - a) / a) * 100 : null });
  const [ra, rb] = [rankings(calA, 1), rankings(calB, 1)];
  const [ma, mb] = [ra.months[0], rb.months[0]];
  const [ya, yb] = [ra.years[0], rb.years[0]];
  const [moA, moB] = [monthOfYearTotals(calA), monthOfYearTotals(calB)];
  return [
    row('Total for the period', periodTotal(calA), periodTotal(calB)),
    row('Busiest month', ma ? ma.value : 0, mb ? mb.value : 0, ma ? `${MONTHS[ma.month - 1]} ${ma.year}` : 'none', mb ? `${MONTHS[mb.month - 1]} ${mb.year}` : 'none'),
    row('Busiest year', ya ? ya.value : 0, yb ? yb.value : 0, ya ? String(ya.year) : 'none', yb ? String(yb.year) : 'none'),
    ...MONTHS.map((m, i) => row(`${m} total`, moA[i], moB[i])),
  ];
}

// Same checks and messages as the main bounding-box form. Returns {values} or {message, field (0..3)}.
export function checkBBox(raw, b) {
  const specs = [['West', b.w, b.e], ['South', b.s, b.n], ['East', b.w, b.e], ['North', b.s, b.n]];
  const values = raw.map((x) => (String(x).trim() === '' ? NaN : Number(x)));
  for (const [i, [name, lo, hi]] of specs.entries()) {
    const v = values[i];
    if (!Number.isFinite(v)) return { field: i, message: `${name} is missing. Enter a number between ${lo} and ${hi}.` };
    if (v < lo || v > hi) return { field: i, message: `${name} must be between ${lo} and ${hi} for India coverage` };
  }
  if (values[0] >= values[2]) return { field: 2, message: 'East must be greater than West.' };
  if (values[1] >= values[3]) return { field: 3, message: 'North must be greater than South.' };
  return { values };
}

export function checkSpan(from, to, first, last) {
  const ok = /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) && from >= first && to <= last && from <= to;
  return ok ? null : `Choose months between ${first} and ${last}, with From not after To.`;
}

// Key that pairs a cell with "the same month" on the other side: by year (same dates) or by year offset (other span).
export const syncKey = (rowHead, col, firstYear) => (rowHead === 'Typical' ? `T-${col}` : `${firstYear === null ? rowHead : Number(rowHead) - firstYear}-${col}`);

const fmt = (v) => (v < 10 && !Number.isInteger(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.round(v).toLocaleString('en-US'));
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const pctText = (p) => (p === null ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`);

// ---------- DOM ----------

const ui = { ctx: null, seq: 0, coverage: null, bounds: null, b: null, built: false };
const errorText = (e) => (e && e.message ? e.message : String(e));

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}
const $ = (id) => document.getElementById(id);
const notice = (text, error) => h('p', { class: `notice${error ? ' notice--error' : ''}`, role: error ? 'alert' : null }, text);
const cellsText = (n) => `${n} ${n === 1 ? 'cell' : 'cells'}`;

function styles() {
  document.head.append(h('style', { id: 'fc-compare-styles' }, `
.cmp-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 0 0 12px; }
.cmp-form fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.cmp-form fieldset[hidden] { display: none; }
.cmp-form .field input { width: 9em; }
.cmp-sides { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--gutter); }
.cmp-sides > section { min-width: 0; }
.cmp-sides h3 { margin: 0 0 8px; font-size: 16px; }
.cmp-sides .legend { display: none; } /* one shared legend below both calendars */
.cmp-legend .legend { display: flex; margin: 8px 0 16px; }
.cal-cell.cmp-sync { outline: 3px solid var(--ink); outline-offset: -3px; }
@media (max-width: 899.98px) { .cmp-sides { grid-template-columns: minmax(0, 1fr); } }
`));
}

function build(panel) {
  styles();
  const input = (id, label, type = 'number') => h('label', { class: 'field' }, label, h('input', { id, type, step: type === 'number' ? 'any' : null, inputmode: type === 'number' ? 'decimal' : null, 'aria-describedby': 'cmp-error' }));
  const radio = (value, label, checked) => {
    const r = h('input', { type: 'radio', name: 'cmp-mode', value });
    r.checked = checked;
    return h('label', null, r, ` ${label}`);
  };
  const form = h('form', { class: 'cmp-form', id: 'cmp-form', novalidate: '', 'aria-label': 'Side B of the comparison' },
    h('fieldset', null, h('legend', { class: 'visually-hidden' }, 'Compare with'), radio('area', 'Another area (same dates)', true), radio('span', 'Same area, other months', false)),
    h('fieldset', { id: 'cmp-area' }, h('legend', { class: 'visually-hidden' }, 'Side B bounding box'),
      input('cmp-w', 'West (longitude)'), input('cmp-s', 'South (latitude)'), input('cmp-e', 'East (longitude)'), input('cmp-n', 'North (latitude)')),
    h('fieldset', { id: 'cmp-span', hidden: '' }, h('legend', { class: 'visually-hidden' }, 'Side B months'),
      input('cmp-from', 'From month', 'month'), input('cmp-to', 'To month', 'month')),
    h('button', { type: 'submit', class: 'btn btn--primary' }, 'Compare'));
  panel.replaceChildren(
    h('p', { class: 'hint' }, 'Side A is the selection above. Choose side B; the same categories and measure apply to both.'),
    form,
    h('p', { class: 'notice notice--error', id: 'cmp-error', role: 'alert', hidden: '' }),
    h('p', { class: 'visually-hidden', id: 'cmp-live', 'aria-live': 'polite' }),
    h('div', { id: 'cmp-out' }));
  const mode = () => form.querySelector('input[name="cmp-mode"]:checked').value;
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'cmp-mode') return;
    $('cmp-area').hidden = mode() !== 'area';
    $('cmp-span').hidden = mode() !== 'span';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('cmp-error');
    const show = (message, el) => { err.textContent = message || ''; err.hidden = !message; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };
    for (const el of form.querySelectorAll('input')) el.removeAttribute('aria-invalid');
    if (!ui.ctx) return show('Choose an area above first.');
    if (mode() === 'area') {
      if (!ui.bounds) return show('The data coverage is still loading.');
      const ids = ['cmp-w', 'cmp-s', 'cmp-e', 'cmp-n'];
      const r = checkBBox(ids.map((id) => $(id).value), ui.bounds);
      if (r.message) return show(r.message, $(ids[r.field]));
      ui.b = { kind: 'area', bbox: r.values };
    } else {
      const [first, last] = [ui.ctx.meta.coverage_start.slice(0, 7), ui.ctx.meta.coverage_end.slice(0, 7)];
      const message = checkSpan($('cmp-from').value, $('cmp-to').value, first, last);
      if (message) return show(message, $('cmp-from'));
      ui.b = { kind: 'span', range: { from: $('cmp-from').value, to: $('cmp-to').value } };
    }
    show(null);
    return runB();
  });
  ui.built = true;
}

async function loadCoverage(ctx) {
  if (ui.coverage) return;
  ui.coverage = await q.coverage(ctx.db);
  let [s, n, w, e] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const id of ui.coverage) {
    const [lat, lon] = cellCenter(id);
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  ui.bounds = { s: Math.floor(s), n: Math.ceil(n), w: Math.floor(w), e: Math.ceil(e) };
}

async function runB() {
  const ctx = ui.ctx;
  const my = ++ui.seq;
  const out = $('cmp-out');
  if (!ctx || !ui.b) return;
  out.setAttribute('aria-busy', 'true');
  out.replaceChildren(notice('Loading side B…'));
  try {
    await loadCoverage(ctx);
    let area = ctx.area;
    let range = ctx.range;
    let label;
    if (ui.b.kind === 'area') {
      const [w, s, e, n] = ui.b.bbox;
      const cells = cellsFromBBox(w, s, e, n, ui.coverage);
      if (!cells.ids.length) throw new Error('No data coverage in side B yet (India only for now)');
      area = { ...cells, ranges: cellsToRanges(cells.ids), geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
      label = `B: box W ${w}, S ${s}, E ${e}, N ${n}, ${cellsText(cells.ids.length)} · ${range.from} to ${range.to}`;
    } else {
      range = ui.b.range;
      label = `B: same area · ${range.from} to ${range.to}`;
    }
    const { calendars } = await q.overview(ctx.db, area, range, ctx.cats, ctx.metric);
    if (my !== ui.seq) return;
    show(ctx, calendars[ctx.metric], label);
  } catch (e) {
    if (my !== ui.seq) return;
    out.replaceChildren(notice(`Couldn't load side B. ${errorText(e)}`, true));
    $('cmp-live').textContent = `Comparison failed: ${errorText(e)}`;
  } finally {
    if (my === ui.seq) out.removeAttribute('aria-busy');
  }
}

function show(ctx, rowsB, labelB) {
  const rowsA = ctx.calendarRows;
  const scaleValues = sharedScale(rowsA, rowsB);
  const span = ui.b.kind === 'span';
  const opts = { mode: 'counts', metric: ctx.metric, baseYears: ctx.baseYears, gaps: ctx.gaps, scaleValues,
    currentYM: { year: ctx.lastDataDate.getUTCFullYear(), month: ctx.lastDataDate.getUTCMonth() + 1 } };
  const side = (key, title, rows) => {
    const cal = h('div', { id: `cmp-cal-${key}`, 'data-first-year': rows.length ? Math.min(...rows.map((r) => r.year)) : '' });
    const sec = h('section', { 'aria-labelledby': `cmp-title-${key}` }, h('h3', { id: `cmp-title-${key}` }, title), cal,
      h('p', { class: 'visually-hidden', id: `cmp-other-${key}` }));
    return [sec, cal];
  };
  const [secA, calA] = side('a', `A: main selection, ${cellsText(ctx.area.ids.length)} · ${ctx.range.from} to ${ctx.range.to}`, rowsA);
  const [secB, calB] = side('b', labelB, rowsB);
  const unit = UNIT[ctx.metric];
  const legendHost = h('div', { class: 'cmp-legend' });
  const table = h('table', { class: 'data-table' },
    h('caption', { class: 'visually-hidden' }, `Side B against side A, ${unit}`),
    h('thead', null, h('tr', null, ...['', 'A', 'B', 'B − A', '(B − A) / A'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
    h('tbody', null, ...diffRows(rowsA, rowsB).map((r) => h('tr', null,
      h('th', { scope: 'row' }, r.label),
      h('td', { class: 'num' }, r.aNote ? `${r.aNote}: ${fmt(r.a)}` : fmt(r.a)),
      h('td', { class: 'num' }, r.bNote ? `${r.bNote}: ${fmt(r.b)}` : fmt(r.b)),
      h('td', { class: 'num' }, signed(r.diff)),
      h('td', { class: 'num' }, pctText(r.pct))))));
  $('cmp-out').replaceChildren(h('div', { class: 'cmp-sides' }, secA, secB), legendHost,
    h('h3', null, `Difference (${unit})`), h('div', { class: 'table-scroll' }, table));
  renderCalendar(calA, rowsA, opts);
  renderCalendar(calB, rowsB, opts);
  // the shared legend: both calendars carry the same one (hidden); show A's once
  const legend = calA.querySelector('.legend');
  if (legend) legendHost.append(legend.cloneNode(true));
  sync(calA, calB, span, 'B', 'cmp-other-a');
  sync(calB, calA, span, 'A', 'cmp-other-b');
  const total = (rows) => fmt(periodTotal(rows));
  $('cmp-live').textContent = `Comparison updated: A ${total(rowsA)}, B ${total(rowsB)} ${unit}`;
}

// Hover or focus a month in `from` highlights the same month in `to`, and describes it to screen readers.
function sync(from, to, span, otherName, descId) {
  const first = (el) => (span ? Number(el.dataset.firstYear) : null);
  const keyOf = (el, td) => syncKey(td.parentElement.querySelector('th').textContent, td.dataset.c, first(el));
  const desc = $(descId);
  const index = () => new Map([...to.querySelectorAll('td.cal-cell')].map((td) => [keyOf(to, td), td]));
  let map = null;
  for (const td of from.querySelectorAll('td.cal-cell')) td.setAttribute('aria-describedby', [td.getAttribute('aria-describedby'), desc.id].filter(Boolean).join(' '));
  const on = (e) => {
    const td = e.target.closest && e.target.closest('td.cal-cell');
    if (!td) return;
    map = map || index();
    for (const old of to.querySelectorAll('.cmp-sync')) old.classList.remove('cmp-sync');
    const other = map.get(keyOf(from, td));
    if (other) other.classList.add('cmp-sync');
    desc.textContent = `Side ${otherName}: ${other ? other.getAttribute('aria-label') : 'no matching month'}`;
  };
  const off = () => { for (const old of to.querySelectorAll('.cmp-sync')) old.classList.remove('cmp-sync'); };
  from.addEventListener('mouseover', on);
  from.addEventListener('focusin', on);
  from.addEventListener('mouseleave', off);
  from.addEventListener('focusout', off);
}

function onResults(ctx) {
  const panel = $('panel-compare');
  if (!panel) return;
  if (!ui.built) build(panel);
  ui.ctx = ctx;
  if (!$('cmp-from').value) { $('cmp-from').value = ctx.range.from; $('cmp-to').value = ctx.range.to; }
  for (const id of ['cmp-from', 'cmp-to']) { $(id).min = ctx.meta.coverage_start.slice(0, 7); $(id).max = ctx.meta.coverage_end.slice(0, 7); }
  if (ui.b) runB();
  else $('cmp-out').replaceChildren(notice(`Side A: ${ctx.range.from} to ${ctx.range.to}, ${ctx.area.ids.length} cells. Choose side B and press Compare.`));
  loadCoverage(ctx).catch((e) => { $('cmp-out').replaceChildren(notice(`Couldn't load the data coverage. ${errorText(e)}`, true)); });
}

if (typeof document !== 'undefined') {
  document.addEventListener('fc:results', (e) => onResults(e.detail));
  document.addEventListener('fc:error', (e) => {
    ui.ctx = null;
    ++ui.seq;
    const out = $('cmp-out');
    if (out) out.replaceChildren(notice(`Side A has no results: ${e.detail.message}`, true));
  });
  const ctx = window.fireCalendar && window.fireCalendar.getContext();
  if (ctx) onResults(ctx);
}
