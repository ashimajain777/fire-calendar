# Build report: Harmonized Burning Activity Calendar

Written 14 Nov 2026. Every number here was produced by a command run in this build session; the raw outputs are in `work/` (build logs, `crosscheck*.json`, `timing_*.json`, `a11y.json`, `verify/`) and the history is in [`BUILD_LOG.md`](BUILD_LOG.md).

## 1. Build status

**Verdict: Ready with issues.**

- Deployed: https://ashimajain777.github.io/fire-calendar/ (Methodology: `/methodology.html`).
- Code commit at verification: `c9460da` (this report is committed on top of it).
- Data: India, 1 Nov 2000 to 13 Nov 2026, 16,783,415 detections, refreshed daily by GitHub Actions.
- Main issues:
  1. Slow first query: the first query after page load takes 14-16 s (Punjab box) and the first all-India queries 10-14 s; later queries meet the targets.
  2. Small-area values before 2018 are uncertain (1° box error 10-47 %).
  3. Stretch features F6-F10 are not built.

## 2. Feature and requirement status

| Item | Status | Evidence |
|---|---|---|
| F1 Harmonized series + bands | Done | Trend tab and Methodology page; step test naive 6.36× vs harmonized 0.98×; W3 browser check: chart table equals calendar sums (2005: 103,260; 2016: 119,627; 2021: 101,592) |
| F2 Calendar + anomalies | Done | Calendar (counts/anomaly), latest-month card, rankings, anomaly bars; `stats.test.js`; cross-check top months match Python |
| F3 Fire season | Done, with a caveat | Season tab; `stats.season` tests; Punjab is not detected as two seasons (Apr-May bump 17.8 % < 25 % rule), reported not tuned |
| F4 Classification | Done | 8 categories, toggles, per-category calendars, mask layer; Jharia: Industrial / static = 98.2 % of raw detections, 90 mask cells shown |
| F5 Walkthrough areas | Done (as test inputs only) | Punjab + Haryana, Uttarakhand, Jharia load on the live site; no area-specific code (verifier search: no hits) |
| F6 Climate context | Not built | Cut (DECISIONS D20) |
| F7 Exposure | Not built | Cut |
| F8 Comparison mode | Not built | Cut |
| F9 Alerts (Telegram) | Not built | Cut (was low priority) |
| F10 Timelapse | Not built | Cut |
| R1 Harmonized MODIS+VIIRS series | Done | as F1; series starts Nov 2000 (Terra→Aqua link) |
| R2 Area by map or lat/long, date range | Done, mouse drawing not exercised by a script | Bbox and point-radius forms, polygon and rectangle draw tools, month inputs; keyboard check passes; drawing with a mouse was not scripted |
| R3 Calendar with colour ramp | Done | single-hue blue sequential, blue-grey-red diverging |
| R4 Historical comparisons | Done | latest month vs typical (complete 10-day periods), percentile, z-score, top months/years, anomaly bars |
| R5 Number of fires | Done | KPI row: harmonized hotspots with range, fire-days, raw detections per satellite |
| R6 Accessible ramps | Done | palette validator passes; axe 0 violations; table view per chart |
| R7 CSV + analytics + images | Done | hotspots CSV (row count equals calendar raw + low-confidence: 20,708 = 19,807 + 901, Punjab Nov 2024), monthly and annual CSV, SVG/PNG per chart, calendar PNG |
| R8 FIRMS archive + NRT | Done | country CSVs 2000-2025 + Area API 2026 (SP and NRT); daily workflow run 43556763431 succeeded |

## 3. Test results

| Suite | Command | Result (commit `c9460da`) |
|---|---|---|
| Python | `.venv/Scripts/python -m pytest pipeline/tests -q` | **115 passed** |
| JavaScript | `node --test "web/tests/*.test.js"` | **101 passed, 0 failed, 0 skipped** |
| Independent verifier (clean checkout `dfcf97f`) | same commands | 114 passed; 99 passed |

