# Decisions made during the unattended build

Each entry: what was decided, and why. Newest at the bottom.

## D1. No `.env` file exists: continue without the credentials

- Found at start: the project has no `.env`. `FIRMS_MAP_KEY`, `HF_TOKEN`, `HF_DATASET_REPO`, `EARTHDATA_*` and `APPEEARS_TASK_ID` are unavailable. `gh` is logged in as `ashimajain777`.
- Decision: build everything that doesn't need them and re-check for `.env` at every phase gate.
- Consequences are D2–D5.

## D2. GitHub repo: `ashimajain777/fire-calendar`

- `GITHUB_REPO` isn't available. The account has one empty public repo, created 13 Nov 2026, named `fire-calendar`. That's taken to be the pre-made repo.

## D3. Points host: GitHub Release assets, served through Pages

- No HF token, so nothing can be uploaded to Hugging Face.
- The plan's fallback is GitHub Releases. Release assets are stored on the `data` release, and the shared deploy step copies them into the Pages artifact, so the browser reads them from the same origin as the app (`config.json` → `data.points = "./data/points/"`).
- This also removes the cross-origin risk. Moving to HF or R2 later is still a one-line config change.
- The same release holds the current-year dekad file and `meta.json` (build-prompt amendment 1).

## D4. 2026 data is blocked until a FIRMS MAP_KEY exists

- The FIRMS Area API needs a key. Without it, the data ends at 31 Dec 2025 (the last per-country yearly CSV).
- The Area API fetcher, the daily job and the workflow are still built and unit-tested, but can't be run for real. The app reads the last data date from `meta.json`, so "this month vs typical" compares the last month that has data, and says which.
- To finish: add `FIRMS_MAP_KEY` to `.env`, run `python -m pipeline.build --region india --steps ingest_api,classify,harmonize,aggregate,validate,publish`, and `gh secret set FIRMS_MAP_KEY`.

## D5. Land cover without an Earthdata login

- AppEEARS and `earthaccess` both need the Earthdata login. Decision: read the same product (MODIS MCD12Q1 v061, LC_Type1 / IGBP) from Microsoft Planetary Computer's open copy, which needs no account. If that's unreachable, use Copernicus Global Land Cover 100 m (2019) mapped to IGBP-like classes, and record it in `meta.json` → `landcover_source`.

## D6. Python 3.12, not 3.14

- Both are installed. 3.12 has wheels for every dependency (duckdb 1.5.2, pyarrow 26.0.1, rasterio 2.0.0 installed cleanly), so there's no reason to risk 3.14.

## D7. File names use `points_{YYYY}.parquet` and `dekad_{YYYY}.parquet`

- The plan used `year=YYYY.parquet`. Release asset names with `=` are not reliably preserved, and one naming scheme everywhere is simpler.

## D8. Chain switch dates use each satellite's first full month

- The plan switched from Aqua to S-NPP on S-NPP's first day (20 Jan 2012). The build prompt defines the Terra→Aqua switch as "Aqua's first full month". For one consistent rule, every switch happens on the first day of the new satellite's first full month of data, computed from the data.

## D9. Land cover is ESA CCI / C3S 2020 (300 m), not MCD12Q1

- Update to D5: Planetary Computer has no MCD12Q1 collection. It does have the ESA CCI / C3S global land cover (300 m, year 2020), open without login.
- `scripts/fetch_landcover.py` reads the India window and recodes each LCCS class to the nearest IGBP class number (table in the script), so the classifier's IGBP rules apply unchanged. No LCCS class in the India window was left unmapped (script output: `unmapped classes: []`).
- `meta.json` records `landcover_source = "ESA CCI / C3S Land Cover 2020 v2.1.1 (300 m), recoded to IGBP classes"`.
- To switch to MCD12Q1 later: put the GeoTIFF in `work/aux/` and rerun the `landcover` step.

## D10. Agent worktrees are plain git worktrees under `.worktrees/`

- The harness's own worktree isolation refused to start ("not in a git repository") because the repo was created after the session began. Manual `git worktree add` is used instead; each agent is told its path.

