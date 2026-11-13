# ADR-005: MapLibre GL JS + mapbox-gl-draw + OpenFreeMap tiles

**Status:** Proposed
**Date:** 2026-11-14

## Context
We need a map with rectangle and polygon drawing, tens of thousands of points (map and timelapse), a snapped-cell overlay, no API key and no cost.

## Decision
- MapLibre GL JS (WebGL).
- @mapbox/mapbox-gl-draw for drawing (1.5.x; works with MapLibre using the documented CSS-class shim).
- OpenFreeMap vector tiles (free, no key).
- Pin exact versions at least 2 weeks old.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| MapLibre + gl-draw (chosen) | WebGL handles 100k points and a smooth timelapse; data-driven styling; free tiles | Drawing plugin is mouse-only (the keyboard form covers this); slightly more setup |
| Leaflet + Leaflet.draw | Easiest API; huge docs | Canvas/SVG struggles beyond ~20–50k points; timelapse less smooth |
| deck.gl | Best for big animated point layers | Heavier; extra learning; drawing needs another library |

## Consequences
- The timelapse uses a MapLibre GeoJSON source updated per frame. deck.gl is only a fallback if performance requires it.
- Basemap boundaries: choose a style without disputed-boundary lines where possible, and label the source.
