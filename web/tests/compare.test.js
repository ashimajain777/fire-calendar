import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, sharedScale, monthOfYearTotals, periodTotal, checkBBox, checkSpan, syncKey } from '../panel-compare.js';
import { calendarModel, quantileBins } from '../calendar.js';

// two years of months; value function per side
const cal = (fn, years = [2020, 2021]) => years.flatMap((y) => Array.from({ length: 12 }, (_, i) => ({ year: y, month: i + 1, value: fn(y, i + 1) })));
const A = cal((y, m) => (m === 11 ? 1000 + (y - 2020) * 500 : m === 4 ? 200 : 0));
const B = cal((y, m) => (m === 10 ? 3000 : m === 4 ? 100 * (y - 2019) : 0));

test('monthOfYearTotals and periodTotal add up the rows', () => {
  const mo = monthOfYearTotals(A);
  assert.equal(mo[10], 2500);
  assert.equal(mo[3], 400);
  assert.equal(mo.reduce((t, v) => t + v, 0), periodTotal(A));
  assert.equal(periodTotal(A), 2900);
  assert.equal(periodTotal(B), 6300);
});

test('diffRows: totals equal each side\'s row sums; busiest month and year; month-of-year rows', () => {
  const rows = diffRows(A, B);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows[0], { label: 'Total for the period', a: 2900, b: 6300, aNote: null, bNote: null, diff: 3400, pct: (3400 / 2900) * 100 });
  assert.equal(rows[1].aNote, 'Nov 2021');
  assert.equal(rows[1].a, 1500);
  assert.equal(rows[1].b, 3000);
  assert.equal(rows[2].aNote, '2021');
  assert.equal(rows[2].a, 1700);
  assert.equal(rows[2].bNote, '2021');
  assert.equal(rows[2].b, 3200);
  assert.equal(rows[3].label, 'Jan total');
  assert.equal(rows[3].pct, null); // A is 0
  assert.equal(rows[13].a, 2500); // Nov
  assert.equal(rows[13].b, 0);
  assert.equal(rows[13].pct, -100);
});

test('diffRows: swapping A and B flips the sign of every difference', () => {
  const ab = diffRows(A, B);
  const ba = diffRows(B, A);
  for (const [i, r] of ab.entries()) {
    assert.equal(ba[i].diff + r.diff, 0, r.label);
    assert.ok(r.diff === 0 || Math.sign(ba[i].diff) === -Math.sign(r.diff), r.label);
    assert.equal(ba[i].a, r.b);
    assert.equal(ba[i].b, r.a);
    if (r.pct !== null && ba[i].pct !== null) assert.equal(Math.sign(ba[i].pct), -Math.sign(r.pct), r.label);
  }
});

test('diffRows: empty sides give zeros, not invented values', () => {
  const zero = cal(() => 0);
  const rows = diffRows(zero, zero);
  assert.ok(rows.every((r) => r.a === 0 && r.b === 0 && r.diff === 0 && r.pct === null));
  assert.equal(rows[1].aNote, 'none');
});

test('sharedScale: one scale, identical legend and bins on both sides', () => {
  const scale = sharedScale(A, B);
  const sorted = (xs) => [...xs].sort((x, y) => x - y);
  assert.deepEqual(sorted(scale), sorted(sharedScale(B, A)));
  assert.ok(scale.every((v) => v > 0));
  assert.equal(scale.length, A.filter((r) => r.value > 0).length + B.filter((r) => r.value > 0).length);
  const opts = { mode: 'counts', metric: 'harm_n', baseYears: [2020, 2021], scaleValues: scale };
  const ma = calendarModel(A, opts);
  const mb = calendarModel(B, opts);
  assert.deepEqual(ma.legend, mb.legend);
  // same value -> same colour step on either side
  const stepOf = (m, y, mo) => m.years.find((r) => r.year === y).cells[mo - 1].step;
  assert.equal(stepOf(ma, 2020, 4), stepOf(mb, 2021, 4)); // both 200
});

test('calendarModel scaleValues: bins come from the given values, default unchanged', () => {
  const own = calendarModel(A, { mode: 'counts' });
  assert.deepEqual(calendarModel(A, { mode: 'counts', scaleValues: null }), own);
  const given = [1, 2, 3, 4, 5, 6, 7, 10000];
  const wide = calendarModel(A, { mode: 'counts', scaleValues: given });
  assert.notDeepEqual(wide.legend, own.legend);
  assert.equal(wide.legend[wide.legend.length - 2].label, `> ${quantileBins(given, 7).at(-1)}`); // top bin from the given values
  assert.equal(wide.legend.length, quantileBins(given, 7).length + 3); // 0, bins, no data
  // a calendar of zeros still shows the shared bins
  const zeros = calendarModel(cal(() => 0), { mode: 'counts', scaleValues: [5, 50] });
  assert.ok(zeros.legend.some((l) => l.kind === 'bin'));
  // anomaly mode ignores scaleValues
  const an = { mode: 'anomaly', baseYears: [2020, 2021] };
  assert.deepEqual(calendarModel(A, { ...an, scaleValues: [1, 999] }).legend, calendarModel(A, an).legend);
});

test('checkBBox: same messages as the main form', () => {
  const b = { w: 68, s: 6, e: 98, n: 38 };
  assert.deepEqual(checkBBox(['73.8', '29.5', '77.5', '32.5'], b), { values: [73.8, 29.5, 77.5, 32.5] });
  assert.equal(checkBBox(['', '29', '77', '32'], b).message, 'West is missing. Enter a number between 68 and 98.');
  assert.equal(checkBBox(['60', '29', '77', '32'], b).message, 'West must be between 68 and 98 for India coverage');
  assert.deepEqual(checkBBox(['78', '29', '77', '32'], b), { field: 2, message: 'East must be greater than West.' });
  assert.deepEqual(checkBBox(['73', '33', '77', '32'], b), { field: 3, message: 'North must be greater than South.' });
});

test('checkSpan and syncKey', () => {
  assert.equal(checkSpan('2015-01', '2016-12', '2003-01', '2026-10'), null);
  assert.ok(checkSpan('2017-01', '2016-12', '2003-01', '2026-10'));
  assert.ok(checkSpan('2001-01', '2016-12', '2003-01', '2026-10'));
  assert.ok(checkSpan('', '2016-12', '2003-01', '2026-10'));
  assert.equal(syncKey('2016', '3', null), '2016-3');
  assert.equal(syncKey('2016', '3', 2015), syncKey('2024', '3', 2023)); // other span: matched by year offset
  assert.equal(syncKey('Typical', '3', 2015), syncKey('Typical', '3', null));
});