## D11. Fit years exclude each target satellite's partial first year

- Real data: S-NPP starts 20 Jan 2012 and NOAA-20 starts 1 Apr 2018. Including those years would put source detections with no possible target detections into the ratio of totals and bias the January-March ratios low.
- Fit years are now Aqua->S-NPP 2013-2021 and S-NPP->NOAA-20 2019-2025 (Terra->Aqua stays 2003-2011). This was decided from the satellites' start dates before any ratio was looked at.

## D12. `.env` found in `docs/` (after Phase 2): what changed and what did not

- The credentials file was in `docs/.env`, not the project root. It is git-ignored and was never committed (checked `git log --all --name-only`). It is now copied to the root `.env` (also ignored).
- **2026 data:** the FIRMS key works. January 2026 onward is fetched from the Area API (standard processing where available, near-real-time after), and the whole pipeline is rebuilt. This supersedes D4.
- **Land cover:** the AppEEARS task was done, so land cover is now MODIS MCD12Q1 v061 LC_Type1 (2024), as the plan intended. This supersedes D5 and D9. The ESA CCI files are kept in `work/aux/cci_*.tif` as a fallback.
- **Points host stays GitHub Release -> Pages (D3).** It is already deployed and tested with real range reads, it is same-origin, and switching to Hugging Face now would add cross-origin risk for no gain. Moving later is one config line.
- `FIRMS_MAP_KEY` is set as a GitHub Actions secret with `gh secret set`.
- Because classification and ratios depend on land cover, every Gate 2 number is recomputed; the earlier Gate 2 entry in BUILD_LOG is kept as history and marked superseded.

## D13. Multi-day satellite outages are flagged as gaps

- The code review found partial outages passing as real lows (Terra had no data 20-28 March 2002, in peak season).
- Real data: runs of days with no chain-satellite detection anywhere in India are 2-4 days long in the monsoon (cloud), and 7, 9 and 19 days long in three known outages. Rule: a run of 5 or more such days is an outage, and every dekad it touches goes into `gaps.parquet`.
- A gap dekad is filled from another convertible satellite if one has data; otherwise it is "no data".
- The calendar shows a month as "no data" when any of its dekads is an unfilled gap (it was "all three"), so an incomplete total is never shown as a low value.

## D14. Direct Aqua -> NOAA-20 benchmark uses 2019-2021

- Same reason as D11: NOAA-20 starts 1 April 2018, so 2018 is partial. The earlier figure (12.1 % error) was inflated by this.

## D15. Hotspots CSV includes low-confidence detections

- The CSV row count equals the calendar's raw count plus the low-confidence count for the same filter (checked on November 2024, Punjab box: 19,807 + 901 = 20,708). Low-confidence points are kept in the files (classify, don't delete) and marked `conf_class = 'l'` with weight 0.

## D16. API fetch box is wider than India; clipping removes the rest

- The Area API is queried by bounding box (68-98 E, 6-38 N), which includes neighbouring countries. The 2026 rebuild dropped 1,128,680 rows outside the India polygon and 320,430 duplicate rows (overlapping API chunks and SP/NRT overlap). Both counts are logged per year in `work/build_full.log`.

## D17. NOAA-21 is stored for 2026 only

- FIRMS has no per-country file for NOAA-21, so 2023-2025 NOAA-21 detections are not in the archive. 2026 NOAA-21 detections are fetched, stored and exported with weight 0. They don't affect the harmonized series.

## D18. Data URLs are versioned per publish, and file reads are retried (corrected)

- Seen on the live site twice: a points file read failed with "NetworkError" in the first minutes after a deploy, then worked a few minutes later with no change (cross-check: error right after deploy, 8/8 MATCH and 0 errors on the rerun).
- First explanation (CDN cache keyed by URL, fixed by `?v=<meta.generated_utc>`) was **wrong**: probing with random `?probe=` parameters returns `X-Cache: HIT`, so GitHub Pages' CDN ignores query strings. The parameter is kept because it does stop the *browser's* own 10-minute cache from mixing versions.
- Actual mitigation: `db.js` retries a query whose error is network-level (not SQL errors, not missing files) after 3 s and 10 s (`withRetry`, unit-tested). The root cause on the CDN side is not proven; the failures only occurred within minutes of a deploy.

