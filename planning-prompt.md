# Planning prompt — Harmonized Burning Activity Calendar (NASA Space Apps 2026)

> **Mode: PLAN ONLY.** Do not write application code, scaffold projects, install packages, or download data yet. Your output for this session is a written plan for me to review. Stop after delivering it and wait for my approval.

---

## 0. Ground rules and constraints (decided)

- **No hardcoded or simulated outputs. Ever.** Every number, chart, calendar, alert and export must be computed from real NASA FIRMS data (and the real climate/population datasets in §5). No mock data, placeholder values or canned responses anywhere in the app. The app must work for **any area the user selects** within the data coverage. No area may have special-cased logic.
- Precomputing the harmonized dataset from real FIRMS archives is a processing step, not hardcoding, and is expected. Recent days come live from the FIRMS NRT API. If a live source is unavailable, the app should say so and show the timestamp of the last successful update. It must never fake data.
- **Team:** 2 people, basic Python and JavaScript, but **only one Claude Code session**. All building happens sequentially in this one session, so don't split the build into parallel workstreams. The second person handles non-coding work alongside: data downloads, testing the app against real areas, checking outputs, and preparing the presentation. Choose a stack that is simple, well-documented and fast to build with. Avoid anything exotic.
- **Time:** 24 hours total to a working, deployed app. The plan must be realistic for that. Build a thin, fully working end-to-end slice first (real data → harmonization → calendar for a drawn area → CSV), then add features in priority order. Anything that doesn't fit in 24 h goes to future scope. Be honest about this in the plan.
- **Stack:** no preference. Recommend one via ADRs, choosing for simplicity and speed.
- **Coverage:** recommend between global and India-first, based on data volume, download time and the 24 h limit. Check whether FIRMS's ready-made per-country yearly CSVs (MODIS + VIIRS) are still available, since they avoid archive-request wait times. The pipeline must work for any region, so expanding coverage later only means running it on more data.
- **Alerts must send for real** (email or Telegram) if they're built. They are not simulated.
- **Time-sensitive first task:** list anything that takes waiting time (FIRMS MAP_KEY, archive download requests, API keys) as the very first tasks, so we start them immediately.

---

## 1. Skills to use

Load and follow these skills (via the Skill tool) if they are available in this session. If one isn't installed, say so and carry on.

| Skill | Use it for |
|---|---|
| `superpowers:brainstorming` | Before designing: work through goals, users, constraints. Ask me the open questions in §9 **before** you lock the plan. |
| `engineering:system-design` | Overall architecture, data model, API design, service boundaries. |
| `engineering:architecture` | Write a short ADR for each major tech choice (storage format, grid system, backend framework, map library, charting library, hosting, job scheduler). |
| `dataviz` | Calendar heatmap, anomaly charts, color ramps, legends, KPI cards. Read it before specifying any visual. |
| `design:accessibility-review` | Colorblind-safe ramps, contrast, keyboard use, screen-reader labels. Accessible color ramps are an explicit requirement. |
| `frontend-design:frontend-design` | Visual direction and layout of the web app (it should feel like a professional operations tool, not a template). |
| `engineering:testing-strategy` | Test plan, especially for harmonization correctness and the statistics. |
| `superpowers:writing-plans` | Turn the final design into a step-by-step implementation plan with ordered, testable tasks. **Use this last.** |

If we later deploy on Vercel, `vercel:create-a-backend` applies. Don't assume Vercel yet; treat hosting as an ADR decision.

---

## 2. The challenge (summary of the official problem statement)

**2026 NASA Space Apps Challenge.** Satellites have recorded active fire hotspots for 20+ years, but the record is split between two sensors that can't be compared directly:

- **MODIS** (Terra/Aqua): ~1 km pixels, record from 2000, nearing end of life
- **VIIRS** (S-NPP, NOAA-20, NOAA-21): 375 m pixels, from 2012, more sensitive (many more small fires and night detections)

If you just add the two together, you get a fake jump in activity around 2012. **Goal:** build a web app that **harmonizes MODIS + VIIRS hotspots (from NASA FIRMS) into one consistent series** and presents it as a **burning activity calendar** for any area the user picks. It's for early-warning and emergency responders, scientists, land managers and firefighters.

**Requirements.** Treat all of these as mandatory, including the ones the problem statement lists as "potential considerations":
1. A harmonized MODIS + VIIRS hotspot time series from the early 2000s to the present. Once harmonized, the sensor of origin shouldn't affect patterns, trends or anomalies.
2. The user selects an area of interest by **drawing on an interactive map** or **entering lat/long**, plus a **date range**.
3. A **burning calendar** (year × month) of hotspot counts with a color ramp.
4. Historical comparisons: months and years with the most activity, **current month vs. historical median**, **anomalies vs. multi-year averages**.
5. Number of fires detected.
6. **Accessible color ramps.**
7. **Downloadable CSV** of the hotspots in the search, plus downloadable analytics and visualizations.
8. Data source: NASA FIRMS (MODIS C6.1 + VIIRS 375 m, archive/standard and near-real-time).

