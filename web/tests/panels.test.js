import test from 'node:test';
import assert from 'node:assert/strict';
import { season } from '../stats.js';
import { maskCellsSQL } from '../queries.js';
import { categorySummary, calendarRowsFor, maskFeatures, CATEGORY_ORDER } from '../panel-categories.js';
import { seasonSentence, seasonBars, climatology, seasonTable } from '../panel-season.js';

const BASE = Array.from({ length: 23 }, (_, i) => 2003 + i);
const dekads = (from, to, fn) => {
  const rows = [];
  for (let y = from; y <= to; y++) {
    for (let i = 0; i < 36; i++) {
      const value = fn(y, i);
      if (value > 0) rows.push({ year: y, month: Math.floor(i / 3) + 1, dekad: (i % 3) + 1, value });
    }
  }
  return rows;
};

// ---------- stats.season: data-coverage bounds ----------

test('season: a season-year that starts before the data does is incomplete', () => {
  // data starts 1 Nov 2000: the year 2000 only has its last six dekads
  const rows = dekads(2000, 2025, (y, i) => (y === 2000 ? (i >= 30 ? 5 : 0) : i >= 9 && i <= 14 ? 20 : 0));
  const old = season(rows, BASE).years.find((r) => r.year === 2000);
  assert.equal(old.complete, true); // without the bounds the behaviour is unchanged
  const s = season(rows, BASE, { firstDataDate: '2000-11-01', lastDataDate: '2025-12-31' });
  const y = s.years.find((r) => r.year === 2000);
  assert.equal(y.complete, false);
  assert.equal(y.onset, null);
  assert.deepEqual(y.flags, []);
  assert.equal(s.years.find((r) => r.year === 2001).complete, true);
});

test('season: completeness follows the last data date, not the newest row', () => {
  // a quiet area: nothing detected after May 2025, but the data runs to 13 Nov 2026
  const rows = dekads(2003, 2025, (y, i) => (i >= 9 && i <= 14 ? 20 : 0));
  assert.equal(season(rows, BASE).years.find((r) => r.year === 2025).complete, false);
  const s = season(rows, BASE, { firstDataDate: new Date('2000-11-01'), lastDataDate: new Date('2026-11-13') });
  const y = s.years.find((r) => r.year === 2025);
  assert.equal(y.complete, true);
  assert.deepEqual([y.onset, y.end], [9, 14]);
  // 2026 has no rows; its season-year needs data to 10 Jan 2027, so it is listed as incomplete
  const last = s.years.find((r) => r.year === 2026);
  assert.equal(last.complete, false);
  assert.equal(last.onset, null);
  // a dekad counts only once its last day is in the data
  const edge = (d) => season(rows, BASE, { lastDataDate: d }).years.find((r) => r.year === 2025).complete;
  assert.equal(edge('2026-01-09'), false);
  assert.equal(edge('2026-01-10'), true);
});

// ---------- categories ----------

const month = (value, raw, extra = {}) => ({ year: 2020, month: 1, value, raw, lo: value, hi: value, ...extra });

test('categorySummary: order, totals, shares', () => {
  const byCat = new Map([
    [0, [month(10, 8), month(30, 12)]], [1, [month(0, 0)]], [2, []], [3, [month(5, 5)]],
    [4, [month(1, 1)]], [5, [month(50, 60)]], [6, [month(0, 4)]], [7, [month(0, 10)]],
  ]);
  const s = categorySummary(byCat);
  assert.deepEqual(s.rows.map((r) => r.category), [0, 1, 2, 3, 5, 4, 6, 7]);
  assert.deepEqual(CATEGORY_ORDER, [0, 1, 2, 3, 5, 4, 6, 7]);
  assert.equal(s.total, 96);
  assert.equal(s.raw, 100);
  const by = (c) => s.rows.find((r) => r.category === c);
  assert.deepEqual([by(0).total, by(0).raw, by(0).share], [40, 20, 0.2]);
  assert.equal(by(5).name, 'Industrial / static');
  assert.equal(by(5).share, 0.6);
  assert.equal(by(0).harmonized, true);
  // volcanic and offshore carry weight 0: no harmonized total, raw detections instead
  assert.deepEqual([by(6).harmonized, by(6).total, by(6).raw], [false, null, 4]);
  assert.equal(by(7).share, 0.1);
  assert.deepEqual(s.rows.filter((r) => r.any).map((r) => r.category), [0, 3, 5, 4, 6, 7]);
  assert.equal(Math.round(s.rows.reduce((t, r) => t + r.share, 0) * 1e9), 1e9);
});

