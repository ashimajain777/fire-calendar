import duckdb
import pyarrow as pa
import pytest

from pipeline import aggregate, harmonize
from pipeline.tests.test_harmonize import DATES, R, pt, ratios_tbl, write_points

KEYS = "cell_id, year, month, dekad, category"


def build(tmp_path, pts):
    con, rows = duckdb.connect(), ratios_tbl()
    rat = pa.Table.from_pylist(rows)
    harmonize.apply_weights(con, write_points(tmp_path, pts), rat, "noregion", DATES, tmp_path / "points")
    pg = (tmp_path / "points").as_posix() + "/points_*.parquet"
    gaps = aggregate.build_gaps(con, pg, DATES)
    aggregate.build_dekad(con, pg, rat, "noregion", DATES, gaps, tmp_path / "dekad")
    return con, pg, (tmp_path / "dekad").as_posix() + "/dekad_*.parquet", gaps.to_pylist(), rows


def mixed():
    return ([pt("Terra", "2001-03-05"), pt("Aqua", "2005-03-05"), pt("Terra", "2005-03-05"),
             pt("SNPP", "2015-03-05", cat=1), pt("SNPP", "2015-03-06", cat=1), pt("Aqua", "2015-03-06", cat=1)]
            + [pt("NOAA20", f"2020-01-{d:02d}") for d in (2, 12, 22)]
            + [pt("NOAA20", "2020-01-02", conf="l"), pt("NOAA21", "2020-01-02"), pt("NOAA20", "2020-01-02", cat=7),
               pt("SNPP", "2020-01-02", proc="NRT"), pt("NOAA20", "2020-01-03", at=(30.05, 75.05), frp=7.0)])


def test_dekad_split(tmp_path):
    con, _, dg, _, _ = build(tmp_path, [pt("NOAA20", f"2020-01-{d}") for d in (10, 11, 20, 21, 31)])
    assert con.execute(f"SELECT dekad, n_noaa20 FROM read_parquet('{dg}') ORDER BY 1").fetchall() == [
        (1, 1), (2, 2), (3, 2)]


def test_conservation(tmp_path):
    con, pg, dg, _, _ = build(tmp_path, mixed())
    n = con.execute(f"""SELECT sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21 + n_lowconf), sum(n_lowconf),
        sum(n_noaa21), max(processing), max(frp_max) FROM read_parquet('{dg}')""").fetchone()
    assert n == (len(mixed()), 1, 1, 1, 7.0)
    aggregate.check_invariants(con, pg, dg)


def test_harm_equals_weights(tmp_path):
    con, pg, dg, _, _ = build(tmp_path, mixed())
    rows = con.execute(f"""
        SELECT d.harm_n, p.w, d.harm_n_lo, p.lo, d.harm_n_hi, p.hi, d.harm_from, d.year FROM read_parquet('{dg}') d
        JOIN (SELECT cell_id, year(acq_date) AS year, month(acq_date) AS month,
                     CASE WHEN day(acq_date) <= 10 THEN 1 WHEN day(acq_date) <= 20 THEN 2 ELSE 3 END AS dekad,
                     category, sum(harm_weight) AS w, sum(harm_weight_lo) AS lo, sum(harm_weight_hi) AS hi
              FROM read_parquet('{pg}') GROUP BY ALL) p USING ({KEYS})""").fetchall()
    assert len(rows) == con.execute(f"SELECT count(*) FROM read_parquet('{dg}')").fetchone()[0]
    for x in rows:
        assert x[0:6:2] == pytest.approx(x[1:6:2], rel=1e-6)
    assert {(x[7], x[6]) for x in rows} == {(2001, 4), (2005, 2), (2015, 1), (2020, 0)}
    assert sum(x[0] for x in rows) > 3
    aggregate.check_invariants(con, pg, dg)


