// Queries over the static Parquet files. See docs/CONTRACTS.md sections 4 and 6.
// The *SQL functions are pure string builders (unit-tested); the rest run them through db.js.

import { rangesSQL } from './cells.js';
import { csvLines } from './db.js';
import { calendarModel } from './calendar.js';

export const CATEGORY_NAMES = ['Agricultural', 'Forest', 'Grass / shrub', 'Other vegetation', 'Urban', 'Industrial / static', 'Volcanic', 'Offshore'];
const METRICS = ['harm_n', 'harm_fd'];
const RAW = 'n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21';
const SENSORS = ['n_terra', 'n_aqua', 'n_snpp', 'n_noaa20', 'n_noaa21'];
const POINT_COLUMNS = ['lat', 'lon', 'acq_date', 'acq_time', 'sensor', 'satellite', 'confidence_raw', 'conf_class', 'frp', 'daynight',
  'brightness', 'firms_type', 'processing', 'version', 'cell_id', 'cell001_id', 'region_id', 'category',
  'in_baseline_chain', 'harm_weight', 'harm_weight_lo', 'harm_weight_hi'];

// ---------- pure helpers ----------

const ym = (s) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new TypeError(`Month must be YYYY-MM, got ${s}`);
  return { year: +m[1], month: +m[2] };
};
const metricCol = (metric) => {
  if (!METRICS.includes(metric)) throw new TypeError(`Unknown metric ${metric}`);
  return metric;
};
const catsSQL = (cats) => {
  if (!cats.every(Number.isInteger)) throw new TypeError('Categories must be integers');
  return cats.length ? `category IN (${cats.join(', ')})` : 'FALSE';
};
const fileList = (urls) => `read_parquet([${urls.map((u) => `'${String(u).replace(/'/g, "''")}'`).join(', ')}])`;
const monthsSQL = (range) => {
  const a = ym(range.from);
  const b = ym(range.to);
  return `year::INT * 100 + month BETWEEN ${a.year * 100 + a.month} AND ${b.year * 100 + b.month}`;
};
const datesSQL = (range) => {
  const b = ym(range.to);
  const lastDay = new Date(Date.UTC(b.year, b.month, 0)).getUTCDate();
  return `acq_date BETWEEN DATE '${range.from}-01' AND DATE '${range.to}-${String(lastDay).padStart(2, '0')}'`;
};

// Fire-days for a set of categories count each cell-day once: the per-category day masks are OR-ed within a
// cell and 10-day period before counting. Harmonized fire-days scale that union by the selected categories' own
// conversion (sum harm_fd / sum fd_base), which is exact from NOAA-20 on (ratio 1).
export function cellDekadsSQL(urls, ranges, cats, byCategory = false) {
  const g = byCategory ? ', category' : '';
  const fd = ['', '_lo', '_hi'].map((s) => `coalesce(sum(harm_fd${s}) * bit_count(bit_or(day_mask)) / nullif(sum(fd_base), 0), 0) AS harm_fd${s}`);
  return `(SELECT cell_id, year, month, dekad, harm_from${g}, sum(harm_n) AS harm_n, sum(harm_n_lo) AS harm_n_lo, sum(harm_n_hi) AS harm_n_hi,
    bit_count(bit_or(day_mask)) AS fd_base, ${fd.join(', ')}, max(processing) AS processing,
    ${SENSORS.map((c) => `sum(${c}) AS ${c}`).join(', ')}, sum(n_lowconf) AS n_lowconf
  FROM ${fileList(urls)} WHERE ${rangesSQL(ranges)} AND ${catsSQL(cats)} GROUP BY cell_id, year, month, dekad, harm_from${g})`;
}

export function yearsBetween(from, to) {
  const out = [];
  for (let y = from; y <= to; y++) out.push(y);
  return out;
}

// Base period 2003-2025 (CONTRACTS section 2), limited to the years the data covers.
export function baseYearsFor(meta) {
  return yearsBetween(2003, 2025).filter((y) => y >= +meta.coverage_start.slice(0, 4) && y <= +meta.coverage_end.slice(0, 4));
}

