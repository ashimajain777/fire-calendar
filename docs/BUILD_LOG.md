# Build log

Times are local (IST). Numbers are copied from command output.

## 14 Nov 2026, start

- **Blocker found:** no `.env` in the project. Continuing without FIRMS key, HF token or Earthdata login. See `docs/DECISIONS.md` D1–D5.
- Environment: Python 3.12 venv; duckdb 1.5.2, pyarrow 26.0.1, rasterio 2.0.0. Git repo initialised, remote `ashimajain777/fire-calendar`.
- FIRMS India yearly CSVs downloading (MODIS 2000–2025, S-NPP 2012–2025, NOAA-20 2017–2025). Natural Earth India point-of-view admin-0 file downloaded.

## Gate 0: PASSED (range reads)

- Deployed https://ashimajain777.github.io/fire-calendar/gate.html (first two deploys failed: `data/` folder was not in the repo; fixed with placeholders).
- `curl -H "Range: bytes=0-999"` on the Pages-served test file: `206`, 1000 bytes of 1,417,018. `Accept-Ranges: bytes`.
- DuckDB-WASM 1.32.0 in the browser, query on the Pages-served file (real MODIS 2004 India data): `n = 9883` rows with latitude 30-31, 3528 ms cold. DuckDB in Python on the same file: 9883. They match.
- Direct read from the GitHub Release URL: **blocked by CORS** ("No 'Access-Control-Allow-Origin' header"). So points are served through Pages (DECISIONS D3).
- `docs/CONTRACTS.md` committed.

## Phase 1 in progress (resumed after a usage-limit pause)

- CSV download finished: 48 files (MODIS 2000-2025, S-NPP 2012-2025, NOAA-20 2018-2025). `viirs-jpss1 2017` returned 404 (no such file).
- Land cover fetched: ESA CCI 2020, recoded to IGBP classes (DECISIONS D9).
- Agent P2 (classify) finished and is merged into `main`. Agents P1 (ingest), P3 (harmonize + aggregate), V1 (validate) and W1 (web core) were cut off by the usage limit and have been resumed in their worktrees under `.worktrees/`.
- **Resume point if this stops again:** check each worktree with `git -C .worktrees/<branch> status`, resume or finish the unfinished agents, merge the branches one at a time into `main` running both test suites after each, then write `pipeline/build.py` and start Phase 2.

## Gate 1: PASSED with one item open (code review not yet run)

- Branches merged into `main` one at a time: p2-classify, v1-validate, p1-ingest, p3-harmonize, w1-webcore. Tests after the last merge: `pytest pipeline/tests -q` -> **107 passed**; `node --test "web/tests/*.test.js"` -> **47 passed, 0 failed**.
- Contract fixes: JS test command uses the glob form (Node 25 rejects the directory form); fit years changed (DECISIONS D11).
- Open: the merged-code review is run alongside Phase 3 to save time.

## Gate 2 (first run, SUPERSEDED by the rerun below): passed on data 2000-11-01 to 2025-12-31 with ESA CCI land cover

All numbers below are from `work/build_1.log`, `build_2.log`, `build_3.log`.

- **Row accounting:** 48 input CSVs, 14,633,820 data rows (same as the sum of CSV line counts minus headers). Out: 14,633,812; clip dropped 4; duplicates dropped 4.
- **Satellites:** Terra 567,663 (from 2000-11-01); Aqua 1,278,326 (from 2002-07-04); S-NPP 8,223,386 (from 2012-01-20); NOAA-20 4,564,437 (from 2018-04-01). No 2026 data (no FIRMS key).
- **Chain dates (computed):** Aqua 2002-08-01, S-NPP 2012-02-01, NOAA-20 2018-04-01.
- **Categories:** agricultural 7,678,374; forest 3,623,052; grass/shrub 1,507,039; other vegetation 9,463; urban 60,639; industrial 1,683,841; volcanic 199; offshore 71,205.
- **Static mask:** firms_static 1,537 cells; persistent 3; volcano 3. Jharia: found (90 cells). Jamnagar: found (18 cells). **Mumbai High: not found** (the FIRMS India country file has no detections that far offshore).
- **Stratum variant chosen: no region.** Mean leave-one-year-out median error of whole-India monthly totals: no-region 8.46 %, region 9.30 %; only no-region kept band coverage within 60-95 % on every link.
- **Ratios (detection-weighted mean per category, chosen variant):** Aqua->S-NPP 5.9 to 9.4 for vegetation categories, 28 urban, 37 industrial. S-NPP->NOAA-20 0.97 to 1.06. **Terra->Aqua 3.1 to 4.6 for agricultural/forest/grass, not near 1** (0.83 industrial, 1.16 urban). Not patched: Terra passes at about 10:30 and Aqua at about 13:30, and vegetation fires peak in the afternoon, while industrial sources burn all day and give a ratio near 1. This means the 2000-2002 values carry the largest conversion.
- **Step at 2012:** naive sum 6.34x; harmonized 0.97x; normal year-to-year range (10th-90th percentile) 0.79 to 1.27.
- **Leave-one-year-out, whole-India monthly totals (median abs error / band coverage):** Terra->Aqua 14.3 % / 71 %; Aqua->S-NPP 7.9 % / 87 %; S-NPP->NOAA-20 3.2 % / 76 %.
- **Weak spot, reported as found:** at 1-degree-box level the error is much larger and the bands are too narrow: Aqua->S-NPP 44 % / 18 % coverage; Terra->Aqua 48 % / 28 %; S-NPP->NOAA-20 9.9 % / 22 %. Small-area values before 2018 are indicative only.
- Direct Aqua->NOAA-20 link (2018-2021): 12.1 % error, 54 % coverage, worse than the chain, so the chain is kept.
- **Gaps:** 1 dekad with no Terra data and nothing to fill from (21-30 June 2001).
- **Invariants:** conservation, harm_equals_weights, duplicates, date_range all pass.
- **Files:** 26 dekad files, largest 2.1 MB, 28.8 MB total. Points 231 MB in 26 files, uploaded to the `data` release with `meta.json`.

