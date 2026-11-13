# ADR-008: Pipeline in Python with DuckDB, pyarrow and rasterio

**Status:** Proposed
**Date:** 2026-11-14

## Context
The pipeline must process about 1 GB of CSV for India, and later more than 15 GB globally, on a laptop and in GitHub Actions. It should be reproducible from scratch, and the team knows basic Python.

## Decision
- Python scripts (`ingest`, `classify`, `harmonize`, `aggregate`, `validate`, `daily`) using DuckDB for SQL transforms and Parquet I/O.
- rasterio is used once, to sample land cover into lookup tables, so Actions only needs duckdb, pyarrow and requests.
- pytest for tests.
- Scripts, not notebooks (they diff and test cleanly).
- One command rebuilds everything: `py -m pipeline.build --region india`.

## Options Considered
| Option | Pros | Cons |
|---|---|---|
| DuckDB + pyarrow (chosen) | Fast, out-of-core, same SQL dialect as the browser | SQL-heavy code |
| pandas/geopandas | Familiar | Memory-heavy at global scale; slower |
| Spark/Dask | Scales | Overkill; setup time |

## Consequences
- Use the same SQL in browser and pipeline wherever possible.
- Check Python 3.14 wheels in hour 0, with 3.12 as the fallback.
