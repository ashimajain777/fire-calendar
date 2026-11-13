import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness } from '../freshness.js';

const now = new Date('2026-11-14T12:00:00Z');
const ago = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
const meta = (h, status = 'ok') => ({ status, sources: { NOAA20: { last_success_utc: ago(h) }, Aqua: { last_success_utc: ago(h + 50) } } });

test('Review Focus 5: good under 36 h', () => {
  assert.deepEqual(freshness(meta(10), now), { level: 'good', text: 'Data updated 10 hours ago' });
  assert.equal(freshness(meta(1), now).text, 'Data updated 1 hour ago');
  assert.equal(freshness(meta(0.2), now).text, 'Data updated less than an hour ago');
});

test('warning from 36 to 72 h', () => {
  assert.deepEqual(freshness(meta(40), now), { level: 'warning', text: 'Data is 1 day old' });
  assert.equal(freshness(meta(36), now).level, 'warning');
  assert.equal(freshness(meta(72), now).level, 'warning');
});

test('critical over 72 h', () => {
  assert.deepEqual(freshness(meta(80), now), { level: 'critical', text: 'Data is 3 days old' });
});

test('failed run is critical and names the last good date', () => {
  assert.deepEqual(freshness(meta(50, 'failed'), now),
    { level: 'critical', text: 'Last update failed. Showing data from 12 Nov 2026.' });
  assert.deepEqual(freshness({ status: 'failed', sources: {} }, now), { level: 'critical', text: 'Last update failed.' });
});

test('missing meta or no usable timestamp is critical', () => {
  for (const m of [null, undefined, {}, { status: 'ok', sources: { A: { last_success_utc: null } } }, { status: 'ok', sources: { A: { last_success_utc: 'nonsense' } } }]) {
    assert.deepEqual(freshness(m, now), { level: 'critical', text: 'Data status unavailable' });
  }
});

test('uses the newest source', () => {
  const m = { status: 'ok', sources: { Terra: { last_success_utc: ago(100) }, NOAA20: { last_success_utc: ago(5) } } };
  assert.equal(freshness(m, now).level, 'good');
});
