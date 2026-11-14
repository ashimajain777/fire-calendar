import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellId, cellCenter, cellsFromGeometry, cellsFromBBox, cellsFromPointRadius,
  cellsToRanges, rangesSQL, outlineGeoJSON, areaKm2,
} from '../cells.js';

const box = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
const haversine = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
};
// every cell whose centre is in 76..77 E, 30..31 N
const boxCells = () => {
  const s = new Set();
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) s.add(cellId(30.05 + i / 10, 76.05 + j / 10));
  return s;
};

test('cellId matches the Python grid', () => {
  assert.equal(cellId(0.05, 0.05), 3241800);
  assert.equal(cellId(31.27, 75.81), 4365758);
  assert.equal(cellId(-33.9, 151.2), 2022912);
  assert.equal(cellId(23.75, 86.41), 4095864);
  assert.equal(cellId(8.08, 77.55), 3530575);
});

test('cellId clamps lat=90 and lon=180 into the last index', () => {
  assert.equal(cellId(90, 180), 1799 * 3600 + 3599);
});

test('cellCenter is the middle of the cell and round-trips', () => {
  const [lat, lon] = cellCenter(cellId(31.27, 75.81));
  assert.ok(Math.abs(lat - 31.25) < 1e-9);
  assert.ok(Math.abs(lon - 75.85) < 1e-9);
  assert.equal(cellId(lat, lon), cellId(31.27, 75.81));
});

test('cellsToRanges and rangesSQL', () => {
  assert.deepEqual(cellsToRanges([5, 6, 7, 10]), [[5, 7], [10, 10]]);
  assert.deepEqual(cellsToRanges([]), []);
  assert.equal(rangesSQL([[5, 7], [10, 10]]), '(cell_id BETWEEN 5 AND 7 OR cell_id = 10)');
  assert.equal(rangesSQL([[1, 2]], 'c'), '(c BETWEEN 1 AND 2)');
  assert.equal(rangesSQL([]), 'FALSE');
  assert.throws(() => rangesSQL([['1; DROP', 2]]));
});

test('Review Focus 1: area smaller than a cell snaps to the containing cell', () => {
  const tri = { type: 'Polygon', coordinates: [[[76.01, 30.01], [76.03, 30.01], [76.02, 30.03], [76.01, 30.01]]] };
  const r = cellsFromGeometry(tri, new Set([cellId(30.02, 76.02)]));
  assert.deepEqual(r.ids, [cellId(30.02, 76.02)]);
  assert.equal(r.snappedToContaining, true);
  assert.equal(r.outsideShare, 0);
});

test('box selects the cells whose centre is inside, sorted, not snapped', () => {
  const r = cellsFromGeometry({ type: 'Polygon', coordinates: box(76, 30, 77, 31) }, boxCells());
  assert.equal(r.ids.length, 100);
  assert.deepEqual(r.ids, [...boxCells()].sort((a, b) => a - b));
  assert.equal(r.snappedToContaining, false);
  assert.equal(r.outsideShare, 0);
  assert.deepEqual(cellsFromBBox(76, 30, 77, 31, boxCells()), r);
});

test('Review Focus 2: half outside coverage', () => {
  const cov = new Set([...boxCells()].filter((id) => cellCenter(id)[1] < 76.5));
  const r = cellsFromBBox(76, 30, 77, 31, cov);
  assert.ok(r.outsideShare > 0.45 && r.outsideShare < 0.55);
  assert.equal(r.ids.length, 50);
  assert.ok(r.ids.every((id) => cov.has(id)));
});

test('Review Focus 2: fully outside coverage', () => {
  const r = cellsFromBBox(76, 30, 77, 31, new Set());
  assert.deepEqual(r.ids, []);
  assert.equal(r.outsideShare, 1);
});

test('polygon with a hole excludes the hole', () => {
  const g = { type: 'Polygon', coordinates: [box(76, 30, 77, 31)[0], box(76.3, 30.3, 76.7, 30.7)[0]] };
  const r = cellsFromGeometry(g, boxCells());
  assert.equal(r.ids.length, 84);
  assert.ok(!r.ids.includes(cellId(30.55, 76.55)));
  assert.ok(r.ids.includes(cellId(30.15, 76.15)));
});

test('MultiPolygon and Feature wrapper', () => {
  const g = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [box(76, 30, 76.2, 30.2), box(76.8, 30.8, 77, 31)] } };
  const r = cellsFromGeometry(g, boxCells());
  assert.equal(r.ids.length, 8);
  assert.ok(r.ids.includes(cellId(30.05, 76.05)));
  assert.ok(r.ids.includes(cellId(30.95, 76.95)));
  assert.ok(!r.ids.includes(cellId(30.55, 76.55)));
});

test('unsupported geometry throws', () => {
  assert.throws(() => cellsFromGeometry({ type: 'Point', coordinates: [76, 30] }, new Set()));
  assert.throws(() => cellsFromBBox(77, 30, 76, 31, new Set()));
});

test('point radius: includes the containing cell, nothing farther than km', () => {
  const all = { has: () => true };
  const r = cellsFromPointRadius(30, 76, 25, all);
  assert.ok(r.ids.includes(cellId(30, 76)));
  assert.ok(r.ids.length > 5);
  for (const id of r.ids) {
    if (id === cellId(30, 76)) continue;
    const [la, lo] = cellCenter(id);
    assert.ok(haversine(30, 76, la, lo) <= 25);
  }
  // a cell centre just inside 25 km to the north must be in
  assert.ok(r.ids.includes(cellId(30.15, 76.05)));
  assert.equal(r.snappedToContaining, false);
});

test('point radius smaller than a cell still returns the containing cell', () => {
  const r = cellsFromPointRadius(30.01, 76.01, 1, { has: () => true });
  assert.deepEqual(r.ids, [cellId(30.01, 76.01)]);
  assert.equal(r.snappedToContaining, true);
});

test('areaKm2 scales with cos(lat)', () => {
  const eq = areaKm2([cellId(0.05, 0.05)]);
  assert.ok(Math.abs(eq - 123.6) < 0.5);
  const hi = areaKm2([cellId(60.05, 10.05)]);
  assert.ok(Math.abs(hi / eq - Math.cos(60.05 * Math.PI / 180)) < 1e-3);
  assert.equal(areaKm2([]), 0);
});

test('outlineGeoJSON: one closed square per cell', () => {
  const fc = outlineGeoJSON([cellId(30.02, 76.02), cellId(30.12, 76.02)]);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  const ring = fc.features[0].geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.ok(Math.abs(ring[0][0] - 76.0) < 1e-9 && Math.abs(ring[0][1] - 30.0) < 1e-9);
  assert.ok(Math.abs(ring[2][0] - 76.1) < 1e-9 && Math.abs(ring[2][1] - 30.1) < 1e-9);
});

test('rangesSQL switches to an id list for many ranges, selecting the same cells', () => {
  const ranges = Array.from({ length: 45 }, (_, i) => [i * 10, i * 10 + 2]);
  const sql = rangesSQL(ranges);
  assert.match(sql, /^\(cell_id BETWEEN 0 AND 442 AND cell_id IN \(0,1,2,10,11,12,/);
  const ids = sql.match(/IN \(([^)]*)\)/)[1].split(',').map(Number);
  assert.equal(ids.length, 45 * 3);
  assert.deepEqual(cellsToRanges(ids), ranges);
});
