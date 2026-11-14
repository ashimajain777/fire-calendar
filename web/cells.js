// 0.1 degree grid and area selection. Pure: no imports, no DOM. See docs/CONTRACTS.md sections 3 and 6.

const ROWS = 1800;
const COLS = 3600;
const EARTH_KM = 6371;
const RAD = Math.PI / 180;

const rowOf = (lat) => Math.max(0, Math.min(Math.floor((lat + 90) * 10), ROWS - 1));
const colOf = (lon) => Math.max(0, Math.min(Math.floor((lon + 180) * 10), COLS - 1));
const rowLat = (r) => r / 10 - 90 + 0.05;
const colLon = (c) => c / 10 - 180 + 0.05;

// Same arithmetic as pipeline/grid.py: no epsilons.
export function cellId(lat, lon) {
  return Math.min(Math.floor((lat + 90) * 10), ROWS - 1) * COLS + Math.min(Math.floor((lon + 180) * 10), COLS - 1);
}

export function cellCenter(id) {
  return [rowLat(Math.floor(id / COLS)), colLon(id % COLS)];
}

function polygonsOf(geojson) {
  const g = geojson && geojson.type === 'Feature' ? geojson.geometry : geojson;
  if (g && g.type === 'Polygon') return [g.coordinates];
  if (g && g.type === 'MultiPolygon') return g.coordinates;
  throw new Error(`Area must be a Polygon or MultiPolygon, got ${g ? g.type : g}`);
}

function split(selected, coverageSet, snappedToContaining) {
  const ids = [...selected].filter((id) => coverageSet.has(id)).sort((a, b) => a - b);
  return { ids, outsideShare: ids.length ? 1 - ids.length / selected.size : 1, snappedToContaining };
}

export function cellsFromGeometry(geojson, coverageSet) {
  const polys = polygonsOf(geojson);
  const edges = [];
  const outer = [];
  let south = Infinity;
  let north = -Infinity;
  for (const poly of polys) {
    poly.forEach((ring, ringIdx) => {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        edges.push([x1, y1, x2, y2]);
        if (ringIdx === 0) {
          outer.push(ring[i]);
          south = Math.min(south, y1);
          north = Math.max(north, y1);
        }
      }
    });
  }
  if (!outer.length) throw new Error('Area has no coordinates');

  // Ray casting, one ray per grid row: a cell centre is inside when an odd number of
  // edge crossings lie to its west. Holes and multi-part polygons follow from the parity.
  const selected = new Set();
  for (let r = rowOf(south); r <= rowOf(north); r++) {
    const y = rowLat(r);
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let c = colOf(xs[k]); c <= colOf(xs[k + 1]); c++) {
        const x = colLon(c);
        if (x >= xs[k] && x < xs[k + 1]) selected.add(r * COLS + c);
      }
    }
  }

  let snapped = false;
  if (!selected.size) {
    snapped = true;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of outer) {
      selected.add(cellId(y, x));
      sx += x;
      sy += y;
    }
    selected.add(cellId(sy / outer.length, sx / outer.length));
  }
  return split(selected, coverageSet, snapped);
}

export function cellsFromBBox(w, s, e, n, coverageSet) {
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) {
    throw new RangeError('Bounding box needs west < east and south < north');
  }
  return cellsFromGeometry({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, coverageSet);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

export function cellsFromPointRadius(lat, lon, km, coverageSet) {
  if (![lat, lon, km].every(Number.isFinite) || km < 0) throw new RangeError('Point and radius must be numbers, radius >= 0');
  const dLat = km / EARTH_KM / RAD;
  const dLon = dLat / Math.max(Math.cos(lat * RAD), 0.01);
  const selected = new Set();
  for (let r = rowOf(lat - dLat); r <= rowOf(lat + dLat); r++) {
    for (let c = colOf(lon - dLon); c <= colOf(lon + dLon); c++) {
      if (haversineKm(lat, lon, rowLat(r), colLon(c)) <= km) selected.add(r * COLS + c);
    }
  }
  const snapped = selected.size === 0;
  selected.add(cellId(lat, lon));
  return split(selected, coverageSet, snapped);
}

export function cellsToRanges(ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  const ranges = [];
  for (const id of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && id <= last[1] + 1) last[1] = id;
    else ranges.push([id, id]);
  }
  return ranges;
}

export const MAX_OR_RANGES = 40;

export function rangesSQL(ranges, column = 'cell_id') {
  if (!ranges.length) return 'FALSE';
  // Many ranges (a large area): an id list is far faster to evaluate than hundreds of ORs; the BETWEEN guard keeps
  // Parquet row-group skipping. Same rows either way.
  if (ranges.length > MAX_OR_RANGES) {
    const ids = [];
    for (const [a, b] of ranges) {
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError('Cell ranges must be integers');
      for (let i = a; i <= b; i++) ids.push(i);
    }
    return `(${column} BETWEEN ${ranges[0][0]} AND ${ranges[ranges.length - 1][1]} AND ${column} IN (${ids.join(',')}))`;
  }
  const parts = ranges.map(([a, b]) => {
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError('Cell ranges must be integers');
    return a === b ? `${column} = ${a}` : `${column} BETWEEN ${a} AND ${b}`;
  });
  return `(${parts.join(' OR ')})`;
}

export function outlineGeoJSON(ids) {
  return {
    type: 'FeatureCollection',
    features: ids.map((id) => {
      const s = Math.floor(id / COLS) / 10 - 90;
      const w = (id % COLS) / 10 - 180;
      const n = s + 0.1;
      const e = w + 0.1;
      return {
        type: 'Feature',
        properties: { cell_id: id },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      };
    }),
  };
}

export function areaKm2(ids) {
  const side = 0.1 * RAD * EARTH_KM;
  let km2 = 0;
  for (const id of ids) km2 += side * side * Math.cos(cellCenter(id)[0] * RAD);
  return km2;
}
