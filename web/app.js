// Page wiring: area entry, filters, queries, KPI row, calendar, month-to-date card, rankings, downloads.
// No chart code here. Other modules listen for `fc:results` on document or use window.fireCalendar.

import { cellsFromGeometry, cellsFromBBox, cellsFromPointRadius, cellsToRanges, cellCenter, outlineGeoJSON, areaKm2 } from './cells.js';
import { monthToDate, rankings, percentileRank, zScore, median } from './stats.js';
import { freshness } from './freshness.js';
import { initDB } from './db.js';
import { linkErrors, widenRows, smallAreaNote } from './uncertainty.js';
import { renderCalendar } from './calendar.js';
import * as q from './queries.js';
import * as map from './map.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIT = { harm_n: 'hotspots', harm_fd: 'fire-days' };
const CSV_CONFIRM_ROWS = 500000;

const fmt = (v) => (v < 10 && !Number.isInteger(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  : Math.round(v).toLocaleString('en-US'));
const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
};
const h = (tag, attrs, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
  node.append(...kids);
  return node;
};
const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
const errorText = (e) => (e && e.message ? e.message : String(e));

const state = {
  db: null, config: null, meta: null, summary: null, coverage: null, bounds: null, gaps: [],
  area: null, range: null, cats: [0, 1, 2, 3], metric: 'harm_n', mode: 'counts',
  ctx: null, seq: 0,
};

// ---------- status ----------

function setStatus(...notices) {
  $('status').replaceChildren(...notices.filter(Boolean).map(([text, error]) => h('p', { class: `notice${error ? ' notice--error' : ''}`, role: error ? 'alert' : null }, text)));
}

function fail(message) {
  state.ctx = null;
  $('results').hidden = true;
  setStatus([message, true]);
  emit('fc:error', { message });
}

// ---------- area ----------

