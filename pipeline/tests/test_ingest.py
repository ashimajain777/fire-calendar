from datetime import date

import duckdb
import pytest

from pipeline import grid, ingest

MODIS_HDR = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"
VIIRS_HDR = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type"
# Not aligned to the 0.1 deg grid, so edge cells take the per-point path.
SQUARE = "POLYGON((70.03 10.03, 80.03 10.03, 80.03 20.03, 70.03 20.03, 70.03 10.03))"
COLUMNS = {
    "lat": "DOUBLE", "lon": "DOUBLE", "acq_date": "DATE", "acq_time": "SMALLINT", "sensor": "VARCHAR",
    "satellite": "VARCHAR", "confidence_raw": "VARCHAR", "conf_class": "VARCHAR", "frp": "FLOAT",
    "daynight": "VARCHAR", "brightness": "FLOAT", "firms_type": "TINYINT", "processing": "VARCHAR",
    "version": "VARCHAR", "cell_id": "INTEGER", "cell001_id": "BIGINT", "region_id": "INTEGER",
}


def modis(lat=15.0, lon=75.0, d="2020-03-01", t="0821", sat="Terra", conf="50", typ="0"):
    return f"{lat},{lon},310.5,1.0,1.0,{d},{t},{sat},MODIS,{conf},6.2,290.1,12.5,D,{typ}"


def viirs(lat=15.0, lon=75.0, d="2020-03-01", t="0821", sat="N", conf="n", typ="0"):
    return f"{lat},{lon},330.5,0.4,0.4,{d},{t},{sat},VIIRS,{conf},2,290.1,3.5,N,{typ}"


def write(tmp_path, name, header, rows):
    p = tmp_path / name
    p.write_text("\n".join([header, *rows]) + "\n", encoding="utf-8")
    return p


def run(tmp_path, inputs, wkt=SQUARE):
    """Build the stage; return (stats, rows as dicts in file order, {column: type})."""
    con = duckdb.connect()
    out = tmp_path / "stage"
    stats = ingest.build_points_stage(con, inputs, out, wkt)
    rows, types = [], {}
    for y in sorted(stats):
        r = con.execute(f"SELECT * FROM read_parquet('{(out / f'points_{y}.parquet').as_posix()}')")
        types = {d[0]: str(d[1]) for d in r.description}
        rows += [dict(zip(types, row)) for row in r.fetchall()]
    return stats, rows, types


def test_conf_class(tmp_path):
    m = write(tmp_path, "m.csv", MODIS_HDR, [modis(conf=c, t=f"080{i}") for i, c in enumerate(["29", "30", "79", "80"])])
    v = write(tmp_path, "v.csv", VIIRS_HDR,
              [viirs(conf=c, t=f"090{i}") for i, c in enumerate(["l", "n", "h", "low", "nominal", "high", "H"])])
    _, rows, _ = run(tmp_path, [(m, "modis", "SP"), (v, "viirs-snpp", "SP")])
    got = {r["confidence_raw"]: r["conf_class"] for r in rows}
    assert got == {"29": "l", "30": "n", "79": "n", "80": "h",
                   "l": "l", "n": "n", "h": "h", "low": "l", "nominal": "n", "high": "h", "H": "h"}


def test_dedup_prefers_sp(tmp_path):
    nrt = write(tmp_path, "nrt.csv", VIIRS_HDR.removesuffix(",type"), [viirs().rsplit(",", 1)[0]])
    sp = write(tmp_path, "sp.csv", VIIRS_HDR, [viirs()])
    for inputs in ([(nrt, "viirs-snpp", "NRT"), (sp, "viirs-snpp", "SP")],
                   [(sp, "viirs-snpp", "SP"), (nrt, "viirs-snpp", "NRT")]):
        stats, rows, _ = run(tmp_path, inputs)
        assert [r["processing"] for r in rows] == ["SP"]
        assert stats[2020]["dup_dropped"] == 1


def test_dedup_keeps_other_satellite(tmp_path):
    a = write(tmp_path, "a.csv", VIIRS_HDR, [viirs()])
    b = write(tmp_path, "b.csv", VIIRS_HDR, [viirs()])
    _, rows, _ = run(tmp_path, [(a, "viirs-snpp", "SP"), (b, "viirs-jpss1", "SP")])
    assert sorted(r["satellite"] for r in rows) == ["NOAA20", "SNPP"]


