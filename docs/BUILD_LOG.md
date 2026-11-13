# Build log

Times are local (IST). Numbers are copied from command output.

## 14 Nov 2026, start

- **Blocker found:** no `.env` in the project. Continuing without FIRMS key, HF token or Earthdata login. See `docs/DECISIONS.md` D1–D5.
- Environment: Python 3.12 venv; duckdb 1.5.2, pyarrow 26.0.1, rasterio 2.0.0. Git repo initialised, remote `ashimajain777/fire-calendar`.
- FIRMS India yearly CSVs downloading (MODIS 2000–2025, S-NPP 2012–2025, NOAA-20 2017–2025). Natural Earth India point-of-view admin-0 file downloaded.

## Gate 0: PASSED (range reads)

- Deployed https://ashimajain777.github.io/fire-calendar/gate.html (first two deploys failed: `data/` folder was not in the repo; fixed with placeholders).
- `curl -H "Range: bytes=0-999"` on the Pages-served test file: `206`, 1000 bytes of 1,417,018. `Accept-Ranges: bytes`.
- DuckDB-WASM 1.32.0 in the browser, query on the Pages-served file (real MODIS 2004 India data): `n = 9883` rows with latitude 30-31, 3528 ms cold. DuckDB in Python on the same file: 9883. They match.
- Direct read from the GitHub Release URL: **blocked by CORS** ("No 'Access-Control-Allow-Origin' header"). So points are served through Pages (DECISIONS D3).
- `docs/CONTRACTS.md` committed.
