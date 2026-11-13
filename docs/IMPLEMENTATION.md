# Harmonized Burning Activity Calendar: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed static web app showing a harmonized MODIS + VIIRS hotspot calendar (July 2002 → today) for any area in India, with anomalies, season timing, categories and honest exports, built from real FIRMS data in 24 hours.

**Architecture:**
- A Python + DuckDB pipeline turns FIRMS country CSVs (2002–2025) and the FIRMS Area API (2026 → today) into Parquet:
  - raw points with a category and a harmonization weight, on a Hugging Face dataset
  - a cell × dekad × category table in the repo
- A static GitHub Pages app queries both with DuckDB-WASM using HTTP range reads.
- A daily GitHub Action refreshes the current year.

**Tech Stack:**
- Python (`py` launcher, 3.14, fallback 3.12), duckdb (+ spatial extension), pyarrow, rasterio (one-off), requests, huggingface_hub, pytest.
- Browser: plain ES modules, @duckdb/duckdb-wasm, maplibre-gl, @mapbox/mapbox-gl-draw, @turf/turf, @observablehq/plot, Public Sans. Tests use `node --test`.
- GitHub Pages + Actions.

**Spec:** [`docs/PLAN.md`](PLAN.md) and ADRs in [`docs/adr/`](adr/). Read PLAN §4–§8 before any task.

## Global Constraints

- No hardcoded, mocked or simulated outputs anywhere in the app. Every displayed number comes from FIRMS-derived files. Tests may use hand-built inputs; the app never displays them.
- No special-case logic for any area, including the demo areas.
- If a file or source fails, show the error and the last successful update time. Never show substitute numbers.
- Every data location lives in `config.json` (keys `data.dekad`, `data.tables`, `data.points`). No other file contains a data URL or path prefix.
- The dekad files are committed to the repo, one per year, each < 100 MB. Raw points go on HF (fallback: GitHub Releases).
- Harmonized unit: NOAA-20-equivalent. Chain: Aqua MODIS until S-NPP's first day (2012-01-20) → S-NPP until NOAA-20's first full month → NOAA-20. Fit years: Aqua→S-NPP 2012–2021; S-NPP→NOAA-20 from NOAA-20's first full year through 2025.
- Base period for climatology, percentiles and z-scores: 2003–2025, excluding the current year.
- Confidence filter: MODIS `confidence >= 30`; VIIRS `n` or `h`. Low-confidence points are kept in files and excluded from counts.
- Category codes: `0 agricultural, 1 forest, 2 grass_shrub, 3 other_veg, 4 urban, 5 industrial, 6 volcanic, 7 offshore`. Landscape = {0,1,2,3}; default visible = landscape.
- Harmonization strata = categories 0–5 × calendar month. Fallback below 200 detections: stratum all-months, then all landscape. Categories 6–7 get weight 0 (not harmonized).
- Grid: `cell_id = floor((lat+90)*10)*3600 + floor((lon+180)*10)`; `cell001_id = floor((lat+90)*100)*36000 + floor((lon+180)*100)`. `lat=90` and `lon=180` clamp into the last index.
- Static mask: 0.01° cells; ≥3 FIRMS `type=2` → `firms_static`; ≥3 `type=1` → `volcano`; persistent = fire on ≥30 distinct days in ≥3 of the last 5 complete years **and** ≥6 distinct calendar months in at least one of those years.
- Colours: sequential = blue 100→700 from `docs/PLAN.md` §8.3, 7 quantile bins; diverging = blue ↔ grey `#f0efec`/`#383835` ↔ red, bins ≤10/10–25/25–40/40–60/60–75/75–90/≥90 percentile; map category groups = `#2a78d6`/`#eb6834`/`#1baf7a` (dark `#3987e5`/`#d95926`/`#199e70`). No dual-axis charts.
- Library versions are pinned exactly, each released at least 2 weeks before the build day. Checked on 14 Nov 2026: duckdb-wasm 1.32.0, mapbox-gl-draw 1.5.2, turf 7.4.0; maplibre-gl and Plot = the release before the newest (the newest are under 2 weeks old).
- WCAG 2.1 AA:
  - Every chart has a table view.
  - The calendar is a `<table>` with arrow-key navigation.
  - Focus ring is 2 px.
  - Targets ≥ 44 px.
  - No autoplay.
- Performance: ≤ 2 s for a district-sized area once warm; ≤ 6 s for all of India.

## Review Focus

1. **An area smaller than one cell, or a thin polygon with no cell centre inside it.** Expected: use the cell(s) containing the polygon's centroid and vertices, and say "Area is smaller than one 11 km grid cell; using the cell that contains it." The test goes in Task 6 (`cells.test.js`).
2. **An area partly or fully outside India.** Expected: count only covered cells and say "N % of this area is outside data coverage". Fully outside shows "No data coverage here yet (India only for now)", never zeros. The test goes in Task 6.
3. **The first days of a month (no completed dekad yet).** Expected: the "this month vs typical" card compares the last completed month and says so. It never compares a partial dekad with full historical dekads. The test goes in Task 7 (`stats.test.js`, `monthToDate`).
4. **An area with no fires, or a base period of all zeros.** Expected: an empty calendar with "No hotspots detected…". Median 0 and sd 0 give "—", never NaN, Infinity or "0th percentile" for everything. The test goes in Task 7.
5. **Stale or missing `meta.json`, or a failed file fetch.** Expected: the badge turns warning after 36 h and critical after 72 h or when the last run failed, and charts show the fetch error. The test goes in Task 10 (`freshness.test.js`).


## Amendments (14 Nov 2026, build prompt + unattended-build decisions)

These override anything below that disagrees. The exact contracts are in [`CONTRACTS.md`](CONTRACTS.md); decisions made during the build are in [`DECISIONS.md`](DECISIONS.md).

