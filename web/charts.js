// Annual charts, anomaly bars, table toggles and image export. See docs/CONTRACTS.md section 6, docs/PLAN.md section 8.3.
// The first half is pure (unit-tested under node); Observable Plot is imported on first use so this module loads without a browser.

import { median, percentileRank, zScore, anomalyPct, anomalyBin } from './stats.js';

const PLOT_ESM = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm'; // same build as methodology.js
export const UNIT = { harm_n: 'hotspots', harm_fd: 'fire-days' };
export const SENSORS = [
  { key: 'n_terra', label: 'Terra', colour: 'var(--series-1)', chain: null },
  { key: 'n_aqua', label: 'Aqua', colour: 'var(--series-2)', chain: 'aqua_start' },
  { key: 'n_snpp', label: 'S-NPP', colour: 'var(--series-3)', chain: 'snpp_start' },
  { key: 'n_noaa20', label: 'NOAA-20', colour: 'var(--series-4)', chain: 'noaa20_start' },
];
export const ANOMALY_LABELS = ['≤ 10th', '10–25th', '25–40th', '40–60th (typical)', '60–75th', '75–90th', '≥ 90th'];

// ---------- pure ----------

export const fmt = (v) => (v < 10 && !Number.isInteger(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  : Math.round(v).toLocaleString('en-US'));
const signed = (v, digits) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
export const fmtPct = (v) => (v === null ? '—' : `${signed(v, Math.abs(v) < 9.95 ? 1 : 0)}%`);
export const fmtZ = (v) => (v === null ? '—' : signed(v, 1));
export const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
};

// Calendar rows [{year, month, value, lo, hi}] -> one row per year.
// complete: all 12 months are in the rows and the data reaches 31 Dec of that year.
// nodata: the year has an unfilled gap dekad (same rule as calendar.js), so its total is an undercount.
// band: lo/hi differ from the value (converted, pre-NOAA-20 data).
export function annualFromCalendar(rows, gaps = [], lastDataDate = null) {
  const byYear = new Map();
  for (const r of rows || []) {
    let o = byYear.get(r.year);
    if (!o) byYear.set(r.year, o = { year: r.year, value: 0, lo: 0, hi: 0, months: 0, seen: new Set() });
    o.value += r.value;
    o.lo += r.lo;
    o.hi += r.hi;
    o.seen.add(r.month);
  }
  const unfilled = gaps.filter((g) => g.filled_from == null);
  return [...byYear.values()].sort((a, b) => a.year - b.year).map(({ seen, ...o }) => {
    const eps = 1e-6 * Math.max(1, o.value);
    return {
      ...o,
      months: seen.size,
      complete: seen.size === 12 && (!lastDataDate || lastDataDate.getTime() >= Date.UTC(o.year, 11, 31)),
      nodata: unfilled.some((g) => g.year === o.year && seen.has(g.month)),
      band: Math.abs(o.lo - o.value) > eps || Math.abs(o.hi - o.value) > eps,
    };
  });
}

// Anomaly of each complete year against the median of the base years (complete, no missing-data month).
export function anomalyRows(annual, baseYears) {
  const baseRows = annual.filter((r) => r.complete && !r.nodata && baseYears.includes(r.year));
  const base = baseRows.map((r) => r.value);
  const med = median(base);
  return {
    median: med,
    baseYears: baseRows.map((r) => r.year),
    rows: annual.map((r) => {
      const percentile = r.complete ? percentileRank(r.value, base) : null;
      return {
        ...r,
        pct: r.complete ? anomalyPct(r.value, base) : null,
        percentile,
        z: r.complete ? zScore(r.value, base) : null,
        bin: percentile === null ? null : anomalyBin(percentile),
      };
    }),
  };
}

// Raw detections per satellite per year. queryRows come from queries.annual (whole calendar years), so a year the
// selected dates cut short is dropped rather than shown with a whole-year count. A 0 before launch is null (not flying).
export function sensorRows(queryRows, annual, meta) {
  const [y0, m0] = meta.coverage_start.split('-').map(Number);
  const [y1, m1] = meta.coverage_end.split('-').map(Number);
  const available = (y) => (y === y1 ? m1 : 12) - (y === y0 ? m0 : 1) + 1;
  const start = (s) => +(s.chain ? meta.chain[s.chain] : meta.coverage_start).slice(0, 4);
  const byYear = new Map(queryRows.map((r) => [r.year, r]));
  const rows = [];
  const dropped = [];
  for (const a of annual) {
    if (a.months !== available(a.year)) { dropped.push(a.year); continue; }
    const q = byYear.get(a.year) || {};
    const out = { year: a.year, complete: a.complete, months: a.months, nodata: !!a.nodata };
    for (const s of SENSORS) out[s.key] = (q[s.key] || 0) === 0 && a.year < start(s) ? null : (q[s.key] || 0);
    rows.push(out);
  }
  return { rows, dropped };
}

