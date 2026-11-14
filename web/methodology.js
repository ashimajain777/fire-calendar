// Methodology page. Every number shown is read from data/validation/*, ratios.parquet, static_mask.parquet,
// gaps.parquet and meta.json at load time. The functions above init() are pure and unit-tested under node;
// Plot and DuckDB are imported inside init() so this module loads without a browser.

// 0.6.17 (Feb 2025): the newest release that is at least two weeks old on 14 Nov 2026.
const PLOT_ESM = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm';

export const CATEGORY_NAMES = ['Agricultural', 'Forest', 'Grass / shrub', 'Other vegetation', 'Urban', 'Industrial / static', 'Volcanic', 'Offshore'];
export const LINKS = ['terra_aqua', 'aqua_snpp', 'snpp_noaa20'];
export const LINK_LABELS = { terra_aqua: 'Terra → Aqua', aqua_snpp: 'Aqua → S-NPP', snpp_noaa20: 'S-NPP → NOAA-20' };
export const UNIT_TYPES = ['region_month', 'stratum_month', 'box1deg'];
export const UNIT_LABELS = { region_month: 'Whole-India month', stratum_month: 'Category × month', box1deg: '1° box × month' };
export const VARIANT_LABELS = { noregion: 'No region', region: 'Region (5° boxes)' };
export const SERIES = [
  { key: 'terra', label: 'Terra (raw)' },
  { key: 'aqua', label: 'Aqua (raw)' },
  { key: 'snpp', label: 'S-NPP (raw)' },
  { key: 'noaa20', label: 'NOAA-20 (raw)' },
  { key: 'naive', label: 'Naive sum' },
  { key: 'harm', label: 'Harmonized' },
];
const MASK_REASONS = { firms_static: 'FIRMS static land source', volcano: 'Volcano (FIRMS)', persistent: 'Persistent, year-round fire' };
const FALLBACK_LABELS = {
  india: 'all-India ratio for the category and month',
  stratum: "the category's all-months ratio",
  landscape: 'one ratio for all landscape categories',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const COVERAGE_MIN = 0.7; // a 10th-90th percentile band should cover about 80 %
export const COVERAGE_MAX = 0.9;
export const SMALL_AREA_FACTOR = 2; // "much larger": 1° box error at least twice the whole-India error
export const WELL_ABOVE_ONE = 1.5; // Terra → Aqua ratio that triggers the overpass-time note

// ---------- formatting ----------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const fmtInt = (x) => (isNum(x) ? Math.round(x).toLocaleString('en-GB') : '–');
export const fmtPct = (x, digits = 1) => (isNum(x) ? `${(x * 100).toFixed(digits)} %` : '–');
export function fmtSignedPct(x, digits = 1) {
  if (!isNum(x)) return '–';
  const v = Number((x * 100).toFixed(digits)); // sign of the rounded value, so there is no "−0.0"
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)} %`;
}
export const fmtTimes = (x) => (isNum(x) ? `${x.toFixed(2)}×` : '–');
export const fmtRatio = (x) => (isNum(x) ? x.toFixed(2) : '–');
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '–';
}
export const monthName = (m) => MONTHS[m - 1] ?? String(m);
export const categoryName = (code) => CATEGORY_NAMES[Number(code)] ?? `Category ${code}`;
const joinAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------- pure derivations ----------

export function approachSentences(chain, coverageStart) {
  return [
    `The satellites that detect fires have changed since ${fmtDate(coverageStart)}, and the newer VIIRS sensors report several times more hotspots than the older MODIS sensors for the same fires.`,
    'Adding the satellites together, or switching from one to the next, puts a jump in the record that did not happen on the ground.',
    `This calendar counts one satellite at a time, in a chain: Terra MODIS from ${fmtDate(coverageStart)} until Aqua's first full month (${fmtDate(chain.aqua_start)}), then Aqua MODIS until ${fmtDate(chain.snpp_start)}, then S-NPP VIIRS until ${fmtDate(chain.noaa20_start)}, then NOAA-20 VIIRS.`,
    'Every count is converted to one unit: NOAA-20-equivalent hotspots.',
    'Each conversion is a ratio of totals, fitted for each fire category and calendar month on years when both satellites were flying: all hotspots from the newer satellite divided by all hotspots from the older one.',
    'The bands are the 10th to 90th percentile of that ratio when it is computed one year at a time. NOAA-20 observations need no conversion, so they have no band.',
  ];
}