function circle(lat, lon, km) {
  const dLat = km / 111.195;
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const ring = Array.from({ length: 65 }, (_, i) => {
    const a = (i % 64) * (Math.PI / 32);
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: 'Polygon', coordinates: [ring] };
}

function bboxOf(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const pts = polys.flatMap((p) => p[0]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function applyArea(cells, geometry) {
  state.area = { ...cells, ranges: cellsToRanges(cells.ids), geometry };
  const { ids } = state.area;
  $('area-summary').textContent = ids.length
    ? `Area: ${fmt(areaKm2(ids))} km² · ${fmt(ids.length)} ${ids.length === 1 ? 'cell' : 'cells'}`
    : 'Area: outside data coverage';
  map.showArea(geometry).catch(() => {});
  map.showCells(outlineGeoJSON(ids)).catch(() => {});
  map.showPoints([]).catch(() => {});
  map.fitTo(bboxOf(geometry)).catch(() => {});
  return run();
}

function setArea(input) {
  if (!state.coverage) throw new Error('The page is still loading');
  if (Array.isArray(input)) {
    const [w, s, e, n] = input;
    return applyArea(cellsFromBBox(w, s, e, n, state.coverage), { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  }
  const geometry = input.type === 'Feature' ? input.geometry : input;
  return applyArea(cellsFromGeometry(geometry, state.coverage), geometry);
}

// Reads number inputs; marks the first bad one and returns its message.
function readNumbers(specs, errorEl) {
  const values = [];
  let message = null;
  for (const [id, name, lo, hi, why] of specs) {
    const input = $(id);
    const v = input.value.trim() === '' ? NaN : Number(input.value);
    const bad = !Number.isFinite(v) || v < lo || v > hi;
    input.setAttribute('aria-invalid', String(bad));
    if (bad && !message) message = !Number.isFinite(v) ? `${name} is missing. Enter a number between ${lo} and ${hi}.` : `${name} must be between ${lo} and ${hi}${why}`;
    values.push(v);
  }
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
  if (message) $(specs.find(([id]) => $(id).getAttribute('aria-invalid') === 'true')[0]).focus();
  return message ? null : values;
}

function wireAreaForms() {
  const b = state.bounds;
  const india = ' for India coverage';
  $('point-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = readNumbers([
      ['pt-lat', 'Latitude', b.s, b.n, india], ['pt-lon', 'Longitude', b.w, b.e, india], ['pt-km', 'Radius', 0, 2000, ' km'],
    ], $('point-error'));
    if (v) applyArea(cellsFromPointRadius(v[0], v[1], v[2], state.coverage), circle(v[0], v[1], Math.max(v[2], 1)));
  });
  $('bbox-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('bbox-error');
    const v = readNumbers([
      ['bb-w', 'West', b.w, b.e, india], ['bb-s', 'South', b.s, b.n, india], ['bb-e', 'East', b.w, b.e, india], ['bb-n', 'North', b.s, b.n, india],
    ], err);
    if (!v) return;
    const order = v[0] >= v[2] ? ['bb-e', 'East must be greater than West.'] : v[1] >= v[3] ? ['bb-n', 'North must be greater than South.'] : null;
    if (order) {
      $(order[0]).setAttribute('aria-invalid', 'true');
      err.textContent = order[1];
      err.hidden = false;
      $(order[0]).focus();
      return;
    }
    setArea(v);
  });
  $('draw-polygon').addEventListener('click', () => map.drawPolygon().catch((e) => setStatus([errorText(e), true])));
  $('draw-rectangle').addEventListener('click', () => map.drawRectangle().catch((e) => setStatus([errorText(e), true])));
}

// ---------- filters ----------

function wireDates() {
  const from = $('date-from');
  const to = $('date-to');
  const first = state.meta.coverage_start.slice(0, 7);
  const last = state.meta.coverage_end.slice(0, 7);
  for (const el of [from, to]) { el.min = first; el.max = last; }
  const set = (a, b) => {
    from.value = a;
    to.value = b;
    state.range = { from: a, to: b };
    $('date-error').hidden = true;
  };
  set(first, last);
  const change = () => {
    const a = from.value;
    const b = to.value;
    const ok = /^\d{4}-\d{2}$/.test(a) && /^\d{4}-\d{2}$/.test(b) && a >= first && b <= last && a <= b;
    $('date-error').hidden = ok;
    $('date-error').textContent = ok ? '' : `Choose months between ${first} and ${last}, with From not after To.`;
    if (ok) { state.range = { from: a, to: b }; run(); }
  };
  from.addEventListener('change', change);
  to.addEventListener('change', change);
  const [ly, lm] = last.split('-').map(Number);
  const shift = (k) => { const t = ly * 12 + lm - 1 - k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
  const clamp = (m) => (m < first ? first : m);
  const fullYear = lm === 12 ? ly : ly - 1; // the last year the data covers through December
  const presets = { full: [first, last], last12: [clamp(shift(11)), last], lastyear: [clamp(`${fullYear}-01`), `${fullYear}-12`] };
  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => { set(...presets[btn.dataset.preset]); run(); });
  }
}

function renderCategoryBoxes() {
  $('categories').replaceChildren(...q.CATEGORY_NAMES.map((name, i) => {
    const box = h('input', { type: 'checkbox', value: i });
    box.checked = state.cats.includes(i);
    box.addEventListener('change', () => {
      state.cats = [...$('categories').querySelectorAll('input:checked')].map((el) => Number(el.value));
      run();
    });
    return h('label', null, box, name);
  }));
}

function setCategories(cats) {
  state.cats = [...new Set(cats)].filter((c) => Number.isInteger(c) && c >= 0 && c < q.CATEGORY_NAMES.length).sort((a, b) => a - b);
  for (const el of $('categories').querySelectorAll('input')) el.checked = state.cats.includes(Number(el.value));
}

function wireToggle(id, key, after) {
  const group = $(id);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.value === state[key]) return;
    state[key] = btn.dataset.value;
    for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    after();
  });
}

function wireTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      t.setAttribute('aria-selected', String(t === tab));
      t.tabIndex = t === tab ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = t !== tab;
    }
    if (focus) tab.focus();
  };
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(tabs[(to + tabs.length) % tabs.length], true);
    });
  }
}

// ---------- results ----------

