import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualFromCalendar, anomalyRows, sensorRows, spreadLabels, yearTicks, annualCSVRows, ANNUAL_CSV_COLUMNS,
  notesFor, calendarSVG, fmtPct, fmtZ,
} from '../charts.js';
import { calendarModel } from '../calendar.js';

// months m0..m1 of one year; every month has the same value, lo and hi
const months = (year, m0, m1, value, lo = value, hi = value) => {
  const rows = [];
  for (let m = m0; m <= m1; m++) rows.push({ year, month: m, value, lo, hi });
  return rows;
};
const END = new Date('2026-11-13');

test('annualFromCalendar sums months and flags incomplete years', () => {
  const rows = [...months(2000, 11, 12, 5, 4, 7), ...months(2001, 1, 12, 10, 8, 13), ...months(2025, 1, 12, 2), ...months(2026, 1, 11, 3)];
  const a = annualFromCalendar(rows, [], END);
  assert.deepEqual(a.map((r) => [r.year, r.value, r.lo, r.hi, r.months, r.complete, r.band]), [
    [2000, 10, 8, 14, 2, false, true],
    [2001, 120, 96, 156, 12, true, true],
    [2025, 24, 24, 24, 12, true, false],
    [2026, 33, 33, 33, 11, false, false],
  ]);
  assert.deepEqual(annualFromCalendar([], [], END), []);
});

test('annualFromCalendar: 12 months are not a complete year until the data reaches 31 December', () => {
  const rows = months(2026, 1, 12, 1);
  assert.equal(annualFromCalendar(rows, [], new Date('2026-12-13'))[0].complete, false);
  assert.equal(annualFromCalendar(rows, [], new Date('2026-12-31'))[0].complete, true);
});

test('annualFromCalendar flags a year with an unfilled gap dekad, not a filled one', () => {
  const rows = [...months(2001, 1, 12, 1), ...months(2002, 1, 12, 1), ...months(2003, 1, 6, 1)];
  const gaps = [
    { year: 2001, month: 6, dekad: 2, chain_satellite: 'Terra', filled_from: null },
    { year: 2002, month: 8, dekad: 1, chain_satellite: 'Aqua', filled_from: 'Terra' },
    { year: 2003, month: 9, dekad: 1, chain_satellite: 'Aqua', filled_from: null }, // outside the selected months
  ];
  assert.deepEqual(annualFromCalendar(rows, gaps, END).map((r) => r.nodata), [true, false, false]);
});

test('anomalyRows: percent, percentile, z and colour bin against complete base years', () => {
  const annual = [
    { year: 2002, value: 100, complete: true, nodata: true }, // base year with missing data: not in the base
    ...[10, 20, 30, 40, 50].map((value, i) => ({ year: 2003 + i, value, complete: true, nodata: false })),
    { year: 2008, value: 60, complete: true, nodata: false }, // not a base year
    { year: 2009, value: 5, complete: false, nodata: false },
  ];
  const out = anomalyRows(annual, [2002, 2003, 2004, 2005, 2006, 2007]);
  assert.equal(out.median, 30);
  assert.deepEqual(out.baseYears, [2003, 2004, 2005, 2006, 2007]);
  const by = Object.fromEntries(out.rows.map((r) => [r.year, r]));
  assert.equal(by[2005].pct, 0);
  assert.equal(by[2005].percentile, 50);
  assert.equal(by[2005].bin, 3);
  assert.equal(by[2005].z, 0);
  assert.equal(by[2003].percentile, 10);
  assert.equal(by[2003].bin, 0);
  assert.equal(by[2008].pct, 100);
  assert.equal(by[2008].percentile, 100);
  assert.equal(by[2008].bin, 6);
  assert.ok(Math.abs(by[2008].z - 30 / Math.sqrt(250)) < 1e-12);
  assert.deepEqual([by[2009].pct, by[2009].percentile, by[2009].z, by[2009].bin], [null, null, null, null]);
});

test('anomalyRows: zero median gives no percent; no base years gives a null median', () => {
  const zero = anomalyRows([2003, 2004, 2005].map((year) => ({ year, value: 0, complete: true, nodata: false })), [2003, 2004, 2005]);
  assert.equal(zero.median, 0);
  assert.equal(zero.rows[0].pct, null);
  assert.equal(anomalyRows([{ year: 2026, value: 4, complete: false, nodata: false }], [2003]).median, null);
});

