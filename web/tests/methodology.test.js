import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtInt, fmtPct, fmtSignedPct, fmtTimes, fmtDate, categoryName, approachSentences, stepSentences, coverageFlag, loyoRows,
  smallAreaNote, variantRows, directComparison, ratioSummaryRows, fallbackText, timingNote, gapRanges, gapText, annualWide,
  endLabels, coverageLimitText,
} from '../methodology.js';

// Hand-built inputs only; none of these values come from the real validation files.
const chain = { aqua_start: '2002-08-01', snpp_start: '2012-02-01', noaa20_start: '2018-04-01' };
const m = (mdape, coverage, n = 10, bias = 0) => ({ mdape, bias, coverage, n });
const summary = {
  chosen_variant: 'a',
  loyo: {
    a: {
      terra_aqua: { region_month: m(0.1, 0.8), stratum_month: m(0.2, 0.65), box1deg: m(0.5, 0.3) },
      aqua_snpp: { region_month: m(0.05, 0.95), stratum_month: m(0.07, 0.8), box1deg: m(0.08, 0.75) },
      snpp_noaa20: { region_month: m(0.02, 0.7), stratum_month: m(0.03, 0.9), box1deg: m(0.03, 0.8) },
    },
    b: {
      terra_aqua: { region_month: m(0.3, 0.5) },
      aqua_snpp: { region_month: m(0.2, 0.8) },
      snpp_noaa20: { region_month: m(0.1, 0.8) },
    },
  },
  direct_aqua_noaa20: { mdape: 0.2, coverage: 0.5, n: 48 },
};

test('formatting', () => {
  assert.equal(fmtInt(1234567.4), '1,234,567');
  assert.equal(fmtInt(null), '–');
  assert.equal(fmtPct(0.1234), '12.3 %');
  assert.equal(fmtPct(0.7, 0), '70 %');
  assert.equal(fmtSignedPct(0.0123), '+1.2 %');
  assert.equal(fmtSignedPct(-0.1), '−10.0 %');
  assert.equal(fmtSignedPct(-0.0003), '0.0 %');
  assert.equal(fmtTimes(6.3449), '6.34×');
  assert.equal(fmtDate('2002-08-01'), '1 Aug 2002');
  assert.equal(fmtDate('2026-11-13T22:31:00+00:00'), '13 Nov 2026');
  assert.equal(fmtDate(undefined), '–');
  assert.equal(categoryName(2), 'Grass / shrub');
  assert.equal(categoryName('5'), 'Industrial / static');
  assert.equal(categoryName(42), 'Category 42');
});

test('approach text takes every switch date from the chain', () => {
  const text = approachSentences(chain, '2000-11-01').join(' ');
  for (const d of ['1 Nov 2000', '1 Aug 2002', '1 Feb 2012', '1 Apr 2018']) assert.ok(text.includes(d), d);
  assert.ok(text.includes('NOAA-20-equivalent'));
});

test('step sentences: inside the normal range', () => {
  const { sentences, inside } = stepSentences({ naive_step: 5, harm_step: 1.1, yoy_p10: 0.8, yoy_p90: 1.2 }, chain);
  assert.equal(inside, true);
  assert.ok(sentences[0].includes('5.00×') && sentences[0].includes('2012–2014 compared with 2009–2011'));
  assert.ok(sentences[1].includes('1.10×'));
  assert.ok(sentences[2].includes('0.80×') && sentences[2].includes('1.20×'));
  assert.ok(sentences[3].includes('inside'));
});

test('step sentences: outside the range keeps the real numbers', () => {
  const { sentences, inside } = stepSentences({ naive_step: 5, harm_step: 1.5, yoy_p10: 0.8, yoy_p90: 1.2 }, chain);
  assert.equal(inside, false);
  assert.ok(sentences[3].includes('outside') && sentences[3].includes('1.50×') && sentences[3].includes('0.80×') && sentences[3].includes('1.20×'));
  assert.equal(stepSentences({ naive_step: 5, harm_step: 0.7, yoy_p10: 0.8, yoy_p90: 1.2 }, chain).inside, false);
  assert.equal(stepSentences({ naive_step: null, harm_step: null, yoy_p10: null, yoy_p90: null }, chain).inside, false);
});

test('coverage flag: 70-90 % is fine, edges included', () => {
  assert.equal(coverageFlag(0.7), null);
  assert.equal(coverageFlag(0.9), null);
  assert.equal(coverageFlag(0.8), null);
  assert.equal(coverageFlag(0.69).level, 'low');
  assert.equal(coverageFlag(0.91).level, 'high');
  assert.equal(coverageFlag(null), null);
});