// One row per (year, month); harm_from is the source carrying the most weight that month.
export function calendarSQL(urls, ranges, cats, metric, range, byCategory = false) {
  const m = metricCol(metric);
  const cat = byCategory ? 'category::INT AS category, ' : '';
  const g = byCategory ? 'category, ' : '';
  return `SELECT ${cat}year::INT AS year, month::INT AS month, sum(v)::DOUBLE AS value, sum(lo)::DOUBLE AS lo, sum(hi)::DOUBLE AS hi,
  arg_max(harm_from, v)::INT AS harm_from, bool_or(p) AS provisional, sum(raw)::INT AS raw, sum(lowconf)::INT AS lowconf
FROM (SELECT ${g}year, month, harm_from, sum(${m}) AS v, sum(${m}_lo) AS lo, sum(${m}_hi) AS hi,
    bool_or(processing = 1) AS p, sum(${RAW}) AS raw, sum(n_lowconf) AS lowconf
  FROM ${cellDekadsSQL(urls, ranges, cats, byCategory)}
  WHERE ${monthsSQL(range)}
  GROUP BY ${g}year, month, harm_from)
GROUP BY ${g}year, month ORDER BY ${g}year, month`;
}

export function dekadSeriesSQL(urls, ranges, cats, metric) {
  return `SELECT year::INT AS year, month::INT AS month, dekad::INT AS dekad, sum(${metricCol(metric)})::DOUBLE AS value
FROM ${cellDekadsSQL(urls, ranges, cats)}
GROUP BY year, month, dekad ORDER BY year, month, dekad`;
}

export function annualSQL(urls, ranges, cats, metric) {
  const m = metricCol(metric);
  return `SELECT year::INT AS year, sum(${m})::DOUBLE AS value, sum(${m}_lo)::DOUBLE AS lo, sum(${m}_hi)::DOUBLE AS hi,
  sum(n_terra)::INT AS n_terra, sum(n_aqua)::INT AS n_aqua, sum(n_snpp)::INT AS n_snpp, sum(n_noaa20)::INT AS n_noaa20, sum(n_noaa21)::INT AS n_noaa21
FROM ${cellDekadsSQL(urls, ranges, cats)}
GROUP BY year ORDER BY year`;
}

export function sensorTotalsSQL(urls, ranges, cats, range) {
  return `SELECT coalesce(sum(n_terra), 0)::INT AS n_terra, coalesce(sum(n_aqua), 0)::INT AS n_aqua, coalesce(sum(n_snpp), 0)::INT AS n_snpp,
  coalesce(sum(n_noaa20), 0)::INT AS n_noaa20, coalesce(sum(n_noaa21), 0)::INT AS n_noaa21
FROM ${cellDekadsSQL(urls, ranges, cats)} WHERE ${monthsSQL(range)}`;
}

// One pass over the dekad files for everything the main page shows (each extra pass costs a round of file reads).
export function overviewSQL(urls, ranges, cats) {
  return `SELECT year::INT AS year, month::INT AS month, dekad::INT AS dekad, harm_from::INT AS harm_from,
  sum(harm_n)::DOUBLE AS harm_n, sum(harm_n_lo)::DOUBLE AS harm_n_lo, sum(harm_n_hi)::DOUBLE AS harm_n_hi,
  sum(harm_fd)::DOUBLE AS harm_fd, sum(harm_fd_lo)::DOUBLE AS harm_fd_lo, sum(harm_fd_hi)::DOUBLE AS harm_fd_hi,
  bool_or(processing = 1) AS provisional, ${SENSORS.map((c) => `sum(${c})::INT AS ${c}`).join(', ')}, sum(n_lowconf)::INT AS lowconf
FROM ${cellDekadsSQL(urls, ranges, cats)}
GROUP BY year, month, dekad, harm_from ORDER BY year, month, dekad, harm_from`;
}

// Same rows as calendarSQL + fillMonths, computed from overviewSQL rows.
export function overviewCalendar(rows, metric, range) {
  const m = metricCol(metric);
  const a = ym(range.from);
  const b = ym(range.to);
  const months = new Map();
  for (const r of rows) {
    const k = r.year * 100 + r.month;
    if (k < a.year * 100 + a.month || k > b.year * 100 + b.month) continue;
    let o = months.get(k);
    if (!o) months.set(k, o = { year: r.year, month: r.month, value: 0, lo: 0, hi: 0, harm_from: null, provisional: false, raw: 0, lowconf: 0, w: new Map() });
    o.value += r[m];
    o.lo += r[`${m}_lo`];
    o.hi += r[`${m}_hi`];
    o.provisional = o.provisional || !!r.provisional;
    o.raw += SENSORS.reduce((t, c) => t + r[c], 0);
    o.lowconf += r.lowconf;
    o.w.set(r.harm_from, (o.w.get(r.harm_from) || 0) + r[m]);
  }
  return fillMonths([...months.values()].map(({ w, ...o }) => ({ ...o, harm_from: [...w].sort((p, q) => q[1] - p[1])[0][0] })), range);
}

