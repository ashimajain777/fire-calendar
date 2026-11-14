"""FIRMS download and the points stage. See docs/CONTRACTS.md sections 4.1 and 5."""
import logging
import os
import time
from datetime import date, timedelta
from pathlib import Path

import duckdb
import requests

from . import settings
from .grid import CELL001_SQL, CELL_ID_SQL, REGION_ID_SQL

log = logging.getLogger(__name__)

FIRMS = "https://firms.modaps.eosdis.nasa.gov"
BACKOFF = (5, 20, 60)
TIMEOUT = 300
STAGE_COLUMNS = ("lat, lon, acq_date, acq_time, sensor, satellite, confidence_raw, conf_class, frp, daynight, "
                 "brightness, firms_type, processing, version, cell_id, cell001_id, region_id")


class FirmsError(Exception):
    def __init__(self, source: str, date: date, status: int | None, detail: str = ""):
        self.source, self.date, self.status = source, date, status
        super().__init__(f"FIRMS {source} {date}: HTTP {status} {detail}".rstrip())


def _save(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(content)
    os.replace(part, path)


def download_country_csvs(region: str, sensors: list[str], years: range, out_dir: Path) -> list[Path]:
    name = settings.REGIONS[region]["country_file_name"]
    paths = []
    for sensor in sensors:
        for year in years:
            path = Path(out_dir) / sensor / f"{sensor}_{year}_{name}.csv"
            if not (path.exists() and path.stat().st_size > 0):
                r = requests.get(f"{FIRMS}/data/country/{sensor}/{year}/{path.name}", timeout=TIMEOUT)
                if r.status_code == 404:
                    log.warning("missing on FIRMS (404): %s", path.name)
                    continue
                if r.status_code != 200:
                    raise FirmsError(sensor, date(year, 1, 1), r.status_code)
                _save(path, r.content)
            paths.append(path)
    return paths


def fetch_area_api(source: str, bbox: tuple, start: date, end: date, map_key: str, out_dir: Path,
                   sleep=time.sleep) -> list[Path]:
    """One CSV per 5-day chunk of [start, end], named by the chunk's first day."""
    box = ",".join(f"{v:g}" for v in bbox)
    paths = []
    day = start
    while day <= end:
        n = min(5, (end - day).days + 1)
        url = f"{FIRMS}/api/area/csv/{map_key}/{source}/{box}/{n}/{day.isoformat()}"
        for wait in (*BACKOFF, None):
            status, detail = None, ""
            try:
                r = requests.get(url, timeout=TIMEOUT)
                status = r.status_code
                if status == 200 and "latitude" in r.text.split("\n", 1)[0].split(","):
                    break
                # FIRMS reports errors as text with HTTP 200 (e.g. "Invalid MAP_KEY").
                detail = r.text[:200].replace(map_key, "***").strip()
            except requests.RequestException as e:
                detail = type(e).__name__  # str(e) contains the URL, which contains the key
            if wait is None:
                raise FirmsError(source, day, status, detail) from None
            log.warning("FIRMS %s %s failed (HTTP %s), retrying in %s s", source, day, status, wait)
            sleep(wait)
        path = Path(out_dir) / source / f"{day.isoformat()}.csv"
        _save(path, r.content)
        paths.append(path)
        day += timedelta(days=n)
    return paths


def clip_wkt(region: str) -> str:
    cfg = settings.REGIONS[region]
    shp = Path(os.environ.get("FIRE_WORK_ROOT") or settings.ROOT) / cfg["clip_shapefile"]
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    wkt = con.execute(
        "SELECT ST_AsText(ST_Buffer(ST_Union_Agg(geom), ?)) FROM ST_Read(?) WHERE NAME = ?",
        [cfg["buffer_deg"], shp.as_posix(), cfg["clip_name"]]).fetchone()[0]
    if wkt is None:
        raise ValueError(f"no feature with NAME = {cfg['clip_name']!r} in {shp}")
    return wkt


def _satellite_sql(source: str) -> tuple[str, str]:
    """(sensor, SQL expression for satellite). Accepts archive names (viirs-jpss1) and API names (VIIRS_NOAA20_NRT)."""
    s = source.lower()
    if s.startswith("modis"):
        return "MODIS", "CASE upper(satellite[1]) WHEN 'A' THEN 'Aqua' WHEN 'T' THEN 'Terra' ELSE satellite END"
    if s.startswith("viirs"):
        for names, sat in ((("snpp",), "SNPP"), (("jpss1", "noaa20"), "NOAA20"), (("jpss2", "noaa21"), "NOAA21")):
            if any(n in s for n in names):
                return "VIIRS", f"'{sat}'"
    raise ValueError(f"unknown FIRMS source: {source!r}")


def _select_sql(con, path: Path, source: str, processing: str) -> str:
    if processing not in ("SP", "NRT"):
        raise ValueError(f"processing must be SP or NRT, got {processing!r}")
    sensor, satellite = _satellite_sql(source)
    src = f"read_csv('{Path(path).as_posix().replace(chr(39), chr(39) * 2)}', all_varchar=true, header=true)"
    header = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
    if sensor == "MODIS":
        conf = (f"CASE WHEN TRY_CAST(confidence AS INTEGER) < {settings.CONF_MODIS_MIN} THEN 'l' "
                "WHEN TRY_CAST(confidence AS INTEGER) < 80 THEN 'n' "
                "WHEN TRY_CAST(confidence AS INTEGER) >= 80 THEN 'h' END")
    else:
        conf = "lower(confidence[1])"  # l/n/h or low/nominal/high
    return f"""
        SELECT latitude::DOUBLE, longitude::DOUBLE, acq_date::DATE, replace(acq_time, ':', '')::SMALLINT,
               '{sensor}', {satellite}, confidence, {conf}, frp::REAL, daynight,
               {'bright_ti4' if 'bright_ti4' in header else 'brightness'}::REAL,
               {'"type"::TINYINT' if 'type' in header else 'NULL'}, '{processing}', version
        FROM {src}"""


def build_points_stage(con, inputs: list[tuple[Path, str, str]], out_dir: Path, clip_wkt: str) -> dict[int, dict]:
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute("""CREATE OR REPLACE TEMP TABLE _ingest_raw (
        lat DOUBLE, lon DOUBLE, acq_date DATE, acq_time SMALLINT, sensor VARCHAR, satellite VARCHAR,
        confidence_raw VARCHAR, conf_class VARCHAR, frp REAL, daynight VARCHAR, brightness REAL,
        firms_type TINYINT, processing VARCHAR, version VARCHAR)""")
    for path, source, processing in inputs:
        con.execute("INSERT INTO _ingest_raw " + _select_sql(con, path, source, processing))

    # Point-in-polygon against a detailed country outline is slow, so cells whose whole 0.1 deg box
    # lies inside the polygon skip it; only points in edge cells get the per-point test.
    con.execute(f"""CREATE OR REPLACE TEMP TABLE _ingest_stage AS
        WITH clip AS (SELECT ST_GeomFromText(?) AS g),
        d AS (
            SELECT *, {CELL_ID_SQL} AS cell_id, {CELL001_SQL} AS cell001_id, {REGION_ID_SQL} AS region_id,
                   ROW_NUMBER() OVER (PARTITION BY lat, lon, acq_date, acq_time, satellite
                                      ORDER BY (processing = 'SP') DESC, frp DESC NULLS LAST, brightness DESC NULLS LAST,
                                               confidence_raw, version, daynight) AS rn  -- full tie-break: the same row wins every run
            FROM _ingest_raw),
        cells AS (
            SELECT cell_id, ST_Within(ST_MakeEnvelope(x, y, x + 0.1, y + 0.1), g) AS whole
            FROM (SELECT DISTINCT cell_id, (cell_id % 3600) / 10.0 - 180 AS x, (cell_id // 3600) / 10.0 - 90 AS y
                  FROM d), clip)
        SELECT d.*, CASE WHEN whole THEN true ELSE ST_Within(ST_Point(lon, lat), g) END AS inside
        FROM d JOIN cells USING (cell_id), clip""", [clip_wkt])

    stats = {y: {"rows_in": n, "rows_out": out, "clip_dropped": clipped, "dup_dropped": dup}
             for y, n, out, clipped, dup in con.execute("""
                SELECT year(acq_date), count(*), count(*) FILTER (rn = 1 AND inside),
                       count(*) FILTER (rn = 1 AND NOT inside), count(*) FILTER (rn > 1)
                FROM _ingest_stage GROUP BY 1 ORDER BY 1""").fetchall()}
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for y in stats:
        con.execute(f"""COPY (SELECT {STAGE_COLUMNS} FROM _ingest_stage
                              WHERE rn = 1 AND inside AND year(acq_date) = {y} ORDER BY cell_id, acq_date)
                        TO '{(out_dir / f"points_{y}.parquet").as_posix().replace("'", "''")}'
                        (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    con.execute("DROP TABLE _ingest_raw; DROP TABLE _ingest_stage")
    return stats
