import duckdb
from pipeline import grid

PTS = [(0.05, 0.05), (31.27, 75.81), (-33.9, 151.2), (23.75, 86.41), (8.08, 77.55)]


def test_cell_id_known():
    assert grid.cell_id(0.05, 0.05) == 900 * 3600 + 1800


def test_cell_id_edges():
    assert grid.cell_id(90, 180) == 1799 * 3600 + 3599
    assert grid.cell_id(-90, -180) == 0
    assert grid.cell001_id(90, 180) == 17999 * 36000 + 35999
    assert grid.region_id(90, 180) == 35 * 72 + 71


def test_center_roundtrip():
    for lat, lon in PTS:
        c = grid.cell_id(lat, lon)
        assert grid.cell_id(*grid.cell_center(c)) == c


def test_sql_matches_python():
    con = duckdb.connect()
    for lat, lon in PTS + [(90.0, 180.0), (-90.0, -180.0)]:
        row = con.execute(
            f"SELECT {grid.CELL_ID_SQL}, {grid.CELL001_SQL}, {grid.REGION_ID_SQL} FROM (SELECT ?::DOUBLE AS lat, ?::DOUBLE AS lon)",
            [lat, lon]).fetchone()
        assert row == (grid.cell_id(lat, lon), grid.cell001_id(lat, lon), grid.region_id(lat, lon))