test('sensorRows: null before launch, real zeros after, and years cut by the selected dates are dropped', () => {
  const meta = { coverage_start: '2000-11-01', coverage_end: '2026-11-13', chain: { aqua_start: '2002-08-01', snpp_start: '2012-02-01', noaa20_start: '2018-04-01' } };
  const annual = [
    { year: 2000, months: 2, complete: false }, // all the months the data has for 2000
    { year: 2001, months: 12, complete: true, nodata: true },
    { year: 2019, months: 12, complete: true },
    { year: 2020, months: 5, complete: false }, // the selected dates end in May 2020
  ];
  const q = [
    { year: 2000, n_terra: 3, n_aqua: 0, n_snpp: 0, n_noaa20: 0 },
    { year: 2019, n_terra: 0, n_aqua: 4, n_snpp: 9, n_noaa20: 11 },
    { year: 2020, n_terra: 1, n_aqua: 1, n_snpp: 1, n_noaa20: 1 },
  ];
  const out = sensorRows(q, annual, meta);
  assert.deepEqual(out.dropped, [2020]);
  assert.deepEqual(out.rows, [
    { year: 2000, complete: false, months: 2, nodata: false, n_terra: 3, n_aqua: null, n_snpp: null, n_noaa20: null },
    { year: 2001, complete: true, months: 12, nodata: true, n_terra: 0, n_aqua: null, n_snpp: null, n_noaa20: null },
    { year: 2019, complete: true, months: 12, nodata: false, n_terra: 0, n_aqua: 4, n_snpp: 9, n_noaa20: 11 },
  ]);
});

test('spreadLabels keeps labels at least minGap apart and leaves spaced ones alone', () => {
  assert.deepEqual(spreadLabels([{ value: 10, text: 'b' }, { value: 0, text: 'a' }, { value: 11, text: 'c' }, { value: 50, text: 'd' }], 5).map((l) => [l.text, l.y]),
    [['a', 0], ['b', 10], ['c', 15], ['d', 50]]);
  assert.deepEqual(spreadLabels([], 5), []);
});

test('yearTicks', () => {
  const years = Array.from({ length: 27 }, (_, i) => 2000 + i);
  assert.deepEqual(yearTicks(years, 30), years);
  assert.deepEqual(yearTicks(years, 6), [2000, 2005, 2010, 2015, 2020, 2025]);
  assert.deepEqual(yearTicks([2001, 2002, 2003], 1), [2001]); // no multiple of 5 in range: first year
  assert.deepEqual(yearTicks([], 5), []);
});

test('annualCSVRows: columns, rounding and blanks for incomplete years', () => {
  const annual = [
    ...[10, 20, 30, 40, 50].map((value, i) => ({ year: 2003 + i, value, lo: value - 1.23456, hi: value + 1, complete: true, nodata: false })),
    { year: 2008, value: 7.00049, lo: 7, hi: 7, complete: false, nodata: false },
  ];
  const rows = annualCSVRows(annual, [2003, 2004, 2005, 2006, 2007]);
  assert.deepEqual(Object.keys(rows[0]), ANNUAL_CSV_COLUMNS);
  assert.deepEqual(rows[4], { year: 2007, value: 50, lo: 48.765, hi: 51, anomaly_pct: 66.7, percentile: 90, z_score: 1.26, complete: true });
  assert.deepEqual(rows[5], { year: 2008, value: 7, lo: 7, hi: 7, anomaly_pct: null, percentile: null, z_score: null, complete: false });
});

test('notes and number formats', () => {
  assert.deepEqual(notesFor({ complete: true, nodata: false }), []);
  assert.deepEqual(notesFor({ complete: false, months: 2, nodata: true }),
    ['Incomplete year: 2 of 12 months', 'Includes a month with no satellite data, so the total is too low']);
  assert.equal(fmtPct(12.34), '+12%');
  assert.equal(fmtPct(-3.21), '−3.2%');
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtZ(-1.26), '−1.3');
  assert.equal(fmtZ(null), '—');
});

test('calendarSVG draws one coloured cell per month with data, from the given colours only', () => {
  const rows = [...months(2024, 11, 12, 0), ...months(2025, 1, 12, 40)];
  rows[1].value = 7; // Dec 2024
  const model = calendarModel(rows, { mode: 'counts', baseYears: [2025], gaps: [] });
  const css = (name) => `{${name}}`;
  const svg = calendarSVG(model, css, 'A <title> & more');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('A &lt;title&gt; &amp; more'));
  // background + 14 months in range + 12 typical cells; the 10 months before Nov 2024 are not drawn
  assert.equal(svg.match(/<rect /g).length, 1 + 14 + 12);
  assert.ok(svg.includes('>2025</text>') && svg.includes('>Typical</text>') && svg.includes('>Dec</text>'));
  assert.ok(/fill="\{--seq-\d\}"/.test(svg) && /fill="\{--seq-\d-ink\}"/.test(svg));
  assert.ok(!/#[0-9a-f]{6}/i.test(svg)); // no colour that did not come from css()
  const anomaly = calendarSVG(calendarModel(rows, { mode: 'anomaly', baseYears: [2025], gaps: [] }), css);
  assert.ok(anomaly.includes('{--div-4}') && !anomaly.includes('--seq-'));
});
