# Build log

Times are local (IST). Numbers are copied from command output.

## 14 Nov 2026, start

- **Blocker found:** no `.env` in the project. Continuing without FIRMS key, HF token or Earthdata login. See `docs/DECISIONS.md` D1–D5.
- Environment: Python 3.12 venv; duckdb 1.5.2, pyarrow 26.0.1, rasterio 2.0.0. Git repo initialised, remote `ashimajain777/fire-calendar`.
- FIRMS India yearly CSVs downloading (MODIS 2000–2025, S-NPP 2012–2025, NOAA-20 2017–2025). Natural Earth India point-of-view admin-0 file downloaded.
