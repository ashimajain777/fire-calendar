# Frozen contracts

Every module is built against this file. Where it disagrees with `PLAN.md` or `IMPLEMENTATION.md`, **this file wins** (it includes the build-prompt amendments). Only the orchestrator edits it.

## 1. Rules for all code

- No hardcoded, mocked or simulated outputs in app code. No area-specific branches.
- Unit tests may use small hand-built inputs. No test contains a typed-in expected value for real data.
- No data URL or path prefix anywhere except `config.json`.
- Python: 3.12, run as `.venv/Scripts/python`. Tests: `.venv/Scripts/python -m pytest pipeline/tests -q`.
- JS: plain ES modules, no bundler, no npm dependencies in `web/` modules that are unit-tested (`cells.js`, `stats.js`, `freshness.js` must import nothing from a CDN). Tests: `node --test "web/tests/*.test.js"`.
- All pipeline functions that take `con` take a `duckdb.DuckDBPyConnection`.

## 2. Constants (`pipeline/settings.py`, already written)

```
CATEGORY = {"agricultural":0,"forest":1,"grass_shrub":2,"other_veg":3,"urban":4,"industrial":5,"volcanic":6,"offshore":7}
LANDSCAPE = {0,1,2,3}          # default visible; harmonized
HARMONIZED = {0,1,2,3,4,5}     # strata; 6 and 7 get weight 0
BASE_YEARS = range(2003, 2026) # climatology, percentiles, z-scores
CONF_MODIS_MIN = 30            # MODIS conf_class: <30 l, 30..79 n, >=80 h
MIN_DETECTIONS = 200           # fallback threshold (source + target detections)
FIT_YEARS = {"terra_aqua": range(2003, 2012), "aqua_snpp": range(2013, 2022), "snpp_noaa20": range(2019, 2026)}
SATELLITES = ["Terra","Aqua","SNPP","NOAA20","NOAA21"]
MASK_MIN_DAYS = 30; MASK_MIN_YEARS = 3; MASK_WINDOW_YEARS = 5; MASK_MIN_MONTHS = 6; MASK_MIN_TYPED = 3
```

IGBP → category (for `firms_type` 0 or NULL): 12, 14 → 0 · 1–5 → 1 · 6–10 → 2 · 13 → 4 · 17 or no land cover → 7 · anything else (11, 15, 16) → 3.

## 3. Grid

```
cell_id    = floor((lat+90)*10)  * 3600  + floor((lon+180)*10)     # 0.1°, INTEGER
cell001_id = floor((lat+90)*100) * 36000 + floor((lon+180)*100)    # 0.01°, BIGINT
region_id  = floor((lat+90)/5)   * 72    + floor((lon+180)/5)      # 5° box, INTEGER
```
`lat = 90` and `lon = 180` clamp into the last index. Cell centre = lower-left + half a cell.

## 4. Files

| File | Where | Notes |
|---|---|---|
| `config.json` | repo root, served at `/config.json` | `{"data":{"dekad":"./data/dekad/","tables":"./data/","points":"./data/points/"}}` |
| `dekad_{YYYY}.parquet` | `data/dekad/` (archive years committed; current year fetched at deploy) | |
| `points_{YYYY}.parquet` | GitHub Release `data` asset → bundled into the Pages artifact under `data/points/` at deploy | not committed |
| `cells.parquet`, `ratios.parquet`, `static_mask.parquet`, `gaps.parquet`, `meta.json` | `data/` | |
| `validation/{annual_series,loyo,breakdown}.parquet`, `validation/summary.json` | `data/validation/` | |
| `lc001.parquet` | `pipeline/static/` | not served |
| staging | `work/csv/{sensor}/{sensor}_{YYYY}_India.csv`, `work/api/{SOURCE}/{YYYY-MM-DD}.csv`, `work/stage/`, `work/classified/`, `work/points/` (each `points_{YYYY}.parquet`) | git-ignored |

Browser URLs are always `config.data.<key> + filename`.

### 4.1 Points (`points_{YYYY}.parquet`), sorted by `cell_id, acq_date`, row groups 100 000, zstd