// The pipeline's step is mean(3 years from the S-NPP switch) / mean(3 years before it).
export function stepSentences(step, chain) {
  const y = chain && chain.snpp_start ? Number(String(chain.snpp_start).slice(0, 4)) : null;
  const span = y ? `${y}–${y + 2} compared with ${y - 3}–${y - 1}` : 'the three years after S-NPP joined compared with the three years before';
  const inside = isNum(step.harm_step) && isNum(step.yoy_p10) && isNum(step.yoy_p90) && step.harm_step >= step.yoy_p10 && step.harm_step <= step.yoy_p90;
  const sentences = [
    `Adding up the raw counts of every satellite, hotspots are ${fmtTimes(step.naive_step)} as many in ${span}.`,
    `In the harmonized series the same comparison gives ${fmtTimes(step.harm_step)}.`,
    `In a normal pair of years the count changes by between ${fmtTimes(step.yoy_p10)} and ${fmtTimes(step.yoy_p90)} (10th to 90th percentile of year-to-year changes in the harmonized series).`,
    inside
      ? `The harmonized step (${fmtTimes(step.harm_step)}) is inside that normal range, so the sensor change no longer shows as a jump.`
      : `The harmonized step (${fmtTimes(step.harm_step)}) is outside that normal range (${fmtTimes(step.yoy_p10)} to ${fmtTimes(step.yoy_p90)}), so part of the sensor change is still visible.`,
  ];
  return { sentences, inside };
}

export function coverageFlag(c) {
  if (!isNum(c)) return null;
  if (c < COVERAGE_MIN) return { level: 'low', label: 'Band too narrow', note: `Below ${fmtPct(COVERAGE_MIN, 0)}: the band misses more observed values than it should.` };
  if (c > COVERAGE_MAX) return { level: 'high', label: 'Band too wide', note: `Above ${fmtPct(COVERAGE_MAX, 0)}: the band is wider than it needs to be.` };
  return null;
}

export function loyoRows(summary, variant) {
  const byLink = (summary.loyo && summary.loyo[variant]) || {};
  const rows = [];
  for (const link of LINKS) {
    for (const unitType of UNIT_TYPES) {
      const m = byLink[link] && byLink[link][unitType];
      if (m) rows.push({ link, unitType, mdape: m.mdape, bias: m.bias, coverage: m.coverage, n: m.n, flag: coverageFlag(m.coverage) });
    }
  }
  return rows;
}

export function smallAreaNote(summary, variant, chain) {
  const byLink = (summary.loyo && summary.loyo[variant]) || {};
  const hit = LINKS.filter((l) => {
    const box = byLink[l] && byLink[l].box1deg;
    const whole = byLink[l] && byLink[l].region_month;
    return box && whole && isNum(box.mdape) && isNum(whole.mdape) && box.mdape >= SMALL_AREA_FACTOR * whole.mdape;
  });
  if (!hit.length) return 'At 1° box level the error is less than twice the whole-India error on every conversion, so small-area values are about as reliable as national ones.';
  const part = (l) => `${fmtPct(byLink[l].box1deg.mdape)} for ${LINK_LABELS[l]} (whole India: ${fmtPct(byLink[l].region_month.mdape)}; band coverage ${fmtPct(byLink[l].box1deg.coverage)})`;
  return `Small areas are much less certain than national totals. In 1° boxes the median error is ${joinAnd(hit.map(part))}. `
    + `Where coverage is far below 80 %, the bands are too narrow at that scale. Treat values for small areas before ${fmtDate(chain && chain.noaa20_start)}, when NOAA-20 observations begin and no conversion is needed, as indicative only.`;
}

export function variantRows(summary) {
  const variants = Object.keys(summary.loyo || {});
  return LINKS.map((link) => {
    const row = { link };
    for (const v of variants) {
      const m = summary.loyo[v][link] && summary.loyo[v][link].region_month;
      row[v] = m ? { mdape: m.mdape, coverage: m.coverage, flag: coverageFlag(m.coverage) } : null;
    }
    return row;
  });
}

