// Trend and Anomalies tabs and the extra downloads. Listens for the fc:* events app.js dispatches; chart logic is in charts.js.

import * as C from './charts.js';
import { annual as annualQuery } from './queries.js';
import { calendarModel } from './calendar.js';
import { csvLines } from './db.js';

const { h, fmt } = C;
const $ = (id) => document.getElementById(id);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const errorText = (e) => (e && e.message ? e.message : String(e));
const notice = (text, error) => h('p', { class: `notice${error ? ' notice--error' : ''}`, role: error ? 'alert' : null }, text);
const notes = (r) => C.notesFor(r).join('. ');

let current = null; // { ctx, annual, charts: Map<key, {name, draw(Plot, width)}> }
let stops = [];

function clear() {
  for (const stop of stops) stop();
  stops = [];
  current = null;
  $('panel-trend').replaceChildren();
  $('panel-anomalies').replaceChildren();
}

// A chart area that draws itself when Plot is ready, or says why it can't. The table next to it never depends on Plot.
function chartHost(key, name, draw) {
  const host = h('div', { class: 'chart' });
  const mine = current;
  mine.charts.set(key, { name, draw });
  C.loadPlot().then((Plot) => {
    if (current === mine) stops.push(C.responsive(host, (w) => draw(Plot, w)));
  }).catch((e) => { if (current === mine) host.replaceChildren(notice(errorText(e), true)); });
  return host;
}

function legend(...items) {
  return h('div', { class: 'legend' }, ...items.map(([swatch, label]) => h('span', { class: 'legend-item' }, swatch, label)));
}
const line = (colour) => h('span', { class: 'legend-line', style: `border-top-color:${colour}`, 'aria-hidden': 'true' });

function renderTrend(ctx, annual) {
  const unit = C.UNIT[ctx.metric];
  const incomplete = annual.filter((r) => !r.complete);
  const block = h('section', { class: 'chart-block' },
    h('h3', null, `Harmonized ${unit} per year`),
    legend([line('var(--ink)'), 'Harmonized'], [h('span', { class: 'legend-band', 'aria-hidden': 'true' }), 'Conversion range'],
      [h('span', { class: 'legend-dot legend-dot--hollow', 'aria-hidden': 'true' }), 'Incomplete year']),
    chartHost('trend', `annual_${ctx.metric}`, (Plot, w) => C.plotAnnual(Plot, annual, w, { metric: ctx.metric })));
  if (incomplete.length) {
    block.append(h('p', { class: 'muted' }, `Hollow markers are incomplete years, left off the line: ${incomplete.map((r) => `${r.year} (${r.months} of 12 months)`).join(', ')}. The data runs from ${longDate(ctx.meta.coverage_start)} to ${longDate(ctx.meta.coverage_end)}.`));
  }
  const n20 = ctx.meta.chain.noaa20_start;
  block.append(h('p', null, `Each point is the year's total for the selected area and categories, adjusted so that every year is comparable to the NOAA-20 satellite. The shaded band is the range from year-to-year variation in the sensor conversion; values from ${MONTHS[+n20.slice(5, 7) - 1]} ${n20.slice(0, 4)} on are observed by NOAA-20 and have no band.`));
  C.tableToggle(block, annual, [
    { label: 'Year', cell: (r) => String(r.year) },
    { label: `Harmonized ${unit}`, num: true, cell: (r) => fmt(r.value) },
    { label: 'Range low', num: true, cell: (r) => (r.band ? fmt(r.lo) : '—') },
    { label: 'Range high', num: true, cell: (r) => (r.band ? fmt(r.hi) : '—') },
    { label: 'Notes', cell: notes },
  ], `Harmonized ${unit} per year`);

  const sensors = h('section', { class: 'chart-block' }, h('h3', null, 'Raw detections per satellite per year'), notice('Loading satellite counts…'));
  $('panel-trend').replaceChildren(block, sensors);

  const mine = current;
  annualQuery(ctx.db, ctx.area, ctx.cats, ctx.metric).then((rows) => {
    if (current !== mine) return;
    const s = C.sensorRows(rows, annual, ctx.meta);
    const cell = (key) => (r) => (r[key] === null ? '—' : fmt(r[key]));
    sensors.replaceChildren(
      h('h3', null, 'Raw detections per satellite per year'),
      legend(...C.SENSORS.map((x) => [line(x.colour), x.label])),
      chartHost('sensors', 'raw_by_satellite', (Plot, w) => C.plotSensors(Plot, s.rows, w)),
      h('p', null, 'These are the counts before any adjustment, for the same area and categories. Each satellite sees a different number of fires: the newer VIIRS instruments (S-NPP, NOAA-20) pick up several times more than MODIS (Terra, Aqua), and each started in a different year. Adding or switching satellites would put jumps in the record that are not changes in burning, so the chart above converts every year to one scale.'
        + (s.dropped.length ? ` Years only partly inside the selected dates are left out here: ${s.dropped.join(', ')}.` : '')),
    );
    C.tableToggle(sensors, s.rows, [
      { label: 'Year', cell: (r) => String(r.year) },
      ...C.SENSORS.map((x) => ({ label: x.label, num: true, cell: cell(x.key) })),
      { label: 'Notes', cell: notes },
    ], 'Raw detections per satellite per year (a dash means the satellite was not flying)');
  }).catch((e) => { if (current === mine) sensors.replaceChildren(h('h3', null, 'Raw detections per satellite per year'), notice(`Couldn't load the satellite counts. ${errorText(e)}`, true)); });
}

