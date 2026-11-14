import json
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import daily, grid, ingest, publish, settings
from pipeline.tests.test_ingest import SQUARE, VIIRS_HDR, viirs

TODAY = date(2026, 3, 20)
Y = TODAY.year
KEY = "secretkey0123456789"
PREV = "2026-01-01T00:00:00+00:00"


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A tiny repo layout; returns a record of fetch calls, fake rows and uploads."""
    root = tmp_path / "repo"
    data = root / "data"
    (data / "dekad").mkdir(parents=True)
    (root / "pipeline" / "static").mkdir(parents=True)
    sat = {"last_success_utc": PREV, "coverage_end": "2025-12-31"}
    (data / "meta.json").write_text(json.dumps({
        "status": "ok", "git_sha": "abc", "coverage_start": "2000-11-01", "coverage_end": "2025-12-31",
        "chain": {"aqua_start": "2002-08-01", "snpp_start": "2012-02-01", "noaa20_start": "2018-04-01"},
        "variant": "noregion", "sources": {"NOAA20": dict(sat), "Aqua": dict(sat)},
        "last_error": None, "generated_utc": PREV}))
    pq.write_table(pa.table({"cell001_id": pa.array([], pa.int64()), "reason": pa.array([], pa.string()),
                             "n_days_max": pa.array([], pa.int32())}), data / "static_mask.parquet")
    pq.write_table(pa.table({"cell001_id": pa.array([grid.cell001_id(15.0, 75.0), grid.cell001_id(16.0, 76.0)], pa.int64()),
                             "igbp": pa.array([12, 2], pa.int8())}), root / "pipeline" / "static" / "lc001.parquet")
    keys = [(link, metric, s, m) for link in ("terra_aqua", "aqua_snpp", "snpp_noaa20") for metric in ("n", "fd")
            for s in range(6) for m in range(1, 13)]
    n = len(keys)
    pq.write_table(pa.table({
        "variant": ["noregion"] * n, "link": [k[0] for k in keys], "metric": [k[1] for k in keys],
        "region_id": pa.array([-1] * n, pa.int32()), "stratum": pa.array([k[2] for k in keys], pa.int8()),
        "month": pa.array([k[3] for k in keys], pa.int8()), "r": [1.0] * n, "r_lo": [1.0] * n, "r_hi": [1.0] * n,
        "n_years": pa.array([1] * n, pa.int32()), "n_detections": pa.array([1000] * n, pa.int64()),
        "fallback": ["none"] * n, "chosen": [True] * n}), data / "ratios.parquet")
    pq.write_table(pa.table({"year": pa.array([2019], pa.int16()), "month": pa.array([1], pa.int8()),
                             "dekad": pa.array([1], pa.int8()), "chain_satellite": ["NOAA20"],
                             "filled_from": ["SNPP"]}), data / "gaps.parquet")

    rec = {"root": root, "calls": [], "dates": [], "uploads": [], "meta": None}

    def fake_fetch(source, bbox, start, end, map_key, out_dir):
        assert map_key == KEY
        rec["calls"].append((source, start, end))
        rows = []
        if source == "VIIRS_NOAA20_SP":     # one detection on the first and last day of every chunk
            rows = [viirs(d=d.isoformat(), sat="N20", lat=15.0 + i, lon=75.0 + i) for i, d in enumerate((start, end))]
            rec["dates"] += [start, end]
        p = Path(out_dir) / source / f"{start.isoformat()}.csv"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("\n".join([VIIRS_HDR, *rows]) + "\n", encoding="utf-8")
        return [p]

    def fake_upload(paths, repo, tag="data"):
        rec["uploads"].append([Path(p).name for p in paths])
        rec["meta"] = json.loads(next(Path(p) for p in paths if Path(p).name == "meta.json").read_text())

    monkeypatch.setattr(daily, "ROOT", root)
    monkeypatch.setattr(daily, "release_meta", lambda repo, dest: None)
    monkeypatch.setattr(settings, "load_env", lambda: None)
    monkeypatch.setattr(ingest, "clip_wkt", lambda region: SQUARE)
    monkeypatch.setattr(ingest, "fetch_area_api", fake_fetch)
    monkeypatch.setattr(publish, "upload_release_assets", fake_upload)
    monkeypatch.setenv("FIRMS_MAP_KEY", KEY)
    return rec


def assert_failed_meta_only(rec):
    assert rec["uploads"] == [["meta.json"]]
    assert rec["meta"]["status"] == "failed"
    assert rec["meta"]["last_error"]
    assert rec["meta"]["coverage_end"] == "2025-12-31"
    assert all(s == {"last_success_utc": PREV, "coverage_end": "2025-12-31"} for s in rec["meta"]["sources"].values())
    assert rec["meta"]["generated_utc"] > PREV      # so the deploy step prefers it over the committed copy


def test_missing_key_fails_without_upload_of_data(repo, monkeypatch):
    monkeypatch.delenv("FIRMS_MAP_KEY")
    assert daily.run("india", TODAY, True) == 1
    assert repo["calls"] == []
    assert_failed_meta_only(repo)
    assert "FIRMS_MAP_KEY" in repo["meta"]["last_error"]


def test_fetch_error_keeps_old_data(repo, monkeypatch):
    def boom(source, bbox, start, end, map_key, out_dir):
        raise ingest.FirmsError(source, start, 500, f"upstream said {map_key}")
    monkeypatch.setattr(ingest, "fetch_area_api", boom)
    assert daily.run("india", TODAY, True) == 1
    assert_failed_meta_only(repo)
    assert "FIRMS" in repo["meta"]["last_error"] and KEY not in repo["meta"]["last_error"]


def test_success_uploads_current_year_files(repo):
    assert daily.run("india", TODAY, True) == 0
    assert repo["uploads"] == [[f"points_{Y}.parquet", f"dekad_{Y}.parquet", "gaps.parquet", "meta.json"]]
    meta = repo["meta"]
    assert meta["status"] == "ok" and meta["last_error"] is None
    assert meta["coverage_end"] == max(repo["dates"]).isoformat()
    assert meta["sources"]["NOAA20"]["coverage_end"] == max(repo["dates"]).isoformat()
    assert meta["sources"]["NOAA20"]["last_success_utc"] > PREV
    assert meta["sources"]["Aqua"] == {"last_success_utc": PREV, "coverage_end": "2025-12-31"}
    assert meta["git_sha"] == "abc" and meta["variant"] == "noregion"
    root = repo["root"]
    assert list((root / "data" / "dekad").iterdir()) == []
    assert json.loads((root / "data" / "meta.json").read_text())["generated_utc"] == PREV   # committed copy untouched
    out = root / "work" / "daily" / "out"
    assert pq.read_table(out / f"points_{Y}.parquet").num_rows == len(set(repo["dates"]))
    assert 2019 in pq.read_table(out / "gaps.parquet")["year"].to_pylist()       # other years' gap rows kept


def test_recent_chunks_refetched_older_skipped(repo):
    assert daily.run("india", TODAY, False) == 0
    first = [c for c in repo["calls"] if c[0] == "VIIRS_NOAA20_SP"]
    assert first[0][1] == date(Y, 1, 1) and first[-1][2] == TODAY
    assert all((e - s).days <= 4 for _, s, e in first)
    repo["calls"].clear()
    assert daily.run("india", TODAY, False) == 0
    again = [c for c in repo["calls"] if c[0] == "VIIRS_NOAA20_SP"]
    assert again == [c for c in first if c[2] > TODAY - timedelta(days=10)]
    assert 0 < len(again) < len(first)
    # NRT chunks that came back empty stay skipped too; only the recent ones are asked for again
    assert all(e > TODAY - timedelta(days=10) for src, _, e in repo["calls"] if src.endswith("_NRT"))


def test_snpp_not_fetched_after_its_end(repo):
    assert daily.run("india", date(2026, 11, 14), False) == 0
    assert max(e for src, _, e in repo["calls"] if "SNPP" in src) == date(2026, 11, 2)
    assert max(e for src, _, e in repo["calls"] if "NOAA21" in src) == date(2026, 11, 14)


def test_no_publish_flag_uploads_nothing(repo):
    assert daily.run("india", TODAY, False) == 0
    assert repo["uploads"] == []
