"""Daily refresh of the current year. python -m pipeline.daily --region india [--no-publish]

Rebuilds only the year of "today" from the FIRMS Area API and uploads it to the "data" release.
Nothing is written under data/: the current-year files live on the release (DECISIONS D3, CONTRACTS section 4).
On any failure no data file is uploaded; only a meta.json with status "failed", so the site keeps the old data.
"""
import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from pipeline import aggregate, classify, harmonize, ingest, publish, settings
from pipeline.build import API_SOURCES, con

ROOT = settings.ROOT
DEFAULT_REPO = "ashimajain777/fire-calendar"
SNPP_END = dt.date(2026, 11, 2)     # S-NPP stopped; its sources are not asked for later dates
REFETCH_DAYS = 10                   # NRT rows are replaced by SP later, so recent chunks are always fetched again


def _has_rows(path: Path) -> bool:
    with open(path, encoding="utf-8") as f:
        f.readline()
        return bool(f.readline().strip())


def fetch(region: str, year: int, today: dt.date, key: str, api_dir: Path) -> None:
    """Fixed 5-day chunks from 1 Jan; a chunk already on disk is skipped unless it is recent."""
    bbox = settings.REGIONS[region]["bbox"]
    for name in API_SOURCES:
        last = min(today, SNPP_END) if "SNPP" in name else today
        day = dt.date(year, 1, 1)
        while day <= last:
            end = min(day + dt.timedelta(days=4), last)
            path = api_dir / name / f"{day.isoformat()}.csv"
            # An SP chunk that was empty when fetched is asked for again: SP arrives months after NRT.
            # shortcut: an SP chunk that was only partly processed when fetched is kept as is (its other
            # days stay NRT), delete work/api/*_SP to force a full refetch.
            if (end > today - dt.timedelta(days=REFETCH_DAYS) or not path.exists()
                    or (name.endswith("_SP") and not _has_rows(path))):
                ingest.fetch_area_api(name, bbox, day, end, key, api_dir)
            day += dt.timedelta(days=5)


def build(region: str, year: int, today: dt.date, key: str, work: Path, out: Path) -> dict[str, str]:
    """Writes points_{year}, dekad_{year} and gaps.parquet into `out`; returns {satellite: last acquisition date}."""
    data = ROOT / "data"
    committed = json.loads((data / "meta.json").read_text(encoding="utf-8"))
    variant = committed["variant"]
    dates = {k: dt.date.fromisoformat(v) for k, v in committed["chain"].items()}

    fetch(region, year, today, key, work / "api")
    inputs = [(p, source, proc) for name, (source, proc) in API_SOURCES.items()
              for p in sorted((work / "api" / name).glob(f"{year}-*.csv")) if _has_rows(p)]
    inputs += [(p, sensor, "SP") for sensor in ("modis", "viirs-snpp", "viirs-jpss1")
               for p in sorted((work / "csv" / sensor).glob(f"{sensor}_{year}_*.csv"))]
    if not inputs:
        raise RuntimeError(f"FIRMS returned no detections for {year}")
    print(f"daily: {len(inputs)} input files with rows")

    tmp = out.parent
    name = f"points_{year}.parquet"
    c = con()
    stats = ingest.build_points_stage(c, inputs, tmp / "stage", ingest.clip_wkt(region))
    if year not in stats or not stats[year]["rows_out"]:
        raise RuntimeError(f"no detections inside the region for {year}")
    print("daily: ingest", stats[year])
    cats = classify.classify_points(c, (tmp / "stage" / name).as_posix(), ROOT / "pipeline" / "static" / "lc001.parquet",
                                    data / "static_mask.parquet", tmp / "classified")
    print("daily: category counts", cats)
    ratios = pq.read_table(data / "ratios.parquet")
    ratios = ratios.filter(ratios["chosen"]).drop_columns(["chosen"])
    harmonize.apply_weights(c, (tmp / "classified" / name).as_posix(), ratios, variant, dates, out)
    points = (out / name).as_posix()

    old = pq.read_table(data / "gaps.parquet")
    gaps = pa.concat_tables([old.filter(pc.not_equal(old["year"], year)),
                             aggregate.build_gaps(c, points, dates).cast(old.schema)])
    pq.write_table(gaps, out / "gaps.parquet")
    aggregate.build_dekad(c, points, ratios, variant, dates, gaps, out)
    aggregate.check_invariants(c, points, (out / f"dekad_{year}.parquet").as_posix())
    print("daily: invariants PASS")
    return {sat: str(end) for sat, end in c.execute(
        f"SELECT satellite, max(acq_date) FROM read_parquet('{points}') GROUP BY 1").fetchall()}


def release_meta(repo: str, dest: Path) -> dict | None:
    """meta.json from the release: it holds the state of earlier daily runs (the committed one stops at the archive)."""
    r = subprocess.run(["gh", "release", "download", "data", "--repo", repo, "--pattern", "meta.json",
                        "--dir", str(dest), "--clobber"], capture_output=True)
    return json.loads((dest / "meta.json").read_text(encoding="utf-8")) if r.returncode == 0 else None


def run(region: str, today: dt.date, publish: bool, work_dir: Path | None = None) -> int:
    from pipeline import publish as pub     # the `publish` argument shadows the module
    work = Path(work_dir) if work_dir else ROOT / "work"
    year = today.year
    repo = os.environ.get("GITHUB_REPO") or DEFAULT_REPO
    tmp = work / "daily"
    shutil.rmtree(tmp, ignore_errors=True)
    out = tmp / "out"
    out.mkdir(parents=True)

    meta = json.loads((ROOT / "data" / "meta.json").read_text(encoding="utf-8"))
    if publish:
        (tmp / "release").mkdir()
        rel = release_meta(repo, tmp / "release")
        if rel and rel.get("generated_utc", "") > meta.get("generated_utc", ""):
            meta = rel
    settings.load_env()
    key = os.environ.get("FIRMS_MAP_KEY")
    files = []
    try:
        if not key:
            raise RuntimeError("FIRMS_MAP_KEY is not set")
        ends = build(region, year, today, key, work, out)
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        for sat, end in ends.items():
            meta.setdefault("sources", {})[sat] = {"last_success_utc": now, "coverage_end": end}
        meta.update(status="ok", last_error=None, coverage_end=max([meta["coverage_end"], *ends.values()]))
        files = [out / f"points_{year}.parquet", out / f"dekad_{year}.parquet", out / "gaps.parquet"]
        rc = 0
    except Exception as e:      # any failure: keep the old data, publish only the failed status
        msg = f"{type(e).__name__}: {e}"
        if key:
            msg = msg.replace(key, "***")
        meta.update(status="failed", last_error=msg[:300])
        print("daily: FAILED:", meta["last_error"], file=sys.stderr)
        rc = 1
    meta.pop("generated_utc", None)
    pub.write_meta(out / "meta.json", **meta)
    if publish:
        pub.upload_release_assets([*files, out / "meta.json"], repo)
        print("daily: uploaded", [p.name for p in files] + ["meta.json"])
    return rc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="india")
    ap.add_argument("--no-publish", action="store_true")
    a = ap.parse_args()
    sys.exit(run(a.region, dt.datetime.now(dt.timezone.utc).date(), not a.no_publish))