test('loyo rows: three links by three unit types for the asked variant, flagged', () => {
  const rows = loyoRows(summary, 'a');
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.link, r.unitType]),
    [['terra_aqua', 'region_month'], ['terra_aqua', 'stratum_month'], ['terra_aqua', 'box1deg']]);
  assert.deepEqual(rows.map((r) => (r.flag ? r.flag.level : null)), [null, 'low', 'low', 'high', null, null, null, null, null]);
  assert.equal(loyoRows(summary, 'b').length, 3);
  assert.deepEqual(loyoRows(summary, 'missing'), []);
});

test('small-area note names only links whose box error is at least twice the whole-India error', () => {
  const note = smallAreaNote(summary, 'a', chain);
  assert.ok(note.includes('50.0 % for Terra → Aqua (whole India: 10.0 %; band coverage 30.0 %)'));
  assert.ok(!note.includes('Aqua → S-NPP') && !note.includes('S-NPP → NOAA-20'));
  assert.ok(note.includes('1 Apr 2018') && note.includes('indicative only'));
  assert.ok(smallAreaNote(summary, 'b', chain).includes('less than twice'));
});

test('variant rows: whole-India month metrics side by side', () => {
  const rows = variantRows(summary);
  assert.deepEqual(rows.map((r) => r.link), ['terra_aqua', 'aqua_snpp', 'snpp_noaa20']);
  assert.equal(rows[0].a.mdape, 0.1);
  assert.equal(rows[0].b.mdape, 0.3);
  assert.equal(rows[0].b.flag.level, 'low');
  assert.equal(rows[1].a.flag.level, 'high');
});

test('direct comparison: worse than both chain steps, or not', () => {
  const worse = directComparison(summary, 'a');
  assert.equal(worse.worse, true);
  assert.equal(worse.rows.length, 3);
  assert.equal(worse.rows[0].flag.level, 'low');
  assert.ok(worse.sentence.includes('20.0 %') && worse.sentence.includes('5.0 % and 2.0 %') && worse.sentence.includes('The chain is used'));
  const better = directComparison({ ...summary, direct_aqua_noaa20: { mdape: 0.03, coverage: 0.8, n: 48 } }, 'a');
  assert.equal(better.worse, false);
  assert.ok(!better.sentence.includes('The chain is used') && better.sentence.includes('3.0 %'));
});

test('ratio summary: detection-weighted mean, range, fallback months', () => {
  const rows = ratioSummaryRows([
    { link: 'aqua_snpp', stratum: 1, month: 1, r: 2, n_detections: 100, fallback: 'none' },
    { link: 'aqua_snpp', stratum: 1, month: 2, r: 4, n_detections: 300, fallback: 'none' },
    { link: 'terra_aqua', stratum: 3, month: 1, r: 1, n_detections: 50, fallback: 'stratum' },
    { link: 'terra_aqua', stratum: 3, month: 2, r: 1, n_detections: 50, fallback: 'stratum' },
    { link: 'terra_aqua', stratum: 0, month: 1, r: 3, n_detections: 0, fallback: 'none' },
    { link: 'terra_aqua', stratum: 0, month: 2, r: 5, n_detections: 0, fallback: 'landscape' },
  ]);
  assert.deepEqual(rows.map((r) => [r.link, r.stratum]), [['terra_aqua', 0], ['terra_aqua', 3], ['aqua_snpp', 1]]);
  assert.deepEqual(rows[2], { link: 'aqua_snpp', stratum: 1, mean: 3.5, min: 2, max: 4, months: 2, fallbackMonths: 0, fallbackLevels: [] });
  assert.equal(rows[0].mean, 4); // no detections recorded: plain mean
  assert.equal(fallbackText(rows[2]), 'None');
  assert.equal(fallbackText(rows[1]), "2 of 2 months: the category's all-months ratio");
  assert.ok(fallbackText(rows[0]).startsWith('1 of 2 months'));
});