test('categorySummary: nothing detected', () => {
  const s = categorySummary(new Map());
  assert.equal(s.rows.length, 8);
  assert.ok(s.rows.every((r) => !r.any && r.share === 0));
  assert.equal(s.total, 0);
});

test('calendarRowsFor: raw counts replace values for non-harmonized categories', () => {
  const rows = [month(0, 7, { harm_from: 0 })];
  assert.equal(calendarRowsFor(0, rows), rows);
  assert.deepEqual(calendarRowsFor(6, rows), [{ year: 2020, month: 1, value: 7 }]);
});

test('maskCellsSQL: 0.01 degree rows and columns of the bbox', () => {
  const sql = maskCellsSQL("data/static_mask.parquet", [86.1, 23.6, 86.5, 23.9], 5000);
  assert.match(sql, /cell001_id \/\/ 36000 BETWEEN 11360 AND 11389/);
  assert.match(sql, /cell001_id % 36000 BETWEEN 26610 AND 26649/);
  assert.match(sql, /FROM read_parquet\(\['data\/static_mask.parquet'\]\)/);
  assert.match(sql, /LIMIT 5000$/);
  assert.throws(() => maskCellsSQL('x', [0, 0, NaN, 1], 10), TypeError);
  assert.throws(() => maskCellsSQL('x', [0, 0, 1, 1], 0), TypeError);
});

test('maskFeatures: one 0.01 degree square per cell', () => {
  // row 11360, col 26610 -> lower-left corner 23.60 N, 86.10 E
  const fc = maskFeatures([{ r: 11360, c: 26610, reason: 'persistent', n_days_max: 40 }]);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  const ring = fc.features[0].geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(ring[0][0], 86.1) && near(ring[0][1], 23.6));
  assert.ok(near(ring[2][0], 86.11) && near(ring[2][1], 23.61));
  assert.deepEqual(fc.features[0].properties, { reason: 'persistent', n_days_max: 40 });
  assert.deepEqual(maskFeatures([]).features, []);
});

// ---------- season ----------

test('seasonSentence: one season', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 28 && i <= 32 ? (i === 30 ? 60 : 20) : 0)), BASE);
  assert.equal(seasonSentence(s), 'Fire season here typically runs from 11–20 Oct to 21–30 Nov and peaks around 1–10 Nov (±10 days).');
});

test('seasonSentence: two seasons get one sentence each', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 11 && i <= 13 ? 40 : i >= 28 && i <= 31 ? 30 : 0)), BASE);
  const text = seasonSentence(s);
  assert.match(text, /two fire seasons/);
  assert.match(text, /The first peaks around 21–30 Apr \(±10 days\)\./);
  assert.match(text, /The second peaks around 11–20 Oct \(±10 days\)\./);
});

test('seasonSentence: insufficient', () => {
  assert.equal(seasonSentence(season([], BASE)), 'Not enough fires in this area to define a season.');
});

test('climatology: median per dekad over the base years, missing years count as zero', () => {
  const clim = climatology([
    { year: 2003, month: 1, dekad: 1, value: 4 }, { year: 2004, month: 1, dekad: 1, value: 10 }, { year: 2005, month: 1, dekad: 1, value: 6 },
    { year: 2004, month: 12, dekad: 3, value: 9 }, { year: 2010, month: 1, dekad: 1, value: 1000 },
  ], [2003, 2004, 2005]);
  assert.equal(clim.length, 36);
  assert.equal(clim[0], 6);
  assert.equal(clim[35], 0);
});

