# ADR-004: Harmonization in NOAA-20-equivalent units with a stratified ratio of totals

**Status:** Proposed
**Date:** 2026-11-14

## Context
- MODIS (from 2000, 1 km) and VIIRS (from 2012, 375 m) counts aren't comparable.
- S-NPP VIIRS stopped on 1–2 Nov 2026. NOAA-20 (from 2018) and NOAA-21 (from 2023) continue.
- Terra and Aqua have drifted since 2022 and end in 2027.
- We need a consistent series with uncertainty in 24 h.

## Decision
- **Unit:** NOAA-20-equivalent hotspots and fire-days.
- **Chain:**
  - Aqua MODIS 2002-07→2011-12 × r (Aqua→S-NPP, fitted 2012–2021) × s
  - S-NPP 2012→2017 × s (S-NPP→NOAA-20, fitted 2018–2025)
  - NOAA-20 from 2018, observed
- **Strata:** land-cover class × calendar month. Fitted on landscape fires; static sources form their own stratum. Thin strata (fewer than 200 baseline detections) fall back to the class ratio, then to the overall ratio.
- **Ratio of totals** over cells and years, so cells where MODIS saw nothing still contribute their VIIRS fires.
- **Bands:** the 10th–90th percentile of the yearly ratios (year bootstrap), multiplied along the chain (conservative).
- **Validation:** leave-one-year-out error and band coverage; before/after step statistic; breakdown by class and month. All of it is shown in the app.
- Confidence: MODIS ≥ 30, VIIRS n/h. Day and night both included. No FRP threshold.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| Stratified ratio of totals (chosen) | Unbiased for area sums; simple; transparent; robust to zeros | Ignores within-stratum variation in fire size; per-cell values are only meaningful in aggregate |
| Per-cell log-linear regression | Captures non-linearity | Zero-inflation; biased for sums after back-transform; more code |
| Quantile mapping | Matches distributions | Can't create VIIRS fires where MODIS saw 0; needs large samples per stratum |
| S-NPP units | Longest observed VIIRS run | Live data (the most-used numbers) would need conversion now that S-NPP has ended |
| Merge all VIIRS satellites | More detections | Counts jump as satellites are added (2018, 2023) |
| Terra + Aqua | Starts 2000 | Different overpass time; Terra drift; inconsistent with VIIRS |

## Consequences
- The series starts July 2002, and the base period is 2003–2025.
- Each point carries `harm_weight`, so CSV, table and calendar always reconcile.
- Revisit: a region dimension for global use; the direct Aqua→NOAA-20 link if it validates better; a NOAA-21 backup link.