def test_fire_days(tmp_path):
    con, _, dg, _, rows = build(tmp_path, [
        pt("NOAA20", "2020-01-02"), pt("NOAA20", "2020-01-02"), pt("NOAA20", "2020-01-03"),
        pt("SNPP", "2015-05-02", cat=1), pt("SNPP", "2015-05-02", cat=1), pt("SNPP", "2015-05-03", cat=1),
        pt("Aqua", "2015-05-04", cat=1), pt("SNPP", "2015-05-05", cat=1, conf="l")])
    out = con.execute(f"SELECT fd_base, harm_fd, harm_fd_lo, harm_fd_hi FROM read_parquet('{dg}') ORDER BY year").fetchall()
    s = [R(rows, "snpp_noaa20", 1, 5, c, "fd") for c in ("r", "r_lo", "r_hi")]
    assert out[1] == (2, 2.0, 2.0, 2.0)
    assert out[0][0] == 2 and out[0][1:] == pytest.approx([2 * v for v in s], rel=1e-6)


def gap_points():
    return ([pt("NOAA20", "2020-01-05"), pt("NOAA20", "2020-01-25"), pt("NOAA20", "2020-01-15", conf="l")]
            + [pt("SNPP", "2020-01-15") for _ in range(3)] + [pt("SNPP", "2020-01-05")])


def test_gap_fill(tmp_path):
    con, pg, dg, gaps, rows = build(tmp_path, gap_points())
    assert gaps == [dict(year=2020, month=1, dekad=2, chain_satellite="NOAA20", filled_from="SNPP")]
    out = con.execute(f"""SELECT dekad, harm_from, harm_n, harm_n_lo, fd_base, harm_fd, n_snpp
        FROM read_parquet('{dg}') ORDER BY dekad""").fetchall()
    s, s_lo, s_fd = (R(rows, "snpp_noaa20", 0, 1, c, m) for c, m in (("r", "n"), ("r_lo", "n"), ("r", "fd")))
    assert out[1] == (2, 3, pytest.approx(3 * s, rel=1e-6), pytest.approx(3 * s_lo, rel=1e-6), 1,
                      pytest.approx(s_fd, rel=1e-6), 3)
    assert out[0] == (1, 0, 1.0, 1.0, 1, 1.0, 1) and out[2][:3] == (3, 0, 1.0)
    aggregate.check_invariants(con, pg, dg)


def test_gap_unfilled_listed(tmp_path):
    _, _, _, gaps, _ = build(tmp_path, [pt("NOAA20", "2020-01-05"), pt("NOAA21", "2020-01-15"),
                                        pt("NOAA20", "2020-02-25"), pt("Terra", "2001-01-01"),
                                        pt("Aqua", "2001-01-15"), pt("Terra", "2001-01-25")])
    assert [(g["year"], g["month"], g["dekad"], g["chain_satellite"], g["filled_from"]) for g in gaps
            if g["year"] == 2020] == [(2020, 1, d, "NOAA20", None) for d in (2, 3)] + [
                (2020, 2, d, "NOAA20", None) for d in (1, 2)]
    assert [(g["month"], g["dekad"], g["chain_satellite"], g["filled_from"]) for g in gaps
            if g["year"] == 2001][0] == (1, 2, "Terra", "Aqua")


def test_invariant_raises(tmp_path):
    con, pg, dg, _, _ = build(tmp_path, mixed())
    f = (tmp_path / "dekad" / "dekad_2020.parquet").as_posix()
    con.execute(f"CREATE TABLE t AS SELECT * FROM read_parquet('{f}') ORDER BY n_noaa20 DESC OFFSET 1")
    con.execute(f"COPY t TO '{f}' (FORMAT parquet)")
    with pytest.raises(aggregate.InvariantError) as e:
        aggregate.check_invariants(con, pg, dg)
    assert str(e.value) == "conservation"


def test_invariant_duplicates_and_date_range(tmp_path):
    con, pg, dg, _, _ = build(tmp_path, mixed())
    f = (tmp_path / "points" / "points_2020.parquet").as_posix()
    con.execute(f"CREATE TABLE t AS SELECT * FROM read_parquet('{f}')")
    con.execute(f"COPY (SELECT * FROM t UNION ALL (SELECT * FROM t LIMIT 1)) TO '{f}' (FORMAT parquet)")
    with pytest.raises(aggregate.InvariantError, match="duplicates"):
        aggregate.check_invariants(con, pg, dg)
    con.execute(f"COPY (SELECT * REPLACE ((acq_date - INTERVAL 400 DAY)::DATE AS acq_date) FROM t) TO '{f}' (FORMAT parquet)")
    with pytest.raises(aggregate.InvariantError, match="date_range"):
        aggregate.check_invariants(con, pg, dg)
