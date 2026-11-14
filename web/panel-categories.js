// Categories tab: one small calendar per fire category, a summary table, and the static-mask map layer.
// See docs/PLAN.md sections 5.5 and 9 F4. Pure helpers are exported and unit-tested; DOM code runs only in a browser.

import { CATEGORY_NAMES, categoryCalendars, maskCells } from './queries.js';
import { renderCalendar } from './calendar.js';
import { showMask } from './map.js';

// The four landscape categories, then Industrial / static, Urban, Volcanic, Offshore.
export const CATEGORY_ORDER = [0, 1, 2, 3, 5, 4, 6, 7];
const NOT_HARMONIZED = [6, 7]; // weight 0 (docs/CONTRACTS.md section 2)
const MASK_LIMIT = 5000;
const UNIT = { harm_n: 'hotspots', harm_fd: 'fire-days' };
const REASONS = { firms_static: 'flagged static by FIRMS', persistent: 'persistent hotspot', volcano: 'volcano' };

// rowsByCat: Map<category, [{value, raw}]> from queries.categoryCalendars.
// share is each category's part of all raw detections, the one count every category has.
export function categorySummary(rowsByCat) {
  const sums = CATEGORY_ORDER.map((category) => {
    const rows = rowsByCat.get(category) || [];
    return { category, value: rows.reduce((t, r) => t + r.value, 0), raw: rows.reduce((t, r) => t + r.raw, 0) };
  });
  const raw = sums.reduce((t, s) => t + s.raw, 0);
  return {
    total: sums.reduce((t, s) => t + s.value, 0),
    raw,
    rows: sums.map((s) => {
      const harmonized = !NOT_HARMONIZED.includes(s.category);
      return {
        category: s.category, name: CATEGORY_NAMES[s.category], harmonized,
        total: harmonized ? s.value : null, raw: s.raw, share: raw > 0 ? s.raw / raw : 0,
        any: s.value > 0 || s.raw > 0,
      };
    }),
  };
}

// Calendar input for one category: non-harmonized categories show their raw detection counts.
export function calendarRowsFor(category, rows) {
  return NOT_HARMONIZED.includes(category) ? rows.map((r) => ({ year: r.year, month: r.month, value: r.raw })) : rows;
}

// cells: [{r, c, reason, n_days_max}] with r, c the 0.01 degree row and column (docs/CONTRACTS.md section 3).
export function maskFeatures(cells) {
  return {
    type: 'FeatureCollection',
    features: cells.map(({ r, c, reason, n_days_max }) => {
      const [s, w, n, e] = [r / 100 - 90, c / 100 - 180, (r + 1) / 100 - 90, (c + 1) / 100 - 180];
      return {
        type: 'Feature', properties: { reason, n_days_max },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      };
    }),
  };
}