export function overviewDekads(rows, metric) {
  const m = metricCol(metric);
  const out = new Map();
  for (const r of rows) {
    const k = (r.year * 12 + r.month) * 4 + r.dekad;
    const o = out.get(k);
    if (o) o.value += r[m];
    else out.set(k, { year: r.year, month: r.month, dekad: r.dekad, value: r[m] });
  }
  return [...out.values()];
}

export function overviewSensors(rows, range) {
  const a = ym(range.from);
  const b = ym(range.to);
  const out = Object.fromEntries(SENSORS.map((c) => [c, 0]));
  for (const r of rows) {
    const k = r.year * 100 + r.month;
    if (k >= a.year * 100 + a.month && k <= b.year * 100 + b.month) for (const c of SENSORS) out[c] += r[c];
  }
  return out;
}

const pointsWhere = (urls, ranges, cats, range) => `FROM ${fileList(urls)}
WHERE ${rangesSQL(ranges)} AND ${datesSQL(range)} AND ${catsSQL(cats)}`;

export function pointsSQL(urls, ranges, cats, range, limit) {
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new TypeError('limit must be a positive integer');
  return `SELECT ${POINT_COLUMNS.join(', ')} ${pointsWhere(urls, ranges, cats, range)}${limit ? ` LIMIT ${limit}` : ''}`;
}

export function pointsCSVSQL(urls, ranges, cats, range) {
  const names = CATEGORY_NAMES.map((n, i) => `WHEN ${i} THEN '${n}'`).join(' ');
  return `SELECT ${POINT_COLUMNS.join(', ')}, CASE category ${names} END AS category_name ${pointsWhere(urls, ranges, cats, range)}
ORDER BY acq_date, acq_time, cell_id`;
}

export function pointsCountSQL(urls, ranges, cats, range) {
  return `SELECT count(*)::INT AS n ${pointsWhere(urls, ranges, cats, range)}`;
}

