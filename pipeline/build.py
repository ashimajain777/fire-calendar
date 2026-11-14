"""Full rebuild. python -m pipeline.build --region india --steps ingest,landcover,classify,harmonize,aggregate,validate,publish

Each step reads the previous step's files under work/, so steps can be rerun on their own.
Every number printed here is computed from the files; nothing is typed in.
"""
import argparse
import datetime as dt
import glob
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import settings

ROOT = settings.ROOT
WORK = ROOT / "work"
DATA = ROOT / "data"
STATE = WORK / "build_state.json"
API_SOURCES = {  # FIRMS Area API source -> (ingest source, processing)
    "MODIS_SP": ("modis", "SP"), "MODIS_NRT": ("modis", "NRT"),
    "VIIRS_SNPP_SP": ("viirs-snpp", "SP"), "VIIRS_SNPP_NRT": ("viirs-snpp", "NRT"),
    "VIIRS_NOAA20_SP": ("viirs-jpss1", "SP"), "VIIRS_NOAA20_NRT": ("viirs-jpss1", "NRT"),
    "VIIRS_NOAA21_SP": ("viirs-jpss2", "SP"), "VIIRS_NOAA21_NRT": ("viirs-jpss2", "NRT"),
}
LANDCOVER_SOURCE = "MODIS MCD12Q1 v061 LC_Type1 (IGBP), 2024, 500 m, via NASA AppEEARS"
BOUNDARY_SOURCE = "Natural Earth 1:10m admin-0 countries, India point-of-view (ne_10m_admin_0_countries_ind)"


def con():
    c = duckdb.connect()
    c.execute("SET preserve_insertion_order = false")
    return c


def state(**update) -> dict:
    s = json.loads(STATE.read_text()) if STATE.exists() else {}
    if update:
        s.update(update)
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(s, indent=1, default=str))
    return s


def g(sub: str) -> str:
    return (WORK / sub / "points_*.parquet").as_posix()


def step_ingest(region: str):
    from pipeline import ingest
    inputs = []
    for sensor in ("modis", "viirs-snpp", "viirs-jpss1"):
        for p in sorted((WORK / "csv" / sensor).glob("*.csv")):
            inputs.append((p, sensor, "SP"))
    for name, (source, proc) in API_SOURCES.items():
        for p in sorted((WORK / "api" / name).glob("*.csv")):
            inputs.append((p, source, proc))
    print(f"ingest: {len(inputs)} input files")
    stats = ingest.build_points_stage(con(), inputs, WORK / "stage", ingest.clip_wkt(region))
    for y in sorted(stats):
        print("  ", y, stats[y])
    tot = {k: sum(v[k] for v in stats.values()) for k in ("rows_in", "rows_out", "clip_dropped", "dup_dropped")}
    print("  total", tot)
    by_sat = con().execute(
        f"SELECT year(acq_date) y, satellite, count(*) n FROM '{g('stage')}' GROUP BY ALL ORDER BY ALL").fetchall()
    state(ingest=stats, ingest_total=tot, rows_by_year_satellite=by_sat)


def step_ingest_api(region: str):
    """Fetch the current year from the FIRMS Area API: SP where available, NRT after the SP end date."""
    import csv
    import io
    import requests
    from pipeline import ingest
    key = os.environ["FIRMS_MAP_KEY"]
    r = requests.get(f"https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/ALL", timeout=60)
    r.raise_for_status()
    avail = {row["data_id"]: (dt.date.fromisoformat(row["min_date"]), dt.date.fromisoformat(row["max_date"]))
             for row in csv.DictReader(io.StringIO(r.text))}
    last_csv_year = max(int(p.stem.split("_")[1]) for p in (WORK / "csv" / "modis").glob("*.csv"))
    start = dt.date(last_csv_year + 1, 1, 1)
    bbox = settings.REGIONS[region]["bbox"]
    for name in API_SOURCES:
        lo, hi = avail[name]
        s = max(start, lo)
        if s > hi:
            print("  ", name, "nothing to fetch")
            continue
        files = ingest.fetch_area_api(name, bbox, s, hi, key, WORK / "api")
        print("  ", name, s, "->", hi, len(files), "files")
    state(api_availability={k: [str(a), str(b)] for k, (a, b) in avail.items() if k in API_SOURCES})