export function directComparison(summary, variant) {
  const d = summary.direct_aqua_noaa20 || {};
  const chain = ['aqua_snpp', 'snpp_noaa20'].map((link) => ({ link, ...(((summary.loyo || {})[variant] || {})[link] || {}).region_month }));
  const rows = [
    { label: 'Direct: Aqua → NOAA-20', mdape: d.mdape, coverage: d.coverage, n: d.n, flag: coverageFlag(d.coverage) },
    ...chain.map((c) => ({ label: `Chain step: ${LINK_LABELS[c.link]}`, mdape: c.mdape, coverage: c.coverage, n: c.n, flag: coverageFlag(c.coverage) })),
  ];
  const errs = chain.map((c) => c.mdape);
  const worse = isNum(d.mdape) && errs.every((e) => isNum(e) && d.mdape > e);
  const sentence = worse
    ? `The direct step has a larger error (${fmtPct(d.mdape)}) than either step of the chain (${joinAnd(errs.map((e) => fmtPct(e)))}), and its band covers ${fmtPct(d.coverage)} of observed values. The chain is used.`
    : `The direct step's error (${fmtPct(d.mdape)}) is not larger than both steps of the chain (${joinAnd(errs.map((e) => fmtPct(e)))}); its band covers ${fmtPct(d.coverage)} of observed values.`;
  return { rows, sentence, worse };
}

// rows: ratios.parquet rows of one variant and metric -> one row per link × category
export function ratioSummaryRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.link}|${r.stratum}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    const w = g.reduce((s, r) => s + (r.n_detections || 0), 0);
    const mean = w > 0 ? g.reduce((s, r) => s + r.r * r.n_detections, 0) / w : g.reduce((s, r) => s + r.r, 0) / g.length;
    const fb = g.filter((r) => r.fallback && r.fallback !== 'none');
    out.push({
      link: g[0].link,
      stratum: g[0].stratum,
      mean,
      min: Math.min(...g.map((r) => r.r)),
      max: Math.max(...g.map((r) => r.r)),
      months: new Set(g.map((r) => r.month)).size,
      fallbackMonths: new Set(fb.map((r) => r.month)).size,
      fallbackLevels: [...new Set(fb.map((r) => r.fallback))].sort(),
    });
  }
  return out.sort((a, b) => LINKS.indexOf(a.link) - LINKS.indexOf(b.link) || a.stratum - b.stratum);
}

export function fallbackText(row) {
  if (!row.fallbackMonths) return 'None';
  return `${row.fallbackMonths} of ${row.months} months: ${row.fallbackLevels.map((l) => FALLBACK_LABELS[l] ?? l).join('; ')}`;
}

// Vegetation categories are codes 0-3.
export function timingNote(summaryRows, chain) {
  const high = summaryRows.filter((r) => r.link === 'terra_aqua' && r.stratum <= 3 && r.mean >= WELL_ABOVE_ONE);
  if (!high.length) return null;
  return `The Terra → Aqua ratio is well above 1 for ${joinAnd(high.map((r) => `${categoryName(r.stratum).toLowerCase()} (${fmtRatio(r.mean)})`))}. `
    + 'Terra passes over at about 10:30 local time and Aqua at about 13:30, and vegetation fires peak in the afternoon, so Aqua sees more of them. '
    + `Values before ${fmtDate(chain && chain.aqua_start)}, which come from Terra alone, therefore carry the largest conversion.`;
}

