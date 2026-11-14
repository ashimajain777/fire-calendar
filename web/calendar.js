// Year x month calendar. See docs/CONTRACTS.md section 6 and docs/PLAN.md section 8.
// calendarModel() is pure (unit-tested); renderCalendar() only turns the model into DOM.
// Colours live in styles.css: cells and legend swatches get .cal-seq-1..7 (counts) or .cal-div-1..7 (anomaly).

import { quantile, median, percentileRank, zScore, anomalyBin } from './stats.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SOURCES = {
  0: 'observed by NOAA-20',
  1: 'converted from S-NPP',
  2: 'converted from Aqua MODIS',
  3: 'filled from another satellite',
  4: 'converted from Terra MODIS',
};
const UNITS = { harm_n: 'hotspot', harm_fd: 'fire-day' };
const ANOMALY_LABELS = ['≤ 10th', '10–25th', '25–40th', '40–60th (typical)', '60–75th', '75–90th', '≥ 90th'];
const STEPS = 7;

// k-quantile thresholds (ascending, at most k-1). Duplicates and thresholds at the maximum are dropped,
// so no bin is ever empty at the top.
export function quantileBins(values, k) {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  const bins = [];
  for (let j = 1; j < k && sorted.length; j++) {
    const t = quantile(sorted, j / k);
    if (t < max && t !== bins[bins.length - 1]) bins.push(t);
  }
  return bins;
}

// Bin i holds bins[i-1] < value <= bins[i].
export function binIndex(value, bins) {
  let i = 0;
  while (i < bins.length && value > bins[i]) i++;
  return i;
}

const fmt = (v) => (v < 10 && !Number.isInteger(v)
  ? v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  : Math.round(v).toLocaleString('en-US'));
const compact = (v) => (v >= 1000
  ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
  : fmt(v));
const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
};