function renderKpis(ctx, totals, sensors) {
  const top = rankings(ctx.calendarRows, 1);
  const kpi = (label, value, note) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), note ? h('div', { class: 'kpi-note' }, note) : '');
  const band = (t) => (Math.round(t.lo) !== Math.round(t.value) || Math.round(t.hi) !== Math.round(t.value) ? `Range ${fmt(t.lo)}–${fmt(t.hi)}` : null);
  const sensorLine = sensors && [['Terra', sensors.n_terra], ['Aqua', sensors.n_aqua], ['S-NPP', sensors.n_snpp], ['NOAA-20', sensors.n_noaa20], ['NOAA-21', sensors.n_noaa21]]
    .filter(([, n]) => n > 0).map(([name, n]) => `${name} ${fmt(n)}`).join(' · ');
  const m = top.months[0];
  const y = top.years[0];
  $('kpis').replaceChildren(
    kpi('Harmonized hotspots', fmt(totals.harm_n.value), band(totals.harm_n)),
    kpi('Fire-days', fmt(totals.harm_fd.value), band(totals.harm_fd)),
    kpi(`Busiest month (${UNIT[ctx.metric]})`, m ? `${MONTHS[m.month - 1]} ${m.year}` : '—', m ? fmt(m.value) : null),
    kpi(`Busiest year (${UNIT[ctx.metric]})`, y ? String(y.year) : '—', y ? fmt(y.value) : null),
    h('p', { class: 'kpi-note', style: 'grid-column: 1 / -1; margin: 0' }, `Raw detections by satellite, before harmonization: ${sensorLine || 'none'}`),
  );
}

function renderMtd(ctx) {
  const r = monthToDate(ctx.dekadRows, ctx.lastDataDate, ctx.baseYears);
  const lastDay = new Date(Date.UTC(r.year, r.month, 0)).getUTCDate();
  const end = [10, 20, lastDay][Math.max(...r.dekads) - 1];
  const days = `1–${end} ${MONTHS[r.month - 1]}`;
  const baseYears = ctx.baseYears.filter((y) => y !== r.year);
  const span = baseYears.length ? `${baseYears[0]}–${baseYears[baseYears.length - 1]}` : 'no base years';
  const unit = UNIT[ctx.metric];
  const typical = median(r.base);
  const pct = percentileRank(r.current, r.base);
  const z = zScore(r.current, r.base);
  const parts = [
    h('p', { class: 'mtd-value' }, `${days} ${r.year}: ${fmt(r.current)} ${unit}`),
    h('p', null, typical === null ? 'No base-period data for these days.' : `Typical for the same days (${span}): ${fmt(typical)}${typical === 0 ? ' (no typical activity)' : ''}.`),
  ];
  if (pct !== null) parts.push(h('p', null, `${ordinal(Math.round(pct))} percentile, z = ${z === null ? '—' : z.toFixed(1).replace('-', '−')}`));
  parts.push(h('p', { class: 'hint' }, r.mode === 'mtd' && r.dekads.length < 3
    ? `Data runs to ${ctx.meta.coverage_end}; only complete 10-day periods are compared.`
    : `Data runs to ${ctx.meta.coverage_end}; this is the latest complete month.`));
  $('mtd').replaceChildren(...parts);
}

function renderRankings(ctx) {
  const r = rankings(ctx.calendarRows, 5);
  const list = (items, label) => (items.length
    ? h('ol', null, ...items.map((i) => h('li', null, `${label(i)}: ${fmt(i.value)}`)))
    : h('p', { class: 'hint' }, 'None in this period.'));
  $('rankings').replaceChildren(
    h('h3', null, `Top months (${UNIT[ctx.metric]})`), list(r.months, (i) => `${MONTHS[i.month - 1]} ${i.year}`),
    h('h3', null, `Top years (${UNIT[ctx.metric]})`), list(r.years, (i) => String(i.year)),
  );
}

function drawCalendar() {
  const ctx = state.ctx;
  if (!ctx) return;
  renderCalendar($('calendar'), ctx.calendarRows, {
    mode: state.mode, metric: ctx.metric, baseYears: ctx.baseYears, gaps: ctx.gaps,
    currentYM: { year: ctx.lastDataDate.getUTCFullYear(), month: ctx.lastDataDate.getUTCMonth() + 1 },
    onSelect: showMonthPoints,
  });
}

