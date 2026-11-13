import datetime as dt

import duckdb
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from pipeline import classify, grid

D = dt.date
CELL = (23.755, 86.415)   # the 0.01 deg cell most tests burn in
OTHER = (20.005, 80.005)


@pytest.fixture
def con():
    return duckdb.connect()


def pt(lat, lon, date, satellite="SNPP", conf="n", ftype=0, processing="SP"):
    return (lat, lon, date, satellite, conf, ftype, processing)


def write_stage(con, path, rows):
    """Stage-schema parquet (CONTRACTS 4.1) from (lat, lon, date, satellite, conf, firms_type, processing)."""
    con.execute("CREATE OR REPLACE TEMP TABLE _r (lat DOUBLE, lon DOUBLE, acq_date DATE, satellite VARCHAR, "
                "conf_class VARCHAR, firms_type TINYINT, processing VARCHAR)")
    con.executemany("INSERT INTO _r VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    con.execute(f"""COPY (SELECT lat, lon, acq_date, 1200::SMALLINT AS acq_time,
            CASE WHEN satellite IN ('Terra', 'Aqua') THEN 'MODIS' ELSE 'VIIRS' END AS sensor, satellite,
            conf_class AS confidence_raw, conf_class, 1.5::REAL AS frp, 'D' AS daynight, 330::REAL AS brightness,
            firms_type, processing, '2' AS version,
            {grid.CELL_ID_SQL} AS cell_id, {grid.CELL001_SQL} AS cell001_id, {grid.REGION_ID_SQL} AS region_id
        FROM _r) TO '{path.as_posix()}' (FORMAT parquet)""")


def days(year, months, per_month):
    return [D(year, m, d) for m in months for d in range(1, per_month + 1)]


def december(years):
    """One ordinary fire per year in another cell, so each year counts as complete."""
    return [pt(*OTHER, D(y, 12, 15)) for y in years]


def build_mask(con, tmp_path, rows):
    write_stage(con, tmp_path / "points_all.parquet", rows)
    out = tmp_path / "static_mask.parquet"
    counts = classify.build_static_mask(con, (tmp_path / "points_*.parquet").as_posix(), out)
    got = con.execute(f"SELECT cell001_id, reason, n_days_max FROM read_parquet('{out.as_posix()}')").fetchall()
    return counts, {c: (r, n) for c, r, n in got}


def write_lc(con, path, rows):
    con.execute("CREATE OR REPLACE TEMP TABLE _lc (cell001_id BIGINT, igbp TINYINT)")
    if rows:
        con.executemany("INSERT INTO _lc VALUES (?, ?)", rows)
    con.execute(f"COPY _lc TO '{path.as_posix()}' (FORMAT parquet)")


def write_mask(con, path, rows):
    con.execute("CREATE OR REPLACE TEMP TABLE _m (cell001_id BIGINT, reason VARCHAR, n_days_max INTEGER)")
    if rows:
        con.executemany("INSERT INTO _m VALUES (?, ?, ?)", rows)
    con.execute(f"COPY _m TO '{path.as_posix()}' (FORMAT parquet)")


RULES = (
    [(0, 12, None, 0), (0, 14, None, 0)]
    + [(0, i, None, 1) for i in range(1, 6)]
    + [(0, i, None, 2) for i in range(6, 11)]
    + [(0, 13, None, 4), (0, 11, None, 3), (0, 15, None, 3), (0, 16, None, 3), (0, 17, None, 7)]
    + [(None, 12, None, 0), (None, 13, None, 4), (None, None, None, 7), (0, None, None, 7)]
    + [(None, 12, "persistent", 5), (0, 12, "persistent", 5), (0, 12, "firms_static", 5),
       (None, 12, "firms_static", 5), (0, 17, "persistent", 5), (0, None, "persistent", 5)]
    + [(2, 12, None, 5), (2, 17, None, 5), (2, None, None, 5), (2, 12, "volcano", 6)]
    + [(1, 12, None, 6), (1, 17, None, 6), (1, None, None, 6), (1, 12, "persistent", 6)]
    + [(3, 12, None, 7), (3, 1, None, 7), (3, None, None, 7), (3, 12, "persistent", 7), (3, 12, "volcano", 6)]
    + [(0, 12, "volcano", 6), (None, 12, "volcano", 6)]
)


@pytest.mark.parametrize("ftype,igbp,reason,expected", RULES)
def test_rules_table(con, tmp_path, ftype, igbp, reason, expected):
    c001 = grid.cell001_id(*CELL)
    stage = tmp_path / "stage"
    stage.mkdir()
    write_stage(con, stage / "points_2023.parquet", [pt(*CELL, D(2023, 3, 1), ftype=ftype)])
    write_lc(con, tmp_path / "lc001.parquet", [(c001, igbp)] if igbp is not None else [])
    write_mask(con, tmp_path / "mask.parquet", [(c001, reason, 0)] if reason else [])
    counts = classify.classify_points(con, (stage / "points_*.parquet").as_posix(), tmp_path / "lc001.parquet",
                                      tmp_path / "mask.parquet", tmp_path / "out")
    assert counts == {expected: 1}
    assert con.execute(f"SELECT category, typeof(category) FROM read_parquet('{(tmp_path / 'out' / 'points_2023.parquet').as_posix()}')"
                       ).fetchall() == [(expected, "TINYINT")]


def test_mask_persistence(con, tmp_path):
    both, lowconf, modis = (23.765, 86.415), (23.775, 86.415), (23.785, 86.415)
    rows = []
    for y in (2021, 2022, 2023):
        # 30 distinct days over 6 months, alternating satellites: days are counted over both together
        rows += [pt(*CELL, d, satellite=("SNPP", "NOAA20")[i % 2]) for i, d in enumerate(days(y, range(7, 13), 5))]
        # 30 points but only 15 distinct days (both satellites see the same day)
        rows += [pt(*both, d, satellite=s) for d in days(y, range(7, 13), 5)[::2] for s in ("SNPP", "NOAA20")]
        rows += [pt(*lowconf, d, conf="l") for d in days(y, range(7, 13), 5)]
        rows += [pt(*modis, d, satellite="Aqua") for d in days(y, range(7, 13), 5)]
    counts, mask = build_mask(con, tmp_path, rows)
    assert mask == {grid.cell001_id(*CELL): ("persistent", 30)}
    assert counts == {"volcano": 0, "firms_static": 0, "persistent": 1}


def test_mask_two_years_not_enough(con, tmp_path):
    rows = december([2021, 2022, 2023])
    for y in (2021, 2022):
        rows += [pt(*CELL, d) for d in days(y, range(1, 7), 5)]
    _, mask = build_mask(con, tmp_path, rows)
    assert mask == {}


def test_mask_crop_excluded(con, tmp_path):
    rows = december([2021, 2022, 2023])
    for y in (2021, 2022, 2023):
        rows += [pt(*CELL, d) for d in days(y, (4, 5, 10, 11), 10)]   # 40 days a year, 4 months
    counts, mask = build_mask(con, tmp_path, rows)
    assert mask == {}
    assert sum(counts.values()) == 0


def test_mask_firms_static(con, tmp_path):
    two, volcano = (23.765, 86.415), (23.775, 86.415)
    rows = december([2023])
    # typed rules use every satellite and confidence
    rows += [pt(*CELL, D(2023, 1, d), satellite="Terra", conf="l", ftype=2) for d in (1, 2, 3)]
    rows += [pt(*two, D(2023, 1, d), ftype=2) for d in (1, 2)]
    rows += [pt(*volcano, D(2023, 1, d), ftype=t) for d in (1, 2, 3) for t in (1, 2)]   # volcano wins
    counts, mask = build_mask(con, tmp_path, rows)
    assert {c: r for c, (r, _) in mask.items()} == {grid.cell001_id(*CELL): "firms_static",
                                                    grid.cell001_id(*volcano): "volcano"}
    assert counts == {"volcano": 1, "firms_static": 1, "persistent": 0}


def test_mask_window_is_last_five_complete_years(con, tmp_path):
    old, edge_in, edge_out, latest = (23.765, 86.415), (23.775, 86.415), (23.785, 86.415), (23.795, 86.415)
    rows = december(range(2015, 2024))                      # 2015..2023 complete -> window 2019..2023
    for y in (2015, 2016, 2017):                            # persistence outside the window
        rows += [pt(*old, d) for d in days(y, range(1, 7), 5)]
    rows += [pt(*edge_in, D(2019, 1, d), ftype=2) for d in (1, 2, 3)]
    rows += [pt(*edge_out, D(2018, 12, d), ftype=2) for d in (1, 2, 3)]
    rows += [pt(*latest, D(2024, 6, d), ftype=2) for d in (1, 2, 3)]   # 2024 has no December
    _, mask = build_mask(con, tmp_path, rows)
    assert {c: r for c, (r, _) in mask.items()} == {grid.cell001_id(*edge_in): "firms_static"}


def test_same_mask_sp_nrt(con, tmp_path):
    stage = tmp_path / "stage"
    stage.mkdir()
    rows = december([2023]) + [pt(*CELL, D(2023, 1, d), ftype=2) for d in (1, 2, 3)]
    rows += [pt(*CELL, D(2023, 5, 1), ftype=0, processing="SP"), pt(*CELL, D(2023, 5, 1), ftype=None, processing="NRT")]
    write_stage(con, stage / "points_2023.parquet", rows)
    glob = (stage / "points_*.parquet").as_posix()
    classify.build_static_mask(con, glob, tmp_path / "mask.parquet")
    write_lc(con, tmp_path / "lc001.parquet", [(grid.cell001_id(*CELL), 12), (grid.cell001_id(*OTHER), 12)])
    classify.classify_points(con, glob, tmp_path / "lc001.parquet", tmp_path / "mask.parquet", tmp_path / "out")
    got = con.execute(f"""SELECT processing, firms_type, category FROM read_parquet('{(tmp_path / 'out' / 'points_2023.parquet').as_posix()}')
                          WHERE acq_date = DATE '2023-05-01' ORDER BY processing""").fetchall()
    assert got == [("NRT", None, 5), ("SP", 0, 5)]


def test_no_deletion(con, tmp_path):
    stage = tmp_path / "stage"
    stage.mkdir()
    spots = [CELL, OTHER, (10.005, 77.005), (30.005, 75.005)]
    n_in = {}
    for y in (2022, 2023):
        rows = [pt(*spots[i % 4], D(y, 1 + i % 12, 1 + i % 28), ftype=(0, 1, 2, 3, None)[i % 5],
                   processing=("SP", "NRT")[i % 2]) for i in range(200 + y % 7)]
        rows += rows[:10]   # exact duplicates stay too
        write_stage(con, stage / f"points_{y}.parquet", rows)
        n_in[y] = len(rows)
    write_lc(con, tmp_path / "lc001.parquet", [(grid.cell001_id(*CELL), 12), (grid.cell001_id(*OTHER), 4)])
    write_mask(con, tmp_path / "mask.parquet", [(grid.cell001_id(*OTHER), "persistent", 40)])
    counts = classify.classify_points(con, (stage / "points_*.parquet").as_posix(), tmp_path / "lc001.parquet",
                                      tmp_path / "mask.parquet", tmp_path / "out")
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["points_2022.parquet", "points_2023.parquet"]
    for y, n in n_in.items():
        f = (tmp_path / "out" / f"points_{y}.parquet").as_posix()
        got = con.execute(f"SELECT cell_id, acq_date, category FROM read_parquet('{f}')").fetchall()
        assert len(got) == n
        assert all(c is not None for _, _, c in got)
        assert [g[:2] for g in got] == sorted(g[:2] for g in got)
        stage_cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{(stage / f'points_{y}.parquet').as_posix()}')").fetchall()]
        out_cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{f}')").fetchall()]
        assert out_cols == stage_cols + ["category"]
    assert sum(counts.values()) == sum(n_in.values())


SINU = "+proj=sinu +lon_0=0 +x_0=0 +y_0=0 +R=6371007.181 +units=m +no_defs"


def test_landcover_lookup(con, tmp_path):
    # bbox = 3 x 2 cells of 0.1 deg. Tif A (EPSG:4326, 0.01 deg) covers the west 2 x 2 cells; the NW cell is no data.
    a = np.full((20, 20), 12, dtype="uint8")      # row 0 = north
    a[0:10, 0:10] = 255                           # NW: no data ...
    a[5, 5] = 0                                   # ... in both spellings
    a[10:20, 10:16] = 1                           # SE: 60 forest (IGBP 1), 40 urban
    a[10:20, 16:20] = 13
    a[0:10, 10:13] = 12                           # NE: 30 + 30 crop classes beat 40 of IGBP 2
    a[0:10, 13:16] = 14
    a[0:10, 16:20] = 2
    tif_a = tmp_path / "a.tif"
    with rasterio.open(tif_a, "w", driver="GTiff", height=20, width=20, count=1, dtype="uint8", crs="EPSG:4326",
                       transform=from_origin(10.0, 20.2, 0.01, 0.01), nodata=255) as dst:
        dst.write(a, 1)
    # Tif B (MODIS sinusoidal, all water) overlaps all four west cells: it may only fill A's no-data.
    w, s, e, n = transform_bounds("EPSG:4326", SINU, 9.95, 20.05, 10.15, 20.25)
    tif_b = tmp_path / "b.tif"
    with rasterio.open(tif_b, "w", driver="GTiff", height=60, width=60, count=1, dtype="uint8", crs=SINU,
                       transform=from_origin(w, n, (e - w) / 60, (n - s) / 60), nodata=255) as dst:
        dst.write(np.full((60, 60), 17, dtype="uint8"), 1)

    out001, out_cells = tmp_path / "lc001.parquet", tmp_path / "cells.parquet"
    clip = "POLYGON((9.9 19.9, 10.1 19.9, 10.1 20.3, 9.9 20.3, 9.9 19.9))"   # west column only
    classify.build_landcover_lookup([tif_a, tif_b], (10.0, 20.0, 10.3, 20.2), clip, out001, out_cells)

    assert con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out001.as_posix()}')").fetchall()[0][:2] == ("cell001_id", "BIGINT")
    lc = dict(con.execute(f"SELECT cell001_id, igbp FROM read_parquet('{out001.as_posix()}')").fetchall())
    assert len(lc) == 400 == con.execute(f"SELECT count(*) FROM read_parquet('{out001.as_posix()}')").fetchone()[0]
    expect = {(20.005, 10.005): 12, (20.095, 10.095): 12,            # SW
              (20.005, 10.105): 1, (20.095, 10.155): 1, (20.005, 10.165): 13, (20.095, 10.195): 13,   # SE
              (20.105, 10.105): 12, (20.195, 10.135): 14, (20.105, 10.195): 2,                        # NE
              (20.105, 10.005): 17, (20.145, 10.055): 17, (20.195, 10.095): 17}                       # NW from B
    assert {k: lc.get(grid.cell001_id(*k)) for k in expect} == expect
    assert grid.cell001_id(20.105, 10.205) not in lc                  # east column: no data anywhere

    cells = con.execute(f"SELECT * FROM read_parquet('{out_cells.as_posix()}') ORDER BY cell_id").fetchall()
    types = [r[:2] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{out_cells.as_posix()}')").fetchall()]
    assert types == [("cell_id", "INTEGER"), ("lat_c", "DOUBLE"), ("lon_c", "DOUBLE"),
                     ("lc_class", "TINYINT"), ("in_coverage", "BOOLEAN")]
    assert len(cells) == 6
    got = {c[0]: c for c in cells}
    for (lat, lon), lc_class, cov in [((20.05, 10.05), 0, True), ((20.05, 10.15), 1, False), ((20.05, 10.25), 7, False),
                                      ((20.15, 10.05), 7, True), ((20.15, 10.15), 0, False), ((20.15, 10.25), 7, False)]:
        cid, lat_c, lon_c, cls, in_cov = got[grid.cell_id(lat, lon)]
        assert (lat_c, lon_c) == pytest.approx(grid.cell_center(cid))
        assert (cls, in_cov) == (lc_class, cov)