const fmt = (v) => (v < 10 && !Number.isInteger(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  : Math.round(v).toLocaleString('en-US'));
export const sharePct = (share) => (share > 0 && share < 0.001 ? '< 0.1 %' : `${(share * 100).toFixed(1)} %`);

// ---------- DOM ----------

const CSS = `
.cat-check { display: inline-flex; align-items: center; gap: 10px; min-height: var(--control-h); cursor: pointer; }
.cat-stack { display: flex; flex-direction: column; gap: 12px; }
.cat-scroll { overflow-x: auto; }
.cat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: var(--gutter); }
.cat-grid > section { min-width: 0; }
.cat-grid h3 { margin-bottom: 2px; }
.cat-cal.calendar { padding: 8px 0 0; }
.cat-cal .cal-table { min-width: 470px; font-size: 12px; }
.cat-cal .cal-table th:first-child { width: 44px; }
.cat-cal .cal-cell { min-width: 0; height: 22px; font-size: 11px; cursor: default; }
`;

function start() {
  const panel = document.getElementById('panel-categories');
  if (!panel) return;
  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };
  document.head.append(h('style', null, CSS));

  const box = h('input', { type: 'checkbox', id: 'cat-mask' });
  const maskStatus = h('p', { class: 'hint', role: 'status' });
  const body = h('div', { class: 'cat-stack' });
  panel.replaceChildren(h('div', { class: 'cat-stack' },
    h('p', null, h('strong', null, 'Industrial / static'), ' means persistent hotspots that are not landscape fires, such as coal fires, gas flares, kilns and industrial plants. '
      + 'They are kept and can be exported, but they are left out of the default view. Tick the category in the panel to include them.'),
    h('div', null, h('label', { class: 'cat-check' }, box, 'Show persistent-source cells on the map'), maskStatus),
    body));

  let ctx = null;   // latest results
  let shown = null; // the ctx the calendars were drawn for
  let seq = 0;
  let maskSeq = 0;

  function render(c, byCat) {
    const s = categorySummary(byCat);
    const unit = UNIT[c.metric];
    const num = (v) => h('td', { class: 'num' }, v);
    const table = h('table', { class: 'data-table' },
      h('caption', { class: 'visually-hidden' }, `Detections by category, ${c.range.from} to ${c.range.to}`),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col', class: 'num' }, `Harmonized ${unit}`),
        h('th', { scope: 'col', class: 'num' }, 'Raw detections'), h('th', { scope: 'col', class: 'num' }, 'Share of raw detections'))),
      h('tbody', null, ...s.rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r.name),
        num(r.harmonized ? fmt(r.total) : 'not harmonized'), num(fmt(r.raw)), num(sharePct(r.share))))),
      h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, 'All categories'), num(fmt(s.total)), num(fmt(s.raw)), num(s.raw > 0 ? '100 %' : '—'))));
    const any = s.rows.filter((r) => r.any);
    const grid = h('div', { class: 'cat-grid' }, ...any.map((r) => {
      const cal = h('div', { class: 'cat-cal' });
      renderCalendar(cal, calendarRowsFor(r.category, byCat.get(r.category)), { mode: 'counts', metric: c.metric, baseYears: c.baseYears, gaps: c.gaps });
      const total = r.harmonized ? `${fmt(r.total)} ${unit}` : `${fmt(r.raw)} raw detections, not harmonized`;
      return h('section', { 'aria-label': r.name }, h('h3', null, r.name),
        h('p', { class: 'hint' }, `${total} · ${sharePct(r.share)} of all raw detections`), cal);
    }));
    body.replaceChildren(
      h('div', { class: 'cat-scroll' }, table),
      h('p', { class: 'hint' }, 'Raw detections count every satellite, before harmonization, without low-confidence detections. '
        + 'Volcanic and Offshore are not harmonized, so they show raw detections. Each calendar below has its own colour scale.'),
      any.length ? grid : h('p', { class: 'notice' }, 'No hotspots detected in this area for the selected period'));
  }

  async function load() {
    const c = ctx;
    const my = ++seq;
    shown = c;
    body.replaceChildren(h('p', { class: 'notice', role: 'status' }, 'Loading categories…'));
    try {
      const byCat = await categoryCalendars(c.db, c.area, c.range, c.metric);
      if (my === seq) render(c, byCat);
    } catch (e) {
      if (my === seq) body.replaceChildren(h('p', { class: 'notice notice--error', role: 'alert' }, `Couldn't load the categories. ${e && e.message ? e.message : e}`));
    }
  }

  async function mask() {
    const my = ++maskSeq;
    try {
      if (!box.checked || !ctx) {
        maskStatus.textContent = box.checked ? 'Choose an area first.' : '';
        await showMask(null);
        return;
      }
      maskStatus.textContent = 'Loading persistent-source cells…';
      const { cells, total } = await maskCells(ctx.db, ctx.area, MASK_LIMIT);
      if (my !== maskSeq) return;
      await showMask(maskFeatures(cells));
      const kinds = Object.entries(cells.reduce((t, x) => ({ ...t, [x.reason]: (t[x.reason] || 0) + 1 }), {}))
        .map(([reason, n]) => `${fmt(n)} ${REASONS[reason] || reason}`).join(', ');
      maskStatus.textContent = !total ? "No persistent-source cells in this area's bounding box."
        : `${total > cells.length ? `Showing the ${fmt(cells.length)} most persistent of ${fmt(total)}` : `Showing ${fmt(total)}`} persistent-source ${total === 1 ? 'cell' : 'cells'} `
          + `in this area's bounding box as orange squares about 1 km across (${kinds}).`;
    } catch (e) {
      if (my === maskSeq) maskStatus.textContent = `Couldn't load the persistent-source cells. ${e && e.message ? e.message : e}`;
    }
  }

  const open = () => !panel.hidden;
  document.addEventListener('fc:results', (e) => {
    const areaChanged = !ctx || ctx.area !== e.detail.area;
    ctx = e.detail;
    if (open()) load();
    if (box.checked && areaChanged) mask();
  });
  document.addEventListener('fc:error', () => {
    ctx = null;
    shown = null;
    seq++;
    body.replaceChildren();
    if (box.checked) mask();
  });
  // app.js shows a tab by clearing `hidden` on its panel (click or arrow keys).
  new MutationObserver(() => { if (open() && ctx && shown !== ctx) load(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  box.addEventListener('change', mask);
}

if (typeof document !== 'undefined') start();
