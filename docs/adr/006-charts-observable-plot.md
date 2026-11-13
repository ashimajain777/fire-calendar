# ADR-006: Observable Plot for charts

**Status:** Proposed
**Date:** 2026-11-14

## Context
We need a calendar heatmap (cell mark), line charts with bands, diverging bars, small multiples, SVG/PNG export, tooltips, light and dark themes, and no build step.

## Decision
Observable Plot (ESM from jsDelivr, exact version at least 2 weeks old). The calendar itself is an HTML `<table>`, for accessibility and keyboard navigation, coloured from the same ramps. Plot is used for the other charts.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| Observable Plot (chosen) | Concise; `cell`, `areaY` and `barY` cover every chart; renders SVG, so export is trivial | Fewer built-in interactions (its tip mark is enough) |
| ECharts | Rich interactivity | Canvas by default (harder accessibility and SVG export); large bundle |
| Chart.js | Familiar | No native heatmap; canvas |
| D3 | Total control | Too slow to build in 24 h |

## Consequences
Chart images are exported by serialising the SVG, with PNG produced via a canvas.
