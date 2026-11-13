# ADR-003: Regular 0.1° grid as the spatial unit (not H3)

**Status:** Proposed
**Date:** 2026-11-14

## Context
- Hotspots must be aggregated so VIIRS's several detections per MODIS footprint don't inflate counts, and so area queries are fast.
- Climate data (ERA5-Land at 0.1°, FWI at 0.25°) and land cover (resampled) need to join onto the same unit.
- DuckDB-WASM must compute cell IDs without extensions.

## Decision
- 0.1° lat/lon cells: `cell_id = floor((lat+90)*10)*3600 + floor((lon+180)*10)`.
- A 0.01° sub-grid is used only for the static-source mask and for exposure.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| 0.1° grid (chosen) | One line of arithmetic in SQL, JS and Python; aligns with ERA5-Land; contiguous row-major IDs give good Parquet pruning | Cells shrink in area towards the poles (fine for India; areas are computed per cell for global) |
| H3 resolution 6 (~36 km²) or 5 (~250 km²) | Equal-area hexagons, nice maps | Needs the H3 extension in DuckDB-WASM (availability and size risk) or an extra JS library; no climate alignment; harder for basic devs |
| No grid (point counts) | Simplest | VIIRS/MODIS footprint mismatch; slow area queries |

## Consequences
- An area selection is snapped to cells by cell centre and shown on the map. The CSV uses the same cells, so counts match.
- The resolution is about 11 km, so small polygons snap coarsely, and the UI says so.
- Revisit: equal-area weighting when expanding globally.