## Credentials found; Gate 2 RERUN: PASSED (India, 2000-11-01 to 2026-11-13, MCD12Q1 land cover)

`.env` was in `docs/` (git-ignored, never committed). With it: 2026 data fetched from the FIRMS Area API (297 chunk files, 37 minutes), land cover switched to MODIS MCD12Q1 2024, `FIRMS_MAP_KEY` set as an Actions secret. Numbers from `work/build_full.log` and `build_pub.log`:

- **Rows:** 345 input files, 18,232,525 rows in; 16,783,415 out; 1,128,680 outside India (API box is wider than India); 320,430 duplicates.
- **2026 detections:** NOAA-20 612,058 (to 13 Nov); S-NPP 546,261 (to 2 Nov, its last day); NOAA-21 909,572; Aqua 53,351; Terra 28,361.
- **Categories:** agricultural 8,497,469; forest 2,976,951; grass/shrub 3,197,793; other vegetation 24,756; urban 93,505; industrial 1,956,433; volcanic 240; offshore 36,268.
- **Static mask:** firms_static 1,537; persistent 3; volcano 3. Jharia found (90 cells), Jamnagar found (18), Mumbai High not found.
- **Variant:** no region (8.65 % vs 9.13 % mean error; only no-region keeps coverage within 60-95 % on every link).
- **Ratios (weighted mean by category):** Terra->Aqua 3.2 / 4.0 / 3.7 for agricultural / forest / grass (0.83 industrial); Aqua->S-NPP 7.8 to 12.6 vegetation, 24 urban, 37 industrial; S-NPP->NOAA-20 0.95 to 1.08.
- **Step at 2012:** naive 6.36x; harmonized 0.98x; normal year-to-year range 0.79 to 1.26.
- **Leave-one-year-out, whole-India monthly (error / band coverage):** Terra->Aqua 14.9 % / 81 %; Aqua->S-NPP 7.9 % / 88 %; S-NPP->NOAA-20 3.1 % / 76 %.
- **1-degree boxes (weak spot):** Terra->Aqua 47 % / 28 %; Aqua->S-NPP 44 % / 19 %; S-NPP->NOAA-20 10 % / 22 %.
- **Direct Aqua->NOAA-20 (2019-2021):** 8.5 % error, 42 % coverage.
- **Gaps:** 6 dekads. Unfilled (Terra only): 11-30 June 2001, 1-10 July 2001, 11-31 March 2002. Filled from Terra: 1-10 August 2002 (Aqua).
- **Invariants:** all four pass. Dekad files: largest 2.2 MB, 30.7 MB total. 30 files uploaded to the `data` release (27 points files, `dekad_2026.parquet`, `meta.json`, `gaps.parquet`).
- **Code review** (independent agent, read-only): no error in the headline series; recomputed every in-chain weight from the ratios with 0 mismatches. Its findings 1 and 2 are fixed (DECISIONS D13, D14). Not fixed, listed for the report: fire-days are counted per category, so summing across categories counts a cell-day once per category (+11 % in 2021); Terra outages inside fit years bias the December Terra->Aqua ratio by about +3 %; SP/NRT dedup needs identical coordinates.

## Status now