// Moves label positions apart so neighbours are at least minGap apart. items: [{value, ...}] -> same items + y, ascending.
export function spreadLabels(items, minGap) {
  const out = [...items].sort((a, b) => a.value - b.value).map((i) => ({ ...i, y: i.value }));
  for (let i = 1; i < out.length; i++) out[i].y = Math.max(out[i].y, out[i - 1].y + minGap);
  return out;
}

// At most maxTicks year ticks on a 1/2/5/10/... step, aligned to multiples of the step.
export function yearTicks(years, maxTicks) {
  if (!years.length) return [];
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => years.length / s <= Math.max(1, maxTicks)) || 100;
  const ticks = years.filter((y) => y % step === 0);
  return ticks.length ? ticks : [years[0]];
}

const round = (v, d) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
export const ANNUAL_CSV_COLUMNS = ['year', 'value', 'lo', 'hi', 'anomaly_pct', 'percentile', 'z_score', 'complete'];
export function annualCSVRows(annual, baseYears) {
  return anomalyRows(annual, baseYears).rows.map((r) => ({
    year: r.year, value: round(r.value, 3), lo: round(r.lo, 3), hi: round(r.hi, 3),
    anomaly_pct: round(r.pct, 1), percentile: round(r.percentile, 1), z_score: round(r.z, 2), complete: r.complete,
  }));
}

export function notesFor(r) {
  return [
    r.complete ? null : `Incomplete year: ${r.months} of 12 months`,
    r.nodata ? 'Includes a month with no satellite data, so the total is too low' : null,
  ].filter(Boolean);
}

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The calendar as a standalone SVG string. model: calendarModel() output; css(name) -> the value of a CSS custom property.
export function calendarSVG(model, css, title = '') {
  const ramp = model.mode === 'anomaly' ? '--div-' : '--seq-';
  const [W, H, LEFT, TOP, PAD] = [56, 26, 64, title ? 56 : 28, 12];
  const rows = [...model.years.map((y) => [String(y.year), y.cells]), ['Typical', model.typical]];
  const width = LEFT + 12 * W + PAD * 2;
  const height = TOP + rows.length * H + PAD * 2 + 8;
  const ink = css('--ink');
  const text = (x, y, s, fill, anchor = 'middle', weight = 400) => `<text x="${x}" y="${y}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${xml(s)}</text>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${xml(css('font-family') || 'sans-serif')}" font-size="12">`,
    `<rect width="${width}" height="${height}" fill="${css('--surface-1')}"/>`,
  ];
  if (title) parts.push(text(PAD, PAD + 14, title, ink, 'start', 700));
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].forEach((m, i) => {
    parts.push(text(PAD + LEFT + i * W + W / 2, PAD + TOP - 8, m, css('--ink-2'), 'middle', 600));
  });
  rows.forEach(([label, cells], r) => {
    const y = PAD + TOP + r * H + (r === rows.length - 1 ? 8 : 0); // gap above the Typical row
    parts.push(text(PAD + LEFT - 8, y + H / 2 + 4, label, css('--ink-2'), 'end', 600));
    cells.forEach((c, i) => {
      if (c.state === 'empty') return;
      const x = PAD + LEFT + i * W;
      const fill = c.state === 'nodata' ? css('--hatch') : c.step ? css(`${ramp}${c.step}`) : css('--surface-1');
      parts.push(`<rect x="${x + 1}" y="${y + 1}" width="${W - 2}" height="${H - 2}" rx="3" fill="${fill}" stroke="${css('--line')}" stroke-width="${c.step ? 0 : 1}"/>`);
      parts.push(text(x + W / 2, y + H / 2 + 4, c.text, c.step ? css(`${ramp}${c.step}-ink`) : ink));
    });
  });
  parts.push('</svg>');
  return parts.join('');
}

// ---------- DOM (browser only) ----------