def test_clip_buffer(tmp_path):
    p = write(tmp_path, "m.csv", MODIS_HDR, [
        modis(lon=75.0),    # interior cell
        modis(lon=80.01),   # edge cell, inside
        modis(lon=80.05),   # edge cell, outside
        modis(lon=80.53),   # 0.5 deg outside
    ])
    stats, rows, _ = run(tmp_path, [(p, "modis", "SP")])
    assert sorted(r["lon"] for r in rows) == [75.0, 80.01]
    assert stats[2020]["clip_dropped"] == 2


def test_satellite_from_source(tmp_path):
    v = [write(tmp_path, f"v{i}.csv", VIIRS_HDR, [viirs(sat=s)]) for i, s in enumerate(["N", "1", "N21"])]
    m = write(tmp_path, "m.csv", MODIS_HDR,
              [modis(sat=s, t=f"070{i}") for i, s in enumerate(["Aqua", "Terra", "A", "T"])])
    _, rows, _ = run(tmp_path, [(v[0], "viirs-snpp", "SP"), (v[1], "viirs-jpss1", "SP"),
                                (v[2], "viirs-jpss2", "NRT"), (m, "modis", "SP")])
    assert sorted((r["sensor"], r["satellite"]) for r in rows) == [
        ("MODIS", "Aqua"), ("MODIS", "Aqua"), ("MODIS", "Terra"), ("MODIS", "Terra"),
        ("VIIRS", "NOAA20"), ("VIIRS", "NOAA21"), ("VIIRS", "SNPP")]


def test_unknown_source_raises(tmp_path):
    p = write(tmp_path, "v.csv", VIIRS_HDR, [viirs()])
    with pytest.raises(ValueError):
        ingest.build_points_stage(duckdb.connect(), [(p, "landsat", "SP")], tmp_path / "s", SQUARE)


def test_nrt_has_null_type(tmp_path):
    nrt = write(tmp_path, "nrt.csv", VIIRS_HDR.removesuffix(",type"), [viirs(t="0100").rsplit(",", 1)[0]])
    sp = write(tmp_path, "sp.csv", VIIRS_HDR, [viirs(t="0200", typ="2")])
    _, rows, types = run(tmp_path, [(nrt, "viirs-snpp", "NRT"), (sp, "viirs-snpp", "SP")])
    assert {r["processing"]: r["firms_type"] for r in rows} == {"NRT": None, "SP": 2}
    assert types == COLUMNS


def test_old_viirs_brightness_column(tmp_path):
    old = VIIRS_HDR.replace("bright_ti4", "brightness").replace("bright_ti5", "bright_t31")
    _, rows, _ = run(tmp_path, [(write(tmp_path, "v.csv", old, [viirs()]), "viirs-snpp", "SP")])
    assert rows[0]["brightness"] == 330.5


def test_acq_time_parsing(tmp_path):
    p = write(tmp_path, "m.csv", MODIS_HDR, [modis(t="821", lon=75.0), modis(t="0821", lon=75.5),
                                             modis(t="0005", lon=76.0), modis(t="2359", lon=76.5)])
    _, rows, _ = run(tmp_path, [(p, "modis", "SP")])
    assert {r["lon"]: r["acq_time"] for r in rows} == {75.0: 821, 75.5: 821, 76.0: 5, 76.5: 2359}
    assert rows[0]["acq_date"] == date(2020, 3, 1)


def test_cell_ids_present(tmp_path):
    pts = [(15.0, 75.0), (10.07, 70.04), (19.999, 79.999), (12.345, 77.777)]
    p = write(tmp_path, "m.csv", MODIS_HDR, [modis(lat=a, lon=o) for a, o in pts])
    _, rows, _ = run(tmp_path, [(p, "modis", "SP")])
    assert len(rows) == len(pts)
    for r in rows:
        assert r["cell_id"] == grid.cell_id(r["lat"], r["lon"])
        assert r["cell001_id"] == grid.cell001_id(r["lat"], r["lon"])
        assert r["region_id"] == grid.region_id(r["lat"], r["lon"])
    assert [r["cell_id"] for r in rows] == sorted(r["cell_id"] for r in rows)


def test_row_accounting(tmp_path):
    sp = write(tmp_path, "sp.csv", MODIS_HDR, [
        modis(d="2019-12-31"), modis(d="2020-01-01"), modis(d="2020-01-02", lon=85.0), modis(d="2020-01-03")])
    nrt = write(tmp_path, "nrt.csv", MODIS_HDR.removesuffix(",type"),
                [modis(d="2020-01-03").rsplit(",", 1)[0], modis(d="2020-01-04").rsplit(",", 1)[0]])
    stats, rows, _ = run(tmp_path, [(sp, "modis", "SP"), (nrt, "modis", "NRT")])
    assert stats == {2019: {"rows_in": 1, "rows_out": 1, "clip_dropped": 0, "dup_dropped": 0},
                     2020: {"rows_in": 5, "rows_out": 3, "clip_dropped": 1, "dup_dropped": 1}}
    for s in stats.values():
        assert s["rows_in"] == s["rows_out"] + s["clip_dropped"] + s["dup_dropped"]
    assert len(rows) == 4