function renderAnomalies(ctx, annual) {
  const unit = C.UNIT[ctx.metric];
  const anom = C.anomalyRows(annual, ctx.baseYears);
  const panel = $('panel-anomalies');
  if (!anom.median) {
    // 0: no typical activity. null: no complete base year in the selected dates.
    panel.replaceChildren(notice(anom.median === 0
      ? "No typical activity in this area, so anomalies can't be computed"
      : 'Anomalies need at least one complete year between ' + `${ctx.baseYears[0]} and ${ctx.baseYears[ctx.baseYears.length - 1]} in the selected dates.`));
    return;
  }
  const span = `${anom.baseYears[0]}–${anom.baseYears[anom.baseYears.length - 1]}`;
  const skipped = anom.rows.filter((r) => r.pct === null);
  const block = h('section', { class: 'chart-block' },
    h('h3', null, `Each year against the typical year (${unit})`),
    h('div', { class: 'legend' }, h('span', { class: 'legend-title' }, `Percentile among ${span}`),
      ...C.ANOMALY_LABELS.map((label, i) => h('span', { class: 'legend-item' },
        h('span', { class: 'legend-swatch', style: `background:var(--div-${i + 1})`, 'aria-hidden': 'true' }), label))),
    chartHost('anomalies', `anomalies_${ctx.metric}`, (Plot, w) => C.plotAnomalies(Plot, anom, w, { metric: ctx.metric })),
    h('p', null, `Bars show how far each year's total is above or below the typical year: the median of ${anom.baseYears.length} complete ${anom.baseYears.length === 1 ? 'year' : 'years'} (${span}), which is ${fmt(anom.median)} ${unit}. Colour shows where the year ranks among those years.`
      + (skipped.length ? ` Incomplete years have no bar: ${skipped.map((r) => r.year).join(', ')}.` : '')));
  C.tableToggle(block, anom.rows, [
    { label: 'Year', cell: (r) => String(r.year) },
    { label: `Harmonized ${unit}`, num: true, cell: (r) => fmt(r.value) },
    { label: 'Against typical', num: true, cell: (r) => C.fmtPct(r.pct) },
    { label: 'Percentile', num: true, cell: (r) => (r.percentile === null ? '—' : C.ordinal(Math.round(r.percentile))) },
    { label: 'z-score', num: true, cell: (r) => C.fmtZ(r.z) },
    { label: 'Notes', cell: notes },
  ], `Annual ${unit} against the ${span} median of ${fmt(anom.median)}`);
  panel.replaceChildren(block);
}