## D19. Playwright uses the installed Microsoft Edge

- Headless checks run with `chromium.launch({channel: 'msedge'})` from `tools-browser/` (its `node_modules` is git-ignored). The built-in browser pane was hidden, which stalled in-page queries, so it is not used for timed checks.

## D20. Stretch features are cut

- Comparison mode, timelapse, climate context, exposure and alerts are not built. The build was paused five times by usage limits, so the remaining time goes to Core polish (Task 13) and the mandatory verification and report. The architecture notes for each are in PLAN §14.

## D21. Fire-days are a union across categories (per-row day bitmask)

- The dekad table gets `day_mask SMALLINT`: bit i = a detection on day i of the 10-day period (11 bits cover a 31-day month's last period). The browser ORs the masks of the selected categories within each cell and period, and counts the bits, so a cell-day counts once for any combination of toggles. Exact, and only 2 bytes per row (dekad files grew from 30.7 to 33.4 MB in total).
- Harmonized fire-days for a selection = union count × (sum of the categories' harmonized fire-days / sum of their raw fire-days) in that cell and period. From NOAA-20 on the ratio is 1, so this is exact; before that it is the categories' own conversion, weighted by their fire-days.
- Chosen over storing precomputed unions (landscape, all, singles), which would be exact only for those combinations.
- Measured on 2021 landscape categories: per-category sum 233,561 vs union 210,880 (the old view overcounted by 10.8 %).

## D22. Dekad archive is split into 5-degree tiles; map points load on demand

- Measured on the live site: DuckDB-WASM 1.32 reads each file with one plain GET (no `Range` header) and keeps it in memory. With full reads disabled it refuses to open the file, even for files GitHub Pages serves uncompressed (`.zip`/`.gz` probes). Pages also gzips `.parquet` (`Content-Encoding: gzip` on 206 responses), so its ranges refer to compressed bytes. **The Gate 0 "range reads" result was only true for curl, not for DuckDB.** So every query downloaded all 27 yearly files (about 30 MB) for any area.
- Fix: archive years (2000 to the year before the current one) are published as one file per 5-degree tile (27 tiles, 31 MB in total); the browser picks the tiles an area overlaps from `meta.json` (`dekad_tiles`, `archive_end`). Later years stay one file per year (the daily job is unchanged).
- The map no longer loads the latest month's points after every query. That pulled the whole current-year points file (34 MB) and delayed the next query; points now load when a month is selected.
- Tried and dropped: a background warm-up of file metadata (no measurable gain: first query 14.9 s before and after).

## D23. Secondary season peak (added after seeing Punjab's result)

- Round 1 reported that Punjab + Haryana's April-May peak holds 17.8 % of the typical year, below the 25 % "two seasons" rule. That 17.8 % summed all of April and May. Spring wheat-residue burning there is agronomically well known, so hiding it would mislead.
- The 25 % rule is unchanged. A separate line reports any other bump holding 10 % to 25 % of the typical annual total as "Secondary peak: <dates>, <share> % of the year".
- **How a bump is measured (decided after seeing the data, stated here for that reason):** the first implementation reused the season clusters (dekads at 20 % or more of the main peak). On the real Punjab profile that cut the spring bump to one dekad holding 9.1 %, because its shoulder dekad sits at 18 % of the November peak. A small peak should not be measured against a much larger one, so a secondary bump now runs from its local maximum down to the troughs on either side (a trough shared with the main season stays with the main season), and its displayed dates are its dekads at 20 % or more of its own peak. Result on Punjab: 21-30 Apr to 11-20 May, 18.5 % of the year.
- Thresholds (10 %, 20 % of own peak) were set with Punjab in view; they are not tuned per area, and other areas get the same rule.
