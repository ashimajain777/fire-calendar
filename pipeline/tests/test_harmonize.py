import itertools
from datetime import date

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import grid, harmonize, settings

A = (20.05, 78.05)   # two different 5 degree boxes
B = (30.05, 75.05)
DATES = {"aqua_start": date(2002, 8, 1), "snpp_start": date(2012, 2, 1), "noaa20_start": date(2018, 1, 1)}
SCHEMA = pa.schema([
    ("lat", pa.float64()), ("lon", pa.float64()), ("acq_date", pa.date32()), ("acq_time", pa.int16()),
    ("sensor", pa.string()), ("satellite", pa.string()), ("confidence_raw", pa.string()),
    ("conf_class", pa.string()), ("frp", pa.float32()), ("daynight", pa.string()),
    ("brightness", pa.float32()), ("firms_type", pa.int8()), ("processing", pa.string()),
    ("version", pa.string()), ("cell_id", pa.int32()), ("cell001_id", pa.int64()),
    ("region_id", pa.int32()), ("category", pa.int8())])
_time = itertools.count()


def pt(sat, d, cat=0, conf="n", at=A, frp=1.0, proc="SP"):
    lat, lon = at
    return dict(lat=lat, lon=lon, acq_date=date.fromisoformat(d), acq_time=next(_time) % 30000,
                sensor="MODIS" if sat in ("Terra", "Aqua") else "VIIRS", satellite=sat,
                confidence_raw=conf, conf_class=conf, frp=frp, daynight="D", brightness=330.0,
                firms_type=0, processing=proc, version="t", cell_id=grid.cell_id(lat, lon),
                cell001_id=grid.cell001_id(lat, lon), region_id=grid.region_id(lat, lon), category=cat)


def write_points(tmp_path, pts):
    d = tmp_path / "classified"
    d.mkdir(exist_ok=True)
    for y in {p["acq_date"].year for p in pts}:
        rows = [p for p in pts if p["acq_date"].year == y]
        pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), d / f"points_{y}.parquet")
    return str(d / "points_*.parquet")


def ratios_tbl(variant="noregion", regions=(-1,)):
    """Hand-built ratios: a different value for every link, metric, stratum and month."""
    rows = []
    for metric, k in (("n", 1.0), ("fd", 0.5)):
        for link, base in (("terra_aqua", 1.2), ("aqua_snpp", 3.0), ("snpp_noaa20", 0.9)):
            for reg, s, m in itertools.product(regions, range(6), range(1, 13)):
                r = k * (base + s * 0.1 + m * 0.01)
                rows.append(dict(variant=variant, link=link, metric=metric, region_id=reg, stratum=s, month=m,
                                 r=r, r_lo=r * 0.8, r_hi=r * 1.3, n_years=5, n_detections=1000, fallback="none"))
    return rows


def R(rows, link, s, m, col="r", metric="n"):
    return next(x[col] for x in rows if (x["link"], x["stratum"], x["month"], x["metric"]) == (link, s, m, metric))


def fit(tmp_path, pts, link="aqua_snpp", years=range(2012, 2014), metric="n", variant="noregion"):
    con = duckdb.connect()
    t = harmonize.fit_ratios(con, write_points(tmp_path, pts), link, years, metric, variant)
    return {(x["region_id"], x["stratum"], x["month"]): x for x in t.to_pylist()}, t


def weigh(tmp_path, pts, rows=None, variant="noregion"):
    con = duckdb.connect()
    rows = rows or ratios_tbl(variant)
    harmonize.apply_weights(con, write_points(tmp_path, pts), pa.Table.from_pylist(rows), variant, DATES,
                            tmp_path / "points")
    out = con.execute(f"""SELECT satellite, acq_date, in_baseline_chain, harm_weight, harm_weight_lo, harm_weight_hi
        FROM read_parquet('{(tmp_path / "points").as_posix()}/points_*.parquet') ORDER BY acq_time""").fetchall()
    return out, rows


def two_years():
    return ([]
            + [pt("Aqua", "2012-01-05") for _ in range(10)] + [pt("SNPP", "2012-01-05") for _ in range(30)]
            + [pt("Aqua", "2013-01-05") for _ in range(20)] + [pt("SNPP", "2013-01-05") for _ in range(50)])


def thin_data():
    day = lambda i: f"{1 + i % 28:02d}"
    return ([pt("Aqua", f"2012-01-{day(i)}", at=B) for i in range(100)]
            + [pt("SNPP", f"2012-01-{day(i)}", at=B) for i in range(300)]
            + [pt("Aqua", "2012-01-05") for _ in range(4)] + [pt("SNPP", "2012-01-05") for _ in range(8)]
            + [pt("Aqua", "2012-02-05") for _ in range(2)] + [pt("SNPP", "2012-02-05") for _ in range(2)])


