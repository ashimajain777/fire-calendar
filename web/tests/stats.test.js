import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median, percentileRank, zScore, anomalyPct, anomalyBin,
  monthToDate, rankings, season, dekadToDateLabel,
} from '../stats.js';

const BASE = Array.from({ length: 23 }, (_, i) => 2003 + i); // 2003..2025

// all 36 dekads for every year; fn(year, dekadIndex) -> value
const dekads = (y0, y1, fn) => {
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    for (let i = 0; i < 36; i++) rows.push({ year: y, month: Math.floor(i / 3) + 1, dekad: (i % 3) + 1, value: fn(y, i) });
  }
  return rows;
};

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([0, 0, 0]), 0);
  assert.equal(median([]), null);
});

test('percentileRank', () => {
  assert.equal(percentileRank(5, [1, 5, 9]), 50);
  assert.equal(percentileRank(10, [1, 5, 9]), 100);
  assert.equal(percentileRank(0, [1, 5, 9]), 0);
  assert.equal(percentileRank(0, [0, 0, 0]), 50); // all-zero base is "typical", not "0th percentile"
  assert.equal(percentileRank(1, []), null);
});

test('Review Focus 4: zero base gives null, never NaN or Infinity', () => {
  assert.equal(zScore(3, [0, 0, 0, 0, 0]), null);
  assert.equal(anomalyPct(3, [0, 0, 0]), null);
  assert.equal(anomalyPct(3, []), null);
  assert.equal(zScore(3, [1, 2, 3, 4]), null); // n < 5
});

test('zScore uses the sample sd; anomalyPct uses the median', () => {
  assert.ok(Math.abs(zScore(4, [1, 2, 3, 4, 5]) - 0.632) < 0.001);
  assert.equal(anomalyPct(15, [5, 10, 20]), 50);
});

test('anomalyBin', () => {
  assert.equal(anomalyBin(9.9), 0);
  assert.equal(anomalyBin(10), 0);
  assert.equal(anomalyBin(20), 1);
  assert.equal(anomalyBin(30), 2);
  assert.equal(anomalyBin(50), 3);
  assert.equal(anomalyBin(70), 4);
  assert.equal(anomalyBin(80), 5);
  assert.equal(anomalyBin(90), 6);
  assert.equal(anomalyBin(100), 6);
});

// value encodes year, month and dekad so sums are checkable
const mtdRows = dekads(2003, 2026, (y, i) => (y - 2000) * 1000 + (Math.floor(i / 3) + 1) * 10 + (i % 3) + 1);
const val = (y, m, d) => (y - 2000) * 1000 + m * 10 + d;

test('Review Focus 3: no complete dekad yet -> last complete month', () => {
  const r = monthToDate(mtdRows, new Date('2026-11-05'), BASE);
  assert.equal(r.mode, 'last_month');
  assert.equal(r.year, 2026);
  assert.equal(r.month, 10);
  assert.deepEqual(r.dekads, [1, 2, 3]);
  assert.equal(r.current, val(2026, 10, 1) + val(2026, 10, 2) + val(2026, 10, 3));
  assert.equal(r.base.length, 23);
  assert.equal(r.base[0], val(2003, 10, 1) + val(2003, 10, 2) + val(2003, 10, 3));
});

test('Review Focus 3: month-to-date uses only complete dekads', () => {
  const r = monthToDate(mtdRows, new Date('2026-11-14'), BASE);
  assert.equal(r.mode, 'mtd');
  assert.equal(r.year, 2026);
  assert.equal(r.month, 11);
  assert.deepEqual(r.dekads, [1]);
  assert.equal(r.current, val(2026, 11, 1));
  assert.deepEqual(r.base, BASE.map((y) => val(y, 11, 1)));

  assert.deepEqual(monthToDate(mtdRows, new Date('2026-11-20'), BASE).dekads, [1, 2]);
  assert.deepEqual(monthToDate(mtdRows, new Date('2026-11-29'), BASE).dekads, [1, 2]);
  assert.deepEqual(monthToDate(mtdRows, new Date('2026-11-30'), BASE).dekads, [1, 2, 3]);
  assert.deepEqual(monthToDate(mtdRows, new Date('2026-02-28'), BASE).dekads, [1, 2, 3]);
});

test('monthToDate on Jan 5th -> December of the previous year, which leaves the base', () => {
  const r = monthToDate(mtdRows, new Date('2026-01-05'), BASE);
  assert.equal(r.mode, 'last_month');
  assert.equal(r.year, 2025);
  assert.equal(r.month, 12);
  assert.equal(r.current, val(2025, 12, 1) + val(2025, 12, 2) + val(2025, 12, 3));
  assert.equal(r.base.length, 22);
});

test('monthToDate: a base year with no rows counts as 0', () => {
  const rows = mtdRows.filter((r) => r.year !== 2010);
  const r = monthToDate(rows, new Date('2026-11-14'), BASE);
  assert.equal(r.base[BASE.indexOf(2010)], 0);
  assert.equal(monthToDate([], new Date('2026-11-14'), BASE).current, 0);
});

test('rankings', () => {
  const rows = [
    { year: 2020, month: 1, value: 5 }, { year: 2020, month: 2, value: 50 },
    { year: 2021, month: 1, value: 30 }, { year: 2021, month: 2, value: 10 },
    { year: 2022, month: 1, value: 0 },
  ];
  const r = rankings(rows, 2);
  assert.deepEqual(r.months, [{ year: 2020, month: 2, value: 50 }, { year: 2021, month: 1, value: 30 }]);
  assert.deepEqual(r.years, [{ year: 2020, value: 55 }, { year: 2021, value: 40 }]);
  assert.equal(rankings(rows).months.length, 4); // zeros are not "busiest"
  assert.deepEqual(rankings([]), { months: [], years: [] });
});