const pad = (n) => String(n).padStart(2, '0');
// gaps.parquet rows (one per dekad) -> date ranges; dekads next to each other with the same satellite and fill are merged
export function gapRanges(rows) {
  const idx = (r) => (r.year * 12 + r.month - 1) * 3 + r.dekad - 1;
  const first = (r) => `${r.year}-${pad(r.month)}-${pad((r.dekad - 1) * 10 + 1)}`;
  const last = (r) => `${r.year}-${pad(r.month)}-${pad(r.dekad < 3 ? r.dekad * 10 : new Date(Date.UTC(r.year, r.month, 0)).getUTCDate())}`;
  const sorted = [...rows].sort((a, b) => String(a.chain_satellite).localeCompare(String(b.chain_satellite)) || idx(a) - idx(b));
  const out = [];
  let prev = null;
  for (const r of sorted) {
    const cur = out[out.length - 1];
    const filledFrom = r.filled_from ?? null;
    if (cur && prev && cur.satellite === r.chain_satellite && cur.filledFrom === filledFrom && idx(r) === idx(prev) + 1) cur.end = last(r);
    else out.push({ start: first(r), end: last(r), satellite: r.chain_satellite, filledFrom });
    prev = r;
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function gapText(g) {
  const when = `${fmtDate(g.start)} to ${fmtDate(g.end)}`;
  return g.filledFrom
    ? `${when}: no ${g.satellite} detections anywhere in India; filled from ${g.filledFrom}, converted to NOAA-20 units.`
    : `${when}: no ${g.satellite} detections anywhere in India and no other satellite to fill from. Shown as "no data", not as zero.`;
}

// annual_series.parquet rows -> one row per year. A raw satellite total of 0 means it was not flying: shown as null, not 0.
export function annualWide(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, { year: r.year });
    const raw = ['terra', 'aqua', 'snpp', 'noaa20'].includes(r.series);
    byYear.get(r.year)[r.series] = raw && r.value === 0 ? null : r.value;
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

// One label per series at its last point; series that end within `factor` of each other share a label so text never overlaps.
export function endLabels(wide, series = SERIES, factor = 1.3) {
  const ends = [];
  for (const s of series) {
    const row = [...wide].reverse().find((d) => isNum(d[s.key]) && d[s.key] > 0);
    if (row) ends.push({ year: row.year, value: row[s.key], label: s.label });
  }
  ends.sort((a, b) => a.year - b.year || a.value - b.value);
  const out = [];
  for (const e of ends) {
    const cur = out[out.length - 1];
    if (cur && cur.year === e.year && e.value / cur.max <= factor) {
      cur.labels.push(e.label);
      cur.max = e.value;
    } else out.push({ year: e.year, min: e.value, max: e.value, labels: [e.label] });
  }
  return out.map((g) => ({ year: g.year, value: Math.sqrt(g.min * g.max), text: g.labels.reverse().join(', ') }));
}

export function coverageLimitText(meta, now) {
  const end = String(meta.coverage_end || '');
  const text = `The data currently ends on ${fmtDate(end)}.`;
  const thisMonth = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  return end && end.slice(0, 7) < thisMonth ? `${text} More recent data comes from the daily update, which needs a FIRMS key that has not been set up yet.` : text;
}

// ---------- DOM (browser only) ----------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// columns: [{label, num, cell(row) -> string | Node}]; the first column is the row header
function table(caption, columns, rows) {
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'data-table' },
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : null }, c.label)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...columns.map((c, i) =>
        h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: c.num ? 'num' : null }, c.cell(r))))))));
}

function coverageCell(m) {
  if (!m.flag) return fmtPct(m.coverage);
  return h('span', {}, `${fmtPct(m.coverage)} `, h('span', { class: 'badge badge--warning', title: m.flag.note }, m.flag.label));
}

function tableToggle(tableNode) {
  const btn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false' }, 'Show table');
  tableNode.hidden = true;
  btn.addEventListener('click', () => {
    tableNode.hidden = !tableNode.hidden;
    btn.setAttribute('aria-expanded', String(!tableNode.hidden));
    btn.textContent = tableNode.hidden ? 'Show table' : 'Hide table';
  });
  return h('div', {}, btn, tableNode);
}

const paragraphs = (texts) => texts.map((t) => h('p', {}, t));
const errorNotice = (e) => h('div', { class: 'notice notice--error', role: 'alert' }, e && e.message ? e.message : String(e));

async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Couldn't load ${url}: ${e.message}`, { cause: e });
  }
  if (!res.ok) throw new Error(`Couldn't load ${url}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`Couldn't read ${url}: ${e.message}`, { cause: e });
  }
}

// Draws when the container gets a width, and again when the container width changes (the chart is redrawn, not scaled, so text stays readable).
function responsive(el, draw) {
  let width = 0;
  const run = () => {
    if (!el.clientWidth) return; // not on the page yet; the observer fires again once it is
    const w = Math.max(320, Math.min(940, el.clientWidth));
    if (w === width) return;
    width = w;
    el.replaceChildren(draw(w));
  };
  new ResizeObserver(run).observe(el);
  setTimeout(run, 0); // first draw does not wait for a rendered frame (a background tab has none)
}