const h = (tag, attrs, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  node.append(...kids.filter((k) => k !== null && k !== undefined));
  return node;
};
export { h };

// Series colours and the few classes charts need. styles.css has no series tokens, so they are added here once
// (same values as methodology.html, PLAN 8.3 categorical slots 1-4).
export function ensureStyles() {
  if (document.getElementById('fc-chart-styles')) return;
  const dark = '--series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;';
  document.head.append(h('style', { id: 'fc-chart-styles' }, `
:root { --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }
:root[data-theme="dark"] { ${dark} }
.chart { min-width: 0; color: var(--ink); }
.chart svg { display: block; max-width: 100%; height: auto; }
.chart-block { margin: 0 0 24px; }
.chart-block h3 { margin: 0 0 8px; font-size: 16px; color: var(--ink); }
.chart-block p { margin: 8px 0; max-width: 75ch; }
.table-scroll { overflow-x: auto; margin-top: 8px; }
.legend-line { flex: none; width: 22px; height: 0; border-top: 3px solid; }
.legend-band { flex: none; width: 22px; height: 12px; background: var(--ink); opacity: 0.18; }
.legend-dot { flex: none; box-sizing: border-box; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--ink); background: var(--ink); }
.legend-dot--hollow { background: var(--surface-1); }
.chart-offscreen { position: absolute; left: -10000px; top: 0; width: 800px; }
`));
}

let plotP = null;
export function loadPlot() {
  plotP = plotP || import(PLOT_ESM).catch((e) => {
    plotP = null;
    throw new Error(`Couldn't load the chart library: ${e.message}. The table still has every value.`);
  });
  return plotP;
}

// Observable Plot puts aria-label on <g> mark groups without a role, which ARIA forbids. Keep the label on the
// root <svg> (as role="img"), drop it from inner groups; the table view carries every value for screen readers.
export function plotA11y(node) {
  if (!node || !node.querySelectorAll) return node;
  const svgs = node.tagName && node.tagName.toLowerCase() === 'svg' ? [node] : [...node.querySelectorAll('svg')];
  for (const svg of svgs) {
    if (svg.getAttribute('aria-label')) svg.setAttribute('role', 'img');
    svg.querySelectorAll('[aria-label]:not([role])').forEach((el) => { if (el !== svg) el.removeAttribute('aria-label'); });
  }
  return node;
}

// Draws when the container has a width and redraws (debounced) when that width changes. Returns a stop function.
export function responsive(el, draw) {
  let width = 0;
  let timer = null;
  const run = () => {
    if (!el.clientWidth) return; // hidden tab: the observer fires again when it is shown
    const w = Math.max(300, Math.min(940, el.clientWidth));
    if (w === width) return;
    width = w;
    el.replaceChildren(plotA11y(draw(w)));
  };
  const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(run, width ? 150 : 0); });
  ro.observe(el);
  timer = setTimeout(run, 0); // first draw does not wait for a rendered frame (a background tab has none)
  return () => { ro.disconnect(); clearTimeout(timer); };
}

const baseStyle = { fontFamily: 'inherit', fontSize: '13px', color: 'var(--ink)', background: 'transparent', overflow: 'visible' };
const tipOpts = { fill: 'var(--surface-1)', stroke: 'var(--line)' };
// Line through complete years, filled markers on them, hollow markers on incomplete years (not joined to the line).
function seriesMarks(Plot, rows, y, colour, strokeWidth = 2) {
  const ok = rows.filter((d) => d[y] !== null && d[y] !== undefined);
  return [
    Plot.lineY(ok.filter((d) => d.complete), { x: 'year', y, stroke: colour, strokeWidth }),
    Plot.dot(ok.filter((d) => d.complete), { x: 'year', y, fill: colour, r: 3 }),
    Plot.dot(ok.filter((d) => !d.complete), { x: 'year', y, fill: 'var(--surface-1)', stroke: colour, strokeWidth: 1.5, r: 4 }),
  ];
}
const xYears = (rows, width, margins) => ({
  label: null, tickFormat: 'd',
  ticks: yearTicks(rows.map((d) => d.year), Math.floor((width - margins) / 44)),
  domain: rows.length === 1 ? [rows[0].year - 1, rows[0].year + 1] : undefined,
});