test('season: single season', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 9 && i <= 14 ? 20 : 0)), BASE);
  assert.equal(s.status, 'ok');
  assert.equal(s.onset, 9);
  assert.equal(s.end, 14);
  assert.equal(s.peak, 9);
  assert.equal(s.twoSeasons, false);
  assert.deepEqual(s.peaks, [9]);
  const y = s.years.find((r) => r.year === 2010);
  assert.deepEqual([y.onset, y.end, y.length], [9, 14, 6]);
  assert.deepEqual(y.flags, []);
});

test('season: crossing the year boundary', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 33 || i <= 2 ? 20 : 0)), BASE);
  assert.equal(s.status, 'ok');
  assert.ok(s.start >= 4 && s.start <= 33);
  assert.equal(s.onset, 33);
  assert.equal(s.end, 2);
  const y = s.years.find((r) => r.year === 2010);
  assert.deepEqual([y.onset, y.end, y.length], [33, 2, 6]);
  // the last season-year needs dekads of 2026, which are not in the data
  const last = s.years.find((r) => r.year === 2025);
  assert.equal(last.onset, null);
  assert.deepEqual(last.flags, []);
});

test('season: bimodal', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 11 && i <= 13 ? 40 : i >= 28 && i <= 31 ? 30 : 0)), BASE);
  assert.equal(s.status, 'ok');
  assert.equal(s.twoSeasons, true);
  assert.deepEqual(s.peaks, [11, 28]);
});

test('season: a short dip does not split one season', () => {
  const s = season(dekads(2003, 2025, (y, i) => ((i >= 9 && i <= 11) || (i >= 14 && i <= 16) ? 20 : 0)), BASE);
  assert.equal(s.twoSeasons, false);
});

test('season: insufficient', () => {
  assert.equal(season(dekads(2003, 2025, (y, i) => (i === 10 ? 20 : 0)), BASE).status, 'insufficient');
  assert.equal(season([], BASE).status, 'insufficient');
  assert.deepEqual(season([], BASE).years, []);
});

test('season: early and longer years are flagged', () => {
  const rows = dekads(2003, 2025, (y, i) => {
    if (y === 2010) return i >= 6 && i <= 11 ? 20 : 0;  // same length, 3 dekads early
    if (y === 2012) return i >= 12 && i <= 17 ? 20 : 0; // late
    if (y === 2014) return i >= 9 && i <= 18 ? 12 : 0;  // longer
    return i >= 9 && i <= 14 ? 20 : 0;
  });
  const s = season(rows, BASE);
  const f = (y) => s.years.find((r) => r.year === y);
  assert.equal(f(2010).onset, 6);
  assert.ok(f(2010).flags.includes('early'));
  assert.ok(!f(2010).flags.includes('longer') && !f(2010).flags.includes('shorter'));
  assert.ok(f(2012).flags.includes('late'));
  assert.ok(f(2014).flags.includes('longer'));
  assert.deepEqual(f(2011).flags, []);
});

test('dekadToDateLabel', () => {
  assert.equal(dekadToDateLabel(0), '1–10 Jan');
  assert.equal(dekadToDateLabel(2), '21–31 Jan');
  assert.equal(dekadToDateLabel(5), '21–28 Feb');
  assert.equal(dekadToDateLabel(28), '11–20 Oct');
  assert.equal(dekadToDateLabel(35), '21–31 Dec');
  assert.equal(dekadToDateLabel(11), '21–30 Apr');
});

test('season: a separate cluster with 10-25 % of the year is a secondary peak, not a second season', async () => {
  const { season } = await import('../stats.js');
  const rows = [];
  for (let y = 2003; y <= 2010; y++) {
    for (let i = 0; i < 36; i++) {
      // main season dekads 30-32 (Nov): 80 % of the year; spring dekads 10-11 (Apr): 18 %; a trickle elsewhere
      const v = [30, 31, 32].includes(i) ? 400 : [10, 11].includes(i) ? 135 : 1;
      rows.push({ year: y, month: Math.floor(i / 3) + 1, dekad: (i % 3) + 1, value: v });
    }
  }
  const s = season(rows, [2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010]);
  assert.equal(s.twoSeasons, false);
  assert.equal(s.secondary.length, 1);
  assert.deepEqual([s.secondary[0].from, s.secondary[0].to], [10, 11]);
  assert.ok(s.secondary[0].share > 0.17 && s.secondary[0].share < 0.19);
  // a 5 % bump is not reported
  const small = rows.map((r) => ([10, 11].includes((r.month - 1) * 3 + r.dekad - 1) ? { ...r, value: 35 } : r));
  assert.equal(season(small, [2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010]).secondary.length, 0);
});

test('season: a secondary peak that shares its trough with the main season is still found', async () => {
  const { season } = await import('../stats.js');
  // main season dekads 28-32 falling steadily through winter to a trough at dekad 9; spring bump at 10-12
  const prof = Array.from({ length: 36 }, (_, i) => {
    if (i >= 28 && i <= 32) return 500;
    if (i > 32 || i < 9) return 60 - ((i + 36 - 33) % 36) * 5; // 60, 55, ... down to 9 at the trough
    if (i === 9) return 2;
    if (i >= 10 && i <= 12) return [80, 120, 70][i - 10];
    return 1;
  });
  const rows = [];
  for (let y = 2003; y <= 2008; y++) prof.forEach((v, i) => rows.push({ year: y, month: Math.floor(i / 3) + 1, dekad: (i % 3) + 1, value: v }));
  const s = season(rows, [2003, 2004, 2005, 2006, 2007, 2008]);
  assert.equal(s.secondary.length, 1);
  assert.equal(s.secondary[0].peak, 11);
});
