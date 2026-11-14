# Burning Activity Calendar (NASA Space Apps 2026)

A web app that turns 26 years of NASA FIRMS satellite fire detections for India into one consistent calendar of burning activity, for any area you draw or type.

**Live:** https://ashimajain777.github.io/fire-calendar/ · **Method and validation:** https://ashimajain777.github.io/fire-calendar/methodology.html

## What it does

- Harmonizes MODIS (Terra, Aqua) and VIIRS (S-NPP, NOAA-20) hotspots into one series in **NOAA-20-equivalent** units, from November 2000 to the latest daily update, with uncertainty bands for converted years.
- Shows a year × month calendar with accessible colour ramps, an anomaly view (percentile and z-score against 2003–2025), the latest month against typical, trends, annual anomalies, fire-season timing and a breakdown by fire type.
- Keeps every detection: industrial and other persistent sources, urban, volcanic and offshore hotspots are classified, not deleted, and can be switched on.
- Exports the hotspots in your area as CSV, the monthly and annual tables as CSV, and each chart as SVG or PNG.

Everything shown is computed in your browser from the published data files; there is no server.

## How it works

```
FIRMS country CSVs (2000–2025) + FIRMS Area API (current year)
  → pipeline/ingest.py      normalise, clip to India, de-duplicate
  → pipeline/classify.py    category from FIRMS type + static-source mask + land cover
  → pipeline/harmonize.py   Terra→Aqua→S-NPP→NOAA-20 ratio chain, per category × month, with bands
  → pipeline/aggregate.py   0.1° cell × 10-day table + invariants
  → pipeline/validate.py    leave-one-year-out error, step test, breakdowns
  → data/ (tables, in git) + GitHub Release "data" (points, current year) → GitHub Pages
Browser: DuckDB-WASM reads the Parquet files with HTTP range requests.
Daily: .github/workflows/daily.yml refreshes the current year at 03:30 UTC.
```

Design, decisions and contracts: [`docs/PLAN.md`](docs/PLAN.md), [`docs/adr/`](docs/adr/), [`docs/CONTRACTS.md`](docs/CONTRACTS.md), [`docs/DECISIONS.md`](docs/DECISIONS.md). Build history: [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md); results: [`docs/BUILD_REPORT.md`](docs/BUILD_REPORT.md).

## Rebuild from scratch

Needs Python 3.12, `gh` (logged in), and a `.env` at the project root with `FIRMS_MAP_KEY` (and `EARTHDATA_USERNAME`/`EARTHDATA_PASSWORD`/`APPEEARS_TASK_ID` for the land-cover download). `.env` is git-ignored.

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt rasterio
bash scripts/download_csvs.sh
.venv/Scripts/python -m pipeline.build --region india --steps ingest_api
.venv/Scripts/python -m pipeline.build --region india
```

Land cover: put the MCD12Q1 GeoTIFF (from the AppEEARS task) in `work/aux/lc_*.tif`. The clip boundary (below) goes in `work/aux/`.

Tests: `.venv/Scripts/python -m pytest pipeline/tests -q` and `node --test "web/tests/*.test.js"`.

## Data sources

| Data | Source |
|---|---|
| Active fire hotspots | NASA FIRMS: MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m (S-NPP, NOAA-20, NOAA-21), standard processing and near-real-time |
| Land cover | MODIS MCD12Q1 v061 LC_Type1 (IGBP), 2024, 500 m, via NASA AppEEARS |
| Boundary | **Natural Earth 1:10m admin-0 countries, India point-of-view version** (`ne_10m_admin_0_countries_ind`), used for clipping |
| Basemap | OpenFreeMap (OpenStreetMap data) |

## Known limitations

- India only for now; the pipeline is region-agnostic.
- The static-source mask is built from the last 5 years and applied to all years, so a newer kiln can label older fires at that spot "industrial".
- Land cover is a single year (2024).
- Ground-reported fires are not covered: India has no open nationwide ground-report dataset, so only satellite detections are counted.
- Areas are snapped to a 0.1° grid (about 11 km).
- Season dates are accurate to about ±10 days (10-day periods).
- Values before 2018 are converted. The conversion is good for India-wide monthly totals (median error 3–15 % by link) but much less certain for small areas (about 10–47 % for 1° boxes); see the Methodology page.
- Mumbai High offshore flares are not in the FIRMS India country file.
- NOAA-21 is stored for 2026 only (no per-country archive file) and is not used in the harmonized series.
