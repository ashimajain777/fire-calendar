"""Land cover lookup, static-source mask, point classification. See docs/CONTRACTS.md sections 2, 4.3, 5."""
import glob as globmod
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT

from pipeline.settings import (CATEGORY, MASK_MIN_DAYS, MASK_MIN_MONTHS, MASK_MIN_TYPED, MASK_MIN_YEARS,
                               MASK_WINDOW_YEARS)

_C = CATEGORY
# CONTRACTS section 2: IGBP -> category, over a column named igbp (NULL = no land cover)
IGBP_CATEGORY_SQL = (f"(CASE WHEN igbp IN (12, 14) THEN {_C['agricultural']} WHEN igbp BETWEEN 1 AND 5 THEN {_C['forest']} "
                     f"WHEN igbp BETWEEN 6 AND 10 THEN {_C['grass_shrub']} WHEN igbp = 13 THEN {_C['urban']} "
                     f"WHEN igbp IS NULL OR igbp = 17 THEN {_C['offshore']} ELSE {_C['other_veg']} END)")
REASONS = ("volcano", "firms_static", "persistent")   # precedence order


def _q(path) -> str:
    return "'" + Path(path).as_posix().replace("'", "''") + "'"


def build_landcover_lookup(tifs: list[Path], bbox: tuple, clip_wkt: str, out001: Path, out_cells: Path) -> None:
    w, s, e, n = bbox
    width, height = round((e - w) * 100), round((n - s) * 100)
    grid001 = np.zeros((height, width), dtype="uint8")   # 0 = no data yet
    for tif in tifs:
        with rasterio.open(tif) as src:
            nodata = 255 if src.nodata is None else src.nodata
            # mode = majority source class per 0.01 deg cell; no-data pixels are left out of the vote
            with WarpedVRT(src, crs="EPSG:4326", transform=from_origin(w, n, 0.01, 0.01), width=width, height=height,
                           resampling=Resampling.mode, src_nodata=nodata, nodata=nodata) as vrt:
                arr = vrt.read(1)
        fill = (grid001 == 0) & (arr >= 1) & (arr <= 17)
        grid001[fill] = arr[fill]

    rows, cols = np.nonzero(grid001)
    iy = np.minimum(round((s + 90) * 100) + (height - 1 - rows), 17999).astype("int64")
    ix = np.minimum(round((w + 180) * 100) + cols, 35999).astype("int64")
    lc = pa.table({"cell001_id": iy * 36000 + ix, "igbp": grid001[rows, cols].astype("int8")})

    con = duckdb.connect()
    con.execute("INSTALL spatial")
    con.execute("LOAD spatial")
    con.register("lc", lc)
    for p in (out001, out_cells):
        Path(p).parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY (SELECT cell001_id, igbp FROM lc ORDER BY cell001_id) TO {_q(out001)} (FORMAT parquet, COMPRESSION zstd)")
    y0, y1, x0, x1 = round((s + 90) * 10), round((n + 90) * 10), round((w + 180) * 10), round((e + 180) * 10)
    con.execute(f"""COPY (
        WITH votes AS (
            SELECT ((cell001_id // 36000) // 10) * 3600 + (cell001_id % 36000) // 10 AS cell_id,
                   {IGBP_CATEGORY_SQL} AS cat, count(*) AS n
            FROM lc GROUP BY 1, 2),
        top AS (SELECT cell_id, arg_max(cat, n * 10 - cat) AS cat FROM votes GROUP BY 1),  -- ties: lowest code
        cells AS (
            SELECT (y * 3600 + x)::INTEGER AS cell_id, y / 10.0 - 90 + 0.05 AS lat_c, x / 10.0 - 180 + 0.05 AS lon_c
            FROM range({y0}, {y1}) ty(y), range({x0}, {x1}) tx(x))
        SELECT c.cell_id, c.lat_c, c.lon_c, coalesce(t.cat, {_C['offshore']})::TINYINT AS lc_class,
               ST_Within(ST_Point(c.lon_c, c.lat_c), ST_GeomFromText(?)) AS in_coverage
        FROM cells c LEFT JOIN top t USING (cell_id) ORDER BY c.cell_id
    ) TO {_q(out_cells)} (FORMAT parquet, COMPRESSION zstd)""", [clip_wkt])
    con.close()