export function calendarModel(rows, opts = {}) {
  // soFar: stats.monthToDate() result for the current month, so its cell compares like with like (complete dekads)
  // scaleValues: count-mode bins come from these values instead, so two calendars can share one colour scale
  const { mode = 'counts', metric = 'harm_n', baseYears = [], currentYM = null, gaps = [], soFar = null, scaleValues = null } = opts;
  const unit = UNITS[metric] || UNITS.harm_n;
  const withUnit = (v) => `${fmt(v)} ${unit}${fmt(v) === '1' ? '' : 's'}`;
  if (!rows || !rows.length) return { mode, years: [], typical: [], legend: [], legendTitle: '' };

  const ym = (y, m) => y * 12 + m - 1;
  const byYM = new Map(rows.map((r) => [ym(r.year, r.month), r]));
  let first = Infinity;
  let last = -Infinity;
  for (const k of byYM.keys()) {
    first = Math.min(first, k);
    last = Math.max(last, k);
  }
  const unfilled = new Set(gaps.filter((g) => g.filled_from == null).map((g) => `${g.year}-${g.month}-${g.dekad}`));
  const valueOf = (y, m) => { const r = byYM.get(ym(y, m)); return r && r.value > 0 ? r.value : 0; };
  const stateOf = (y, m) => {
    if (ym(y, m) < first || ym(y, m) > last) return 'empty';
    // an unfilled gap dekad means the month's total is incomplete: show "no data", not a low value
    if ([1, 2, 3].some((d) => unfilled.has(`${y}-${m}-${d}`))) return 'nodata';
    return valueOf(y, m) > 0 ? 'value' : 'zero';
  };

  const measured = (y, m) => stateOf(y, m) === 'value' || stateOf(y, m) === 'zero';
  const baseFor = MONTH_NAMES.map((_, i) => baseYears.filter((y) => measured(y, i + 1)).map((y) => valueOf(y, i + 1)));
  const baseSpan = baseYears.length ? `${Math.min(...baseYears)}–${Math.max(...baseYears)}` : '';

  const firstYear = Math.floor(first / 12);
  const lastYear = Math.floor(last / 12);
  const nonZero = [];
  for (let y = firstYear; y <= lastYear; y++) for (let m = 1; m <= 12; m++) if (stateOf(y, m) === 'value') nonZero.push(valueOf(y, m));
  const scale = scaleValues ? scaleValues.filter((v) => v > 0) : nonZero;
  const bins = quantileBins(scale, STEPS);
  // With fewer than 7 bins the steps are spread over the whole ramp.
  const countStep = (i) => (bins.length ? 1 + Math.round((i * (STEPS - 1)) / bins.length) : 4);
  const stepOf = (value, pct) => {
    if (mode === 'anomaly') return pct === null ? null : anomalyBin(pct) + 1;
    return value > 0 ? countStep(binIndex(value, bins)) : null;
  };

  const cell = (year, month) => {
    const name = `${MONTH_NAMES[month - 1]} ${year}`;
    const state = stateOf(year, month);
    const current = !!currentYM && currentYM.year === year && currentYM.month === month;
    const out = { year, month, state, current, value: null, step: null, text: '', label: '', tip: [] };
    if (state === 'empty') return { ...out, label: `${name}, outside the selected period` };
    if (state === 'nodata') return { ...out, text: '–', label: `${name}, no data`, tip: [name, 'No satellite data for this month'] };

    const r = byYM.get(ym(year, month)) || {};
    const value = valueOf(year, month);
    const base = baseFor[month - 1];
    // The current month is still running: rank only its complete 10-day periods against the same days in base years.
    const partial = current && soFar && !(soFar.mode === 'mtd' && soFar.year === year && soFar.month === month && soFar.dekads.length === 3);
    const mtd = partial && soFar.mode === 'mtd' && soFar.year === year && soFar.month === month ? soFar : null;
    const days = mtd ? `1–${mtd.dekads.length === 1 ? 10 : 20} ${MONTH_NAMES[month - 1].slice(0, 3)}` : null;
    const pct = partial ? (mtd ? percentileRank(mtd.current, mtd.base) : null) : percentileRank(value, base);
    const z = partial ? (mtd ? zScore(mtd.current, mtd.base) : null) : zScore(value, base);
    const pctText = pct === null ? null : `${ordinal(Math.round(pct))} percentile${mtd ? ` for ${days}` : ''}`;
    const tip = [name, `${withUnit(value)}${partial ? ' so far' : ''}`];
    if (partial && !mtd) tip.push('No complete 10-day period yet, so no comparison');
    if (Number.isFinite(r.lo) && Number.isFinite(r.hi) && (r.lo !== value || r.hi !== value)) tip.push(`Range ${fmt(r.lo)}–${fmt(r.hi)}`);
    if (pctText) tip.push(`${pctText} of ${baseSpan}`);
    tip.push(`z-score ${z === null ? '—' : (z > 0 ? '+' : '') + z.toFixed(1).replace('-', '−')}`);
    if (SOURCES[r.harm_from]) tip.push(`Source: ${SOURCES[r.harm_from]}`);
    if (r.provisional) tip.push('Provisional (near-real-time data)');
    return {
      ...out, value, pct, z, step: stepOf(value, pct), text: compact(value), tip,
      label: [name, `${withUnit(value)}${partial ? ' so far' : ''}`, pctText, r.provisional ? 'provisional' : null].filter(Boolean).join(', '),
    };
  };

  const years = [];
  for (let y = lastYear; y >= firstYear; y--) years.push({ year: y, cells: MONTH_NAMES.map((_, i) => cell(y, i + 1)) });

  const typical = MONTH_NAMES.map((name, i) => {
    const value = median(baseFor[i]);
    const out = { year: null, month: i + 1, current: false, value, step: null, text: '', tip: [] };
    if (value === null) return { ...out, state: 'empty', label: `Typical ${name}, no base-period data` };
    const label = `Typical ${name}, ${withUnit(value)} (median of ${baseFor[i].length} years, ${baseSpan})`;
    return {
      ...out, state: value > 0 ? 'value' : 'zero', step: stepOf(value, percentileRank(value, baseFor[i])),
      text: compact(value), label, tip: [`Typical ${name}`, `${withUnit(value)}, median of ${baseSpan}`],
    };
  });

  const nodata = { kind: 'nodata', step: null, label: 'No data' };
  let legend;
  let legendTitle;
  if (mode === 'anomaly') {
    legendTitle = `Percentile against the same month in ${baseSpan}`;
    legend = [...ANOMALY_LABELS.map((label, i) => ({ kind: 'bin', step: i + 1, label })), nodata];
  } else {
    legendTitle = `${unit[0].toUpperCase()}${unit.slice(1)}s per month`;
    const binLabel = (i) => {
      if (!bins.length) return fmt(scale[0]);
      if (i === 0) return `≤ ${fmt(bins[0])}`;
      if (i === bins.length) return `> ${fmt(bins[i - 1])}`;
      return `${fmt(bins[i - 1])}–${fmt(bins[i])}`;
    };
    const binItems = scale.length
      ? Array.from({ length: bins.length + 1 }, (_, i) => ({ kind: 'bin', step: countStep(i), label: binLabel(i) }))
      : [];
    legend = [{ kind: 'zero', step: null, label: '0' }, ...binItems, nodata];
  }
  return { mode, years, typical, legend, legendTitle };
}