async function showMonthPoints({ year, month }) {
  const ctx = state.ctx;
  if (!ctx) return;
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const name = `${MONTHS[month - 1]} ${year}`;
  const caption = $('map-caption');
  caption.textContent = `Loading hotspots for ${name}…`;
  try {
    const rows = await q.points(ctx.db, ctx.area, { from: ym, to: ym }, ctx.cats, { limit: map.MAX_POINTS + 1 });
    if (state.ctx !== ctx) return;
    await map.showPoints(rows);
    caption.textContent = rows.length > map.MAX_POINTS
      ? `Map shows the first ${fmt(map.MAX_POINTS)} hotspots detected in ${name}.`
      : `Map shows ${fmt(rows.length)} ${rows.length === 1 ? 'hotspot' : 'hotspots'} detected in ${name} (all confidence levels, selected categories).`;
  } catch (e) {
    caption.textContent = `Couldn't show hotspots for ${name} on the map. ${errorText(e)}`;
  }
}

async function run() {
  const { area, db, meta } = state;
  const my = ++state.seq;
  if (!db || !meta) return;
  $('dl-status').replaceChildren();
  if (!area) {
    $('results').hidden = true;
    setStatus(['Choose an area to see its fire history: draw it on the map, or type a point and radius or a bounding box in the panel.']);
    return;
  }
  if (!area.ids.length) {
    state.ctx = null;
    $('results').hidden = true;
    const message = 'No data coverage here yet (India only for now)';
    setStatus([message]);
    $('live').textContent = message;
    emit('fc:error', { message });
    return;
  }
  const range = { ...state.range };
  const cats = [...state.cats];
  const metric = state.metric;
  setStatus(['Loading fire history for this area…']);
  $('results').setAttribute('aria-busy', 'true');
  emit('fc:loading', { area, range, cats, metric });
  try {
    const t0 = performance.now();
    const { calendars: { harm_n: rawN, harm_fd: rawFd }, dekadRows, sensors } = await q.overview(db, area, range, cats, metric);
    if (my !== state.seq) return;
    // bands widened to the measured conversion error for an area of this size (fire-days use the hotspot errors)
    const errs = linkErrors(state.summary, area.ids.length, state.coverage.size);
    const [calN, calFd] = [widenRows(rawN, errs), widenRows(rawFd, errs)];
    const calendarRows = metric === 'harm_n' ? calN : calFd;
    const ctx = {
      db, config: state.config, meta, area, range, cats, metric, baseYears: q.baseYearsFor(meta),
      lastDataDate: new Date(meta.coverage_end), calendarRows, dekadRows, gaps: state.gaps,
      queryMs: performance.now() - t0,
    };
    state.ctx = ctx;
    const total = (rows) => rows.reduce((t, r) => ({ value: t.value + r.value, lo: t.lo + r.lo, hi: t.hi + r.hi }), { value: 0, lo: 0, hi: 0 });
    const empty = calendarRows.every((r) => r.value === 0);
    const pctOutside = Math.round(area.outsideShare * 100);
    setStatus(
      area.snappedToContaining && ['Area is smaller than one 11 km grid cell; using the cell that contains it.'],
      area.outsideShare > 0 && [`${pctOutside < 1 ? 'Less than 1' : pctOutside} % of this area is outside data coverage`],
      empty && ['No hotspots detected in this area for the selected period'],
      !empty && smallAreaNote(calendarRows, errs, area.ids.length) && [smallAreaNote(calendarRows, errs, area.ids.length)],
    );
    renderKpis(ctx, { harm_n: total(calN), harm_fd: total(calFd) }, sensors);
    drawCalendar();
    renderMtd(ctx);
    renderRankings(ctx);
    $('results').hidden = false;
    $('results').removeAttribute('aria-busy');
    const years = new Set(calendarRows.map((r) => r.year)).size;
    $('live').textContent = `Calendar updated: ${years} ${years === 1 ? 'year' : 'years'}, ${area.ids.length} ${area.ids.length === 1 ? 'cell' : 'cells'}`;
    emit('fc:results', ctx);
    const latest = [...calendarRows].reverse().find((r) => r.value > 0 || r.raw > 0 || r.lowconf > 0);
    if (latest) showMonthPoints(latest);
    else { map.showPoints([]).catch(() => {}); $('map-caption').textContent = ''; }
  } catch (e) {
    if (my !== state.seq) return;
    $('results').removeAttribute('aria-busy');
    fail(errorText(e));
  }
}