| Column | Type | Stage | Notes |
|---|---|---|---|
| `lat`, `lon` | DOUBLE | stage | |
| `acq_date` | DATE | stage | UTC |
| `acq_time` | SMALLINT | stage | HHMM |
| `sensor` | VARCHAR | stage | `MODIS` / `VIIRS` |
| `satellite` | VARCHAR | stage | `Terra`, `Aqua`, `SNPP`, `NOAA20`, `NOAA21` (from the **source**, see §5 ingest) |
| `confidence_raw` | VARCHAR | stage | |
| `conf_class` | VARCHAR | stage | `l` / `n` / `h` |
| `frp` | REAL | stage | |
| `daynight` | VARCHAR | stage | `D` / `N` |
| `brightness` | REAL | stage | MODIS `brightness`, VIIRS `bright_ti4` (older files: `brightness`) |
| `firms_type` | TINYINT NULL | stage | NULL for NRT |
| `processing` | VARCHAR | stage | `SP` / `NRT` |
| `version` | VARCHAR | stage | |
| `cell_id` | INTEGER | stage | |
| `cell001_id` | BIGINT | stage | |
| `region_id` | INTEGER | stage | |
| `category` | TINYINT | classified | §2 codes |
| `in_baseline_chain` | BOOLEAN | weighted | on-chain satellite for its date, `conf_class != 'l'`, category in HARMONIZED |
| `harm_weight`, `harm_weight_lo`, `harm_weight_hi` | REAL | weighted | 0 when not in chain |

### 4.2 Dekad (`dekad_{YYYY}.parquet`), sorted by `cell_id, year, month, dekad, category`, row groups 50 000, zstd

`cell_id INTEGER, year SMALLINT, month TINYINT, dekad TINYINT (1: day<=10, 2: day<=20, 3: rest), category TINYINT,
n_terra, n_aqua, n_snpp, n_noaa20, n_noaa21 INTEGER (conf_class != 'l'), n_lowconf INTEGER,
harm_n, harm_n_lo, harm_n_hi REAL, fd_base SMALLINT (distinct days with >=1 in-chain detection),
harm_fd, harm_fd_lo, harm_fd_hi REAL, frp_sum, frp_max REAL (in-chain),
harm_from TINYINT (0 NOAA-20 observed, 1 S-NPP converted, 2 Aqua converted, 3 gap-filled from another satellite, 4 Terra converted),
processing TINYINT (0 SP, 1 any NRT)`

### 4.3 Small tables

- `cells.parquet`: `cell_id INTEGER, lat_c DOUBLE, lon_c DOUBLE, lc_class TINYINT, in_coverage BOOLEAN`
- `static_mask.parquet`: `cell001_id BIGINT, reason VARCHAR ('firms_static'|'volcano'|'persistent'), n_days_max INTEGER`
- `ratios.parquet`: `variant VARCHAR ('region'|'noregion'), chosen BOOLEAN, link VARCHAR ('terra_aqua'|'aqua_snpp'|'snpp_noaa20'), metric VARCHAR ('n'|'fd'), region_id INTEGER (-1 in the noregion variant), stratum TINYINT, month TINYINT, r DOUBLE, r_lo DOUBLE, r_hi DOUBLE, n_years INTEGER, n_detections BIGINT, fallback VARCHAR ('none'|'india'|'stratum'|'landscape')`
- `gaps.parquet`: `year SMALLINT, month TINYINT, dekad TINYINT, chain_satellite VARCHAR, filled_from VARCHAR NULL`. A row means the chain satellite had zero detections in the whole region that dekad. `filled_from` NULL = no other satellite available (shown as "no data", never as zero).
- `validation/annual_series.parquet`: `year SMALLINT, series VARCHAR ('terra'|'aqua'|'snpp'|'noaa20'|'naive'|'harm'|'harm_lo'|'harm_hi'), value DOUBLE` (landscape categories, whole region)
- `validation/loyo.parquet`: `variant, link, metric VARCHAR, held_year SMALLINT, unit_type VARCHAR ('stratum_month'|'box1deg'|'region_month'), unit VARCHAR, observed DOUBLE, predicted DOUBLE, lo DOUBLE, hi DOUBLE`
- `validation/breakdown.parquet`: `variant, link VARCHAR, group_type VARCHAR ('stratum'|'month'), grp INTEGER, mdape DOUBLE, bias DOUBLE, coverage DOUBLE, n INTEGER`
- `validation/summary.json`: `{"chosen_variant", "reason", "step": {"naive_step","harm_step","yoy_p10","yoy_p90"}, "loyo": {<variant>: {<link>: {<unit_type>: {"mdape","bias","coverage","n"}}}}, "direct_aqua_noaa20": {"mdape","coverage","n"}, "mask_counts": {reason: n}, "category_counts": {code: n}}`
- `meta.json`: `{"status": "ok"|"failed", "generated_utc", "git_sha", "coverage_start", "coverage_end" (last acquisition date in the data), "landcover_source", "boundary_source", "chain": {"aqua_start","snpp_start","noaa20_start"}, "variant", "sources": {<satellite>: {"last_success_utc","coverage_end"}}, "last_error": null|string}`

## 5. Python interfaces