let tooltipCount = 0;

export function renderCalendar(el, rows, opts = {}) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const model = calendarModel(rows, opts);
  const ramp = model.mode === 'anomaly' ? 'cal-div-' : 'cal-seq-';
  const h = (tag, attrs, ...kids) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };

  el.classList.add('calendar');
  el.replaceChildren();
  if (!model.years.length) {
    el.append(h('p', { class: 'notice' }, 'No hotspots detected in this area for the selected period'));
    return;
  }

  const tipId = `cal-tooltip-${++tooltipCount}`;
  const tip = h('div', { class: 'cal-tooltip', role: 'tooltip', id: tipId, hidden: '' });
  const info = new WeakMap();
  const grid = [];
  const row = (heading, cells, cls) => {
    const tds = cells.map((c, i) => {
      const td = h('td', {
        class: `cal-cell cal-cell--${c.state}${c.step ? ` ${ramp}${c.step}` : ''}${c.current ? ' cal-cell--current' : ''}`,
        role: 'gridcell', tabindex: '-1', 'aria-label': c.label, 'aria-describedby': c.tip.length ? tipId : null,
        'data-r': grid.length, 'data-c': i,
      }, c.text);
      info.set(td, c);
      return td;
    });
    grid.push(tds);
    return h('tr', { class: cls }, h('th', { scope: 'row' }, heading), ...tds);
  };

  const table = h('table', { class: 'cal-table', role: 'grid', 'aria-label': `${model.legendTitle}, by year and month` },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Year'),
      ...MONTH_NAMES.map((m) => h('th', { scope: 'col' }, h('abbr', { title: m }, m.slice(0, 3)))))),
    h('tbody', null, ...model.years.map((y) => row(String(y.year), y.cells, null))),
    h('tfoot', null, row('Typical', model.typical, 'cal-typical')));

  const legend = h('div', { class: 'legend' }, h('span', { class: 'legend-title' }, model.legendTitle),
    ...model.legend.map((l) => h('span', { class: 'legend-item' },
      h('span', { class: `legend-swatch cal-cell--${l.kind === 'bin' ? 'value' : l.kind}${l.step ? ` ${ramp}${l.step}` : ''}`, 'aria-hidden': 'true' }),
      l.label)));

  // Roving tabindex: exactly one cell is in the tab order.
  const flat = grid.flat();
  let active = flat.find((td) => info.get(td).current) || flat.find((td) => info.get(td).state !== 'empty') || flat[0];
  active.tabIndex = 0;
  const activate = (td, focus) => {
    active.tabIndex = -1;
    active = td;
    td.tabIndex = 0;
    if (focus) td.focus();
  };
  const select = (td) => {
    const c = info.get(td);
    if (c.year !== null && c.state !== 'empty' && typeof opts.onSelect === 'function') opts.onSelect({ year: c.year, month: c.month });
  };
  const hideTip = () => { tip.hidden = true; };
  const showTip = (td) => {
    const lines = info.get(td).tip;
    if (!lines.length) return hideTip();
    tip.replaceChildren(...lines.map((line, i) => h(i ? 'div' : 'strong', null, line)));
    tip.hidden = false;
    const cellBox = td.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(cellBox.left + cellBox.width / 2 - box.width / 2, win.innerWidth - box.width - 8));
    const below = cellBox.bottom + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${below + box.height > win.innerHeight ? cellBox.top - box.height - 6 : below}px`;
    return undefined;
  };
  const cellOf = (e) => (e.target.closest ? e.target.closest('td.cal-cell') : null);

  table.addEventListener('keydown', (e) => {
    const td = cellOf(e);
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const to = { ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], Home: [r, 0], End: [r, 11] }[e.key];
    if (to) {
      e.preventDefault();
      const target = grid[to[0]] && grid[to[0]][to[1]];
      if (target) activate(target, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(td);
    } else if (e.key === 'Escape') {
      hideTip();
    }
  });
  table.addEventListener('click', (e) => {
    const td = cellOf(e);
    if (!td) return;
    activate(td, false);
    select(td);
  });
  table.addEventListener('mouseover', (e) => { const td = cellOf(e); if (td) showTip(td); });
  table.addEventListener('mouseleave', hideTip);
  table.addEventListener('focusin', (e) => { const td = cellOf(e); if (td) showTip(td); });
  table.addEventListener('focusout', hideTip);

  el.append(h('div', { class: 'cal-scroll' }, table), legend, tip);
}
