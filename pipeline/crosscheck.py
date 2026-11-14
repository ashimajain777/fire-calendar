"""Independent totals for bounding boxes, computed in Python/DuckDB from the published files,
to compare with what the browser app shows. Uses the same cell snapping as web/cells.js:
a cell is in the area when its centre is inside the box and the cell is in coverage.

python -m pipeline.crosscheck [--random 5] [--seed 1]  -> prints JSON
"""
import argparse
import json
import random

import duckdb

from pipeline import settings

ROOT = settings.ROOT
AREAS = {  # the walkthrough areas from PLAN F5; used only as test inputs, never in app code
    "punjab_haryana": (73.8, 29.5, 77.5, 32.5),
    "uttarakhand": (77.5, 28.7, 81.1, 31.5),
    "jharia": (86.1, 23.6, 86.5, 23.9),
}


def dekad_files() -> list[str]:
    files = sorted((ROOT / "data" / "dekad").glob("dekad_*.parquet"))
    cur = sorted((ROOT / "work" / "release").glob("dekad_*.parquet"))  # the published current-year file
    have = {f.name for f in files}
    return [f.as_posix() for f in files] + [f.as_posix() for f in cur if f.name not in have]


def totals(con, bbox) -> dict:
    w, s, e, n = bbox
    files = dekad_files()
    cells = (ROOT / "data" / "cells.parquet").as_posix()
    q = f"""
      WITH a AS (SELECT cell_id FROM '{cells}' WHERE in_coverage
                 AND lat_c >= {s} AND lat_c <= {n} AND lon_c >= {w} AND lon_c <= {e})
      SELECT (SELECT count(*) FROM a) AS cells,
             sum(harm_n) FILTER (category IN (0,1,2,3)) AS harm_landscape,
             sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21) FILTER (category IN (0,1,2,3)) AS raw_landscape,
             sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21 + n_lowconf) AS points_all
      FROM read_parquet({files}) d WHERE cell_id IN (SELECT cell_id FROM a)"""
    r = con.execute(q).fetchone()
    top = con.execute(f"""
      WITH a AS (SELECT cell_id FROM '{cells}' WHERE in_coverage
                 AND lat_c >= {s} AND lat_c <= {n} AND lon_c >= {w} AND lon_c <= {e})
      SELECT year, month, sum(harm_n) v FROM read_parquet({files})
      WHERE cell_id IN (SELECT cell_id FROM a) AND category IN (0,1,2,3)
      GROUP BY 1, 2 ORDER BY v DESC LIMIT 1""").fetchone()
    return {"bbox": bbox, "cells": r[0], "harm_landscape": round(r[1] or 0, 1),
            "raw_landscape": int(r[2] or 0), "points_all": int(r[3] or 0),
            "top_month": [top[0], top[1], round(top[2], 1)] if top else None}


def random_boxes(con, k: int, seed: int) -> dict:
    """k random 1-degree boxes whose centre cell is in coverage (chosen from the data, not typed in)."""
    cells = (ROOT / "data" / "cells.parquet").as_posix()
    cands = con.execute(f"""SELECT DISTINCT floor(lon_c) AS w, floor(lat_c) AS s FROM '{cells}' WHERE in_coverage
                            ORDER BY 1, 2""").fetchall()
    rnd = random.Random(seed)
    return {f"box_{int(w)}_{int(s)}": (w, s, w + 1, s + 1) for w, s in rnd.sample(cands, k)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, default=5)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    con = duckdb.connect()
    areas = {**AREAS, **random_boxes(con, a.random, a.seed)}
    print(json.dumps({name: totals(con, b) for name, b in areas.items()}, indent=1))