---

## 3. Core design principle: classify, don't delete

The problem statement explicitly covers wildfires, agricultural burns, land clearing, waste disposal, industrial activity and urban fires. So the tool **must not throw away non-vegetation detections.**

- **Tag every hotspot with a category**, combining the FIRMS `type` field (archive/standard product: 0 = presumed vegetation fire, 1 = active volcano, 2 = other static land source, 3 = offshore) with land cover (e.g. MODIS MCD12Q1). Proposed categories: **cropland/agricultural, forest, grassland/shrub, urban/built-up, industrial/static source (gas flares, refineries, steel mills), volcanic, offshore**. Refine this list in the plan.
- **Users can turn categories on and off.** The default view is landscape fires (wildfire + agricultural) so the seasonal pattern stays readable. Users can switch on industrial, urban, volcanic and offshore layers, or view a separate calendar for each category.
- **Persistent static sources are left out of the harmonization fit** (they behave nothing like landscape fires and would skew the MODIS↔VIIRS conversion) but are still stored, shown and exported.
- **NRT data has no `type` field.** Build a **static-source mask** from the archive (grid cells with fire on a high fraction of days across many years) and apply it to new NRT detections. Specify the persistence threshold and how the mask gets refreshed.
- The CSV export includes each hotspot's category, sensor, satellite, confidence, FRP, day/night flag and harmonization weight.

---

## 4. Harmonization (the scientific core; plan this in the most detail)

Propose a method, justify it, and define how it will be validated. Consider and decide on each of these:

- **Common spatial unit.** Aggregate to a grid (0.1° vs. H3 hexagons at an appropriate resolution; decide in an ADR) so that VIIRS's 3–6 detections per MODIS-sized footprint don't inflate counts.
- **Calibration using the overlap period (2012–present).** Fit a MODIS→VIIRS-equivalent conversion (ratio, linear regression, or quantile mapping), **stratified by region and/or land-cover class**, then apply it to MODIS-only years (2000–2011). Output the series in "VIIRS-equivalent" units.
- **Matching observation times.** Consider using **Aqua-only MODIS** (≈13:30 overpass, like VIIRS) as the baseline, and how Terra's orbital drift late in its life affects consistency. Check Terra/Aqua's current operational status.
- **Consistency within VIIRS.** S-NPP, NOAA-20 and NOAA-21 overlap. Decide whether to pick one baseline satellite or deduplicate detections across them, so counts don't jump as satellites are added.
- **Matching sensitivity.** Optional FRP threshold on VIIRS to approximate MODIS's minimum detectable fire.
- **Confidence normalization.** MODIS confidence (0–100) vs. VIIRS confidence (low/nominal/high). Define one common threshold policy.
- **Day/night handling.** Treat them consistently (VIIRS detects far more fires at night).
- **Metrics.** Offer at least: harmonized hotspot count, plus a robust alternative such as **fire-days per grid cell**. Explain when each is appropriate.
- **Uncertainty.** Carry the conversion's error into **uncertainty bands** on the pre-2012 harmonized values and show them in charts.
- **Validation (shown inside the app, e.g. a "Methodology" page computed from the real data).** (a) Before/after plots showing the 2012 step is removed. (b) Hold-out validation inside the overlap period: train on some years, test on others, report error. (c) Results broken down by region and land cover.

---

## 5. Finalized features (in scope)

For each feature, write: purpose, user story, inputs and data sources, computation method, UI behavior, acceptance criteria, and priority tier (**MVP → Core → Stretch**).

1. **Harmonized series with uncertainty bands.** As in §4.
2. **Burning calendar with percentile and z-score anomalies.** Year × month heatmap (sequential, colorblind-safe ramp such as viridis/cividis) with a toggle between raw harmonized counts and anomaly view (diverging, colorblind-safe ramp). Tooltips show count, percentile rank since 2001 and z-score. Also: a **current month vs. historical median** card, a ranking of top months/years, an annual trend chart and an anomaly bar chart.
3. **Fire season detection.** For the selected area, compute the climatological season **onset, peak and end** (e.g. the dates when cumulative climatological activity reaches 10%, the peak, and 90%). Flag whether each year's season ran **early, late, longer or shorter** than normal. This addresses the problem statement's "critical periods" goal.
4. **Fire type classification (classify-don't-delete).** As in §3: category toggles, per-category calendars, static-source mask.
5. **Presentation walkthrough areas (not special-cased in code).** When we present to judges, we'll draw these areas live in the working app: **Punjab/Haryana stubble burning** (strong Oct–Nov seasonality, tied to Delhi's air quality), plus 1–2 others that show different categories (a forest wildfire region, and an industrial/gas-flare region to show why classification matters). Recommend the areas and use them as real test cases during development. The app treats them exactly like any other area.
6. **Climate context.** Overlay Fire Weather Index (e.g. Copernicus/CEMS GEFF or GFWED) and rainfall anomaly (e.g. CHIRPS or ERA5) on the hotspot charts, so users can see *why* a month was unusual. Decide the data source and resolution, and whether to precompute or fetch on demand.
7. **Exposure.** Population and settlements within a buffer of hotspots or inside the area (e.g. WorldPop, GHSL). Show "people near active fires" for a selected period.
8. **Comparison mode.** Two areas side by side, or two years for the same area: synchronized calendars, charts and summary stats.
9. **Alerts.** Users subscribe to an area and get a notification (email and/or Telegram) when the current week or month goes above a chosen percentile (e.g. 90th) of its historical distribution. Needs a scheduled job that pulls FIRMS NRT data daily, classifies it (static mask) and evaluates subscriptions. Specify the scheduler, delivery channel and anti-spam rules.
10. **Timelapse animation.** Day-by-day (or week-by-week) animated map of hotspots across a chosen period/season: play, pause, scrub and speed controls, points colored by category, and a synced counter/mini-chart. Consider exporting the animation (GIF/MP4) for reports.