def test_ratio_of_totals(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MIN_DETECTIONS", 1)
    row = fit(tmp_path, two_years())[0][(-1, 0, 1)]
    assert row["r"] == pytest.approx(80 / 30)
    assert row["r_lo"] == pytest.approx(np.percentile([3.0, 2.5], 10))
    assert row["r_hi"] == pytest.approx(np.percentile([3.0, 2.5], 90))
    assert (row["fallback"], row["n_years"], row["n_detections"]) == ("none", 2, 110)


def test_fallback_ladder_region(tmp_path):
    rows, _ = fit(tmp_path, thin_data(), variant="region")
    ra, rb = grid.region_id(*A), grid.region_id(*B)
    assert (rows[(rb, 0, 1)]["fallback"], rows[(rb, 0, 1)]["r"]) == ("none", pytest.approx(3.0))
    x = rows[(ra, 0, 1)]
    assert (x["fallback"], x["r"], x["n_detections"]) == ("india", pytest.approx(308 / 104), 412)
    assert x["r_lo"] == x["r_hi"] == x["r"]          # one fit year with data
    x = rows[(ra, 0, 2)]
    assert (x["fallback"], x["r"], x["n_detections"]) == ("stratum", pytest.approx(310 / 106), 416)
    for key in ((ra, 1, 3), (rb, 5, 1)):
        assert (rows[key]["fallback"], rows[key]["r"]) == ("landscape", pytest.approx(310 / 106))


def test_fallback_noregion(tmp_path):
    rows, _ = fit(tmp_path, thin_data())
    assert {k[0] for k in rows} == {-1}
    assert (rows[(-1, 0, 1)]["fallback"], rows[(-1, 0, 1)]["r"]) == ("none", pytest.approx(308 / 104))
    assert (rows[(-1, 0, 2)]["fallback"], rows[(-1, 0, 2)]["r"]) == ("stratum", pytest.approx(310 / 106))
    assert (rows[(-1, 1, 3)]["fallback"], rows[(-1, 1, 3)]["r"]) == ("landscape", pytest.approx(310 / 106))


def test_every_key_has_row(tmp_path):
    for variant, regions in (("region", {grid.region_id(*A), grid.region_id(*B)}), ("noregion", {-1})):
        rows, t = fit(tmp_path, thin_data(), variant=variant)
        assert set(rows) == set(itertools.product(regions, range(6), range(1, 13)))
        assert t.num_rows == len(rows)
        assert all(x["r"] is not None for x in rows.values())
        assert t.column_names == ["variant", "link", "metric", "region_id", "stratum", "month",
                                  "r", "r_lo", "r_hi", "n_years", "n_detections", "fallback"]


def test_fd_metric(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MIN_DETECTIONS", 1)
    pts = ([pt("Aqua", "2012-01-05") for _ in range(3)] + [pt("Aqua", "2012-01-06")]
           + [pt("SNPP", "2012-01-05") for _ in range(5)] + [pt("SNPP", "2012-01-05", at=(20.25, 78.05))]
           + [pt("SNPP", "2012-01-07")])
    row = fit(tmp_path, pts, metric="fd")[0][(-1, 0, 1)]
    assert (row["r"], row["n_detections"]) == (pytest.approx(3 / 2), 5)


def test_chain_dates_first_full_month(tmp_path):
    pts = [pt("Terra", "2000-11-01"), pt("Aqua", "2002-12-20"), pt("SNPP", "2012-01-20"),
           pt("NOAA20", "2018-01-03"), pt("NOAA20", "2018-02-01")]
    assert harmonize.chain_dates(duckdb.connect(), write_points(tmp_path, pts)) == {
        "aqua_start": date(2003, 1, 1), "snpp_start": date(2012, 2, 1), "noaa20_start": date(2018, 1, 1)}


def test_chain_weight(tmp_path):
    out, rows = weigh(tmp_path, [pt("Terra", "2001-05-10", cat=1), pt("Aqua", "2005-05-10", cat=1),
                                 pt("SNPP", "2015-05-10", cat=1), pt("NOAA20", "2020-05-10", cat=1)])
    for sfx, col in (("", 3), ("_lo", 4), ("_hi", 5)):
        t, r, s = (R(rows, link, 1, 5, "r" + sfx) for link in ("terra_aqua", "aqua_snpp", "snpp_noaa20"))
        assert [x[col] for x in out] == pytest.approx([t * r * s, r * s, s, 1.0], rel=1e-6)
    assert all(x[2] for x in out)


def test_missing_region_uses_landscape(tmp_path):
    rows = ratios_tbl("region", regions=(999,))
    for x in rows:
        if (x["stratum"], x["month"]) == (3, 7):
            x["fallback"] = "landscape"
    out, _ = weigh(tmp_path, [pt("SNPP", "2015-05-10", cat=1)], rows, "region")
    assert out[0][2] and out[0][3] == pytest.approx(R(rows, "snpp_noaa20", 3, 7), rel=1e-6)


def test_offchain_zero(tmp_path):
    out, _ = weigh(tmp_path, [pt("Terra", "2005-05-10"), pt("NOAA21", "2024-05-10"), pt("SNPP", "2019-05-10"),
                              pt("Aqua", "2012-02-01"), pt("SNPP", "2012-01-25")])
    assert [x[2:] for x in out] == [(False, 0.0, 0.0, 0.0)] * 5


def test_lowconf_zero(tmp_path):
    out, _ = weigh(tmp_path, [pt("NOAA20", "2020-05-10", conf="l")])
    assert out[0][2:] == (False, 0.0, 0.0, 0.0)


def test_volcanic_zero(tmp_path):
    out, _ = weigh(tmp_path, [pt("NOAA20", "2020-05-10", cat=6), pt("NOAA20", "2020-05-10", cat=7)])
    assert [x[2:] for x in out] == [(False, 0.0, 0.0, 0.0)] * 2


def test_exclude_year(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MIN_DETECTIONS", 1)
    con, glob = duckdb.connect(), write_points(tmp_path, two_years())
    pick = lambda t: [x["r"] for x in t.to_pylist() if (x["link"], x["metric"], x["variant"], x["stratum"],
                                                         x["month"]) == ("aqua_snpp", "n", "noregion", 0, 1)]
    full = harmonize.fit_all(con, glob)
    assert pick(full) == pytest.approx([80 / 30])
    assert pick(harmonize.fit_all(con, glob, exclude_year=2013)) == pytest.approx([3.0])
    assert pick(harmonize.fit_all(con, glob, exclude_year=2012)) == pytest.approx([2.5])
    combos = {(x["link"], x["metric"], x["variant"]) for x in full.to_pylist()}
    assert len(combos) == 12
