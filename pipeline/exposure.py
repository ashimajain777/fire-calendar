"""People living near detected fires (B3). See docs/DECISIONS.md D24.

pop001: GHS-POP 2020 (30 arc-second, about 1 km) summed into 0.01-degree cells.
exposure: for each month, the population of 0.01-degree cells that contain an in-chain landscape detection or touch
one (3 x 3 neighbourhood, so roughly 1-2 km), summed per 0.1-degree cell. A person is counted once per month in
their own cell, so monthly totals add up exactly over any set of cells. Published as 5-degree tiles, like the dekad table.

python -m pipeline.exposure --tif work/aux/ghs/<file>.tif
"""
import argparse
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import settings

ROOT = settings.ROOT
TILE_SQL = "((cell_id // 3600) // 50) * 72 + (cell_id % 3600) // 50"


def build_pop001(tif: Path, bbox: tuple, out: Path) -> dict:
    """Sum population pixels into the 0.01-degree cell holding each pixel centre."""
    import rasterio
    from rasterio.windows import from_bounds

    w, s, e, n = bbox
    with rasterio.open(tif) as src:
        win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
        a = src.read(1, window=win, masked=True).filled(0).astype(np.float64)
        t = src.window_transform(win)
    a[a < 0] = 0
    rows, cols = np.nonzero(a)
    lon = t.c + (cols + 0.5) * t.a
    lat = t.f + (rows + 0.5) * t.e
    cid = (np.floor((lat + 90) * 100).astype(np.int64) * 36000 + np.floor((lon + 180) * 100).astype(np.int64))
    uniq, inv = np.unique(cid, return_inverse=True)
    pop = np.bincount(inv, weights=a[rows, cols])
    pq.write_table(pa.table({"cell001_id": uniq, "pop": pop.astype(np.float32)}), out, compression="zstd")
    return {"cells": int(len(uniq)), "population": float(pop.sum()), "raster_total_in_window": float(a.sum())}


def exposure_sql(points_glob: str, pop001: str) -> str:
    """Monthly exposed population per 0.1-degree cell (landscape categories, in-chain detections)."""
    return f"""
      WITH fire AS (SELECT DISTINCT year(acq_date) AS year, month(acq_date) AS month,
                           cell001_id // 36000 AS r, cell001_id % 36000 AS c
                    FROM read_parquet('{points_glob}') WHERE in_baseline_chain AND category IN (0, 1, 2, 3)),
      near AS (SELECT DISTINCT year, month, (r + dr) * 36000 + (c + dc) AS cell001_id
               FROM fire, (SELECT unnest([-1, 0, 1]) AS dr), (SELECT unnest([-1, 0, 1]) AS dc))
      SELECT ((p.cell001_id // 36000) // 10) * 3600 + (p.cell001_id % 36000) // 10 AS cell_id,
             near.year::SMALLINT AS year, near.month::TINYINT AS month, sum(p.pop)::REAL AS exposed_pop
      FROM near JOIN read_parquet('{pop001}') p USING (cell001_id)
      GROUP BY ALL"""


def build_exposure(con, points_glob: str, pop001: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("exposure_t*.parquet"):
        old.unlink()
    con.execute(f"CREATE OR REPLACE TEMP TABLE _exp AS {exposure_sql(points_glob, pop001.as_posix())}")
    tiles = [r[0] for r in con.execute(f"SELECT DISTINCT {TILE_SQL} FROM _exp ORDER BY 1").fetchall()]
    for t in tiles:
        con.execute(f"""COPY (SELECT * FROM _exp WHERE {TILE_SQL} = {t} ORDER BY cell_id, year, month)
                        TO '{(out_dir / f'exposure_t{t}.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
    rows, last = con.execute("SELECT count(*), max(make_date(year, month, 1)) FROM _exp").fetchone()
    return {"tiles": tiles, "rows": int(rows), "last_month": str(last)[:7]}


if __name__ == "__main__":
    import json
    ap = argparse.ArgumentParser()
    ap.add_argument("--tif", required=True)
    ap.add_argument("--region", default="india")
    a = ap.parse_args()
    w, s, e, n = settings.REGIONS[a.region]["bbox"]
    pop = ROOT / "work" / "pop001.parquet"
    print("pop001:", build_pop001(Path(a.tif), (w - 0.5, s - 0.5, e + 0.5, n + 0.5), pop))
    res = build_exposure(duckdb.connect(), (ROOT / "work" / "points").as_posix() + "/points_*.parquet", pop, ROOT / "data" / "exposure")
    print("exposure:", {k: (v if k != "tiles" else len(v)) for k, v in res.items()})
    meta_path = ROOT / "data" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update(exposure_tiles=res["tiles"], exposure_last_month=res["last_month"],
                population_source="GHS-POP R2023A, epoch 2020, 30 arc-second (about 1 km), JRC")
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