def step_landcover(region: str):
    from pipeline import classify, ingest
    tifs = sorted((WORK / "aux").glob("lc_*.tif"))
    w, s, e, n = settings.REGIONS[region]["bbox"]
    classify.build_landcover_lookup(tifs, (w - 0.5, s - 0.5, e + 0.5, n + 0.5), ingest.clip_wkt(region),
                                    ROOT / "pipeline" / "static" / "lc001.parquet", DATA / "cells.parquet")
    print("landcover:", con().execute(
        f"SELECT count(*), count(*) FILTER (in_coverage) FROM '{(DATA / 'cells.parquet').as_posix()}'").fetchone())


def step_classify(region: str):
    from pipeline import classify
    c = con()
    mask_counts = classify.build_static_mask(c, g("stage"), DATA / "static_mask.parquet")
    print("mask counts:", mask_counts)
    cats = classify.classify_points(c, g("stage"), ROOT / "pipeline" / "static" / "lc001.parquet",
                                    DATA / "static_mask.parquet", WORK / "classified")
    print("category counts:", cats)
    state(mask_counts=mask_counts, category_counts={str(k): v for k, v in cats.items()})


def step_harmonize(region: str):
    from pipeline import harmonize, validate
    c = con()
    dates = harmonize.chain_dates(c, g("classified"))
    print("chain dates:", dates)
    ratios = harmonize.fit_all(c, g("classified"))
    summary = {}
    for variant in ("region", "noregion"):
        summary[variant] = {}
        for link in settings.FIT_YEARS:
            summary[variant][link] = validate.summarise_loyo(validate.loyo(c, g("classified"), link, variant))
            print("  loyo", variant, link, summary[variant][link].get("region_month"))
    variant, reason = validate.choose_variant(summary)
    print("chosen variant:", variant, "|", reason)
    ratios = ratios.append_column("chosen", pa.array([v == variant for v in ratios["variant"].to_pylist()]))
    pq.write_table(ratios, DATA / "ratios.parquet")
    harmonize.apply_weights(c, g("classified"), ratios.drop_columns(["chosen"]), variant, dates, WORK / "points")
    state(chain={k: str(v) for k, v in dates.items()}, variant=variant, variant_reason=reason)
    for row in c.execute(
            f"""SELECT link, stratum, round(sum(r * n_detections) / sum(n_detections), 3) r_weighted,
                       round(min(r), 3) r_min, round(max(r), 3) r_max,
                       count(*) FILTER (fallback <> 'none') n_fallback, count(*) n
                FROM '{(DATA / 'ratios.parquet').as_posix()}' WHERE chosen AND metric = 'n'
                GROUP BY ALL ORDER BY ALL""").fetchall():
        print("  ratio", row)


def step_aggregate(region: str):
    from pipeline import aggregate
    c = con()
    s = state()
    dates = {k: dt.date.fromisoformat(v) for k, v in s["chain"].items()}
    ratios = pq.read_table(DATA / "ratios.parquet").drop_columns(["chosen"])
    gaps = aggregate.build_gaps(c, g("points"), dates)
    pq.write_table(gaps, DATA / "gaps.parquet")
    print("gap dekads:", gaps.num_rows)
    out = WORK / "dekad"
    out.mkdir(parents=True, exist_ok=True)
    aggregate.build_dekad(c, g("points"), ratios, s["variant"], dates, gaps, out)
    aggregate.check_invariants(c, g("points"), (out / "dekad_*.parquet").as_posix())
    print("invariants: PASS (conservation, harm_equals_weights, duplicates, date_range, day_mask)")
    sizes = {p.name: p.stat().st_size for p in sorted(out.glob("dekad_*.parquet"))}
    print("dekad file sizes (bytes): max", max(sizes.values()), "total", sum(sizes.values()))
    assert max(sizes.values()) < 100 * 1024 * 1024
    state(dekad_sizes=sizes)


