# ADR-001: Static site with DuckDB-WASM, no server, no build step

**Status:** Accepted (team decision, 14 Nov 2026)
**Date:** 2026-11-14
**Deciders:** Team (2)

## Context
- Hosting must be free.
- Free Hugging Face Docker/Gradio Spaces now need PRO for new accounts.
- Render's free tier has 512 MB of memory and sleeps after 15 minutes, which means cold starts of 30–60 s during a live demo.
- The data is precomputed and read-only for the browser, apart from a once-a-day refresh.
- The team knows basic Python and JS.

## Decision
- Serve plain HTML/JS from GitHub Pages.
- Run all queries in the browser with DuckDB-WASM, using HTTP range reads of Parquet.
- Load libraries as ES modules from jsDelivr with exact pinned versions (each at least 2 weeks old at build time). There's no bundler.

## Options Considered

### Option A: Static + DuckDB-WASM (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low–Med (SQL in the browser) |
| Cost | $0 |
| Scalability | Scales with CDN; heavy queries cost the client |
| Team familiarity | JS + SQL |

**Pros:** never sleeps; no server to secure or keep alive; the files double as a public API.
**Cons:**
- First load fetches about 6–8 MB of WASM.
- Large-area queries download more data.
- The stats live in JS, not Python.
- Hour-1 risk: CORS and range reads from HF.

### Option B: FastAPI + DuckDB on Render free
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | $0 |
| Scalability | 512 MB memory; one instance |
| Team familiarity | Python |

**Pros:** all logic in Python.
**Cons:** cold starts, memory ceiling, and a redeploy to update data.

## Trade-off Analysis
Reliability during the demo, and $0, outweigh keeping everything in Python. The stats are simple (median, percentile, z-score, cumulative shares) and are unit-tested in plain JS.

## Consequences
- **Easier:** hosting, uptime, sharing the data.
- **Harder:** heavy server-side work, such as alerts. That moves to the daily GitHub Action.
- **Revisit:** a small serverless function if natural-language queries or the public API need one.

## Action Items
1. [ ] Hour-1 gate: DuckDB-WASM range reads from Pages and from HF; fallback GitHub Releases.
2. [ ] Pin exact library versions in `index.html`.
