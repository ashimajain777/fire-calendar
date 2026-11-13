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
