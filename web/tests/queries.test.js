import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarSQL, dekadSeriesSQL, annualSQL, sensorTotalsSQL, pointsSQL, pointsCSVSQL, pointsCountSQL,
  fillMonths, monthlyTable, overviewSQL, overviewCalendar, overviewDekads, overviewSensors, yearsBetween, baseYearsFor, CATEGORY_NAMES,
} from '../queries.js';

const URLS = ['u/dekad_2001.parquet', 'u/dekad_2002.parquet'];
const RANGES = [[5, 7], [10, 10]];
const RANGE = { from: '2001-03', to: '2002-02' };

test('calendarSQL has the cell predicate, the category list, the month window and only the given files', () => {
  const sql = calendarSQL(URLS, RANGES, [0, 3], 'harm_fd', RANGE);
  assert.match(sql, /\(cell_id BETWEEN 5 AND 7 OR cell_id = 10\)/);
  assert.match(sql, /category IN \(0, 3\)/);
  assert.ok(sql.includes("year::INT * 100 + month BETWEEN 200103 AND 200202"));
  assert.match(sql, /read_parquet\(\['u\/dekad_2001\.parquet', 'u\/dekad_2002\.parquet'\]\)/);
  assert.match(sql, /sum\(harm_fd_lo\)/);
  assert.match(sql, /sum\(harm_fd_hi\)/);
  assert.match(sql, /processing = 1/);
  assert.match(sql, /n_terra \+ n_aqua \+ n_snpp \+ n_noaa20 \+ n_noaa21/);
  assert.match(sql, /sum\(harm_fd\) AS v/);
  assert.match(sql, /bit_count\(bit_or\(day_mask\)\)/); // fire-days are a union across the selected categories
});

test('no builder contains a data location of its own', () => {
  const all = [
    calendarSQL(URLS, RANGES, [0], 'harm_n', RANGE), dekadSeriesSQL(URLS, RANGES, [0], 'harm_n'),
    annualSQL(URLS, RANGES, [0], 'harm_n'), sensorTotalsSQL(URLS, RANGES, [0], RANGE),
    overviewSQL(URLS, RANGES, [0]), pointsSQL(URLS, RANGES, [0], RANGE, 10), pointsCSVSQL(URLS, RANGES, [0], RANGE), pointsCountSQL(URLS, RANGES, [0], RANGE),
  ];
  for (const sql of all) {
    const literals = [...sql.matchAll(/'([^']*\.parquet)'/g)].map((m) => m[1]);
    assert.deepEqual(literals, URLS);
    assert.doesNotMatch(sql, /https?:|\.\/data|data\//);
    assert.match(sql, /\(cell_id BETWEEN 5 AND 7 OR cell_id = 10\)/);
  }
});

test('empty selections match nothing instead of producing invalid SQL', () => {
  const sql = calendarSQL(URLS, [], [], 'harm_n', RANGE);
  assert.match(sql, /WHERE FALSE AND FALSE GROUP BY/);
});

test('bad inputs are rejected, not interpolated', () => {
  assert.throws(() => calendarSQL(URLS, RANGES, [0], 'harm_n; DROP', RANGE), TypeError);
  assert.throws(() => calendarSQL(URLS, RANGES, ['0 OR 1=1'], 'harm_n', RANGE), TypeError);
  assert.throws(() => calendarSQL(URLS, RANGES, [0], 'harm_n', { from: '2001-13', to: '2002-01' }), TypeError);
  assert.throws(() => pointsSQL(URLS, RANGES, [0], RANGE, '5; --'), TypeError);
});

test('points builders filter by date, cells and category; the CSV adds a readable category', () => {
  const sql = pointsSQL(URLS, RANGES, [1, 5], { from: '2024-02', to: '2024-02' }, 20001);
  assert.match(sql, /acq_date BETWEEN DATE '2024-02-01' AND DATE '2024-02-29'/);
  assert.match(sql, /category IN \(1, 5\)/);
  assert.match(sql, /LIMIT 20001$/);
  const csv = pointsCSVSQL(URLS, RANGES, [1], RANGE);
  for (const col of ['lat', 'lon', 'acq_date', 'acq_time', 'sensor', 'satellite', 'confidence_raw', 'conf_class', 'frp', 'daynight',
    'brightness', 'firms_type', 'processing', 'version', 'cell_id', 'cell001_id', 'region_id', 'category',
    'in_baseline_chain', 'harm_weight', 'harm_weight_lo', 'harm_weight_hi']) assert.match(csv, new RegExp(`\\b${col}\\b`));
  assert.match(csv, /AS category_name/);
  for (const name of CATEGORY_NAMES) assert.ok(csv.includes(`'${name}'`));
  assert.doesNotMatch(csv, /LIMIT/);
});

test('fillMonths gives every month in range, zero where there is no row', () => {
  const row = { year: 2001, month: 4, value: 7, lo: 6, hi: 8, harm_from: 2, provisional: false, raw: 9, lowconf: 1 };
  const out = fillMonths([row], RANGE);
  assert.equal(out.length, 12);
  assert.deepEqual(out.map((r) => r.month), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]);
  assert.equal(out[1], row);
  assert.deepEqual(out[0], { year: 2001, month: 3, value: 0, lo: 0, hi: 0, harm_from: null, provisional: false, raw: 0, lowconf: 0 });
  assert.equal(out[11].year, 2002);
  assert.equal(out.reduce((s, r) => s + r.value, 0), 7);
});