// ---------- downloads ----------

function save(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function wireDownloads() {
  const status = $('dl-status');
  const say = (text, error) => status.replaceChildren(h('p', { class: `notice${error ? ' notice--error' : ''}` }, text));
  const stem = (ctx) => `${ctx.range.from}_${ctx.range.to}`;
  const busy = async (btn, work) => {
    btn.disabled = true;
    try { await work(); } catch (e) { say(errorText(e), true); } finally { btn.disabled = false; }
  };
  const pointsCSV = async (ctx) => {
    say('Preparing the hotspots CSV…');
    const blob = await q.pointsCSV(ctx.db, ctx.area, ctx.range, ctx.cats);
    save(blob, `hotspots_${stem(ctx)}.csv`);
    say(`Hotspots CSV ready (${(blob.size / 1e6).toFixed(1)} MB).`);
  };
  $('dl-points').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const ctx = state.ctx;
    if (!ctx) return;
    say('Counting rows…');
    const n = await q.pointsCount(ctx.db, ctx.area, ctx.range, ctx.cats);
    if (n <= CSV_CONFIRM_ROWS) return pointsCSV(ctx);
    const go = h('button', { type: 'button', class: 'btn' }, `Download all ${fmt(n)} rows`);
    go.addEventListener('click', () => busy(go, () => pointsCSV(ctx)));
    status.replaceChildren(h('p', { class: 'notice' }, `This file has ${fmt(n)} rows and may take a while to build and be too large for a spreadsheet. Narrow the dates or area, or continue.`), go);
    return undefined;
  }));
  $('dl-monthly').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const ctx = state.ctx;
    if (!ctx) return;
    save(await q.aggregatesCSV(ctx.db, ctx.area, ctx.range, ctx.cats, ctx.metric), `monthly_${ctx.metric}_${stem(ctx)}.csv`);
    say('Monthly table CSV ready.');
  }));
}

// ---------- start ----------

function showFreshness(meta) {
  const f = freshness(meta, new Date());
  const badge = $('freshness');
  badge.className = `badge badge--${f.level}`;
  const sources = Object.entries((meta && meta.sources) || {})
    .map(([name, s]) => `${name}: last update ${String(s.last_success_utc).slice(0, 16).replace('T', ' ')} UTC, data to ${s.coverage_end}`);
  badge.title = sources.join('\n');
  badge.replaceChildren(f.text, h('span', { class: 'visually-hidden' }, sources.length ? `. ${sources.join('. ')}` : ''));
}

window.fireCalendar = {
  getContext: () => state.ctx,
  setArea,
  setCategories(cats) { setCategories(cats); },
  run,
};

async function start() {
  setStatus(['Loading data…']);
  wireTabs();
  wireToggle('metric-toggle', 'metric', run);
  wireToggle('mode-toggle', 'mode', drawCalendar);
  wireDownloads();
  renderCategoryBoxes();
  map.initMap($('map'), (geometry) => setArea(geometry)).catch((e) => { $('map-caption').textContent = errorText(e); });
  try {
    const res = await fetch('./config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Couldn't load config.json: HTTP ${res.status}`);
    state.config = await res.json();
    state.meta = await q.meta(state.config);
    showFreshness(state.meta);
    // the measured conversion errors; without them only the ratio bands are shown
    state.summary = await fetch(state.config.data.tables + 'validation/summary.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!state.meta) throw new Error("Couldn't load meta.json, so the data period is unknown.");
    state.config.version = state.meta.generated_utc;
    state.db = await initDB(state.config);
    [state.coverage, state.gaps] = await Promise.all([q.coverage(state.db), q.gaps(state.db)]);
    let [s, n, w, e] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const id of state.coverage) {
      const [lat, lon] = cellCenter(id);
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
    }
    state.bounds = { s: Math.floor(s), n: Math.ceil(n), w: Math.floor(w), e: Math.ceil(e) };
    wireDates();
    wireAreaForms();
    run();
  } catch (e) {
    fail(errorText(e));
  }
}

start();