Regression tests added after verification were checked red-green: the dedup test failed 3 of 3 times on the old code and passed with the fix.

## 4. Real-data results

- **Rows:** 345 input files, 18,232,525 rows in; 16,783,415 out; 1,128,680 outside India (the API box is wider than India); 320,430 duplicates.
- **By satellite (all years):** Terra from 1 Nov 2000, Aqua from 4 Jul 2002, S-NPP 20 Jan 2012 to 2 Nov 2026, NOAA-20 from 1 Apr 2018, NOAA-21 2026 only. 2026: NOAA-20 612,058; S-NPP 546,261; NOAA-21 909,572; Aqua 53,351; Terra 28,361.
- **Chain switch dates (computed):** Aqua 1 Aug 2002, S-NPP 1 Feb 2012, NOAA-20 1 Apr 2018.
- **Categories:** agricultural 8,497,469; forest 2,976,951; grass/shrub 3,197,793; other vegetation 24,756; urban 93,505; industrial 1,956,433; volcanic 240; offshore 36,268.
- **Stratum variant:** no region. Mean leave-one-year-out error 8.65 % vs 9.13 % with region; only no-region kept band coverage in 60-95 % on every link.
- **Ratios (detection-weighted mean by category):**
  - Terra→Aqua: 3.2 / 4.0 / 3.7 for agricultural / forest / grass, 0.83 industrial. Not near 1: Terra passes about 10:30 and Aqua about 13:30, and vegetation fires peak in the afternoon; persistent industrial sources are near 1.
  - Aqua→S-NPP: 7.8 to 12.6 for vegetation, 24 urban, 37 industrial.
  - S-NPP→NOAA-20: 0.95 to 1.08.
- **Step at 2012:** naive sum 6.36×; harmonized 0.98×; normal year-to-year range 0.79 to 1.26. The harmonized step is inside the normal range.
- **Leave-one-year-out (median abs. error / band coverage):**

| Link | Whole India, monthly | Category × month | 1° box × month |
|---|---|---|---|
| Terra→Aqua | 14.9 % / 81 % | 26 % / 53 % | 47 % / 28 % |
| Aqua→S-NPP | 7.9 % / 88 % | 22 % / 56 % | 44 % / 19 % |
| S-NPP→NOAA-20 | 3.1 % / 76 % | 6.4 % / 59 % | 10 % / 22 % |

  Direct Aqua→NOAA-20 (2019-2021) for comparison: 8.5 % error, 42 % coverage; the chain is kept.
- **Static mask:** firms_static 1,537 cells; persistent 3; volcano 3. Jharia found (90 cells); Jamnagar found (18); Mumbai High **not found** (not in the FIRMS India country file).
- **Gaps:** 6 ten-day periods. Unfilled (shown as "no data"): 11-30 Jun 2001, 1-10 Jul 2001, 11-31 Mar 2002 (Terra outages). Filled from Terra: 1-10 Aug 2002.
- **Invariants** (conservation, harm = Σ weights, no duplicates, dates in range): pass on every build, including the verifier's two reruns.
- **Repeatability:**
  - After the dedup fix, the dekad tables are byte-identical across reruns, and the 27 points files have identical contents (checked with an ordered content hash).
  - The points files' bytes still differ between runs (row layout within ties).
  - Validation files differ only at about 1e-12 (floating-point summation order).
- **Cross-check, browser (live site) vs Python (published files), final deploy:** 8 of 8 MATCH on cells, harmonized total, raw count, CSV row count (all 8 categories) and top month, with 0 console errors.

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

## 5. Performance (headless Edge, live site; `tools-browser/timing.mjs`)

| Measurement | Before id-list fix | After (final) | Target |
|---|---|---|---|
| Page load to ready | 4.8-6.1 s | 6.0-6.3 s | — |
| District box (1°×1°), runs 1 / 2 / 3 / 4 | 12.6 / 10.5 / 1.8 / 1.8 s | 14.5 / 8.5 / 1.7 / 1.8 s | ≤ 2 s warm: **met from the 3rd query** |
| All India, runs 1 / 2 / 3 / 4 | 32.8 / 49.9 / 48.1 / 45.9 s | 14.3 / 10.7 / 5.1 / 5.1 s | ≤ 6 s warm: **met from the 3rd query** |