const SERIES_STYLE = {
  terra: { stroke: 'var(--series-1)' },
  aqua: { stroke: 'var(--series-2)' },
  snpp: { stroke: 'var(--series-3)' },
  noaa20: { stroke: 'var(--series-4)' },
  naive: { stroke: 'var(--ink-2)', strokeDasharray: '6 4' },
  harm: { stroke: 'var(--ink)', strokeWidth: 3 },
};

function annualChart(Plot, wide, width) {
  const tipText = (d) => [String(d.year),
    ...SERIES.filter((s) => isNum(d[s.key])).map((s) => `${s.label}: ${fmtInt(d[s.key])}`),
    isNum(d.harm_lo) && isNum(d.harm_hi) && d.harm_lo !== d.harm_hi ? `Harmonized band: ${fmtInt(d.harm_lo)} to ${fmtInt(d.harm_hi)}` : 'Harmonized band: none (NOAA-20 observed)',
  ].join('\n');
  return Plot.plot({
    width,
    height: 440,
    marginRight: width < 560 ? 110 : 190,
    marginLeft: 48,
    style: { fontFamily: 'inherit', fontSize: '13px', color: 'var(--ink)', background: 'transparent', overflow: 'visible', '--plot-background': 'var(--surface-1)' },
    ariaLabel: 'Hotspots per year: raw satellites, naive sum and harmonized series',
    x: { label: null, tickFormat: 'd' },
    y: { type: 'log', grid: true, label: 'Hotspots per year (log scale)', tickFormat: '~s' },
    marks: [
      Plot.areaY(wide.filter((d) => d.harm_lo > 0), { x: 'year', y1: 'harm_lo', y2: 'harm_hi', fill: 'var(--ink)', fillOpacity: 0.18 }),
      ...SERIES.map((s) => Plot.lineY(wide.filter((d) => isNum(d[s.key]) && d[s.key] > 0), { x: 'year', y: s.key, strokeWidth: 2, ...SERIES_STYLE[s.key] })),
      Plot.text(endLabels(wide), { x: 'year', y: 'value', text: 'text', textAnchor: 'start', dx: 8, fill: 'var(--ink)', lineWidth: width < 560 ? 8 : 16 }),
      Plot.ruleX(wide, Plot.pointerX({ x: 'year', stroke: 'var(--ink-2)' })),
      Plot.tip(wide, Plot.pointerX({ x: 'year', y: 'harm', title: tipText, fill: 'var(--surface-1)', stroke: 'var(--line)' })),
    ],
  });
}

function annualLegend() {
  return h('div', { class: 'legend' },
    ...SERIES.map((s) => h('span', { class: 'legend-item' },
      h('span', { class: `legend-line${s.key === 'naive' ? ' legend-line--dashed' : ''}`, style: `border-top-color:${SERIES_STYLE[s.key].stroke}` }), s.label)),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-band' }), 'Harmonized band (10th–90th percentile)'));
}

const LINK_STYLE = {
  terra_aqua: { fill: 'var(--series-1)', symbol: 'circle' },
  aqua_snpp: { fill: 'var(--series-2)', symbol: 'square' },
  snpp_noaa20: { fill: 'var(--series-3)', symbol: 'triangle' },
};
const SYMBOL_PATH = { circle: 'M7 2a5 5 0 1 0 0 10a5 5 0 1 0 0-10z', square: 'M2.5 2.5h9v9h-9z', triangle: 'M7 1.5L12.5 12h-11z' };

function breakdownPlot(Plot, rows, labelOf, order, width, ariaLabel) {
  const data = rows.map((r) => ({ ...r, label: labelOf(r.grp), pct: r.mdape * 100 }));
  return Plot.plot({
    width,
    height: 60 + order.length * 30,
    marginLeft: 140,
    marginRight: 24,
    style: { fontFamily: 'inherit', fontSize: '13px', color: 'var(--ink)', background: 'transparent', '--plot-background': 'var(--surface-1)' },
    ariaLabel,
    x: { label: 'Median absolute error (%)', grid: true, nice: true, zero: true },
    y: { label: null, domain: order, type: 'point' },
    marks: [
      ...LINKS.map((link) => Plot.dot(data.filter((d) => d.link === link), {
        x: 'pct', y: 'label', r: 6, stroke: 'var(--surface-1)', strokeWidth: 1, ...LINK_STYLE[link],
        title: (d) => `${LINK_LABELS[link]}, ${d.label}\nError ${fmtPct(d.mdape)} · bias ${fmtSignedPct(d.bias)}\nBand coverage ${fmtPct(d.coverage)} · n ${fmtInt(d.n)}`,
        tip: { fill: 'var(--surface-1)', stroke: 'var(--line)' },
      })),
    ],
  });
}

function linkLegend() {
  return h('div', { class: 'legend' }, ...LINKS.map((l) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('class', 'legend-symbol');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', SYMBOL_PATH[LINK_STYLE[l].symbol]);
    p.setAttribute('style', `fill:${LINK_STYLE[l].fill}`);
    svg.append(p);
    return h('span', { class: 'legend-item' }, svg, LINK_LABELS[l]);
  }));
}