class Resp:
    def __init__(self, status=200, text=""):
        self.status_code, self.text, self.content = status, text, text.encode()


def test_area_api_error_body_raises(tmp_path, monkeypatch):
    key, sleeps = "SECRETKEY123", []
    monkeypatch.setattr(ingest.requests, "get", lambda url, **kw: Resp(200, f"Invalid MAP_KEY {key}."))
    with pytest.raises(ingest.FirmsError) as e:
        ingest.fetch_area_api("VIIRS_SNPP_NRT", (68.0, 6.0, 98.0, 38.0), date(2026, 1, 1), date(2026, 1, 3),
                              key, tmp_path, sleep=sleeps.append)
    assert key not in str(e.value) and key not in repr(e.value)
    assert (e.value.source, e.value.date, e.value.status) == ("VIIRS_SNPP_NRT", date(2026, 1, 1), 200)
    assert sleeps == [5, 20, 60]
    assert not list(tmp_path.rglob("*.csv"))


def test_area_api_network_error_hides_key(tmp_path, monkeypatch):
    key = "SECRETKEY123"

    def boom(url, **kw):
        raise ingest.requests.ConnectionError(f"failed: {url}")

    monkeypatch.setattr(ingest.requests, "get", boom)
    with pytest.raises(ingest.FirmsError) as e:
        ingest.fetch_area_api("MODIS_NRT", (68.0, 6.0, 98.0, 38.0), date(2026, 1, 1), date(2026, 1, 1),
                              key, tmp_path, sleep=lambda s: None)
    assert key not in str(e.value) and e.value.__cause__ is None and e.value.__suppress_context__


def test_area_api_chunks_and_retries(tmp_path, monkeypatch):
    urls, sleeps = [], []

    def get(url, **kw):
        urls.append(url)
        return Resp(500, "oops") if len(urls) == 1 else Resp(200, VIIRS_HDR + "\n")

    monkeypatch.setattr(ingest.requests, "get", get)
    paths = ingest.fetch_area_api("VIIRS_NOAA20_NRT", (68.0, 6.0, 98.0, 38.0), date(2026, 1, 1), date(2026, 1, 7),
                                  "K", tmp_path, sleep=sleeps.append)
    base = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/K/VIIRS_NOAA20_NRT/68,6,98,38"
    assert urls == [f"{base}/5/2026-01-01", f"{base}/5/2026-01-01", f"{base}/2/2026-01-06"]
    assert sleeps == [5]
    assert paths == [tmp_path / "VIIRS_NOAA20_NRT" / "2026-01-01.csv", tmp_path / "VIIRS_NOAA20_NRT" / "2026-01-06.csv"]
    assert all(p.read_text().startswith("latitude") for p in paths)


def test_download_skips_existing(tmp_path, monkeypatch):
    urls = []

    def get(url, **kw):
        urls.append(url)
        return Resp(404) if "_2002_" in url else Resp(200, MODIS_HDR + "\n" + modis() + "\n")

    monkeypatch.setattr(ingest.requests, "get", get)
    have = tmp_path / "modis" / "modis_2000_India.csv"
    have.parent.mkdir()
    have.write_text("already here")
    paths = ingest.download_country_csvs("india", ["modis"], range(2000, 2003), tmp_path)
    assert urls == [f"https://firms.modaps.eosdis.nasa.gov/data/country/modis/{y}/modis_{y}_India.csv" for y in (2001, 2002)]
    assert paths == [have, tmp_path / "modis" / "modis_2001_India.csv"]
    assert have.read_text() == "already here"
    assert paths[1].read_text().startswith("latitude")
    assert not list(tmp_path.rglob("*.part"))


def test_dedup_is_deterministic(tmp_path):
    """Duplicates that differ only in FRP: the same row (highest FRP) wins whatever the input order."""
    lo = viirs().replace(",290.1,3.5,", ",290.1,3.5,")
    hi = viirs().replace(",290.1,3.5,", ",290.1,9.9,")
    a = write(tmp_path, "a.csv", VIIRS_HDR, [lo, hi])
    b = write(tmp_path, "b.csv", VIIRS_HDR, [hi, lo])
    for p in (a, b):
        _, rows, _ = run(tmp_path, [(p, "viirs-snpp", "SP")])
        assert [round(r["frp"], 1) for r in rows] == [9.9]