test('timing note appears only when a vegetation Terra → Aqua ratio is well above 1', () => {
  const row = (link, stratum, mean) => ({ link, stratum, mean });
  const note = timingNote([row('terra_aqua', 0, 3.1), row('terra_aqua', 1, 1.2), row('terra_aqua', 5, 9), row('aqua_snpp', 2, 8)], chain);
  assert.ok(note.includes('agricultural (3.10)') && note.includes('10:30') && note.includes('13:30') && note.includes('1 Aug 2002'));
  assert.ok(!note.includes('forest') && !note.includes('industrial') && !note.includes('grass'));
  assert.equal(timingNote([row('terra_aqua', 0, 1.1), row('aqua_snpp', 0, 8)], chain), null);
});

test('gap ranges: dekads to dates, neighbours merged, month ends', () => {
  const g = (year, month, dekad, chain_satellite = 'Terra', filled_from = null) => ({ year, month, dekad, chain_satellite, filled_from });
  assert.deepEqual(gapRanges([g(2001, 6, 3)]), [{ start: '2001-06-21', end: '2001-06-30', satellite: 'Terra', filledFrom: null }]);
  assert.deepEqual(gapRanges([g(2004, 3, 1), g(2004, 2, 3), g(2004, 2, 2)]), [{ start: '2004-02-11', end: '2004-03-10', satellite: 'Terra', filledFrom: null }]);
  assert.equal(gapRanges([g(2004, 2, 3)])[0].end, '2004-02-29');
  assert.equal(gapRanges([g(2003, 12, 3), g(2004, 1, 1)]).length, 1);
  // a different fill, a different satellite or a break each start a new range
  assert.equal(gapRanges([g(2010, 1, 1), g(2010, 1, 2, 'Terra', 'Aqua'), g(2010, 1, 3, 'Aqua'), g(2010, 3, 1)]).length, 4);
  assert.deepEqual(gapRanges([]), []);
});

test('gap text says no data, not zero', () => {
  assert.ok(gapText({ start: '2001-06-21', end: '2001-06-30', satellite: 'Terra', filledFrom: null }).includes('21 Jun 2001 to 30 Jun 2001: no Terra detections'));
  assert.ok(gapText({ start: '2001-06-21', end: '2001-06-30', satellite: 'Terra', filledFrom: null }).includes('"no data", not as zero'));
  assert.ok(gapText({ start: '2001-06-21', end: '2001-06-30', satellite: 'Terra', filledFrom: 'Aqua' }).includes('filled from Aqua'));
});

test('annual rows: long to wide, zero raw satellite becomes null', () => {
  const wide = annualWide([
    { year: 2002, series: 'harm', value: 30 }, { year: 2001, series: 'terra', value: 5 }, { year: 2001, series: 'aqua', value: 0 },
    { year: 2001, series: 'harm', value: 20 }, { year: 2001, series: 'harm_lo', value: 0 }, { year: 2001, series: 'naive', value: 5 },
  ]);
  assert.deepEqual(wide, [{ year: 2001, terra: 5, aqua: null, harm: 20, harm_lo: 0, naive: 5 }, { year: 2002, harm: 30 }]);
});

test('end labels: one per series, close ends share one label', () => {
  const wide = [{ year: 2001, terra: 5, aqua: 100, harm: 110, naive: 400 }, { year: 2002, terra: null, aqua: 100, harm: 120, naive: 500 }];
  const series = [{ key: 'terra', label: 'T' }, { key: 'aqua', label: 'A' }, { key: 'harm', label: 'H' }, { key: 'naive', label: 'N' }];
  const labels = endLabels(wide, series);
  assert.deepEqual(labels.map((l) => [l.year, l.text]), [[2001, 'T'], [2002, 'H, A'], [2002, 'N']]);
  assert.ok(labels[1].value > 100 && labels[1].value < 120);
});

test('coverage limitation: the reason appears only when data ends before the current month', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const old = coverageLimitText({ coverage_end: '2025-12-31' }, now);
  assert.ok(old.includes('31 Dec 2025') && old.includes('FIRMS key'));
  const current = coverageLimitText({ coverage_end: '2026-11-12' }, now);
  assert.ok(current.includes('12 Nov 2026') && !current.includes('FIRMS key'));
});

test('bandMethodText states the measured errors from the summary', async () => {
  const { bandMethodText } = await import('../methodology.js');
  const s = { chosen_variant: 'v', loyo: { v: { aqua_snpp: { box1deg: { mdape: 0.44 }, region_month: { mdape: 0.08 } } } } };
  const t = bandMethodText(s);
  assert.match(t, /Aqua → S-NPP 44(\.0)? ?% for a 1° box and 8(\.0)? ?% for the whole region/);
  assert.equal(bandMethodText({}), '');
});