```python
# pipeline/settings.py  (written)
load_config() -> dict
REGIONS["india"] = {"country_file_name": "India", "bbox": (68.0, 6.0, 98.0, 38.0),
                    "clip_shapefile": "work/aux/ne_10m_admin_0_countries_ind.shp", "clip_name": "India", "buffer_deg": 0.1}

# pipeline/grid.py
cell_id(lat, lon) -> int;  cell001_id(lat, lon) -> int;  region_id(lat, lon) -> int
cell_center(cell_id) -> tuple[float, float]            # (lat, lon)
CELL_ID_SQL, CELL001_SQL, REGION_ID_SQL: str           # DuckDB expressions over columns lat, lon

# pipeline/ingest.py
class FirmsError(Exception)                            # carries source, date, http status
download_country_csvs(region: str, sensors: list[str], years: range, out_dir: Path) -> list[Path]
    # sensors in {"modis","viirs-snpp","viirs-jpss1"}; skips existing; 404 is recorded, not raised
fetch_area_api(source: str, bbox: tuple, start: date, end: date, map_key: str, out_dir: Path) -> list[Path]
    # 5-day chunks; retries 5/20/60 s; raises FirmsError
clip_wkt(region: str) -> str                           # buffered clip polygon as WKT (DuckDB spatial, ST_Read)
build_points_stage(con, inputs: list[tuple[Path, str, str]], out_dir: Path, clip_wkt: str) -> dict[int, dict]
    # inputs: (csv_path, source, processing). source in {"modis","viirs-snpp","viirs-jpss1","viirs-jpss2"}.
    # satellite: modis -> CSV `satellite` column (Aqua/Terra; also accept A/T); viirs-snpp -> SNPP;
    #            viirs-jpss1 -> NOAA20; viirs-jpss2 -> NOAA21.
    # dedup on (lat, lon, acq_date, acq_time, satellite) preferring SP. Clip: ST_Within(point, clip polygon).
    # writes out_dir/points_{Y}.parquet (stage columns); returns {year: {"rows_in","rows_out","clip_dropped","dup_dropped"}}

# pipeline/classify.py
build_landcover_lookup(tifs: list[Path], bbox: tuple, clip_wkt: str, out001: Path, out_cells: Path) -> None
    # lc001.parquet: (cell001_id BIGINT, igbp TINYINT) majority per 0.01° cell; cells.parquet per §4.3
build_static_mask(con, stage_glob: str, out: Path) -> dict[str, int]      # last 5 complete years found in data
classify_points(con, stage_glob: str, lc001: Path, mask: Path, out_dir: Path) -> dict[int, int]  # {category: n}
    # first match: volcanic(type 1 or mask volcano), offshore(type 3), industrial(type 2 or mask firms_static/persistent),
    # then IGBP table in §2. Rows out == rows in.

# pipeline/harmonize.py
chain_dates(con, glob: str) -> dict        # {"aqua_start","snpp_start","noaa20_start"}: first day of each satellite's first FULL month of data
fit_ratios(con, glob: str, link: str, fit_years: range, metric: str, variant: str) -> pyarrow.Table   # ratios schema minus `chosen`
    # r = sum(target)/sum(source) over fit years for (region_id, stratum, month); points filtered conf_class != 'l', category in HARMONIZED
    # r_lo/r_hi = 10th/90th percentile of per-year ratios (years with source > 0)
    # ladder when source+target < MIN_DETECTIONS: region variant: region-stratum-month -> india stratum-month ('india')
    #   -> stratum all months ('stratum') -> all landscape ('landscape'); noregion variant starts at india stratum-month ('none')
    # metric 'fd': counts are distinct (cell_id, acq_date) per satellite
fit_all(con, glob: str, exclude_year: int | None = None) -> pyarrow.Table   # all links, both metrics, both variants
apply_weights(con, glob: str, ratios: pyarrow.Table, variant: str, dates: dict, out_dir: Path) -> None
    # chain: Terra [data start, aqua_start) -> Aqua [aqua_start, snpp_start) -> SNPP [snpp_start, noaa20_start) -> NOAA20
    # weight: Terra t*r*s, Aqua r*s, SNPP s, NOAA20 1 (lo with lo, hi with hi); else 0

# pipeline/aggregate.py
class InvariantError(Exception)
build_gaps(con, glob: str, dates: dict) -> pyarrow.Table                    # gaps schema
build_dekad(con, glob: str, ratios: pyarrow.Table, variant: str, dates: dict, gaps: pyarrow.Table, out_dir: Path) -> None
    # gap dekads with filled_from set: harm_* computed from that satellite x its ratio to NOAA-20 units, harm_from = 3
check_invariants(con, points_glob: str, dekad_glob: str) -> None            # raises InvariantError(<check name>):
    # "conservation", "harm_equals_weights", "duplicates", "date_range"

# pipeline/validate.py
step_stats(con, dekad_glob: str) -> dict                                    # naive_step, harm_step, yoy_p10, yoy_p90
loyo(con, glob: str, link: str, variant: str, metric: str = "n") -> pyarrow.Table
summarise_loyo(table) -> dict;  breakdown(table) -> pyarrow.Table
choose_variant(summary: dict) -> tuple[str, str]                            # (variant, reason): lower region_month mdape among variants with coverage in [0.6, 0.95]; tie or none -> "noregion"
write_validation(con, points_glob: str, dekad_glob: str, out_dir: Path) -> dict

# pipeline/publish.py
upload_release_assets(paths: list[Path], repo: str, tag: str = "data") -> None   # via `gh release upload --clobber`
write_meta(path: Path, **fields) -> None

# pipeline/build.py   CLI: python -m pipeline.build --region india --steps ingest,classify,harmonize,aggregate,validate,publish
# pipeline/daily.py   CLI: python -m pipeline.daily --region india [--no-publish]   -> exit 0/1
```