export async function init() {
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const failed = [];
  // Each block draws itself or says which file failed. Nothing is ever filled in with stand-in numbers.
  const section = async (id, draw) => {
    const el = $(id);
    try {
      el.replaceChildren(...[await draw(el)].flat().filter(Boolean));
    } catch (e) {
      failed.push(id);
      el.replaceChildren(errorNotice(e));
    }
  };

  let db;
  try {
    const config = await fetchJSON(new URL('./config.json', location.href).href);
    const { initDB } = await import('./db.js');
    db = await initDB(config);
  } catch (e) {
    status.className = 'notice notice--error';
    status.textContent = `The page could not start, so no numbers are shown. ${e.message}`;
    return;
  }

  const file = (name) => db.url('tables', name);
  const summaryP = fetchJSON(file('validation/summary.json'));
  const metaP = fetchJSON(file('meta.json'));
  const plotP = import(PLOT_ESM).catch((e) => { throw new Error(`Couldn't load the chart library ${PLOT_ESM}: ${e.message}. The table below still has every value.`); });
  for (const p of [summaryP, metaP, plotP]) p.catch(() => {}); // each section reports the failure itself
  const chainP = Promise.all([summaryP, metaP]).then(([s, m]) => s.chain || m.chain);
  const variantP = summaryP.then((s) => s.chosen_variant);

  await Promise.all([
    section('approach', async () => paragraphs(approachSentences(await chainP, (await metaP).coverage_start))),

    section('annual', async () => {
      const wide = annualWide(await db.query(`SELECT year, series, value FROM read_parquet('${file('validation/annual_series.parquet')}') ORDER BY year, series`));
      const cols = [{ label: 'Year', cell: (r) => String(r.year) },
        ...SERIES.map((s) => ({ label: s.label, num: true, cell: (r) => fmtInt(r[s.key]) })),
        { label: 'Band low', num: true, cell: (r) => fmtInt(r.harm_lo) }, { label: 'Band high', num: true, cell: (r) => fmtInt(r.harm_hi) }];
      const chart = h('div', { class: 'chart' });
      const out = [chart, annualLegend(),
        h('p', { class: 'muted' }, 'The vertical axis is logarithmic: one axis, where equal distances mean equal ratios. Raw MODIS counts are many times smaller than VIIRS counts, so on a linear axis the Terra and Aqua lines would lie flat along the bottom; and a sensor jump is a ratio, which a log axis shows at the same height wherever it happens. A dash in the table means the satellite was not flying that year.'),
        tableToggle(table('Hotspots per year by series', cols, wide))];
      try {
        const Plot = await plotP;
        responsive(chart, (w) => annualChart(Plot, wide, w));
      } catch (e) {
        chart.append(errorNotice(e));
      }
      return out;
    }),

    section('step', async () => {
      const [summary, chain] = [await summaryP, await chainP];
      const { sentences, inside } = stepSentences(summary.step, chain);
      return inside
        ? paragraphs(sentences)
        : [...paragraphs(sentences.slice(0, 3)), h('div', { class: 'notice notice--warning', role: 'note' }, sentences[3])];
    }),

    section('loyo', async () => {
      const [summary, variant, chain] = [await summaryP, await variantP, await chainP];
      const rows = loyoRows(summary, variant);
      const flagged = rows.filter((r) => r.flag);
      return [
        table('Leave-one-year-out error by conversion and unit', [
          { label: 'Conversion', cell: (r) => LINK_LABELS[r.link] },
          { label: 'Unit', cell: (r) => UNIT_LABELS[r.unitType] },
          { label: 'Median absolute error', num: true, cell: (r) => fmtPct(r.mdape) },
          { label: 'Bias', num: true, cell: (r) => fmtSignedPct(r.bias) },
          { label: 'Band coverage', num: true, cell: coverageCell },
          { label: 'Cases', num: true, cell: (r) => fmtInt(r.n) },
        ], rows),
        flagged.length ? h('p', { class: 'muted' }, `Marked rows have band coverage outside ${fmtPct(COVERAGE_MIN, 0)}–${fmtPct(COVERAGE_MAX, 0)}. "Band too narrow" means the true value falls outside the band more often than the band suggests.`) : null,
        h('p', {}, smallAreaNote(summary, variant, chain)),
      ];
    }),

    section('variant', async () => {
      const summary = await summaryP;
      const variants = Object.keys(summary.loyo).sort((a, b) => (b === summary.chosen_variant) - (a === summary.chosen_variant)); // chosen first
      const label = (v) => `${VARIANT_LABELS[v] ?? v}${v === summary.chosen_variant ? ' (chosen)' : ''}`;
      return [
        table('Whole-India monthly error and band coverage for both versions', [
          { label: 'Conversion', cell: (r) => LINK_LABELS[r.link] },
          ...variants.flatMap((v) => [
            { label: `${label(v)}: error`, num: true, cell: (r) => (r[v] ? fmtPct(r[v].mdape) : '–') },
            { label: `${label(v)}: band coverage`, num: true, cell: (r) => (r[v] ? coverageCell(r[v]) : '–') },
          ]),
        ], variantRows(summary)),
        h('p', {}, h('strong', {}, `Chosen: ${VARIANT_LABELS[summary.chosen_variant] ?? summary.chosen_variant}. `), summary.reason),
      ];
    }),

    section('direct', async () => {
      const { rows, sentence } = directComparison(await summaryP, await variantP);
      return [
        h('p', {}, 'Aqua is still flying, so Aqua counts could be converted to NOAA-20 units in one step instead of going through S-NPP. That direct ratio was tested the same way, on whole-India monthly totals.'),
        table('Direct Aqua to NOAA-20 conversion compared with the chain steps', [
          { label: 'Conversion', cell: (r) => r.label },
          { label: 'Median absolute error', num: true, cell: (r) => fmtPct(r.mdape) },
          { label: 'Band coverage', num: true, cell: coverageCell },
          { label: 'Cases', num: true, cell: (r) => fmtInt(r.n) },
        ], rows),
        h('p', {}, sentence),
      ];
    }),

    section('breakdown', async () => {
      const variant = await variantP;
      const rows = await db.query(`SELECT link, group_type, grp, mdape, bias, coverage, n FROM read_parquet('${file('validation/breakdown.parquet')}') WHERE variant = '${String(variant).replace(/'/g, "''")}' ORDER BY group_type, grp, link`);
      const parts = [
        { type: 'stratum', title: 'By category', labelOf: categoryName },
        { type: 'month', title: 'By month', labelOf: monthName },
      ];
      const out = [linkLegend()];
      let Plot = null;
      try {
        Plot = await plotP;
      } catch (e) {
        out.push(errorNotice(e));
      }
      for (const p of parts) {
        const sub = rows.filter((r) => r.group_type === p.type);
        const order = [...new Set(sub.map((r) => r.grp))].sort((a, b) => a - b).map(p.labelOf);
        const chart = h('div', { class: 'chart' });
        if (Plot) responsive(chart, (w) => breakdownPlot(Plot, sub, p.labelOf, order, w, `Median absolute error ${p.title.toLowerCase()} for each conversion`));
        out.push(h('h3', {}, p.title), chart, tableToggle(table(`Error ${p.title.toLowerCase()}`, [
          { label: p.title.replace('By ', '').replace(/^./, (c) => c.toUpperCase()), cell: (r) => p.labelOf(r.grp) },
          { label: 'Conversion', cell: (r) => LINK_LABELS[r.link] },
          { label: 'Median absolute error', num: true, cell: (r) => fmtPct(r.mdape) },
          { label: 'Bias', num: true, cell: (r) => fmtSignedPct(r.bias) },
          { label: 'Band coverage', num: true, cell: coverageCell },
          { label: 'Cases', num: true, cell: (r) => fmtInt(r.n) },
        ], sub.map((r) => ({ ...r, flag: coverageFlag(r.coverage) })))));
      }
      return out;
    }),

    section('ratios', async () => {
      const rows = ratioSummaryRows(await db.query(`SELECT link, stratum, month, r, n_detections, fallback FROM read_parquet('${file('ratios.parquet')}') WHERE chosen AND metric = 'n'`));
      const note = timingNote(rows, await chainP);
      return [
        table('Conversion ratios by conversion and category', [
          { label: 'Conversion', cell: (r) => LINK_LABELS[r.link] },
          { label: 'Category', cell: (r) => categoryName(r.stratum) },
          { label: 'Mean ratio', num: true, cell: (r) => fmtRatio(r.mean) },
          { label: 'Lowest month', num: true, cell: (r) => fmtRatio(r.min) },
          { label: 'Highest month', num: true, cell: (r) => fmtRatio(r.max) },
          { label: 'Months using a wider pool', cell: fallbackText },
        ], rows),
        note ? h('div', { class: 'notice', role: 'note' }, note) : null,
      ];
    }),

    section('categories', async () => {
      const counts = (await summaryP).category_counts;
      const rows = Object.keys(counts).map(Number).sort((a, b) => a - b).map((code) => ({ code, n: counts[code] }));
      const total = rows.reduce((s, r) => s + r.n, 0);
      return table('Hotspots by category, all satellites and years', [
        { label: 'Category', cell: (r) => categoryName(r.code) },
        { label: 'Hotspots (all satellites, all years)', num: true, cell: (r) => fmtInt(r.n) },
        { label: 'Share', num: true, cell: (r) => fmtPct(r.n / total) },
      ], rows);
    }),

    section('mask', async () => {
      const counts = (await summaryP).mask_counts;
      const days = new Map((await db.query(`SELECT reason, max(n_days_max) AS d FROM read_parquet('${file('static_mask.parquet')}') GROUP BY reason`)).map((r) => [r.reason, r.d]));
      const rows = Object.keys(counts).sort().map((reason) => ({ reason, n: counts[reason], days: days.get(reason) }));
      return table('Static-source mask cells by reason', [
        { label: 'Reason', cell: (r) => MASK_REASONS[r.reason] ?? r.reason },
        { label: 'Mask cells (0.01°)', num: true, cell: (r) => fmtInt(r.n) },
        { label: 'Most fire days in one year, any cell', num: true, cell: (r) => fmtInt(r.days) },
      ], rows);
    }),

    section('gaps', async () => {
      const ranges = gapRanges(await db.query(`SELECT year, month, dekad, chain_satellite, filled_from FROM read_parquet('${file('gaps.parquet')}') ORDER BY year, month, dekad`));
      if (!ranges.length) return h('p', {}, 'No gaps: the chain satellite reported detections in every 10-day period.');
      return [
        h('p', {}, 'A gap is a 10-day period in which the satellite in use reported no detections anywhere in India.'),
        h('ul', {}, ...ranges.map((g) => h('li', {}, gapText(g)))),
      ];
    }),

    section('sources', async () => {
      const meta = await metaP;
      const rows = [
        ['Coverage', `${fmtDate(meta.coverage_start)} to ${fmtDate(meta.coverage_end)}`],
        ['Land cover', meta.landcover_source],
        ['Boundary', meta.boundary_source],
        ['Files generated', `${String(meta.generated_utc).slice(0, 16).replace('T', ' ')} UTC`],
        ['Pipeline version (git commit)', meta.git_sha],
      ];
      return table('Data sources and versions', [
        { label: 'Item', cell: (r) => r[0] },
        { label: 'Value', cell: (r) => r[1] ?? '–' },
      ], rows);
    }),

    section('limit-coverage', async () => coverageLimitText(await metaP, new Date())),
  ]);

  if (failed.length) {
    status.className = 'notice notice--error';
    status.textContent = `${failed.length} part${failed.length > 1 ? 's' : ''} of this page could not be loaded. Each one says which file failed; no substitute numbers are shown.`;
  } else {
    status.hidden = true;
  }
  document.documentElement.dataset.ready = 'true';
}
