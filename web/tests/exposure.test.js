import test from 'node:test';
import assert from 'node:assert/strict';
import { exposureSummary, exposureText } from '../panel-exposure.js';
import { exposureSQL } from '../queries.js';

test('exposureSummary picks the busiest and the latest month', () => {
  const s = exposureSummary([{ year: 2024, month: 10, people: 50 }, { year: 2024, month: 11, people: 900 }, { year: 2024, month: 12, people: 10 }]);
  assert.deepEqual([s.peak.month, s.latest.month, s.months], [11, 12, 3]);
  assert.equal(exposureSummary([]), null);
});

test('exposureText states the month and the caveats; empty means zero, not missing', () => {
  const t = exposureText(exposureSummary([{ year: 2024, month: 11, people: 1234.4 }]), {});
  assert.equal(t.value, '1,234');
  assert.match(t.note, /^in Nov 2024, the busiest month/);
  assert.equal(exposureText(null, {}).value, '0');
});

test('exposureSQL filters cells and months over the given files only', () => {
  const sql = exposureSQL(['u/exposure_t1.parquet'], [[5, 7]], { from: '2024-01', to: '2024-12' });
  assert.match(sql, /cell_id BETWEEN 5 AND 7/);
  assert.match(sql, /BETWEEN 202401 AND 202412/);
  assert.match(sql, /read_parquet\(\['u\/exposure_t1\.parquet'\]\)/);
});
