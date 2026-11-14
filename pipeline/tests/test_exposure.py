import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import exposure, grid


def _points(tmp_path, rows):
    t = pa.table({
        "acq_date": pa.array([r[0] for r in rows], pa.date32()),
        "cell001_id": pa.array([grid.cell001_id(r[1], r[2]) for r in rows], pa.int64()),
        "in_baseline_chain": [r[3] for r in rows], "category": pa.array([r[4] for r in rows], pa.int8()),
    })
    p = tmp_path / "points_2020.parquet"
    pq.write_table(t, p)
    return p.as_posix()


def _pop(tmp_path, cells):
    p = tmp_path / "pop.parquet"
    pq.write_table(pa.table({"cell001_id": pa.array([c for c, _ in cells], pa.int64()), "pop": pa.array([v for _, v in cells], pa.float32())}), p)
    return p.as_posix()


def test_neighbourhood_counts_each_person_once_per_month(tmp_path):
    import datetime as dt
    d = dt.date(2020, 3, 5)
    a = grid.cell001_id(30.005, 75.005)
    # two fires in neighbouring 0.01-degree cells the same month: their 3x3 neighbourhoods overlap
    pts = _points(tmp_path, [(d, 30.005, 75.005, True, 0), (d, 30.005, 75.015, True, 1),
                             (d, 30.005, 75.005, False, 0),            # off-chain: ignored
                             (d, 31.5, 76.5, True, 5)])                # industrial: ignored
    near = [a + dr * 36000 + dc for dr in (-1, 0, 1) for dc in (-1, 0, 1, 2)]  # union of both neighbourhoods: 12 cells
    far = grid.cell001_id(30.5, 75.5)
    pop = _pop(tmp_path, [(c, 10.0) for c in near] + [(far, 1000.0)])
    rows = duckdb.connect().execute(f"SELECT year, month, sum(exposed_pop) FROM ({exposure.exposure_sql(pts, pop)}) GROUP BY 1, 2").fetchall()
    assert rows == [(2020, 3, 120.0)]   # 12 cells x 10 people, each counted once; the far cell is not exposed


def test_exposure_is_summed_into_the_persons_own_01_cell(tmp_path):
    import datetime as dt
    d = dt.date(2020, 3, 5)
    # a fire at the edge of a 0.1 cell exposes people in the neighbouring 0.1 cell too
    pts = _points(tmp_path, [(d, 30.095, 75.005, True, 0)])
    inside = grid.cell001_id(30.095, 75.005)
    across = grid.cell001_id(30.105, 75.005)
    pop = _pop(tmp_path, [(inside, 5.0), (across, 7.0)])
    rows = dict(duckdb.connect().execute(f"SELECT cell_id, exposed_pop FROM ({exposure.exposure_sql(pts, pop)})").fetchall())
    assert rows == {grid.cell_id(30.095, 75.005): 5.0, grid.cell_id(30.105, 75.005): 7.0}