export function plotAnnual(Plot, rows, width, { metric = 'harm_n' } = {}) {
  const unit = UNIT[metric];
  const narrow = width < 560;
  const marginRight = narrow ? 84 : 100;
  const last = rows[rows.length - 1];
  const tip = (d) => [String(d.year), `Harmonized ${unit}: ${fmt(d.value)}`,
    d.band ? `Range ${fmt(d.lo)}–${fmt(d.hi)}` : 'No range: observed by NOAA-20', ...notesFor(d)].join('\n');
  return Plot.plot({
    width, height: narrow ? 300 : 360, marginRight, marginLeft: 48,
    style: baseStyle,
    ariaLabel: `Harmonized ${unit} per year`,
    x: xYears(rows, width, marginRight + 48),
    y: { grid: true, zero: true, label: `Harmonized ${unit} per year`, tickFormat: '~s' },
    marks: [
      Plot.ruleY([0], { stroke: 'var(--line)' }),
      Plot.areaY(rows.filter((d) => d.complete), { x: 'year', y1: (d) => (d.band ? d.lo : d.value), y2: (d) => (d.band ? d.hi : d.value), fill: 'var(--ink)', fillOpacity: 0.18 }),
      ...seriesMarks(Plot, rows, 'value', 'var(--ink)', 2.5),
      Plot.text(last ? [last] : [], { x: 'year', y: 'value', text: () => 'Harmonized', textAnchor: 'start', dx: 10, fill: 'var(--ink)' }),
      Plot.ruleX(rows, Plot.pointerX({ x: 'year', stroke: 'var(--ink-2)' })),
      Plot.tip(rows, Plot.pointerX({ x: 'year', y: 'value', title: tip, ...tipOpts })),
    ],
  });
}

export function plotSensors(Plot, rows, width) {
  const narrow = width < 560;
  const height = narrow ? 240 : 260;
  const marginRight = 84;
  const max = Math.max(1, ...rows.flatMap((d) => SENSORS.map((s) => d[s.key] || 0)));
  const last = rows[rows.length - 1];
  const labels = last ? spreadLabels(SENSORS.filter((s) => last[s.key] !== null).map((s) => ({ value: last[s.key], text: s.label })), (max * 15) / (height - 50)) : [];
  const tip = (d) => [String(d.year), ...SENSORS.map((s) => `${s.label}: ${d[s.key] === null ? 'not flying' : fmt(d[s.key])}`), ...notesFor(d)].join('\n');
  return Plot.plot({
    width, height, marginRight, marginLeft: 48,
    style: baseStyle,
    ariaLabel: 'Raw detections per satellite per year',
    x: xYears(rows, width, marginRight + 48),
    y: { grid: true, zero: true, label: 'Raw detections per year', tickFormat: '~s' },
    marks: [
      Plot.ruleY([0], { stroke: 'var(--line)' }),
      ...SENSORS.flatMap((s) => seriesMarks(Plot, rows, s.key, s.colour)),
      Plot.text(labels, { x: () => last.year, y: 'y', text: 'text', textAnchor: 'start', dx: 10, fill: 'var(--ink)' }),
      Plot.ruleX(rows, Plot.pointerX({ x: 'year', stroke: 'var(--ink-2)' })),
      Plot.tip(rows, Plot.pointerX({ x: 'year', y: (d) => Math.max(...SENSORS.map((s) => d[s.key] || 0)), title: tip, ...tipOpts })),
    ],
  });
}

// anom: anomalyRows() output with a non-zero median.
export function plotAnomalies(Plot, anom, width, { metric = 'harm_n' } = {}) {
  const unit = UNIT[metric];
  const data = anom.rows.filter((d) => d.pct !== null);
  const years = anom.rows.map((d) => d.year);
  const domain = [];
  for (let y = years[0]; y <= years[years.length - 1]; y++) domain.push(y);
  const tip = (d) => [String(d.year), `${fmt(d.value)} ${unit}`, `Typical year (median): ${fmt(anom.median)}`,
    `${fmtPct(d.pct)} against typical`, `${ordinal(Math.round(d.percentile))} percentile`, `z-score ${fmtZ(d.z)}`, ...notesFor(d)].join('\n');
  return Plot.plot({
    width, height: width < 560 ? 300 : 340, marginLeft: 56,
    style: baseStyle,
    ariaLabel: `Difference of each year's ${unit} from the typical year, in percent`,
    x: { label: null, domain, ticks: yearTicks(domain, Math.floor((width - 76) / 44)), tickFormat: 'd', padding: 0.15 },
    y: { grid: true, label: 'Difference from the typical year', tickFormat: (v) => `${signed(v, 0)}%` },
    marks: [
      // one bar mark per colour step, so every fill is a plain CSS custom property
      ...ANOMALY_LABELS.map((_, i) => Plot.barY(data.filter((d) => d.bin === i), { x: 'year', y: 'pct', fill: `var(--div-${i + 1})`, stroke: 'var(--ink-2)', strokeWidth: 0.5 })),
      Plot.ruleY([0], { stroke: 'var(--ink)' }),
      Plot.tip(data, Plot.pointerX({ x: 'year', y: 'pct', title: tip, ...tipOpts })),
    ],
  });
}

