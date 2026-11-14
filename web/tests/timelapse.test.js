import test from 'node:test';
import assert from 'node:assert/strict';
import { framesFrom, frameLabel, nextFrame, windowError, MAX_DAYS } from '../panel-timelapse.js';
import { timelapseSQL } from '../queries.js';

const pt = (acq_date, category = 0) => ({ acq_date, lat: 30, lon: 75, category });

test('framesFrom: daily frame counts sum to the rows inside the window; outside rows dropped', () => {
  const rows = [pt('2025-09-30'), pt('2025-10-01'), pt('2025-10-01', 5), pt('2025-10-03'), pt('2025-10-05'), pt('2025-10-06')];
  const f = framesFrom(rows, '2025-10-01', '2025-10-05', 'day');
  assert.equal(f.length, 5);
  assert.deepEqual(f.map((x) => x.points.length), [2, 0, 1, 0, 1]);
  assert.equal(f.reduce((t, x) => t + x.points.length, 0), 4);
  assert.deepEqual(f.map((x) => x.t), ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05']);
  assert.equal(f[1].label, '2 Oct 2025');
});

test('framesFrom: weeks start on the window start date, last week is cut at the end, empty weeks kept', () => {
  // Wednesday 1 Oct to Monday 20 Oct: 20 days -> weeks 1-7, 8-14, 15-20
  const rows = [pt('2025-10-07'), pt('2025-10-15'), pt('2025-10-20')];
  const f = framesFrom(rows, '2025-10-01', '2025-10-20', 'week');
  assert.deepEqual(f.map((x) => [x.t, x.end]), [['2025-10-01', '2025-10-07'], ['2025-10-08', '2025-10-14'], ['2025-10-15', '2025-10-20']]);
  assert.deepEqual(f.map((x) => x.points.length), [1, 0, 2]);
  assert.equal(f[0].label, '1–7 Oct 2025');
});

test('framesFrom: a window with no rows has all frames, all empty; one-day window has one frame', () => {
  assert.deepEqual(framesFrom([], '2024-02-27', '2024-03-02', 'day').map((x) => x.t), ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']);
  assert.equal(framesFrom([pt('2024-01-01')], '2024-01-01', '2024-01-01', 'week').length, 1);
  assert.throws(() => framesFrom([], '2024-01-02', '2024-01-01', 'day'));
  assert.throws(() => framesFrom([], '2024-01-01', '2024-01-02', 'month'));
});

test('framesFrom: a whole-year window across a year end keeps every row', () => {
  const rows = [];
  for (let d = Date.UTC(2025, 6, 1); d <= Date.UTC(2026, 5, 30); d += 86400000 * 3) rows.push(pt(new Date(d).toISOString().slice(0, 10)));
  for (const step of ['day', 'week']) {
    const f = framesFrom(rows, '2025-07-01', '2026-06-30', step);
    assert.equal(f.reduce((t, x) => t + x.points.length, 0), rows.length);
  }
});

test('frameLabel: same month, across months, across years, single day', () => {
  assert.equal(frameLabel('2026-11-08', '2026-11-14'), '8–14 Nov 2026');
  assert.equal(frameLabel('2026-10-29', '2026-11-04'), '29 Oct – 4 Nov 2026');
  assert.equal(frameLabel('2025-12-29', '2026-01-04'), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(frameLabel('2026-11-08'), '8 Nov 2026');
});

test('nextFrame: advances, stops at the end', () => {
  assert.equal(nextFrame(0, 3), 1);
  assert.equal(nextFrame(2, 3), null);
  assert.equal(nextFrame(0, 1), null);
});

test('windowError: order, coverage and the day limit', () => {
  const cov = { start: '2001-01-01', end: '2026-11-13' };
  assert.equal(windowError('2025-10-01', '2025-11-30', cov), null);
  assert.match(windowError('2025-11-30', '2025-10-01', cov), /before/);
  assert.match(windowError('2000-12-01', '2001-01-10', cov), /between/);
  assert.equal(windowError('2025-01-01', '2025-12-31', cov), null); // 365 days
  assert.equal(windowError('2024-01-01', '2024-12-31', cov), null); // 366 days
  assert.match(windowError('2024-01-01', '2025-01-01', cov), new RegExp(`limit is ${MAX_DAYS}`));
  assert.match(windowError('', '2025-01-01', cov), /both/);
});

test('timelapseSQL: four columns, day bounds, no SELECT *, rejects bad dates', () => {
  const sql = timelapseSQL(['a.parquet'], [[1, 3]], [0, 1], { from: '2025-10-01', to: '2025-11-30' });
  assert.match(sql, /^SELECT acq_date, lat, lon, category FROM/);
  assert.match(sql, /acq_date BETWEEN DATE '2025-10-01' AND DATE '2025-11-30'/);
  assert.match(sql, /category IN \(0, 1\)/);
  assert.doesNotMatch(sql, /\*/);
  assert.throws(() => timelapseSQL(['a.parquet'], [[1, 3]], [0], { from: "2025-10-01' OR 1=1 --", to: '2025-11-30' }));
});