def step_validate(region: str):
    from pipeline import validate
    c = con()
    summary = validate.write_validation(c, g("points"), (WORK / "dekad" / "dekad_*.parquet").as_posix(),
                                        DATA / "validation")
    s = state()
    summary["mask_counts"] = s.get("mask_counts", {})
    summary["category_counts"] = s.get("category_counts", {})
    summary["chain"] = s.get("chain", {})
    (DATA / "validation" / "summary.json").write_text(json.dumps(summary, indent=1, default=str))
    print(json.dumps({k: summary[k] for k in ("chosen_variant", "reason", "step", "direct_aqua_noaa20")}, indent=1, default=str))


def step_publish(region: str, upload: bool = True):
    from pipeline import publish
    c = con()
    s = state()
    current_year = dt.date.today().year
    (DATA / "dekad").mkdir(parents=True, exist_ok=True)
    release_files = sorted((WORK / "points").glob("points_*.parquet"))
    for p in sorted((WORK / "dekad").glob("dekad_*.parquet")):
        if int(p.stem.split("_")[1]) == current_year:
            release_files.append(p)     # current year is served from the release, never committed
    # Archive years go out as 5-degree tiles (all years in one file per tile): the browser downloads whole files,
    # so an area query should touch only the tiles it overlaps (DECISIONS D22).
    for old in (DATA / "dekad").glob("dekad_*.parquet"):
        old.unlink()
    tile = "((cell_id // 3600) // 50) * 72 + (cell_id % 3600) // 50"
    src = f"read_parquet('{(WORK / 'dekad').as_posix()}/dekad_*.parquet')"
    tiles = [r[0] for r in c.execute(f"SELECT DISTINCT {tile} FROM {src} WHERE year < {current_year} ORDER BY 1").fetchall()]
    for t_id in tiles:
        c.execute(f"""COPY (SELECT * FROM {src} WHERE year < {current_year} AND {tile} = {t_id}
                    ORDER BY cell_id, year, month, dekad, category)
                    TO '{(DATA / 'dekad' / f'dekad_t{t_id}.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)""")
    print("dekad tiles:", len(tiles), "archive years to", current_year - 1)
    cov = c.execute(f"SELECT min(acq_date), max(acq_date) FROM '{g('points')}'").fetchone()
    sources = {sat: {"last_success_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                     "coverage_end": str(end)}
               for sat, end in c.execute(f"SELECT satellite, max(acq_date) FROM '{g('points')}' GROUP BY 1").fetchall()}
    sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    publish.write_meta(DATA / "meta.json", status="ok", git_sha=sha, coverage_start=str(cov[0]),
                       coverage_end=str(cov[1]), landcover_source=LANDCOVER_SOURCE, boundary_source=BOUNDARY_SOURCE,
                       chain=s.get("chain"), variant=s.get("variant"), sources=sources, last_error=None,
                       dekad_tiles=tiles, archive_end=current_year - 1)
    print("meta coverage:", cov)
    if upload:
        repo = os.environ.get("GITHUB_REPO") or "ashimajain777/fire-calendar"
        release_files.append(DATA / "meta.json")
        release_files.append(DATA / "gaps.parquet")
        publish.upload_release_assets(release_files, repo)
        print("uploaded", len(release_files), "files to release 'data'")


STEPS = {"ingest_api": step_ingest_api, "ingest": step_ingest, "landcover": step_landcover, "classify": step_classify,
         "harmonize": step_harmonize, "aggregate": step_aggregate, "validate": step_validate,
         "publish": step_publish}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="india")
    ap.add_argument("--steps", default=",".join(s for s in STEPS if s != "ingest_api"))
    a = ap.parse_args()
    settings.load_env()
    for name in a.steps.split(","):
        t0 = time.time()
        print(f"=== {name}")
        STEPS[name](a.region)
        print(f"=== {name} done in {time.time() - t0:.0f}s")