**Also required (from the problem statement):** map drawing + lat/long input, date range picker, CSV export of hotspots, downloadable analytics (aggregated tables) and chart images.

---

## 6. Future scope (lower priority, design so these can be added later)

- Short-term forecast of expected next-month activity with a range (seasonal climatology + trend, e.g. SARIMA/Prophet), turning the tool into an early-warning tool
- Quick-pick admin boundaries (country/state/district dropdown) as well as drawing
- One-click PDF situation report + shareable URL that encodes the area, date range and filters
- Low-bandwidth / mobile field view for crews
- Public API for the harmonized dataset
- Cross-check against burned area (MCD64A1)
- Air quality / smoke link (e.g. AQI near the area)
- Multilingual UI (Hindi first, then others)
- Natural-language queries ("how does this October compare to normal?")

---

## 7. Architecture considerations to address

- **Data ingestion:** FIRMS archive bulk downloads (standard-processing MODIS C6.1 and VIIRS 375 m from S-NPP, NOAA-20 and NOAA-21) plus the FIRMS area API for NRT (needs a MAP_KEY). **Check the current FIRMS API endpoints, source names, day-range limits and rate limits**; don't rely on memory.
- **Scope of data:** global vs. India-first (see §0). Weigh storage, download and processing time, and recommend an approach that can scale up later.
- **Storage:** a pre-aggregated cube (grid cell × day × category × sensor → counts, harmonized counts, FRP stats), e.g. Parquet + DuckDB, alongside raw points for CSV export. Area queries must come back in under ~2 s.
- **Backend:** API endpoints for area stats, calendar, anomalies, season detection, comparison, hotspots CSV, timelapse frames, climate overlays, exposure, and alert subscriptions. Write an endpoint spec.
- **Frontend:** map library with drawing tools (MapLibre/Leaflet/deck.gl for the timelapse), charting library, state management. Plan the screen layout.
- **Jobs:** daily NRT ingest → classify → update cube → evaluate alerts.
- **Hosting/deployment:** a free or low-cost option that can serve the precomputed dataset. If a live source fails, degrade gracefully (show the last successful update time) without ever showing fabricated data.
- **Reproducibility:** pipeline scripts and notebooks that regenerate the harmonized dataset from scratch.

---

## 8. What to deliver (your output)

Write everything to **`docs/PLAN.md`** (with ADRs in `docs/adr/`), then summarize it for me in chat. The plan must contain:

1. Goals, users and success criteria (map every requirement in §2 to the features that satisfy it)
2. Architecture diagram (Mermaid) and data-flow diagram from FIRMS to UI
3. Data sources table (product, resolution, period, access method, fields used)
4. Harmonization methodology (§4) with validation plan and risks
5. Classification design (§3), including category rules and static-mask algorithm
6. Data model / schema for raw points and the aggregated cube
7. API specification
8. Frontend screens and interactions (wireframe-level description or ASCII/Mermaid), with color ramps named and checked for accessibility
9. Feature specs for §5 with acceptance criteria and priority tiers
10. ADRs for the major tech choices
11. Test strategy
12. Risks and mitigations (data volume, API limits, harmonization error, live-source outages)
13. Ordered implementation plan (via `superpowers:writing-plans`): a single sequential hour-by-hour build plan over 24 h for one Claude Code session, with a side column of non-coding tasks for the second person; milestones from MVP → Core → Stretch, each task small and testable, with dependencies; and a clear cut line showing which §5 features realistically make it in
14. Future scope (§6) and how the architecture leaves room for it

---

## 9. Ask me before finalizing

Team, time, stack and alert questions are answered in §0. During brainstorming, ask me about anything else that's still unclear (e.g. hosting budget, email vs. Telegram for alerts, your coverage recommendation) before you write the final plan.

**Remember: plan only. No implementation until I approve the plan.**
