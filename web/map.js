// Map: MapLibre GL JS + mapbox-gl-draw. See docs/CONTRACTS.md section 6 and docs/PLAN.md section 8.3.
// Imported inside initMap so nothing loads from the CDN until a page asks for a map.

const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs';
const DRAW = 'https://cdn.jsdelivr.net/npm/@mapbox/mapbox-gl-draw@1.5.2/+esm';
const STYLE = 'https://tiles.openfreemap.org/styles/positron';

export const MAX_POINTS = 20000;
// The basemap is light in both themes, so the light-mode category colours and a light ring are used on it.
const GROUPS = [
  { label: 'Landscape fire', color: '#2a78d6' },      // categories 0-3
  { label: 'Industrial / static', color: '#eb6834' }, // category 5
  { label: 'Urban, volcanic, offshore', color: '#1baf7a' }, // categories 4, 6, 7
];
const RING = '#fcfcfb';
const INK = '#1d2433';
const groupOf = (category) => (category <= 3 ? 0 : category === 5 ? 1 : 2);

const EMPTY = { type: 'FeatureCollection', features: [] };
const asFC = (g) => (!g ? EMPTY : g.type === 'FeatureCollection' ? g : { type: 'FeatureCollection', features: [g.type === 'Feature' ? g : { type: 'Feature', properties: {}, geometry: g }] });

let map = null;
let draw = null;
let ready = null;
let note = null;
let cancelRect = null;

export function initMap(el, onGeometry) {
  ready = (async () => {
    const [maplibre, drawModule] = await Promise.all([import(MAPLIBRE), import(DRAW)]);
    const MapboxDraw = drawModule.default;
    // gl-draw looks for Mapbox class names; point it at MapLibre's.
    Object.assign(MapboxDraw.constants.classes, {
      CANVAS: 'maplibregl-canvas', CONTROL_BASE: 'maplibregl-ctrl', CONTROL_PREFIX: 'maplibregl-ctrl-',
      CONTROL_GROUP: 'maplibregl-ctrl-group', ATTRIBUTION: 'maplibregl-ctrl-attrib',
    });

    map = new maplibre.Map({ container: el, style: STYLE, center: [79, 22.5], zoom: 3.6, attributionControl: { compact: true } });
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
    draw = new MapboxDraw({ displayControlsDefault: false });
    map.addControl(draw);

    const legend = document.createElement('div');
    legend.className = 'legend map-legend';
    legend.innerHTML = '<span class="legend-title">Hotspot type</span>';
    for (const g of GROUPS) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const dot = document.createElement('span');
      dot.className = 'map-dot';
      dot.style.background = g.color;
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, g.label);
      legend.append(item);
    }
    note = document.createElement('p');
    note.className = 'notice map-note';
    note.hidden = true;
    note.setAttribute('role', 'status');
    el.append(legend, note);

    await new Promise((resolve, reject) => {
      map.once('load', resolve);
      map.once('error', (e) => reject(new Error(`Couldn't load the base map: ${e && e.error ? e.error.message : 'unknown error'}`)));
    });

    for (const id of ['boundary', 'mask', 'area', 'cells', 'rect', 'points']) map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'boundary', type: 'line', source: 'boundary', paint: { 'line-color': INK, 'line-width': 1, 'line-opacity': 0.6 } });
    map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': GROUPS[1].color, 'fill-opacity': 0.35, 'fill-outline-color': GROUPS[1].color } });
    map.addLayer({ id: 'area', type: 'line', source: 'area', paint: { 'line-color': INK, 'line-width': 2, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'cells', type: 'line', source: 'cells', paint: { 'line-color': '#184f95', 'line-width': 1, 'line-opacity': 0.7 } });
    map.addLayer({ id: 'rect', type: 'line', source: 'rect', paint: { 'line-color': '#184f95', 'line-width': 2 } });
    map.addLayer({
      id: 'points', type: 'circle', source: 'points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 9, 4.5],
        'circle-color': ['match', ['get', 'g'], 0, GROUPS[0].color, 1, GROUPS[1].color, GROUPS[2].color],
        'circle-stroke-color': RING, 'circle-stroke-width': 1,
      },
    });

    map.on('draw.create', (e) => {
      const geometry = e.features[0].geometry;
      draw.deleteAll(); // the app draws the accepted area itself (showArea), same as for typed areas
      onGeometry(geometry);
    });
    return { onGeometry };
  })();
  return ready;
}

async function setData(id, fc) {
  await ready;
  map.getSource(id).setData(asFC(fc));
}

export const showCells = (fc) => setData('cells', fc);
export const showMask = (fc) => setData('mask', fc);
export const showBoundary = (geojson) => (geojson ? setData('boundary', geojson) : Promise.resolve());
export const showArea = (geojson) => setData('area', geojson);

// rows: [{lat, lon, category, ...}]. Draws at most MAX_POINTS and says so when there are more.
export async function showPoints(rows) {
  const shown = rows.length > MAX_POINTS ? rows.slice(0, MAX_POINTS) : rows;
  await setData('points', {
    type: 'FeatureCollection',
    features: shown.map((r) => ({
      type: 'Feature',
      properties: { g: groupOf(r.category), category: r.category, acq_date: r.acq_date, satellite: r.satellite },
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    })),
  });
  note.hidden = rows.length <= MAX_POINTS;
  note.textContent = note.hidden ? '' : `Showing the first ${MAX_POINTS.toLocaleString('en-US')} hotspots of this month. The CSV download has all of them.`;
}

export async function fitTo([w, s, e, n]) {
  await ready;
  map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 10, duration: 0 });
}

export async function drawPolygon() {
  await ready;
  if (cancelRect) cancelRect();
  draw.deleteAll();
  draw.changeMode('draw_polygon');
}

// Rectangle is not part of gl-draw: two clicks on opposite corners, with a live outline in between.
export async function drawRectangle() {
  const { onGeometry } = await ready;
  if (cancelRect) cancelRect();
  draw.changeMode('simple_select');
  let first = null;
  const ring = (a, b) => {
    const [w, e] = [Math.min(a.lng, b.lng), Math.max(a.lng, b.lng)];
    const [s, n] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)];
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  };
  const move = (e) => { if (first) map.getSource('rect').setData(asFC(ring(first, e.lngLat))); };
  const click = (e) => {
    if (!first) { first = e.lngLat; return; }
    const geometry = ring(first, e.lngLat);
    cancelRect();
    if (first.lng !== e.lngLat.lng && first.lat !== e.lngLat.lat) onGeometry(geometry);
  };
  const key = (e) => { if (e.key === 'Escape') cancelRect(); };
  cancelRect = () => {
    map.off('click', click);
    map.off('mousemove', move);
    document.removeEventListener('keydown', key);
    map.getCanvas().style.cursor = '';
    map.doubleClickZoom.enable();
    map.getSource('rect').setData(EMPTY);
    cancelRect = null;
  };
  map.on('click', click);
  map.on('mousemove', move);
  document.addEventListener('keydown', key);
  map.getCanvas().style.cursor = 'crosshair';
  map.doubleClickZoom.disable();
}