def build_static_mask(con, stage_glob: str, out: Path) -> dict[str, int]:
    src = f"read_parquet({_q(stage_glob)})"
    # a year is complete when it has data in December; the window is the latest complete years
    years = [r[0] for r in con.execute(
        f"SELECT DISTINCT year(acq_date) AS y FROM {src} WHERE month(acq_date) = 12 ORDER BY y DESC LIMIT {MASK_WINDOW_YEARS}"
    ).fetchall()]
    in_window = f"year(acq_date) IN ({', '.join(map(str, years))})" if years else "false"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    # n_days_max = most distinct VIIRS (SNPP + NOAA20, n/h) fire days in one window year; 0 for typed-only cells
    con.execute(f"""COPY (
        WITH p AS (SELECT cell001_id, acq_date, satellite, conf_class, firms_type FROM {src} WHERE {in_window}),
        typed AS (
            SELECT cell001_id, count(*) FILTER (firms_type = 1) AS n1, count(*) FILTER (firms_type = 2) AS n2
            FROM p WHERE firms_type IN (1, 2) GROUP BY 1),
        cy AS (
            SELECT cell001_id, count(DISTINCT acq_date) AS nd, count(DISTINCT month(acq_date)) AS nm
            FROM p WHERE satellite IN ('SNPP', 'NOAA20') AND conf_class <> 'l' GROUP BY cell001_id, year(acq_date)),
        pers AS (
            SELECT cell001_id, count(*) FILTER (nd >= {MASK_MIN_DAYS}) AS ny, max(nm) AS nm, max(nd) AS nd
            FROM cy GROUP BY 1),
        j AS (
            SELECT cell001_id,
                   CASE WHEN coalesce(n1, 0) >= {MASK_MIN_TYPED} THEN 'volcano'
                        WHEN coalesce(n2, 0) >= {MASK_MIN_TYPED} THEN 'firms_static'
                        WHEN coalesce(ny, 0) >= {MASK_MIN_YEARS} AND nm >= {MASK_MIN_MONTHS} THEN 'persistent' END AS reason,
                   coalesce(nd, 0)::INTEGER AS n_days_max
            FROM typed FULL JOIN pers USING (cell001_id))
        SELECT cell001_id, reason, n_days_max FROM j WHERE reason IS NOT NULL ORDER BY cell001_id
    ) TO {_q(out)} (FORMAT parquet, COMPRESSION zstd)""")
    counts = dict.fromkeys(REASONS, 0)
    counts.update(con.execute(f"SELECT reason, count(*) FROM read_parquet({_q(out)}) GROUP BY 1").fetchall())
    return counts


def classify_points(con, stage_glob: str, lc001: Path, mask: Path, out_dir: Path) -> dict[int, int]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[int, int] = {}
    for f in sorted(globmod.glob(stage_glob)):
        out = out_dir / Path(f).name
        con.execute(f"""COPY (
            SELECT p.*, (CASE WHEN p.firms_type = 1 OR m.reason = 'volcano' THEN {_C['volcanic']}
                              WHEN p.firms_type = 3 THEN {_C['offshore']}
                              WHEN p.firms_type = 2 OR m.reason IN ('firms_static', 'persistent') THEN {_C['industrial']}
                              ELSE {IGBP_CATEGORY_SQL} END)::TINYINT AS category
            FROM read_parquet({_q(f)}) p
            LEFT JOIN read_parquet({_q(lc001)}) l ON l.cell001_id = p.cell001_id
            LEFT JOIN read_parquet({_q(mask)}) m ON m.cell001_id = p.cell001_id
            ORDER BY p.cell_id, p.acq_date
        ) TO {_q(out)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
        n_in = con.execute(f"SELECT count(*) FROM read_parquet({_q(f)})").fetchone()[0]
        got = con.execute(f"SELECT category, count(*) FROM read_parquet({_q(out)}) GROUP BY 1").fetchall()
        if sum(n for _, n in got) != n_in:   # a duplicated cell001_id in lc001 or the mask would multiply rows
            raise ValueError(f"{out.name}: {sum(n for _, n in got)} rows out, {n_in} rows in")
        for cat, n in got:
            counts[cat] = counts.get(cat, 0) + n
    return counts