test('seasonBars: axis starts at the circular start, a season crossing New Year is one bar', () => {
  const rows = dekads(2003, 2025, (y, i) => (i >= 33 || i <= 2 ? 20 : 0));
  const s = season(rows, BASE);
  const b = seasonBars(s, climatology(rows, BASE));
  assert.equal(b.axis.length, 36);
  assert.equal(b.axis[0], s.start);
  assert.equal(b.months.reduce((t, m) => t + m.span, 0), 36);
  assert.deepEqual(b.clim.map((c) => c.dekad), b.axis);
  assert.equal(b.clim[b.peak.k].share, 1);
  // onset is 1–10 Dec (33), end is 21–31 Jan (2): onset sits left of end on this axis
  assert.equal(b.axis[b.onset.k], 33);
  assert.equal(b.axis[b.end.k], 2);
  assert.ok(b.onset.k < b.end.k);
  assert.equal(b.onset.label, '1–10 Dec');
  assert.deepEqual(b.rows.map((r) => r.year).slice(0, 2), [2025, 2024]); // newest first
  const y = b.rows.find((r) => r.year === 2010);
  assert.equal(y.label, '2010–11');
  assert.deepEqual([y.from, y.to], [b.onset.k, b.end.k]);
  assert.equal(y.to - y.from + 1, 6);
  const last = b.rows[0];
  assert.equal(last.from, null);
  assert.deepEqual(last.badges.map((x) => x.word), ['incomplete']);
});

test('seasonBars: badges carry an icon and a word; calendar-year seasons keep a plain year label', () => {
  const rows = dekads(2003, 2025, (y, i) => {
    if (y === 2010) return i >= 6 && i <= 11 ? 20 : 0;
    if (y === 2014) return i >= 9 && i <= 18 ? 12 : 0;
    if (y === 2016) return 0;
    return i >= 9 && i <= 14 ? 20 : 0;
  });
  const s = season(rows, BASE, { firstDataDate: '2003-01-01', lastDataDate: '2026-01-10' });
  const real = seasonBars(s, climatology(rows, BASE));
  const f = (y) => real.rows.find((r) => r.year === y);
  assert.deepEqual(f(2010).badges.map((x) => x.word), ['early']);
  assert.ok(f(2014).badges.some((x) => x.word === 'longer'));
  assert.ok(real.rows.flatMap((r) => r.badges).every((x) => x.icon && x.word));
  assert.deepEqual(f(2011).badges, []);
  // a complete year with no fires has no bar and says so in words
  assert.equal(f(2016).from, null);
  assert.deepEqual(f(2016).badges.map((x) => x.word), ['no fires']);
});

test('seasonBars: a season after New Year on the circular axis is labelled by the year it falls in', () => {
  // quiet from mid-September, so the circular year starts in late September; fires peak in March and April
  const rows = dekads(2003, 2025, (y, i) => (i >= 6 && i <= 11 ? 20 : i <= 25 ? 1 : 0));
  const s = season(rows, BASE);
  assert.equal(s.start, 27);
  assert.deepEqual([s.onset, s.end], [6, 11]);
  const b = seasonBars(s, climatology(rows, BASE));
  assert.equal(b.rows.find((r) => r.year === 2010).label, '2011');
  assert.equal(seasonTable(s).find((r) => r.onset === '1–10 Mar').year.length, 4);
});

test('seasonBars / seasonTable: insufficient season gives nothing to draw', () => {
  assert.equal(seasonBars(season([], BASE), new Array(36).fill(0)), null);
  assert.deepEqual(seasonTable(season([], BASE)), []);
});

test('seasonTable: length in dekads and approximate days', () => {
  const s = season(dekads(2003, 2025, (y, i) => (i >= 9 && i <= 14 ? 20 : 0)), BASE);
  const row = seasonTable(s).find((r) => r.year === '2010');
  assert.deepEqual(row, { year: '2010', onset: '1–10 Apr', end: '21–31 May', length: '6 dekads (about 60 days)', flags: '—' });
  assert.equal(seasonTable(s)[0].year, '2025'); // newest first
});