The first one or two queries after page load are slow (8-15 s): DuckDB-WASM fetches the metadata of all 27 yearly files on first use. This is the top open performance issue.

## 6. Accessibility and palette

- `validate_palette.js`: map categories (all pairs) light: all checks pass, contrast warning on `#1baf7a` (2.74:1), with the legend and point outlines as relief; dark: all pass. Sensor lines: pass, contrast warnings with direct labels and table views as relief.
- axe-core 4.10.2, WCAG 2.0/2.1 A and AA: **0 violations** on the main page (before and after opening every tab) and the Methodology page, light and dark. The first run found 21-22 `aria-prohibited-attr` nodes from Observable Plot, which are fixed.
- Keyboard only: 9 Tab stops to the bounding-box form, Enter runs the query, arrow keys move in the calendar, visible focus on every stop.
- No page-level horizontal scroll at 200 % zoom or at 390 px.
- **For the team to do:** NVDA / VoiceOver pass (live-region announcements, calendar cells, tabs, error alert) and a real-phone check.

## 7. Deviations from the plan

See [`DECISIONS.md`](DECISIONS.md) for the reasoning; in short:
- **Points host:** GitHub Release assets served through Pages instead of Hugging Face (D3, D12).
- **`.env` location:** it was in `docs/`, found after Phase 2, so the data was rebuilt with 2026 and MCD12Q1 land cover (D12).
- **Fit years:** they exclude each target satellite's partial first year (D11, D14).
- **Outages:** runs of 5 or more days with no detection are flagged as gaps (D13).
- **CDN failures:** file reads are retried after deploy-time failures; the first explanation (URL versioning) was wrong and is corrected (D18).
- **Multi-agent workflow:** worktrees were created manually (D10); several agents were paused and resumed by usage limits.
- **Stretch features:** cut (D20).

## 8. Known issues and limitations

- Slow first query after page load (section 5).
- Small-area values before 2018 carry large conversion error (section 4); the Methodology page says so.
- Punjab's spring harvest burning is not reported as a separate season under the 25 % rule.
- The static mask is built from the last 5 years and applied to all years, so a newer kiln can label old fires "industrial".
- Land cover is a single year (MCD12Q1 2024).
- Ground-reported fires are not covered: there is no open nationwide dataset for India, so only satellite detections are counted.
- Fire-days are counted per category, so a cell-day with fires in two categories counts twice when categories are summed (+11 % in 2021, from the code review).
- Terra outages inside fit years bias the December Terra→Aqua ratio by about +3 % (code review); it affects December 2000 and 2001 only.
- The current partial month is ranked against full months in the calendar cell ("0th percentile, provisional"); the latest-month card compares like with like.
- The error message for a broken data file is DuckDB's raw text (names the file, shows no numbers).
- The deploy-time file-read failure has an unproven root cause; it was mitigated with retries, and the retry was not observed firing in a scripted test.
- Mumbai High offshore flares are absent from the FIRMS India country file; NOAA-21 is stored for 2026 only.

## 9. What's left

| Item | Where it plugs in |
|---|---|
| Faster first query | Preload file metadata at page load, or a single combined metadata file |
| Comparison mode (F8) | Second `fc:results` context, two `renderCalendar` calls with a shared scale |
| Timelapse (F10) | `queries.points` by day/week + `map.showPoints` per frame |
| Climate context (F6) | `data/climate/` per cell-month tables (CEMS FWI, ERA5-Land), stacked panel |
| Exposure (F7) | GHS-POP 0.01° table joined to point cells |
| Alerts (F9) | Daily workflow step + Telegram bot (ADR-010) |
| Global coverage | Same pipeline on the `all_countries` files + region stratum (ADR-009) |
| Screen-reader and phone checks | Manual, by the team |