test('monthlyTable keeps the months in range and takes percentile and z from the base years', () => {
  const base = [2003, 2004, 2005, 2006, 2007];
  const rows = fillMonths(base.map((y, i) => ({ year: y, month: 1, value: i + 1, lo: i, hi: i + 2, harm_from: 2, provisional: false, raw: 0, lowconf: 0 })),
    { from: '2003-01', to: '2007-12' });
  const out = monthlyTable(rows, { from: '2006-01', to: '2006-02' }, base, []);
  assert.equal(out.length, 2);
  assert.deepEqual({ ...out[0] }, { year: 2006, month: 1, value: 4, lo: 3, hi: 5, percentile: 70, z_score: 0.63, source: 'converted from Aqua MODIS', provisional: false });
  assert.equal(out[1].value, 0);
  assert.equal(out[1].z_score, null); // sd = 0
});

test('year helpers', () => {
  assert.deepEqual(yearsBetween(2000, 2003), [2000, 2001, 2002, 2003]);
  assert.deepEqual(baseYearsFor({ coverage_start: '2000-11-01', coverage_end: '2005-03-02' }), [2003, 2004, 2005]);
});

test('overview rows reduce to the calendar, the dekad series and the sensor totals', () => {
  const row = (year, month, dekad, harm_from, n, extra = {}) => ({
    year, month, dekad, harm_from, harm_n: n, harm_n_lo: n - 1, harm_n_hi: n + 1, harm_fd: 1, harm_fd_lo: 1, harm_fd_hi: 1,
    provisional: false, n_terra: 0, n_aqua: 2, n_snpp: 3, n_noaa20: 0, n_noaa21: 0, lowconf: 1, ...extra,
  });
  const rows = [row(2001, 4, 1, 2, 10), row(2001, 4, 1, 3, 4), row(2001, 4, 3, 2, 5, { provisional: true }), row(2003, 1, 1, 1, 99)];
  const cal = overviewCalendar(rows, 'harm_n', RANGE);
  assert.equal(cal.length, 12);
  assert.deepEqual(cal[1], { year: 2001, month: 4, value: 19, lo: 16, hi: 22, harm_from: 2, provisional: true, raw: 15, lowconf: 3 });
  assert.equal(cal[0].value, 0);
  assert.equal(overviewCalendar(rows, 'harm_fd', RANGE)[1].value, 3);
  assert.deepEqual(overviewDekads(rows, 'harm_n'), [
    { year: 2001, month: 4, dekad: 1, value: 14 }, { year: 2001, month: 4, dekad: 3, value: 5 }, { year: 2003, month: 1, dekad: 1, value: 99 },
  ]);
  assert.deepEqual(overviewSensors(rows, RANGE), { n_terra: 0, n_aqua: 6, n_snpp: 9, n_noaa20: 0, n_noaa21: 0 });
});