// Timelapse: only the four columns a frame needs, for a window of whole days {from, to: 'YYYY-MM-DD'}.
export function timelapseSQL(urls, ranges, cats, window) {
  for (const d of [window.from, window.to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TypeError(`Date must be YYYY-MM-DD, got ${d}`);
  return `SELECT acq_date, lat, lon, category FROM ${fileList(urls)}
WHERE ${rangesSQL(ranges)} AND acq_date BETWEEN DATE '${window.from}' AND DATE '${window.to}' AND ${catsSQL(cats)}
ORDER BY acq_date`;
}

// Months with no rows in the files had no detections: they are zeros, not missing.
export function fillMonths(rows, range) {
  const a = ym(range.from);
  const b = ym(range.to);
  const have = new Map(rows.map((r) => [r.year * 12 + r.month - 1, r]));
  const out = [];
  for (let k = a.year * 12 + a.month - 1; k <= b.year * 12 + b.month - 1; k++) {
    const year = Math.floor(k / 12);
    const month = (k % 12) + 1;
    out.push(have.get(k) || { year, month, value: 0, lo: 0, hi: 0, harm_from: null, provisional: false, raw: 0, lowconf: 0 });
  }
  return out;
}

// Monthly table for the CSV. Percentile and z-score come from calendarModel, so they match the calendar tooltips.
export function monthlyTable(fullRows, range, baseYears, gapRows) {
  const a = ym(range.from);
  const b = ym(range.to);
  const byYM = new Map(fullRows.map((r) => [r.year * 12 + r.month, r]));
  const round = (v, d) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
  return calendarModel(fullRows, { baseYears, gaps: gapRows }).years.flatMap((y) => y.cells).filter((c) => {
    const k = c.year * 100 + c.month;
    return c.state !== 'empty' && k >= a.year * 100 + a.month && k <= b.year * 100 + b.month;
  }).sort((p, q) => p.year - q.year || p.month - q.month).map((c) => {
    const r = byYM.get(c.year * 12 + c.month) || {};
    const source = c.tip.find((t) => t.startsWith('Source: '));
    const nodata = c.state === 'nodata';
    return {
      year: c.year, month: c.month,
      value: nodata ? null : round(c.value, 3), lo: nodata ? null : round(r.lo ?? 0, 3), hi: nodata ? null : round(r.hi ?? 0, 3),
      percentile: nodata ? null : round(c.pct, 1), z_score: nodata ? null : round(c.z, 2),
      source: nodata ? 'no satellite data' : (source ? source.slice(8) : ''), provisional: !!r.provisional,
    };
  });
}

// ---------- data access ----------

let coverageYears = null; // set by meta(); the dekad and points files exist for exactly these years

function years(range) {
  if (!coverageYears) throw new Error("Couldn't load meta.json: the data coverage period is unknown");
  if (!range) return coverageYears;
  const a = ym(range.from).year;
  const b = ym(range.to).year;
  return coverageYears.filter((y) => y >= a && y <= b);
}
let dekadTiles = null; // tile ids holding archive years (<= archiveEnd), from meta.json
let archiveEnd = null;
export const tileOf = (cellId) => Math.floor(Math.floor(cellId / 3600) / 50) * 72 + Math.floor((cellId % 3600) / 50);
// Files an area query needs: the 5-degree tiles it overlaps (archive years), plus one file per later year.
export function dekadFiles(ids, yrs, tiles, end) {
  const out = [];
  if (yrs.some((y) => y <= end)) {
    const want = new Set(ids.map(tileOf));
    for (const t of tiles) if (want.has(t)) out.push(`dekad_t${t}.parquet`);
  }
  for (const y of yrs) if (y > end) out.push(`dekad_${y}.parquet`);
  return out;
}
const dekadUrls = (db, range, area) => (dekadTiles
  ? dekadFiles(area.ids, years(range), dekadTiles, archiveEnd)
  : years(range).map((y) => `dekad_${y}.parquet`)).map((f) => db.url('dekad', f));
const pointUrls = (db, range) => years(range).map((y) => db.url('points', `points_${y}.parquet`));
const fullRange = () => ({ from: `${coverageYears[0]}-01`, to: `${coverageYears[coverageYears.length - 1]}-12` });
// Trim the zero-fill to the months the data covers, so months after the last acquisition are not shown as 0.
let coverageMonths = null;
const clip = (range) => ({
  from: range.from < coverageMonths.from ? coverageMonths.from : range.from,
  to: range.to > coverageMonths.to ? coverageMonths.to : range.to,
});

export async function meta(config) {
  try {
    const res = await fetch(config.data.tables + 'meta.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const m = await res.json();
    coverageYears = yearsBetween(+m.coverage_start.slice(0, 4), +m.coverage_end.slice(0, 4));
    coverageMonths = { from: m.coverage_start.slice(0, 7), to: m.coverage_end.slice(0, 7) };
    [dekadTiles, archiveEnd] = Array.isArray(m.dekad_tiles) ? [m.dekad_tiles, m.archive_end] : [null, null];
    return m;
  } catch {
    return null;
  }
}

export async function coverage(db) {
  const rows = await db.query(`SELECT cell_id FROM read_parquet('${db.url('tables', 'cells.parquet')}') WHERE in_coverage`);
  return new Set(rows.map((r) => r.cell_id));
}

export async function calendar(db, area, range, cats, metric) {
  const urls = dekadUrls(db, range, area);
  if (!urls.length) return [];
  return fillMonths(await db.query(calendarSQL(urls, area.ranges, cats, metric, range)), clip(range));
}

// Unconverted fire-days (distinct cell-days with an in-chain detection) for the selection: the cross-check's
// independent comparison against distinct (cell, date) counted in the points files.
export async function fireDaysBase(db, area, range, cats) {
  const [r] = await db.query(`SELECT coalesce(sum(fd_base), 0)::BIGINT AS fd FROM ${cellDekadsSQL(dekadUrls(db, range, area), area.ranges, cats)} WHERE ${monthsSQL(range)}`);
  return r.fd;
}

export const dekadSeries = (db, area, cats, metric) => db.query(dekadSeriesSQL(dekadUrls(db, null, area), area.ranges, cats, metric));
export const annual = (db, area, cats, metric) => db.query(annualSQL(dekadUrls(db, null, area), area.ranges, cats, metric));

// Everything the main page needs from one query: both calendars, the dekad series and raw counts by satellite.
export async function overview(db, area, range, cats, metric) {
  const rows = await db.query(overviewSQL(dekadUrls(db, null, area), area.ranges, cats));
  return {
    calendars: { harm_n: overviewCalendar(rows, 'harm_n', clip(range)), harm_fd: overviewCalendar(rows, 'harm_fd', clip(range)) },
    dekadRows: overviewDekads(rows, metric),
    sensors: overviewSensors(rows, range),
  };
}

export async function sensorTotals(db, area, range, cats) {
  const urls = dekadUrls(db, range, area);
  return urls.length ? (await db.query(sensorTotalsSQL(urls, area.ranges, cats, range)))[0] : null;
}

export async function categoryCalendars(db, area, range, metric) {
  const all = CATEGORY_NAMES.map((_, i) => i);
  const urls = dekadUrls(db, range, area);
  const rows = urls.length ? await db.query(calendarSQL(urls, area.ranges, all, metric, range, true)) : [];
  return new Map(all.map((c) => [c, fillMonths(rows.filter((r) => r.category === c), clip(range))]));
}

// Static-mask cells (0.01 degree) inside a [w, s, e, n] box, most persistent first; `total` is the count before the limit.
export function maskCellsSQL(url, [w, s, e, n], limit) {
  if (![w, s, e, n].every(Number.isFinite)) throw new TypeError('Bounding box must be four numbers');
  if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError('limit must be a positive integer');
  const idx = (deg) => Math.round(deg * 1e6) / 1e4; // in 0.01 degree steps, without float noise
  const [r0, r1] = [Math.floor(idx(s + 90)), Math.ceil(idx(n + 90)) - 1];
  const [c0, c1] = [Math.floor(idx(w + 180)), Math.ceil(idx(e + 180)) - 1];
  return `SELECT (cell001_id // 36000)::INT AS r, (cell001_id % 36000)::INT AS c, reason, n_days_max::INT AS n_days_max, (count(*) OVER ())::INT AS total
FROM ${fileList([url])}
WHERE cell001_id // 36000 BETWEEN ${r0} AND ${r1} AND cell001_id % 36000 BETWEEN ${c0} AND ${c1}
ORDER BY n_days_max DESC, cell001_id LIMIT ${limit}`;
}

export async function maskCells(db, area, limit = 5000) {
  const g = area.geometry;
  const pts = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flatMap((p) => p[0]);
  const bbox = pts.reduce(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const cells = await db.query(maskCellsSQL(db.url('tables', 'static_mask.parquet'), bbox, limit));
  return { cells, total: cells.length ? cells[0].total : 0 };
}

export function gaps(db) {
  return db.query(`SELECT year::INT AS year, month::INT AS month, dekad::INT AS dekad, chain_satellite, filled_from
FROM read_parquet('${db.url('tables', 'gaps.parquet')}') ORDER BY year, month, dekad`);
}

export async function points(db, area, range, cats, { limit } = {}) {
  const urls = pointUrls(db, range);
  return urls.length ? db.query(pointsSQL(urls, area.ranges, cats, range, limit)) : [];
}

export async function pointsCount(db, area, range, cats) {
  const urls = pointUrls(db, range);
  return urls.length ? (await db.query(pointsCountSQL(urls, area.ranges, cats, range)))[0].n : 0;
}

// Rows for the timelapse; the panel groups them into frames (panel-timelapse.js framesFrom).
export async function timelapsePoints(db, area, window, cats) {
  const urls = pointUrls(db, { from: window.from.slice(0, 7), to: window.to.slice(0, 7) });
  return urls.length ? db.query(timelapseSQL(urls, area.ranges, cats, window)) : [];
}

export function pointsCSV(db, area, range, cats) {
  return db.toCSV(pointsCSVSQL(pointUrls(db, range), area.ranges, cats, range));
}

export async function aggregatesCSV(db, area, range, cats, metric) {
  const [full, gapRows] = await Promise.all([calendar(db, area, fullRange(), cats, metric), gaps(db)]);
  const rows = monthlyTable(full, range, coverageYears.filter((y) => y >= 2003 && y <= 2025), gapRows);
  const columns = ['year', 'month', 'value', 'lo', 'hi', 'percentile', 'z_score', 'source', 'provisional'];
  return new Blob([csvLines(columns, rows)], { type: 'text/csv;charset=utf-8' });
}
