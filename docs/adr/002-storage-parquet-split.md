# ADR-002: Parquet storage, split by access pattern, one config

**Status:** Accepted (team decision); the dekad dimension is Proposed
**Date:** 2026-11-14

## Context
- Calendars need fast sums over cells and time.
- CSV export, the map and the timelapse need individual points.
- Everything must be readable by DuckDB-WASM over HTTP.
- GitHub limits files to 100 MB, and a repo's history grows with every commit of a binary file.

## Decision
- **Aggregated table** (`data/dekad/year=YYYY.parquet`): cell × year × month × dekad × category. It's committed to the repo and served by Pages from the same origin as the app.
- **Raw points** (`points/year=YYYY.parquet`): on a free Hugging Face dataset, every detection kept. Fallback is GitHub Releases; upgrade is Cloudflare R2.
- Both are sorted by `cell_id` so row-group statistics prune area queries.
- **All data locations live in one `config.json`**, read by the pipeline and the app.
- Proposed: the **dekad** dimension (3 rows per month). It enables a fair month-to-date comparison and season dates to about ±10 days. That's about 3× the rows, roughly 3–5 MB per year for India.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| Parquet split (chosen) | Columnar, range-readable, compact, one format for pipeline and browser | Two hosts |
| Everything on HF | One host | Calendar data is cross-origin; depends on HF CORS for core features |
| SQLite/DuckDB database file over HTTP | Single file | Weaker range-read pruning in WASM for this layout; harder to append per year |
| GeoJSON/CSV | Simple | 10–20× larger, slow to parse |

## Consequences
- The current-year dekad file is rebuilt daily and **added to the Pages artifact at deploy time, not committed**, to avoid growing git history.
- Archive years are committed once harmonization is stable.
- HF history is squashed weekly with `super_squash_history`.

## Amendment (14 Nov 2026)
- Points are stored as GitHub Release assets and bundled into the Pages artifact at deploy (no HF token; release assets are blocked by CORS when read directly).
- The current-year dekad file and `meta.json` also live on the release, and one shared deploy step includes them in every deploy.