1. **Deploy fix.** The daily job uploads the current-year dekad file and `meta.json` to the `data` GitHub Release. One shared deploy step (`.github/actions/deploy-site`) is used by every deploy, push-triggered or daily. It copies the release files into the Pages artifact, so a code push never drops current-year data.
2. **Series starts November 2000.** A third link, Terra MODIS -> Aqua MODIS, is fitted on 2003-2011. Chain: Terra (2000-11 until Aqua's first full month) -> Aqua -> S-NPP -> NOAA-20. Same ratio code, same `ratios.parquet` (`link = "terra_aqua"`), same bands, its own leave-one-year-out validation. Terra outages are flagged in `gaps.parquet` and never shown as zeros. The base period stays 2003-2025.
3. **Boundary.** Clipping and any drawn boundary use Natural Earth's India point-of-view admin-0 file (`ne_10m_admin_0_countries_ind`).
4. **Region stratum decided by data.** Strata are region (5 deg box) x category x month, with the fallback ladder region-stratum-month -> all-India stratum-month -> stratum all-months -> all landscape (at 200 detections). Both variants (with and without region) are validated, and the one with the lower median absolute % error and acceptable band coverage is kept. Both results are shown on the Methodology page.
5. **Known limitations to document:** the static mask is built from the last 5 years and applied to all years; land cover is a single year; ground-reported fires are not covered (no open nationwide dataset), only satellite detections.
6. **Points host.** No Hugging Face token was available, and GitHub Release assets can't be read cross-origin by the browser (tested: blocked by CORS). Points files are stored as assets on the `data` release and bundled into the Pages artifact at deploy, so the browser reads them from the app's own origin.
7. **File names** are `points_{YYYY}.parquet` and `dekad_{YYYY}.parquet`.
8. **Chain switch dates** are the first day of each newer satellite's first full month of data.

---

## Schedule (24 h, H0 = start)

One Claude Code session builds everything, one task at a time. Person 2 works the right-hand column alongside.

| Hours | Claude Code session (build) | Person 2 (non-coding) | Milestone |
|---|---|---|---|
| H0–1 | Task 0: repo, venv, config, CI skeleton | **Start waiting tasks now:** FIRMS MAP_KEY; Earthdata login + **AppEEARS request** (MCD12Q1 LC_Type1, India, latest year, GeoTIFF); HF account + dataset repo + write token; GitHub repo + Pages (source: Actions) + secrets; run `download_country_csvs` (about 1 GB); *optional:* ECMWF account + licences (CEMS fire, ERA5-Land), Telegram bot via BotFather | |
| H1–2 | Task 1: **range-read gate** (Pages + HF, fallback Releases) | Download Natural Earth admin-0 10m; check CSV download completeness (file count, sizes) | Gate decided |
| H2–3.5 | Task 2: grid + ingest (CSV + Area API backfill for 2026) | Spot-check normalised Parquet against FIRMS's web map for 3 random days | |
| H3.5–5 | Task 3: land cover lookup, static mask, classify | Visually check mask cells over Jharia, Mumbai High, Jamnagar; note what's missed | |
| H5–7 | Task 4: harmonization ratios + weights + bands | Draft Methodology wording; collect citations | |
| H7–8 | Task 5: dekad table + invariants + publish (HF upload, commit dekad) | Verify upload; record file sizes | **M1-data** |
| H8–10.5 | Task 6: web MVP: config, DuckDB, map + area form, cells, calendar (counts), this-month card, KPIs, points CSV, Pages deploy | Test the 3 walkthrough areas; time the queries; log issues | **M1 MVP live** (~H10.5) |
| H10.5–11.5 | Task 7: stats.js + anomaly view + rankings | Re-test; compare calendar totals with CSV row counts | |
| H11.5–12.5 | Task 8: trend with bands, anomaly bars, downloads (tables CSV, SVG/PNG) | Start slide deck: problem, method, demo flow | |
| H12.5–14 | Task 9: validate.py + Methodology page | Read Methodology page for clarity; check the numbers make sense | |
| H14–15.5 | Task 10: daily Action + meta.json + freshness badge | Trigger `workflow_dispatch`; confirm the badge updates; run the bad-key failure test | |
| H15.5–16.5 | Task 11: category toggles + per-category calendars + mask layer | Jharia demo: industrial on/off story | |
| H16.5–17.5 | Task 12: season detection | Check Punjab shows two seasons and Uttarakhand spring | |
| H17.5–18.5 | Task 13: accessibility, dark mode, mobile, palette validation | Keyboard-only run, NVDA on calendar, 200 % zoom, phone check | **M2 Core done** (~H18.5) |
| **— CUT LINE —** | *Everything below only if M2 is done on time* | | |
| H18.5–20 | Task 14 (stretch): comparison mode | Prepare comparison demo (Punjab 2016 vs 2025?) | |
| H20–21.5 | Task 15 (stretch): timelapse, **or** Task 16 (climate) if Person 2 already downloaded the ECMWF data | | |
| H21.5–22 | Buffer / bug fixes | | |
| H22–24 | **Feature freeze.** Cross-check script, README, final deploy, demo rehearsal ×2 | Rehearse the demo; final slides; record a backup screen video | **Demo ready** |
| after | Future: Task 16 climate (if not done), Task 17 exposure, Task 18 alerts, global coverage | | |

**Honest expectation:**
- MVP and Core fit, with little slack.
- Comparison mode probably fits.
- Of timelapse and climate, at most one fits.
- Exposure and alerts almost certainly don't fit in 24 h and are future scope. The architecture leaves room for them (PLAN §14).

---

## File Structure

```
config.json                     single data-location config
requirements.txt                duckdb pyarrow requests huggingface_hub pytest (+ rasterio, local only)
pipeline/__init__.py
pipeline/settings.py            load_config(), REGIONS, constants from Global Constraints
pipeline/grid.py                cell_id, cell001_id, cell_center, CELL_ID_SQL, CELL001_SQL
pipeline/ingest.py              download_country_csvs, fetch_area_api, build_points_stage
pipeline/classify.py            build_landcover_lookup, build_static_mask, classify_points, CATEGORY codes
pipeline/harmonize.py           fit_ratios, apply_weights
pipeline/aggregate.py           build_dekad, check_invariants
pipeline/validate.py            step_stats, loyo, breakdown, write_validation
pipeline/publish.py             upload_points, squash_history, write_meta
pipeline/build.py               CLI: full archive rebuild
pipeline/daily.py               CLI: current-year refresh
pipeline/tests/test_*.py
pipeline/static/lc001.parquet   0.01° land-cover lookup (not served)
data/cells.parquet ratios.parquet static_mask.parquet meta.json validation/*.parquet
data/dekad/year=YYYY.parquet
web/index.html methodology.html styles.css
web/app.js db.js cells.js queries.js stats.js calendar.js charts.js map.js freshness.js methodology.js
web/tests/*.test.js
.github/workflows/pages.yml daily.yml
work/                           git-ignored: downloads, staging parquet
```

---

### Task 0: Project skeleton and environment

**Files:**
- Create: `config.json`, `requirements.txt`, `.gitignore` (`work/`, `.venv/`), `pipeline/__init__.py`, `pipeline/settings.py`, `pipeline/tests/test_settings.py`, `.github/workflows/pages.yml`, `web/index.html` (placeholder heading only)

**Interfaces:**
- Produces:
  - `settings.load_config() -> dict` (parses `config.json`)
  - `settings.REGIONS: dict[str, dict]` with key `"india"` → `{"country_file_name": "India", "bbox": (68.0, 6.0, 98.0, 38.0), "clip_polygon": "work/aux/ne_10m_admin_0_countries.shp", "clip_name": "India", "buffer_deg": 0.1}`
  - constants `BASE_YEARS = range(2003, 2026)`, `CONF_MODIS_MIN = 30`, `LANDSCAPE = {0,1,2,3}`

- [ ] **Step 1:** `git init`. Create a branch `main`, then create the GitHub repo with `gh repo create --public --source . --push`, after asking the user to confirm the repo name.
- [ ] **Step 2:** `py -3.14 -m venv .venv` then `.venv/Scripts/python -m pip install -r requirements.txt rasterio`. If rasterio has no wheel, delete `.venv`, run `py install 3.12` and retry with `py -3.12`.
- [ ] **Step 3: Write the failing test** `test_config_has_single_data_block`: `load_config()["data"]` has exactly the keys `{"dekad", "tables", "points"}`, and the points value starts with `https://`.
- [ ] **Step 4:** Run `.venv/Scripts/python -m pytest pipeline/tests -q`. Expected: FAIL.
- [ ] **Step 5:** Implement `settings.py` and `config.json` (points URL = the HF dataset `resolve/main/points/` URL Person 2 created).
- [ ] **Step 6:** Run the tests. Expected: PASS.
- [ ] **Step 7:** `pages.yml`: on push to `main` and `workflow_dispatch`, upload `web/` + `data/` + `config.json` as the Pages artifact (layout: `/index.html`, `/data/...`, `/config.json`) and deploy with `actions/deploy-pages`.
- [ ] **Step 8:** Commit `chore: project skeleton`, push, and open the Pages URL in the built-in browser. Expected: the placeholder heading.

### Task 1: Range-read gate (hour 1, decides the points host)

**Files:**
- Create: `web/gate.html` (temporary diagnostic; deleted in Task 6)

**Interfaces:**
- Consumes: Pages URL; HF dataset; one real FIRMS file.
- Produces: the final value of `config.json` → `data.points` (HF or GitHub Releases).

- [ ] **Step 1:** Convert one real downloaded file (`modis_2023_India.csv`) to Parquet with a few lines of duckdb Python (`COPY ... TO ... (FORMAT parquet, ROW_GROUP_SIZE 10000)`), sorted by latitude. Upload one copy to the HF dataset (`gate/test.parquet`) and commit one under `data/gate/`.
- [ ] **Step 2:** `gate.html` loads duckdb-wasm 1.32.0 from jsDelivr and runs `SELECT count(*), min(acq_date) FROM read_parquet('<url>') WHERE latitude BETWEEN 30 AND 31` for both URLs. It prints results and timings.
- [ ] **Step 3:** Deploy, open in the built-in browser, and read network requests. **Pass criteria:** both URLs return results, requests show `Range` headers with HTTP 206, and the bytes transferred are well under the file size.
- [ ] **Step 4:** If HF fails, create a GitHub Release `points-v1`, attach the file, and repeat. Release asset URLs redirect to `objects.githubusercontent.com`, so also check that CORS passes after the redirect. Set `data.points` to whichever passed. If both fail, stop and tell the user: the decision changes (points move into the Pages artifact).
- [ ] **Step 5:** Commit `chore: verify range reads; set points host`.

### Task 2: Grid and ingest

**Files:**
- Create: `pipeline/grid.py`, `pipeline/ingest.py`, `pipeline/tests/test_grid.py`, `pipeline/tests/test_ingest.py`

**Interfaces:**
- Produces:
  - `grid.cell_id(lat: float, lon: float) -> int`, `grid.cell001_id(lat, lon) -> int`, `grid.cell_center(cell_id: int) -> tuple[float, float]`
  - `grid.CELL_ID_SQL: str` and `grid.CELL001_SQL: str` (DuckDB expressions over columns `lat`, `lon`)
  - `ingest.download_country_csvs(region: str, sensors: list[str], years: range, out_dir: Path) -> list[Path]` (sensors ∈ `modis`, `viirs-snpp`, `viirs-jpss1`; skips existing files; 404 → recorded as missing, not an error)
  - `ingest.fetch_area_api(source: str, bbox: tuple, start: date, end: date, map_key: str, out_dir: Path) -> list[Path]` (5-day chunks; retry 3× with backoff 5/20/60 s; raises `FirmsError` with source, date and HTTP status)
  - `ingest.build_points_stage(con, region: str, inputs: list[tuple[Path, str, str]], out_dir: Path) -> dict[int, int]`. Inputs are `(path, satellite, processing)`. It writes `work/stage/year=Y.parquet` and returns the row count per year.
- Satellite comes from the **source** (folder or API source name), not the CSV field: `modis` → the `satellite` column (`Aqua`/`Terra`); `viirs-snpp`/`VIIRS_SNPP_*` → `SNPP`; `viirs-jpss1`/`VIIRS_NOAA20_*` → `NOAA20`; `VIIRS_NOAA21_*` → `NOAA21`.
- Stage columns are as in PLAN §6.1, except `category`, `in_baseline_chain` and the `harm_*` columns.

- [ ] **Step 1: Write failing tests:**
  - `test_cell_id_known`: `cell_id(0.05, 0.05) == 900*3600 + 1800`
  - `test_cell_id_edges`: `cell_id(90, 180) == 1799*3600 + 3599`; `cell_id(-90, -180) == 0`
  - `test_center_roundtrip`: for (31.27, 75.81), `cell_id(*cell_center(cell_id(lat, lon))) == cell_id(lat, lon)`
  - `test_sql_matches_python`: DuckDB evaluates `CELL_ID_SQL` on 5 points and matches Python
  - `test_conf_class`: MODIS 29 → `l`, 30 → `n`, 80 → `h`; VIIRS `l/n/h` unchanged
  - `test_dedup_prefers_sp`: the same `(lat, lon, acq_date, acq_time, satellite)` in SP and NRT gives one row with `processing='SP'`
  - `test_clip_buffer`: a point 0.05° offshore of the clip polygon is kept; 0.5° offshore is dropped. Use a hand-built square polygon via a `clip_wkt` override parameter.
- [ ] **Step 2:** Run `pytest pipeline/tests/test_grid.py pipeline/tests/test_ingest.py -q`. Expected: FAIL.
- [ ] **Step 3:** Implement. Clip with the DuckDB spatial extension: `ST_Within(ST_Point(lon, lat), ST_Buffer(geom, buffer_deg))`. Read the shapefile with `ST_Read`, filtered on `NAME = clip_name`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Backfill 2026 for India: `fetch_area_api` for `VIIRS_NOAA20_SP`, then `VIIRS_NOAA20_NRT` for dates after the SP end (from `/api/data_availability/csv/{key}/ALL`); `VIIRS_SNPP_SP`/`_NRT` to 2026-11-02; `MODIS_SP`/`_NRT`; `VIIRS_NOAA21_SP`/`_NRT`.
- [ ] **Step 6:** Run `build_points_stage` on all CSVs and the API files. Expected: one file per year 2002–2026. Log row counts and compare with the CSV line counts (minus headers and the clip drop, which is logged).
- [ ] **Step 7:** Commit `feat(pipeline): grid and ingest`. `work/` is not committed.

### Task 3: Land cover, static mask, classification

**Files:**
- Create: `pipeline/classify.py`, `pipeline/tests/test_classify.py`, `pipeline/static/lc001.parquet`, `data/cells.parquet`, `data/static_mask.parquet`

**Interfaces:**
- Consumes: stage Parquet (Task 2), `grid.*`.
- Produces:
  - `classify.CATEGORY: dict[str, int]` (codes in Global Constraints)
  - `classify.build_landcover_lookup(tif: Path, region: str, out001: Path, out_cells: Path) -> None`. `lc001.parquet` = `(cell001_id, igbp)`, majority class per 0.01° cell. `cells.parquet` = `(cell_id, lat_c, lon_c, lc_class, in_coverage)`, where `lc_class` is the majority category-class of land 0.01° cells and `in_coverage` is true when the cell centre is within the buffered clip polygon.
  - `classify.build_static_mask(con, stage_glob: str, years: list[int], out: Path) -> dict[str, int]` (counts per reason)
  - `classify.classify_points(con, stage_glob: str, lc001: Path, mask: Path, out_dir: Path) -> dict[int, int]`. It writes `work/classified/year=Y.parquet` with `category` added and returns counts per category.
- Rule order (first match): volcanic, offshore, industrial, urban, agricultural, forest, grass_shrub, other_veg. IGBP mapping as in PLAN §5.1. A point whose 0.01° cell has no land cover (sea) → offshore.

- [ ] **Step 1: Write failing tests:**
  - `test_rules_table`, parametrised over every row of PLAN §5.1: `(firms_type, igbp, in_mask_reason) → category`. Includes: type 0 + IGBP 12 → 0; type 0 + IGBP 13 → 4; type NULL + mask `persistent` + IGBP 12 → 5; type 2 → 5; type 1 → 6; type 3 → 7; type 0 + IGBP 16 → 3; type NULL + no land cover → 7.
  - `test_mask_persistence`: a cell with fire on 30 days in each of 3 years across 6 months → `persistent`.
  - `test_mask_crop_excluded`: 40 days per year in 3 years, but only in Apr–May and Oct–Nov → not in mask.
  - `test_mask_firms_static`: 3 type-2 points → `firms_static`.
  - `test_same_mask_sp_nrt`: identical points, one SP with type 0 and one NRT with type NULL, in a mask cell → both category 5.
  - `test_no_deletion`: rows out == rows in.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `build_landcover_lookup` uses rasterio once (local). The mask uses the last 5 complete years present in the stage (computed, not typed). Mask inputs are VIIRS SNPP + NOAA20 with `conf_class != 'l'`, plus all points with `firms_type IN (1, 2)`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Run on real data once the AppEEARS GeoTIFF arrives. If it hasn't arrived by H5, use the MCD12C1 fallback via `earthaccess` and note it in `meta.json` → `landcover_source`. Print mask counts per reason and category counts per year.
- [ ] **Step 6:** Commit `feat(pipeline): classification and static mask` (with `lc001.parquet`, `cells.parquet`, `static_mask.parquet`).

### Task 4: Harmonization ratios, weights and bands

**Files:**
- Create: `pipeline/harmonize.py`, `pipeline/tests/test_harmonize.py`, `data/ratios.parquet`

**Interfaces:**
- Consumes: classified points (Task 3).
- Produces:
  - `harmonize.chain_dates(con, glob) -> dict` → `{"snpp_start": date, "noaa20_start": date}`. Computed from data: S-NPP's first acquisition date; NOAA-20's first day of the first full month with data.
  - `harmonize.fit_ratios(con, glob: str, link: str, fit_years: range, metric: str) -> pyarrow.Table`. `link ∈ {"aqua_snpp", "snpp_noaa20"}`; `metric ∈ {"n", "fd"}`. Columns: `link, metric, stratum, month, r, r_lo, r_hi, n_years, n_detections, fallback`.
  - `harmonize.apply_weights(con, glob: str, ratios: pyarrow.Table, dates: dict, out_dir: Path) -> None`. It writes `work/weighted/year=Y.parquet` with `in_baseline_chain, harm_weight, harm_weight_lo, harm_weight_hi`.
- `r = Σ target / Σ source` over cells of that stratum × month × fit years. `r_lo`/`r_hi` = 10th/90th percentile of the per-year ratios. The fallback threshold is 200 source + target detections. Categories 6–7 get weight 0. Aqua weight = `r_aqua_snpp × r_snpp_noaa20` (lo × lo, hi × hi); S-NPP = `r_snpp_noaa20`; NOAA-20 = 1 (lo = hi = 1). Off-chain satellites and low-confidence points get 0.

- [ ] **Step 1: Write failing tests:**
  - `test_ratio_of_totals`: 2 years, stratum 0, Jan; source 10 and 20, target 30 and 50 → `r == 80/30`; `r_lo`, `r_hi` equal the percentiles of `[3.0, 2.5]`.
  - `test_fallback`: a stratum-month with 50 detections → `fallback == "stratum"` and `r` equals that stratum's all-months ratio.
  - `test_chain_weight`: an Aqua point in 2005 with stratum 1, May → `harm_weight == r_a[1,5] * r_s[1,5]`.
  - `test_offchain_zero`: Terra, NOAA21, and S-NPP in 2019 → weight 0, `in_baseline_chain` false.
  - `test_lowconf_zero`: a NOAA20 point with `conf_class='l'` → weight 0.
  - `test_volcanic_zero`: category 6 → weight 0.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. For `fd`, count distinct `acq_date` per `cell_id` × month per satellite, then apply the same ratio-of-totals code.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Run on real data. Write `data/ratios.parquet` (both links, both metrics). Print the India-wide `r` per stratum for a sanity read. Expected order of magnitude: Aqua→S-NPP well above 1, S-NPP→NOAA-20 near 1. If not, investigate; don't patch.
- [ ] **Step 6:** Commit `feat(pipeline): harmonization ratios and weights`.

### Task 5: Dekad table, invariants, publish

**Files:**
- Create: `pipeline/aggregate.py`, `pipeline/publish.py`, `pipeline/build.py`, `pipeline/tests/test_aggregate.py`, `data/dekad/year=*.parquet`, `data/meta.json`

**Interfaces:**
- Consumes: weighted points (Task 4), `ratios.parquet`.
- Produces:
  - `aggregate.build_dekad(con, glob: str, ratios: pyarrow.Table, out_dir: Path, years: list[int]) -> None`. Columns are as in PLAN §6.2; `dekad = 1 if day<=10, 2 if day<=20, else 3`. `harm_fd` = `fd_base` × the fd ratio for that chain, stratum and month. The baseline-gap fill sets `harm_from=3`. The output is sorted by `cell_id, year, month, dekad, category`, with `ROW_GROUP_SIZE 50000`.
  - `aggregate.check_invariants(con, points_glob: str, dekad_glob: str) -> None`. It raises `InvariantError` with the failing check name.
  - `publish.upload_points(paths: list[Path], repo_id: str, token: str) -> None`, `publish.squash_history(repo_id, token) -> None`, `publish.write_meta(path: Path, sources: dict, status: str) -> None`
  - `build.py` CLI: `py -m pipeline.build --region india --steps ingest,classify,harmonize,aggregate,publish`
- Final points files = weighted points + `cell_id`-sorted, written to `work/points/year=Y.parquet`, then uploaded to `points/year=Y.parquet`.

- [ ] **Step 1: Write failing tests:**
  - `test_dekad_split`: dates 10th, 11th, 20th, 21st and 31st → dekads 1, 2, 2, 3, 3.
  - `test_conservation`: Σ `n_aqua+n_terra+n_snpp+n_noaa20+n_noaa21+n_lowconf` == number of points.
  - `test_harm_equals_weights`: `harm_n` per cell-dekad == Σ `harm_weight`.
  - `test_fire_days`: 3 points on 2 days in one cell-dekad → `fd_base == 2`.
  - `test_gap_fill`: a dekad with zero NOAA20 points region-wide and S-NPP points present → `harm_from == 3` and `harm_n == Σ snpp × s`.
  - `test_invariant_raises`: deleting one dekad row makes `check_invariants` raise `InvariantError("conservation")`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Full build on real data. Check each dekad file is < 100 MB (expected about 3–5 MB) and that the invariants pass. Upload points to HF. Write `meta.json` with per-source `last_success_utc`, `coverage_end`, `landcover_source` and the git SHA.
- [ ] **Step 6:** Commit `feat(pipeline): dekad table and publish` (with `data/dekad/*` and `meta.json`). **M1-data.**

### Task 6: Web MVP (map, area, calendar, this-month card, KPIs, CSV)

**Files:**
- Create: `web/index.html`, `web/styles.css`, `web/app.js`, `web/db.js`, `web/cells.js`, `web/queries.js`, `web/calendar.js`, `web/map.js`, `web/stats.js` (median + percentileRank only for now), `web/tests/cells.test.js`
- Delete: `web/gate.html`

**Interfaces:**
- Consumes: `config.json`, `data/cells.parquet`, `data/dekad/*`, HF points.
- Produces:
  - `db.initDB(config) -> Promise<{query(sql: string): Promise<object[]>, copyToCSV(sql: string, filename: string): Promise<Blob>}>`
  - `cells.cellId(lat, lon) -> number`; `cells.cellCenter(id) -> [lat, lon]`
  - `cells.cellsFromGeometry(geojson, coverageSet: Set<number>) -> {ids: number[], outsideShare: number, snappedToContaining: boolean}`
  - `cells.cellsFromPointRadius(lat, lon, km, coverageSet) -> same`
  - `cells.cellsToRanges(ids) -> Array<[number, number]>` (contiguous runs)
  - `cells.rangesSQL(ranges, column='cell_id') -> string`
  - `cells.outlineGeoJSON(ids) -> FeatureCollection`
  - `queries.calendar(area, range, cats, metric) -> Promise<Array<{year, month, value, lo, hi, harm_from, provisional}>>`
  - `queries.climatology(area, cats, metric) -> Promise<Array<{month, values: number[]}>>`
  - `queries.dekadSeries(area, cats, metric) -> Promise<Array<{year, month, dekad, value}>>`
  - `queries.points(area, range, cats, {limit}) -> Promise<object[]>`; `queries.pointsCSV(area, range, cats) -> Promise<Blob>`
  - `calendar.renderCalendar(el, rows, {mode: 'counts'|'anomaly', metric, typicalByMonth, currentYM})`
  - `map.initMap(el, onGeometry: (geojson) => void)`, `map.showCells(fc)`, `map.showPoints(rows)`
  - `area` = `{ids, ranges, geometry, outsideShare, snappedToContaining}`; `range` = `{from: 'YYYY-MM', to: 'YYYY-MM'}`; `cats` = `number[]`; `metric` = `'harm_n'|'harm_fd'`.
- The calendar `value` = Σ metric over the area, cats and month. `provisional` = any row with `processing=1`.

- [ ] **Step 1: Write failing tests** (`node --test web/tests`):
  - `cellId` matches Python for the same 5 points (copy the values from `test_grid.py`).
  - `cellsToRanges([5, 6, 7, 10])` deep-equals `[[5, 7], [10, 10]]`.
  - **Review Focus 1:** a 0.02° triangle inside one cell → `ids.length == 1`, `snappedToContaining == true`.
  - **Review Focus 2:** a box half outside `coverageSet` → `outsideShare` within 0.45–0.55 and `ids` only covered cells; a box fully outside → `ids == []`, `outsideShare == 1`.
  - `cellsFromPointRadius(30, 76, 25, set)` includes `cellId(30, 76)` and no cell whose centre is more than 25 km away (haversine).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `cells.js` (turf `booleanPointInPolygon` on cell centres over the geometry's bbox).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Implement the rest of the files to the interfaces above and the layout in PLAN §8.2:
  - Calendar with counts mode and the typical row (median by month over base years).
  - "This month vs typical" card. For the MVP: full-month median and percentile of the last *complete* month; month-to-date comes in Task 7.
  - KPI row: total harmonized hotspots, fire-days, busiest month, busiest year.
  - Points CSV export.
  - Empty states, error states, and the coverage/snapping messages from Review Focus 1–2.
  - Public Sans from Google Fonts; tokens from PLAN §8.1.
- [ ] **Step 6:** Push, deploy, and open the Pages URL in the built-in browser. Draw the Punjab bbox from PLAN §9 F5 with the lat/lon form. Expected:
  - The calendar renders 2002–2026 with the Oct–Nov band visible.
  - The CSV row count equals the calendar's raw count for the same filter (check in the console).
  - Query time ≤ 2 s warm.
- [ ] **Step 7:** Commit `feat(web): MVP calendar, map, CSV`. **M1 MVP live.**

### Task 7: Statistics, anomaly view, rankings

**Files:**
- Modify: `web/stats.js`, `web/calendar.js`, `web/app.js`
- Create: `web/tests/stats.test.js`

**Interfaces:**
- Produces:
  - `stats.median(xs) -> number|null`
  - `stats.percentileRank(x, base) -> number|null`, defined as `(count(base < x) + 0.5·count(base == x)) / n × 100`
  - `stats.zScore(x, base) -> number|null` (null if n < 5 or sd == 0)
  - `stats.anomalyPct(x, base) -> number|null` (null if median == 0)
  - `stats.monthToDate(dekadRows, today: Date, baseYears) -> {mode: 'mtd'|'last_month', year, month, dekads: number[], current: number, base: number[]}`
  - `stats.rankings(calendarRows, n = 5) -> {months: [...], years: [...]}`
  - `stats.anomalyBin(pct) -> 0..6` (bins in Global Constraints)

- [ ] **Step 1: Write failing tests:**
  - `percentileRank(5, [1, 5, 9]) == 50`; `percentileRank(10, [1, 5, 9]) == 100`.
  - **Review Focus 4:** `median([0, 0, 0]) == 0`; `zScore(3, [0, 0, 0, 0, 0]) == null`; `anomalyPct(3, [0, 0, 0]) == null`; `median([]) == null`.
  - `zScore(4, [1, 2, 3, 4, 5]) ≈ 0.632` (sample sd).
  - **Review Focus 3:** `monthToDate(rows, new Date('2026-11-05'))` → `mode == 'last_month'`, `month == 10`. `monthToDate(rows, new Date('2026-11-14'))` → `mode == 'mtd'`, `dekads == [1]`, and the `base` values each sum only dekad 1 of November in each base year.
  - `anomalyBin` at 9.9 → 0, 50 → 3, 90 → 6.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Then wire up:
  - The Counts/Anomaly toggle (diverging bins).
  - Calendar tooltips (value, band, percentile, z, source, provisional).
  - Month-to-date in the card, with text naming the days compared.
  - The top-5 months and years list.
- [ ] **Step 4:** Run the tests. Expected: PASS. Check visually on Punjab and Uttarakhand.
- [ ] **Step 5:** Commit `feat(web): anomalies, month-to-date, rankings`.

### Task 8: Trend with bands, anomaly bars, downloads

**Files:**
- Create: `web/charts.js`
- Modify: `web/queries.js`, `web/app.js`

**Interfaces:**
- Produces:
  - `queries.annual(area, cats, metric) -> Promise<Array<{year, value, lo, hi, n_aqua, n_snpp, n_noaa20}>>`
  - `queries.aggregatesCSV(area, range, cats, metric) -> Promise<Blob>` (columns: year, month, value, lo, hi, percentile, z, source, provisional)
  - `charts.annualChart(el, rows)` (Plot `areaY` band only where lo ≠ hi, plus `lineY`)
  - `charts.anomalyBars(el, rows, base)` (diverging fill by `anomalyBin`)
  - `charts.exportSVG(el, filename)`, `charts.exportPNG(el, filename, scale = 2)`
  - Each chart has a sibling "Show table" toggle rendering the same rows as a `<table>`.

- [ ] **Step 1:** Implement. In the browser, check that the Punjab annual totals equal the calendar row sums (console assert during dev). Check that the band appears only for years before NOAA-20's start.
- [ ] **Step 2:** Downloads menu: points CSV, monthly table CSV, annual CSV, chart SVG and PNG. Open each downloaded file and check its headers and row counts.
- [ ] **Step 3:** Commit `feat(web): trend, anomaly bars, downloads`.

### Task 9: Validation and Methodology page

**Files:**
- Create: `pipeline/validate.py`, `pipeline/tests/test_validate.py`, `data/validation/{annual_series,step,loyo,breakdown}.parquet`, `data/validation/summary.json`, `web/methodology.html`, `web/methodology.js`

**Interfaces:**
- Consumes: weighted points, ratios, dekad.
- Produces:
  - `validate.step_stats(con, dekad_glob, ranges=None) -> dict` → `{naive_step, harm_step, yoy_p10, yoy_p90}`. A step is `mean(2012–14) / mean(2009–11)`. The year-over-year ratio spread is taken over 2003–2025, excluding the 2011→2012 transition.
  - `validate.loyo(con, glob, link, years) -> pyarrow.Table` (columns: held_year, unit_type ∈ {stratum_month, box1deg, region_month}, unit, observed, predicted, lo, hi)
  - `validate.summarise_loyo(table) -> dict` → `{mdape, bias, coverage}` per unit_type
  - `validate.breakdown(table) -> pyarrow.Table` (by stratum and month)
  - `validate.write_validation(out_dir) -> None`. It also runs the direct Aqua→NOAA-20 link (2018–2021) and records which link has the lower MdAPE.

- [ ] **Step 1: Write failing tests:**
  - `test_step_flat`: a constant series → `harm_step == 1`.
  - `test_coverage`: observed [1, 5, 9] with lo/hi [0–2, 6–7, 8–10] → coverage == 2/3.
  - `test_loyo_excludes_year`: the ratio used for held_year Y is fitted without Y (inspect a returned debug field `fit_years`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and run on real data.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** `methodology.html` renders:
  - the before/after chart (raw Aqua, S-NPP, NOAA-20, naive sum, harmonized ± band; legend + direct labels)
  - step statistics as sentences with the computed numbers
  - the LOYO table
  - the breakdown dot plot
  - the ratio table with fallbacks
  - mask counts
  - data sources and versions
  - When coverage is outside 70–90 % or the step is outside the spread, those numbers show in an amber note with plain text. They are never hidden.
- [ ] **Step 6:** Commit `feat: validation and methodology page`.

### Task 10: Daily refresh and freshness badge

**Files:**
- Create: `pipeline/daily.py`, `.github/workflows/daily.yml`, `web/freshness.js`, `web/tests/freshness.test.js`
- Modify: `.github/workflows/pages.yml` (reusable deploy step), `web/app.js`

**Interfaces:**
- Consumes: `ingest.fetch_area_api`, `ingest.build_points_stage`, `classify.classify_points`, `harmonize.apply_weights` (with existing ratios), `aggregate.build_dekad` + `check_invariants`, `publish.*`.
- Produces:
  - `daily.run(region: str, today: date, publish: bool) -> int` (0 ok, 1 failed; on failure writes `meta.json` with `status="failed"` and the previous `last_success_utc` kept)
  - `freshness.freshness(meta, now: Date) -> {level: 'good'|'warning'|'critical', text: string}`
- `daily.yml`:
  - cron `30 3 * * *` + `workflow_dispatch`
  - steps: `pip install duckdb pyarrow requests huggingface_hub`; `py -m pipeline.daily`; upload the current-year points to HF; build the Pages artifact (repo `web/` + `data/` + the generated `data/dekad/year=<current>.parquet` + `meta.json`); deploy
  - squash HF history on Sundays
  - the generated current-year file is **not committed**

- [ ] **Step 1: Write failing tests:**
  - **Review Focus 5:** `freshness({sources: {NOAA20: {last_success_utc: now-10h}}, status: 'ok'}, now).level == 'good'`; 40 h → `warning`; 80 h → `critical`; `status: 'failed'` → `critical`; `meta == null` → `critical` with text "Data status unavailable".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `freshness.js` and the header badge (icon + text + tooltip listing sources).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Implement `daily.py` and `daily.yml`. Run `workflow_dispatch` once. Expected: the badge shows today's time. Then run once with a deliberately wrong `FIRMS_MAP_KEY` in a test run. Expected: the job fails, the site still shows yesterday's data, and the badge goes critical on the next successful deploy of `meta.json`. Then restore the key.
- [ ] **Step 6:** Commit `feat: daily refresh and freshness badge`.

### Task 11: Category toggles, per-category calendars, mask layer

**Files:**
- Modify: `web/app.js`, `web/calendar.js`, `web/map.js`, `web/queries.js`

**Interfaces:**
- Produces:
  - `queries.categoryCalendars(area, range) -> Promise<Map<number, rows>>`
  - `map.showMask(fc)` (from `static_mask.parquet` cells inside the area bbox)
  - Category group of a point: landscape (0–3) → slot 1; industrial (5) → slot 2; urban/volcanic/offshore (4, 6, 7) → slot 3.

- [ ] **Step 1:** Toggles (native checkboxes, landscape on by default) feed `cats` into every query. Add the Categories tab with small multiples, each calendar on its own scale, with the category name as its title.
- [ ] **Step 2:** In the browser, on Jharia: industrial off → a small landscape signal; on → a year-round band. Check that the sum over all categories equals the CSV row count with all categories on (console assert).
- [ ] **Step 3:** Commit `feat(web): categories`.

### Task 12: Season detection

**Files:**
- Modify: `web/stats.js`, `web/charts.js`, `web/app.js`, `web/tests/stats.test.js`

**Interfaces:**
- Produces:
  - `stats.season(dekadRows, baseYears) -> {status: 'ok'|'insufficient', start: dekadIndex, onset, peak, end, twoSeasons: boolean, peaks: number[], years: Array<{year, onset, end, length, flags: string[]}>}`. Dekad index runs 0–35. Flags ⊆ {`early`, `late`, `longer`, `shorter`}.
  - `stats.dekadToDateLabel(i) -> string` (e.g. "11–20 Oct")
  - `charts.seasonStrip(el, season)`

- [ ] **Step 1: Write failing tests:**
  - Single season: all mass in dekads 9–14 → `onset == 9`, `end == 14`.
  - Year-crossing: mass in dekads 33–35 and 0–2 → `start` is in the minimum region, and `onset` is 33 with `end` 2 (circular).
  - Bimodal: equal mass at dekads 11–13 and 28–31 → `twoSeasons == true`, with two peaks.
  - Insufficient: annual mean < 30 → `status == 'insufficient'`.
  - Flags: a year whose onset is 3 dekads before the base-period quartile 1 → includes `early`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (algorithm in PLAN §9 F3). Build the Season tab and the sentence summary, labelled "±10 days".
- [ ] **Step 4:** Run. Expected: PASS. Check Punjab (two seasons) and Uttarakhand (spring) in the browser.
- [ ] **Step 5:** Commit `feat: season detection`.

### Task 13: Accessibility, dark mode, mobile, palette check

**Files:**
- Modify: `web/styles.css`, `web/calendar.js`, `web/app.js`, `web/index.html`, `web/methodology.html`

- [ ] **Step 1:** Run the dataviz validator on the map set:
  `node <dataviz>/scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a" --pairs all --mode light`, then the dark set with `--mode dark --surface "#1a1a19"`. Expected: exit 0. Record any WARN and its relief (point ring + legend).
- [ ] **Step 2:** Calendar keyboard behaviour:
  - Roving tabindex; arrows move, Home/End go to row ends, Enter filters the map to that month.
  - `aria-label` per cell as in PLAN §8.5.
  - `aria-live` announcement after each query.
- [ ] **Step 3:** Dark tokens under `prefers-color-scheme: dark` and `[data-theme=dark]`, plus a theme toggle. Separate dark ramp steps. Respect `prefers-reduced-motion`. Mobile single-column layout at < 768 px with a 16 px gutter.
- [ ] **Step 4:** Person 2 runs the keyboard-only, NVDA, 200 % zoom and phone checks. Fix the findings.
- [ ] **Step 5:** Commit `feat(web): accessibility, dark mode, mobile`. **M2 Core done.**

---

**CUT LINE.** Tasks 14–18 only after M2. Stop new features at H22 regardless.

### Task 14 (stretch): Comparison mode

**Interfaces:**
- `queries.compare(a: {area, range}, b: {area, range}, cats, metric) -> {a: rows, b: rows, scaleMax}`.
- Two calendars with one shared colour scale and synced hover.
- A difference table.

- [ ] **Step 1:** Implement the Compare tab. Second area via the same form or draw tools, or the same area with two different year spans.
- [ ] **Step 2:** Check: both calendars use the identical legend; swapping A and B swaps the sign of the differences.
- [ ] **Step 3:** Commit `feat(web): comparison mode`.

### Task 15 (stretch): Timelapse

**Interfaces:**
- `queries.timelapseFrames(area, range, step) -> Promise<Array<{t, points}>>` (weekly is forced above 50k points)
- `map.playFrames(frames, {speed})`
- Controls: play, pause, scrub and speed as native buttons and a range input. No autoplay.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Check that the sum of frame point counts equals `points()` for the same window.
- [ ] **Step 3:** Commit `feat(web): timelapse`.

### Task 16 (stretch/future): Climate context

- [ ] **Step 1:** `pipeline/climate.py`: `build_climate(fwi_nc: Path, precip_nc: Path, cells: Path, out_dir: Path)` → `data/climate/year=Y.parquet` with columns `(cell_id, year, month, fwi_mean, precip_mm, precip_anom_pct)`. FWI is mapped by nearest 0.25° grid point; anomaly is vs 2003–2025.
- [ ] **Step 2:** Add `data.climate` to `config.json`. Add `queries.climate(area, range)` and two stacked panels sharing the time axis, with source and resolution labels. Missing months are gaps.
- [ ] **Step 3:** Commit.

### Task 17 (future): Exposure

- [ ] `pipeline/exposure.py` builds `pop001.parquet` (cell001_id, pop) from GHS-POP 2020 and uploads it to HF. Then `queries.exposure` counts the distinct 0.01° cells with a hotspot or adjacent to one (3 × 3), joined to population. KPI card states the population year.

### Task 18 (future, low priority): Telegram alerts

- [ ] Implement ADR-010. Test by subscribing a team member's own Telegram account to an area with a low threshold, and confirm a real message arrives. Anti-spam rule: 7 days / +5 percentile points.

---

## H22–24 freeze checklist

- [ ] Cross-check: create `pipeline/crosscheck.py` (`crosscheck(bboxes) -> list[dict]`, printing harmonized and raw totals per bbox from the published files using the same cell snapping). For the 3 walkthrough areas and 5 random 1° boxes, the browser calendar totals and CSV row counts must equal its output.
- [ ] README: what the app is, how to rebuild (`py -m pipeline.build --region india`), data sources and licences, and a known-limitations list (India only, land cover single year, base period 2003–2025, ±10-day season resolution).
- [ ] Final deploy, then a fresh-browser smoke test of the walkthrough areas.
- [ ] Demo rehearsal ×2 with Person 2 driving; record a backup screen video.