**Done and merged on `main`** (tests: 114 Python passed, 72 JS passed):
- Pipeline: ingest, classify, harmonize (3 links, both variants), aggregate, validate, publish, full build script, 2026 API fetch.
- Daily job (`pipeline/daily.py`, `daily.yml`) and the shared deploy step. Tested with mocks only; **not yet run in GitHub Actions**.
- Web: cells, stats, freshness, db, calendar modules; main page (map, area forms, calendar, KPIs, latest-month card, CSV downloads); Methodology page.

**Left, in order:**
1. Push and deploy; check the three walkthrough areas on the live site (Gate 3).
2. Trend chart with bands, anomaly bars, chart image downloads (Task 8).
3. Category calendars, mask layer, Season tab (Tasks 11-12).
4. Run the daily workflow once for real, plus the bad-key failure test.
5. Accessibility, dark mode, mobile pass and palette validation (Task 13).
6. Cross-check script (browser vs Python) on walkthrough areas and 5 random boxes.
7. Fresh verification agent and `docs/BUILD_REPORT.md` (Phase 5).
8. Stretch (comparison, timelapse, climate, exposure, alerts): not started; only if time remains.

**Resume point if this stops:** `main` is the source of truth; all agent branches so far are merged. Continue from item 1 above.

## Phase 3: app features merged; daily job works in CI; cross-check PASSED

- **Merged into `main`:** Trend + Anomalies tabs and chart/table downloads (W3), Categories + Season tabs and mask layer (W4), with a fix to `stats.season` (first partial season-year and quiet areas were mis-flagged; now uses the data's start/end dates). Tests: 114 Python, **99 JS** passed.
- **Mistake caught and fixed:** a merge conflict in `web/index.html` was committed and pushed (commit 9c2840c); fixed in the next commit before the next check.
- **Daily workflow in GitHub Actions:** first run failed (`numpy` missing from requirements; `rasterio` imported at module level). The deploy step still ran, so the site kept its data. After the fix, run 43556763431 **succeeded**: 2,149,603 rows for 2026 (identical to the local build), invariants passed, and it uploaded `points_2026`, `dekad_2026`, `gaps`, `meta.json`, then redeployed.
- **CDN bug found and fixed:** after a redeploy, a points file failed to load ("NetworkError"), because Pages' CDN can serve byte ranges from two versions of a file for up to 10 minutes. Data URLs now carry `?v=<meta.generated_utc>`, so each publish gets new URLs. After the fix: 0 console errors.
- **Cross-check (browser on the live site vs Python on the published files), all MATCH** (cells, harmonized landscape total, raw count, CSV row count with all 8 categories, top month):

| Area | Cells | Harmonized | Raw | CSV rows | Top month |
|---|---|---|---|---|---|
| Punjab + Haryana | 980 | 2,115,127 | 2,144,349 | 2,426,459 | Nov 2021 |
| Uttarakhand | 795 | 360,808 | 428,942 | 476,396 | Apr 2016 |
| Jharia | 12 | 1,934 | 2,763 | 320,116 | Apr 2024 |
| Box 73-74 E, 35-36 N | 64 | 36 | 78 | 81 | Oct 2026 |
| Box 83-84 E, 23-24 N | 100 | 33,932 | 45,355 | 64,360 | Mar 2021 |
| Box 96-97 E, 28-29 N | 81 | 6,544 | 6,353 | 6,678 | Feb 2026 |
| Box 72-73 E, 19-20 N | 37 | 5,808 | 8,380 | 15,014 | Mar 2013 |
| Box 76-77 E, 14-15 N | 100 | 10,940 | 18,478 | 24,795 | Feb 2025 |

  (The 5 boxes were drawn at random from covered cells with seed 1 by `pipeline/crosscheck.py`.)
- **Timings from that run:** first page load 6.5 s; first area query (cold, Punjab) 25.1 s; later areas 0.6-1.4 s. The cold first query misses the plan's target and is listed as a known issue.
- **Findings from the tabs (reported, not tuned):** Punjab + Haryana is *not* detected as two seasons: the Apr-May bump is 17.8 % of the typical annual total, below the 25 % rule, so the season sentence reads "11-20 Oct to 1-10 May, peak 1-10 Nov". Jharia: Industrial / static is 98.2 % of raw detections; 90 mask cells shown on the map.

## Status now

**Left, in order:** accessibility, dark mode, mobile and palette validation (Task 13); deliberate bad-key failure test of the daily job; Phase 5 fresh verification agent and `docs/BUILD_REPORT.md`. Stretch features (comparison, timelapse, climate, exposure, alerts) are **cut**: the usage-limit pauses used the time budget.