// CONTRACTS section 6 entry points: load Plot and keep the chart fitted to el. Each returns a stop function.
const mount = async (el, draw) => { const Plot = await loadPlot(); ensureStyles(); return responsive(el, (w) => draw(Plot, w)); };
export const annualChart = (el, rows, opts) => mount(el, (Plot, w) => plotAnnual(Plot, rows, w, opts));
export const sensorChart = (el, rows) => mount(el, (Plot, w) => plotSensors(Plot, rows, w));
export const anomalyBars = (el, rows, baseYears, opts) => mount(el, (Plot, w) => plotAnomalies(Plot, anomalyRows(rows, baseYears), w, opts));

// columns: [{label, num, cell(row) -> string}]; the first column is the row header. Appends a Show/Hide button and the table to el.
export function tableToggle(el, rows, columns, caption = '') {
  const table = h('div', { class: 'table-scroll', hidden: true },
    h('table', { class: 'data-table' },
      caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
      h('thead', null, h('tr', null, ...columns.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : null }, c.label)))),
      h('tbody', null, ...rows.map((r) => h('tr', null, ...columns.map((c, i) =>
        h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: c.num ? 'num' : null }, c.cell(r))))))));
  const btn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false' }, 'Show table');
  btn.addEventListener('click', () => {
    table.hidden = !table.hidden;
    btn.setAttribute('aria-expanded', String(!table.hidden));
    btn.textContent = table.hidden ? 'Show table' : 'Hide table';
  });
  el.append(btn, table);
  return table;
}

export const cssVar = (name) => {
  const cs = getComputedStyle(document.documentElement);
  return (name.startsWith('--') ? cs.getPropertyValue(name) : getComputedStyle(document.body).getPropertyValue(name)).trim();
};

// A chart SVG that is in the page -> standalone SVG text: computed colours and fonts inlined, solid surface background.
export function svgToString(svg) {
  const clone = svg.cloneNode(true);
  const from = [svg, ...svg.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  from.forEach((node, i) => {
    const cs = getComputedStyle(node);
    for (const p of ['fill', 'stroke', 'color', 'font-family', 'font-size', 'font-weight']) {
      to[i].style.setProperty(p, cs.getPropertyValue(p));
      // var(--x) attributes mean nothing outside the page; replace them too, for editors that read attributes only
      if (/var\(/.test(to[i].getAttribute(p) || '')) to[i].setAttribute(p, cs.getPropertyValue(p));
    }
  });
  const box = svg.getBoundingClientRect();
  const width = Number(svg.getAttribute('width')) || Math.round(box.width);
  const height = Number(svg.getAttribute('height')) || Math.round(box.height);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.style.removeProperty('max-width');
  clone.style.setProperty('background', cssVar('--surface-1'));
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [k, v] of Object.entries({ width: '100%', height: '100%', fill: cssVar('--surface-1') })) bg.setAttribute(k, v);
  clone.prepend(bg);
  return new XMLSerializer().serializeToString(clone);
}

export function saveBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export async function svgTextToPNG(text, scale = 2) {
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("Couldn't draw the image for the PNG")); img.src = url; });
    const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    const g = canvas.getContext('2d');
    g.fillStyle = cssVar('--surface-1');
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error("Couldn't build the PNG");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const findSVG = (el) => {
  const svg = el.matches('svg') ? el : el.querySelector('svg');
  if (!svg) throw new Error('There is no chart to export yet');
  return svg;
};
export function exportSVG(el, name) {
  saveBlob(new Blob([svgToString(findSVG(el))], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`);
}
export async function exportPNG(el, name, scale = 2) {
  saveBlob(await svgTextToPNG(svgToString(findSVG(el)), scale), `${name}.png`);
}