## 6. JavaScript interfaces (`web/`)

```js
// cells.js (pure)
cellId(lat, lon) -> number;  cellCenter(id) -> [lat, lon]
cellsFromGeometry(geojson, coverageSet) -> {ids:number[], outsideShare:number, snappedToContaining:boolean}
   // geojson: Polygon/MultiPolygon Feature or geometry; cell centres inside; if none, cells containing the vertices + centroid
cellsFromBBox(w, s, e, n, coverageSet) -> same
cellsFromPointRadius(lat, lon, km, coverageSet) -> same     // haversine to cell centre <= km; always includes the containing cell
cellsToRanges(ids) -> Array<[number, number]>;  rangesSQL(ranges, column='cell_id') -> string
outlineGeoJSON(ids) -> FeatureCollection                     // one square polygon per cell
areaKm2(ids) -> number

// stats.js (pure)
median(xs) -> number|null
percentileRank(x, base) -> number|null       // (count(base<x) + 0.5*count(base==x)) / n * 100
zScore(x, base) -> number|null               // sample sd; null if n<5 or sd==0
anomalyPct(x, base) -> number|null           // (x-median)/median*100; null if median==0
anomalyBin(pct) -> 0..6                      // <=10, 10-25, 25-40, 40-60, 60-75, 75-90, >=90 (percentile)
monthToDate(dekadRows, lastDataDate: Date, baseYears) -> {mode:'mtd'|'last_month', year, month, dekads:number[], current:number, base:number[]}
   // dekadRows: [{year, month, dekad, value}]. A dekad counts only when lastDataDate >= its last day. No complete dekad -> last complete month.
rankings(calendarRows, n=5) -> {months:[{year,month,value}], years:[{year,value}]}
season(dekadRows, baseYears) -> {status:'ok'|'insufficient', start, onset, peak, end, twoSeasons, peaks:number[], years:[{year, onset, end, length, flags:string[]}]}
dekadToDateLabel(i) -> string                // 0..35 -> "1–10 Jan"

// freshness.js (pure)
freshness(meta, now: Date) -> {level:'good'|'warning'|'critical', text:string}   // <36 h good, 36–72 h warning, >72 h or status failed or meta null critical

// db.js
initDB(config) -> Promise<{query(sql) -> Promise<object[]>, toCSV(sql) -> Promise<Blob>, url(key, file) -> string}>

// queries.js   area = {ids, ranges, geometry, outsideShare, snappedToContaining}; range = {from:'YYYY-MM', to:'YYYY-MM'}; cats = number[]; metric = 'harm_n'|'harm_fd'
calendar(db, area, range, cats, metric) -> [{year, month, value, lo, hi, harm_from, provisional, raw}]
dekadSeries(db, area, cats, metric) -> [{year, month, dekad, value}]
annual(db, area, cats, metric) -> [{year, value, lo, hi, n_terra, n_aqua, n_snpp, n_noaa20}]
categoryCalendars(db, area, range, metric) -> Map<number, rows>
gaps(db) -> [{year, month, dekad, chain_satellite, filled_from}]
points(db, area, range, cats, {limit}) -> object[];  pointsCSV(db, area, range, cats) -> Blob
aggregatesCSV(db, area, range, cats, metric) -> Blob
meta(config) -> object|null;  coverage(db) -> Set<number>

// calendar.js
renderCalendar(el, rows, {mode:'counts'|'anomaly', metric, baseYears, currentYM, gaps, onSelect})
// charts.js
annualChart(el, rows);  anomalyBars(el, rows, baseYears);  seasonStrip(el, season);  exportSVG(el, name);  exportPNG(el, name, scale=2);  tableToggle(el, rows, columns)
// map.js
initMap(el, onGeometry);  showCells(fc);  showPoints(rows);  showMask(fc);  showBoundary(geojson)
```

Colours and layout: `PLAN.md` §8. Category group on the map: 0–3 → `#2a78d6`, 5 → `#eb6834`, 4/6/7 → `#1baf7a` (dark `#3987e5`, `#d95926`, `#199e70`).
