import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantileBins, binIndex, calendarModel, renderCalendar } from '../calendar.js';
import { csvCell, csvLines } from '../db.js';

test('importing the browser modules under node does not throw', () => {
  assert.equal(typeof renderCalendar, 'function');
});

test('quantileBins: k-1 ascending thresholds, binIndex 0..k-1', () => {
  const vals = Array.from({ length: 70 }, (_, i) => i + 1);
  const bins = quantileBins(vals, 7);
  assert.equal(bins.length, 6);
  assert.ok(bins.every((t, i) => i === 0 || t > bins[i - 1]));
  assert.equal(binIndex(1, bins), 0);
  assert.equal(binIndex(70, bins), 6);
  const counts = new Array(7).fill(0);
  for (const v of vals) counts[binIndex(v, bins)]++;
  assert.ok(counts.every((c) => c === 10), counts.join());
});

test('quantileBins: few distinct values give fewer bins, never empty ones', () => {
  assert.deepEqual(quantileBins([], 7), []);
  assert.deepEqual(quantileBins([4, 4, 4], 7), []);
  assert.equal(binIndex(4, []), 0);
  const bins = quantileBins([1, 1, 1, 1, 9], 7);
  assert.ok(bins.length >= 1 && bins.length < 6);
  assert.equal(binIndex(1, bins), 0);
  assert.equal(binIndex(9, bins), bins.length);
});

const BASE = [2020, 2021, 2022];
const rows = [];
for (const y of [2020, 2021, 2022, 2023]) {
  for (let m = 1; m <= 12; m++) {
    if (y === 2023 && m > 6) break;
    rows.push({ year: y, month: m, value: m === 11 ? (y - 2019) * 1000 : 0, lo: 0, hi: 0, harm_from: 1, provisional: y === 2023 });
  }
}
rows.find((r) => r.year === 2023 && r.month === 5).value = 12345;

test('calendarModel: years newest first, typical row, range, labels', () => {
  const m = calendarModel(rows, { mode: 'counts', metric: 'harm_n', baseYears: BASE, currentYM: { year: 2023, month: 6 } });
  assert.deepEqual(m.years.map((y) => y.year), [2023, 2022, 2021, 2020]);
  const nov22 = m.years[1].cells[10];
  assert.equal(nov22.state, 'value');
  assert.equal(nov22.label, 'November 2022, 3,000 hotspots, 83rd percentile');
  assert.equal(m.years[0].cells[10].state, 'empty'); // after the last row
  assert.equal(m.years[0].cells[5].current, true);
  assert.equal(m.years[0].cells[0].state, 'zero');
  assert.ok(m.years[0].cells[4].label.startsWith('May 2023, 12,345 hotspots'));
  assert.ok(m.years[0].cells[4].label.endsWith('provisional'));
  assert.equal(m.typical[10].value, 2000);
  assert.equal(m.typical[0].value, 0);
  assert.ok(m.typical[10].label.startsWith('Typical November, 2,000 hotspots'));
  // highest value gets the darkest step, steps are within 1..7
  assert.equal(m.years[0].cells[4].step, 7);
  assert.ok(m.years.flatMap((y) => y.cells).every((c) => c.step == null || (c.step >= 1 && c.step <= 7)));
  assert.ok(m.legend.length >= 3);
});

test('calendarModel: fire-days unit and singular', () => {
  const m = calendarModel([{ year: 2021, month: 3, value: 1 }, { year: 2021, month: 4, value: 2 }], { metric: 'harm_fd', baseYears: [2021] });
  assert.ok(m.years[0].cells[2].label.includes('1 fire-day,'));
  assert.ok(m.years[0].cells[3].label.includes('2 fire-days,'));
});

test('calendarModel: a month with any unfilled gap dekad is "no data", never zero', () => {
  const gap = (d, filled_from = null) => ({ year: 2021, month: 1, dekad: d, chain_satellite: 'Aqua', filled_from });
  const m = calendarModel(rows, { baseYears: BASE, gaps: [gap(1), gap(2), gap(3)] });
  const c = m.years[2].cells[0];
  assert.equal(c.state, 'nodata');
  assert.equal(c.label, 'January 2021, no data');
  // one unfilled dekad is enough; a filled gap is not "no data"
  assert.equal(calendarModel(rows, { baseYears: BASE, gaps: [gap(2)] }).years[2].cells[0].state, 'nodata');
  assert.equal(calendarModel(rows, { baseYears: BASE, gaps: [gap(3, 'SNPP')] }).years[2].cells[0].state, 'zero');
});

test('calendarModel: anomaly mode bins by percentile of the same month', () => {
  const m = calendarModel(rows, { mode: 'anomaly', baseYears: BASE });
  assert.equal(m.years[1].cells[10].step, 6); // Nov 2022: 83rd percentile -> bin 5
  assert.equal(m.years[3].cells[10].step, 2); // Nov 2020: 17th percentile -> bin 1
  assert.equal(m.years[3].cells[0].step, 4);  // all-zero base: typical (grey), not "0th percentile"
  assert.equal(m.legend.filter((l) => l.step != null).length, 7);
});

test('calendarModel: no rows', () => {
  const m = calendarModel([], { baseYears: BASE });
  assert.deepEqual(m.years, []);
});

test('db.js CSV quoting', () => {
  assert.equal(csvCell('a'), 'a');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('x\ny'), '"x\ny"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(1.5), '1.5');
  assert.equal(csvCell(false), 'false');
  assert.equal(csvLines(['a', 'b,c'], [{ a: 1, 'b,c': 'x' }, { a: null, 'b,c': '"' }]), 'a,"b,c"\r\n1,x\r\n,""""\r\n');
  assert.equal(csvLines(['a'], []), 'a\r\n');
});

test('db.withRetry retries network failures only, then gives up', async () => {
  const { withRetry, isTransient } = await import('../db.js');
  let n = 0;
  const flaky = async () => { n++; if (n < 3) throw new Error("NetworkError: Failed to execute 'send' on 'XMLHttpRequest'"); return 'ok'; };
  assert.equal(await withRetry(flaky, [0, 0], async () => {}), 'ok');
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw new Error('Binder Error: column x not found'); }, [0, 0], async () => {}), /Binder/);
  assert.equal(m, 1);
  assert.equal(isTransient(new Error('IO Error: No files found that match the pattern')), false);
  let k = 0;
  await assert.rejects(withRetry(async () => { k++; throw new Error('NetworkError'); }, [0, 0], async () => {}), /NetworkError/);
  assert.equal(k, 3);
});
