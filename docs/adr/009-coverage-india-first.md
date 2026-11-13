# ADR-009: India first, region-agnostic pipeline

**Status:** Accepted (team decision)
**Date:** 2026-11-14

## Context
Data volumes were measured on 13 Nov 2026:
- **India per-country CSVs:** about 1 GB for 2002–2025, all sensors.
- **Global:** about 80 MB/year zipped for MODIS plus about 380 MB/year zipped per VIIRS satellite, more than 15 GB zipped.

Country files end at 2025, and 2026 has to come from the Area API, where a world bbox means far more calls and processing. Then there's the 24 h limit.

## Decision
- Process India first.
- The pipeline takes a region (country file list plus a clip polygon/bbox) as a parameter and has no India-specific logic.
- The app accepts any geometry and reports "no coverage" outside the processed region.

## Consequences
- Going global later means rerunning on the `all_countries` zips, adding a region stratum, tiling the points partitions, and probably moving points to R2.
- The demo stays focused on Indian fire regimes.
