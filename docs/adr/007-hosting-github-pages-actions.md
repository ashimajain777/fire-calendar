# ADR-007: GitHub Pages hosting and GitHub Actions for the daily job

**Status:** Accepted (team decision)
**Date:** 2026-11-14

## Context
Everything must be free tier: the static site, the daily FIRMS NRT ingest, republishing, and later alerts.

## Decision
- Pages is deployed from a GitHub Actions workflow (artifact-based deploy).
- `daily.yml` runs on cron at 03:30 UTC plus `workflow_dispatch`. It:
  - fetches the current year from the FIRMS Area API (SP where available, else NRT)
  - classifies with the static mask
  - rebuilds the current-year dekad and points files
  - runs the invariants
  - uploads the points to HF
  - deploys Pages with the new current-year dekad file and `meta.json`
- If any step fails, nothing is deployed and the site keeps the last good data.
- Secrets: `FIRMS_MAP_KEY`, `HF_TOKEN`, and `TELEGRAM_BOT_TOKEN` later.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| Pages + Actions (chosen) | Free; same origin for app and dekad table; a failed job leaves the old site up | Scheduled jobs can be delayed or disabled after 60 days without repo activity |
| Cloudflare Pages + Workers cron | Fast CDN | Another account; 25 MB file limit |
| Render cron | — | Paid for cron jobs |

## Consequences
- The schedule has jitter, so freshness is "within about a day", and the badge says so.
- Keep the repo active, or re-enable the workflow after 60 idle days.
