"""Tests for pipeline.validate on tiny hand-built frames (no real data)."""
import datetime as dt
import sys
import types

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import validate


@pytest.fixture
def con():
    c = duckdb.connect()
    yield c
    c.close()


# ---------- helpers ----------

def write_dekad(tmp_path, yearly):
    """yearly: {year: (n_aqua, harm_n)}; one landscape row per year plus a non-landscape row to be ignored."""
    rows = []
    for year, (naive, harm) in yearly.items():
        rows.append(dict(cell_id=1, year=year, month=3, dekad=1, category=0, n_terra=0, n_aqua=naive, n_snpp=0,
                         n_noaa20=0, n_noaa21=0, harm_n=float(harm), harm_n_lo=harm * 0.9, harm_n_hi=harm * 1.1))
        rows.append(dict(cell_id=1, year=year, month=3, dekad=1, category=5, n_terra=999, n_aqua=999, n_snpp=999,
                         n_noaa20=999, n_noaa21=999, harm_n=999.0, harm_n_lo=999.0, harm_n_hi=999.0))
    pq.write_table(pa.Table.from_pylist(rows), tmp_path / "dekad_all.parquet")
    return str(tmp_path / "dekad_*.parquet")


def point(year, satellite, n=1, month=1, lat=20.5, lon=78.5, category=0, conf="n"):
    return [dict(lat=lat, lon=lon, acq_date=dt.date(year, month, 1 + i % 28), satellite=satellite, conf_class=conf,
                 cell_id=int((lat + 90) * 10) * 3600 + int((lon + 180) * 10),
                 region_id=int((lat + 90) // 5) * 72 + int((lon + 180) // 5), category=category) for i in range(n)]


def write_points(tmp_path, rows):
    pq.write_table(pa.Table.from_pylist(rows), tmp_path / "points_all.parquet")
    return str(tmp_path / "points_*.parquet")


@pytest.fixture
def fake_harmonize(monkeypatch):
    """Fake pipeline.harmonize: constant ratio 3 (band 2..4); records the fit_years of every call."""
    fake = types.ModuleType("pipeline.harmonize")
    fake.calls = []

    def fit_ratios(con, glob, link, fit_years, metric, variant):
        fake.calls.append(list(fit_years))
        regions = [-1] if variant == "noregion" else [r[0] for r in con.execute(
            f"select distinct region_id from read_parquet('{glob}')").fetchall()]
        rows = [dict(variant=variant, link=link, metric=metric, region_id=g, stratum=s, month=m, r=3.0, r_lo=2.0,
                     r_hi=4.0, n_years=len(fake.calls[-1]), n_detections=1000, fallback="none")
                for g in regions for s in range(6) for m in range(1, 13)]
        return pa.Table.from_pylist(rows)

    fake.fit_ratios = fit_ratios
    monkeypatch.setitem(sys.modules, "pipeline.harmonize", fake)
    return fake


def loyo_table(observed, predicted, lo, hi, unit_type="region_month", units=None):
    n = len(observed)
    return pa.table({
        "variant": ["region"] * n, "link": ["aqua_snpp"] * n, "metric": ["n"] * n,
        "held_year": pa.array([2015] * n, pa.int16()), "unit_type": [unit_type] * n,
        "unit": units or [str(i + 1) for i in range(n)],
        "observed": [float(x) for x in observed], "predicted": [float(x) for x in predicted],
        "lo": [float(x) for x in lo], "hi": [float(x) for x in hi]})


def summary_for(mdapes, coverages):
    """{variant: [mdape per link]}, {variant: [coverage per link]} -> choose_variant input."""
    links = ["terra_aqua", "aqua_snpp", "snpp_noaa20"]
    return {v: {link: {"region_month": {"mdape": m, "bias": 0.0, "coverage": c, "n": 10}}
                for link, m, c in zip(links, mdapes[v], coverages[v])} for v in mdapes}


# ---------- step statistics ----------

def test_step_flat(con, tmp_path):
    glob = write_dekad(tmp_path, {y: (50, 100) for y in range(2003, 2026)})
    s = validate.step_stats(con, glob)
    assert s["harm_step"] == pytest.approx(1.0)
    assert s["naive_step"] == pytest.approx(1.0)


def test_step_detects_jump(con, tmp_path):
    glob = write_dekad(tmp_path, {y: (50 if y < 2012 else 100, 100) for y in range(2003, 2026)})
    s = validate.step_stats(con, glob)
    assert s["naive_step"] == pytest.approx(2.0)
    assert s["harm_step"] == pytest.approx(1.0)


def test_yoy_excludes_2011_2012(con, tmp_path):
    glob = write_dekad(tmp_path, {y: (50, 100 if y < 2012 else 1000) for y in range(2003, 2026)})
    s = validate.step_stats(con, glob)
    assert s["yoy_p10"] == pytest.approx(1.0)
    assert s["yoy_p90"] == pytest.approx(1.0)
    assert s["harm_step"] == pytest.approx(10.0)


def test_step_none_when_not_computable(con, tmp_path):
    glob = write_dekad(tmp_path, {2020: (50, 100)})
    assert validate.step_stats(con, glob) == {"naive_step": None, "harm_step": None, "yoy_p10": None, "yoy_p90": None}


def test_annual_series(con, tmp_path):
    glob = write_dekad(tmp_path, {2020: (50, 100), 2021: (60, 100)})
    rows = {(r["year"], r["series"]): r["value"] for r in validate.annual_series(con, glob).to_pylist()}
    assert len(rows) == 16
    assert rows[(2021, "aqua")] == 60 and rows[(2021, "naive")] == 60 and rows[(2021, "terra")] == 0
    assert rows[(2020, "harm")] == 100 and rows[(2020, "harm_lo")] == pytest.approx(90)


# ---------- summaries ----------

def test_coverage():
    s = validate.summarise_loyo(loyo_table([1, 5, 9], [1, 6.5, 9], lo=[0, 6, 8], hi=[2, 7, 10]))
    assert s["region_month"]["coverage"] == pytest.approx(2 / 3)
    assert s["region_month"]["n"] == 3


def test_mdape_and_bias():
    # the unit with observed 0 is skipped for mdape but counts in bias
    s = validate.summarise_loyo(loyo_table([10, 20, 0], [12, 15, 1], lo=[0, 0, 0], hi=[99, 99, 99]))
    assert s["region_month"]["mdape"] == pytest.approx(0.225)
    assert s["region_month"]["bias"] == pytest.approx(-2 / 30)


def test_breakdown_groups():
    t = loyo_table([10, 10, 10, 10], [11, 12, 10, 20], lo=[9, 9, 9, 15], hi=[12, 11, 11, 25],
                   unit_type="stratum_month", units=["0-1", "0-2", "1-1", "1-2"])
    extra = loyo_table([5], [500], lo=[0], hi=[1])  # region_month rows must be ignored
    b = {(r["group_type"], r["grp"]): r for r in validate.breakdown(pa.concat_tables([t, extra])).to_pylist()}
    assert set(b) == {("stratum", 0), ("stratum", 1), ("month", 1), ("month", 2)}
    assert b[("stratum", 0)]["mdape"] == pytest.approx(0.15)
    assert b[("stratum", 0)]["coverage"] == pytest.approx(1.0)
    assert b[("stratum", 1)]["coverage"] == pytest.approx(0.5)
    assert b[("month", 2)]["bias"] == pytest.approx(12 / 20)
    assert b[("month", 1)]["n"] == 2
    assert b[("month", 1)]["variant"] == "region" and b[("month", 1)]["link"] == "aqua_snpp"


# ---------- leave-one-year-out ----------

def test_loyo_excludes_year(con, tmp_path, fake_harmonize):
    rows = []
    for y in (2003, 2004, 2005):
        rows += point(y, "Terra", 5) + point(y, "Aqua", 12)
    t = validate.loyo(con, write_points(tmp_path, rows), "terra_aqua", "region")
    out = t.to_pylist()
    assert {r["held_year"] for r in out} == {2003, 2004, 2005}
    assert len(fake_harmonize.calls) == 3
    for r in out:
        used = [int(x) for x in r["fit_years"].split(",")]
        assert r["held_year"] not in used
        assert used in fake_harmonize.calls
        assert set(used) == set(range(2003, 2012)) - {r["held_year"]}
    assert all(len(c) == 8 for c in fake_harmonize.calls)


@pytest.mark.parametrize("variant", ["region", "noregion"])
def test_loyo_prediction(con, tmp_path, fake_harmonize, variant):
    rows = (point(2003, "Terra", 4) + point(2003, "Aqua", 9)
            + point(2004, "Terra", 10) + point(2004, "Aqua", 60)
            + point(2004, "Terra", 7, conf="l")         # low confidence: excluded
            + point(2004, "Terra", 7, category=6)       # not a harmonized category: excluded
            + point(2004, "SNPP", 7))                   # not part of this link
    t = validate.loyo(con, write_points(tmp_path, rows), "terra_aqua", variant)
    got = {(r["held_year"], r["unit_type"]): r for r in t.to_pylist()}
    r = got[(2004, "region_month")]
    assert (r["unit"], r["observed"], r["predicted"], r["lo"], r["hi"]) == ("1", 60, 30, 20, 40)
    assert (r["variant"], r["link"], r["metric"]) == (variant, "terra_aqua", "n")
    assert got[(2004, "stratum_month")]["unit"] == "0-1" and got[(2004, "stratum_month")]["predicted"] == 30
    assert got[(2004, "box1deg")]["unit"] == "20_78-1" and got[(2004, "box1deg")]["predicted"] == 30
    assert (2003, "box1deg") not in got  # observed 9 < 50
    assert got[(2003, "region_month")]["predicted"] == 12


def test_direct_aqua_noaa20(con, tmp_path):
    rows = []
    for y, target in ((2018, 20), (2019, 30), (2020, 40), (2021, 30)):
        rows += point(y, "Aqua", 10) + point(y, "NOAA20", target)
    rows += point(2017, "Aqua", 10) + point(2022, "NOAA20", 500)  # outside 2018-2021: ignored
    d = validate.direct_aqua_noaa20(con, write_points(tmp_path, rows))
    # held 2019, 2021: ratio 3 exactly, band [2.2, 3.8] x 10 holds 30
    # held 2018: predicted 33.3 vs 20, band [30, 38]; held 2020: predicted 26.7 vs 40, band [22, 30]
    assert d["n"] == 4
    assert d["mdape"] == pytest.approx(1 / 6)
    assert d["coverage"] == pytest.approx(0.5)


def test_write_validation(con, tmp_path, fake_harmonize):
    rows = []
    for y in (2003, 2004, 2012, 2013, 2018, 2019):
        for sat in ("Terra", "Aqua", "SNPP", "NOAA20"):
            rows += point(y, sat, 3)
    dekad = write_dekad(tmp_path, {y: (50, 100) for y in range(2003, 2026)})
    out = tmp_path / "validation"
    summary = validate.write_validation(con, write_points(tmp_path, rows), dekad, out)
    import json
    assert json.loads((out / "summary.json").read_text()) == summary
    assert set(summary) == {"chosen_variant", "reason", "step", "loyo", "direct_aqua_noaa20", "mask_counts",
                            "category_counts"}
    assert set(summary["loyo"]) == {"region", "noregion"}
    assert set(summary["loyo"]["region"]) == {"terra_aqua", "aqua_snpp", "snpp_noaa20"}
    assert summary["mask_counts"] == {} and summary["category_counts"] == {}
    for name in ("annual_series", "loyo", "breakdown"):
        assert pq.read_table(out / f"{name}.parquet").num_rows > 0


# ---------- variant choice ----------

def test_choose_variant_lower_mdape():
    s = summary_for({"region": [0.1, 0.1, 0.1], "noregion": [0.2, 0.2, 0.2]},
                    {"region": [0.8] * 3, "noregion": [0.8] * 3})
    variant, reason = validate.choose_variant(s)
    assert variant == "region"
    assert "0.1" in reason and "0.2" in reason


def test_choose_variant_coverage_gate():
    s = summary_for({"region": [0.1, 0.1, 0.1], "noregion": [0.2, 0.2, 0.2]},
                    {"region": [0.8, 0.5, 0.8], "noregion": [0.8] * 3})
    assert validate.choose_variant(s)[0] == "noregion"
    # nobody eligible: lower score still wins and the reason says so
    s = summary_for({"region": [0.1, 0.1, 0.1], "noregion": [0.2, 0.2, 0.2]},
                    {"region": [0.99] * 3, "noregion": [0.5] * 3})
    variant, reason = validate.choose_variant(s)
    assert variant == "region"
    assert "neither" in reason.lower()


def test_choose_variant_tie():
    s = summary_for({"region": [0.1, 0.2, 0.3], "noregion": [0.3, 0.2, 0.1]},
                    {"region": [0.8] * 3, "noregion": [0.8] * 3})
    assert validate.choose_variant(s)[0] == "noregion"