function render(ctx) {
  clear();
  C.ensureStyles();
  const annual = C.annualFromCalendar(ctx.calendarRows, ctx.gaps, ctx.lastDataDate);
  current = { ctx, annual, charts: new Map() };
  renderTrend(ctx, annual);
  renderAnomalies(ctx, annual);
}

// ---------- downloads ----------

// Exports are drawn off-screen at a fixed width, so the file does not depend on the window size or the open tab.
async function withChart(key, work) {
  const chart = current && current.charts.get(key);
  if (!chart) throw new Error(key === 'anomalies' ? "There is no anomaly chart for this area, so there is nothing to export" : 'This chart is not ready yet');
  const Plot = await C.loadPlot();
  const host = h('div', { class: 'chart chart-offscreen' }, chart.draw(Plot, 800));
  document.body.append(host);
  try { await work(host, chart.name); } finally { host.remove(); }
}

function calendarText(ctx) {
  const pressed = document.querySelector('#mode-toggle [aria-pressed="true"]');
  const mode = pressed ? pressed.dataset.value : 'counts';
  const model = calendarModel(ctx.calendarRows, {
    mode, metric: ctx.metric, baseYears: ctx.baseYears, gaps: ctx.gaps,
    currentYM: { year: ctx.lastDataDate.getUTCFullYear(), month: ctx.lastDataDate.getUTCMonth() + 1 },
  });
  if (!model.years.length) throw new Error('The calendar is empty for this selection');
  return { mode, text: C.calendarSVG(model, C.cssVar, `${model.legendTitle} · ${ctx.range.from} to ${ctx.range.to}`) };
}

function wireDownloads() {
  const panel = $('panel-download');
  const status = $('dl-status');
  const say = (text, error) => status.replaceChildren(notice(text, error));
  const stem = () => `${current.ctx.range.from}_${current.ctx.range.to}`;
  const button = (label, work) => {
    const btn = h('button', { type: 'button', class: 'btn' }, label);
    btn.addEventListener('click', async () => {
      if (!current) return;
      btn.disabled = true;
      try { say(`${await work()} ready.`); } catch (e) { say(errorText(e), true); } finally { btn.disabled = false; }
    });
    return btn;
  };
  const chartButtons = (key, label) => [
    button(`${label} (SVG)`, async () => { await withChart(key, (el, name) => C.exportSVG(el, `${name}_${stem()}`)); return `${label} SVG`; }),
    button(`${label} (PNG)`, async () => { await withChart(key, (el, name) => C.exportPNG(el, `${name}_${stem()}`)); return `${label} PNG`; }),
  ];
  const extra = h('div', { id: 'dl-charts' },
    h('div', { class: 'downloads', style: 'margin-top: 12px' },
      button('Download annual table CSV', async () => {
        const { ctx, annual } = current;
        C.saveBlob(new Blob([csvLines(C.ANNUAL_CSV_COLUMNS, C.annualCSVRows(annual, ctx.baseYears))], { type: 'text/csv;charset=utf-8' }), `annual_${ctx.metric}_${stem()}.csv`);
        return 'Annual table CSV';
      }),
      ...chartButtons('trend', 'Trend chart'),
      ...chartButtons('sensors', 'Satellite chart'),
      ...chartButtons('anomalies', 'Anomaly chart'),
      button('Calendar image (PNG)', async () => {
        const { ctx } = current;
        const { mode, text } = calendarText(ctx);
        C.saveBlob(await C.svgTextToPNG(text), `calendar_${mode}_${ctx.metric}_${stem()}.png`);
        return 'Calendar image';
      })),
    h('p', { class: 'hint' }, 'Annual table CSV: yearly totals with range, difference from the typical year, percentile, z-score and whether the year is complete. Chart and calendar images use the colours of the current light or dark theme.'));
  panel.insertBefore(extra, status);
}

document.addEventListener('fc:results', (e) => render(e.detail));
document.addEventListener('fc:loading', clear);
document.addEventListener('fc:error', clear);
wireDownloads();
const ctx = window.fireCalendar && window.fireCalendar.getContext();
if (ctx) render(ctx);
