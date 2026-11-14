import test from 'node:test';
import assert from 'node:assert/strict';
import { linkErrors, chainError, widenRows, smallAreaNote } from '../uncertainty.js';

const summary = {
  chosen_variant: 'noregion',
  loyo: { noregion: {
    terra_aqua: { box1deg: { mdape: 0.4 }, region_month: { mdape: 0.1 } },
    aqua_snpp: { box1deg: { mdape: 0.3 }, region_month: { mdape: 0.1 } },
    snpp_noaa20: { box1deg: { mdape: 0.1 }, region_month: { mdape: 0.02 } },
  } },
};

test('linkErrors interpolates in log area between one box and the whole region', () => {
  const region = 10000; // 100 boxes
  assert.deepEqual(linkErrors(summary, 100, region), { terra_aqua: 0.4, aqua_snpp: 0.3, snpp_noaa20: 0.1 });
  assert.deepEqual(linkErrors(summary, 30, region), linkErrors(summary, 100, region)); // below one box: box error
  const whole = linkErrors(summary, region, region);
  assert.ok(Math.abs(whole.aqua_snpp - 0.1) < 1e-12 && Math.abs(whole.snpp_noaa20 - 0.02) < 1e-12);
  const mid = linkErrors(summary, 1000, region); // 10 boxes = half way in log(1..100)
  assert.ok(Math.abs(mid.aqua_snpp - 0.2) < 1e-12);
  assert.equal(linkErrors({}, 100, region), null);
});

test('chainError adds the links a value went through in quadrature; NOAA-20 has none', () => {
  const e = { terra_aqua: 0.4, aqua_snpp: 0.3, snpp_noaa20: 0.1 };
  assert.equal(chainError(e, 0), 0);
  assert.equal(chainError(e, 1), 0.1);
  assert.ok(Math.abs(chainError(e, 2) - Math.sqrt(0.09 + 0.01)) < 1e-12);
  assert.ok(Math.abs(chainError(e, 4) - Math.sqrt(0.16 + 0.09 + 0.01)) < 1e-12);
});

test('widenRows widens only when the error band is wider than the ratio band', () => {
  const e = { terra_aqua: 0.4, aqua_snpp: 0.3, snpp_noaa20: 0.1 };
  const rows = [
    { year: 2020, month: 1, value: 100, lo: 100, hi: 100, harm_from: 0 },
    { year: 2015, month: 1, value: 100, lo: 95, hi: 105, harm_from: 1 },
    { year: 2015, month: 2, value: 100, lo: 80, hi: 130, harm_from: 1 },
    { year: 2005, month: 1, value: 0, lo: 0, hi: 0, harm_from: 2 },
  ];
  const out = widenRows(rows, e);
  assert.equal(out[0], rows[0]);
  assert.ok(Math.abs(out[1].lo - 90) < 1e-9 && Math.abs(out[1].hi - 110) < 1e-9 && out[1].widened);
  assert.equal(out[2], rows[2]); // ratio band already wider
  assert.equal(out[3], rows[3]);
  assert.equal(widenRows(rows, null), rows);
});

test('smallAreaNote: only for areas under 5 boxes that show converted values', () => {
  const e = { terra_aqua: 0.4, aqua_snpp: 0.3, snpp_noaa20: 0.1 };
  const rows = [{ value: 5, harm_from: 2 }, { value: 3, harm_from: 0 }];
  assert.equal(smallAreaNote(rows, e, 100), 'Before 2018, values for small areas are approximate (±32 %).');
  assert.equal(smallAreaNote(rows, e, 500), null);
  assert.equal(smallAreaNote([{ value: 3, harm_from: 0 }], e, 100), null);
  assert.equal(smallAreaNote(rows, null, 100), null);
});
