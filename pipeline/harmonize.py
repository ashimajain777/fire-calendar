"""Conversion ratios, baseline chain and per-point weights. See docs/CONTRACTS.md section 5, docs/PLAN.md section 4."""
import glob as globlib
from datetime import date
from pathlib import Path

import pyarrow as pa

from pipeline import settings

LINKS = {"terra_aqua": ("Terra", "Aqua"), "aqua_snpp": ("Aqua", "SNPP"), "snpp_noaa20": ("SNPP", "NOAA20")}
_PREFIX = (("terra_aqua", "t"), ("aqua_snpp", "r"), ("snpp_noaa20", "s"))
_SFX = (("r", ""), ("r_lo", "_lo"), ("r_hi", "_hi"))
USABLE = f"conf_class != 'l' AND category IN ({', '.join(map(str, sorted(settings.HARMONIZED)))})"


def q(s) -> str:
    """SQL string literal (paths with forward slashes)."""
    return "'" + str(s).replace("\\", "/").replace("'", "''") + "'"


def files(glob) -> list[str]:
    out = sorted(globlib.glob(str(glob)))
    if not out:
        raise FileNotFoundError(glob)
    return out


def chain_dates(con, glob: str) -> dict:
    first = dict(con.execute(f"""SELECT satellite, min(acq_date) FROM read_parquet({q(glob)})
        WHERE satellite IN ('Aqua', 'SNPP', 'NOAA20') GROUP BY 1""").fetchall())

    def start(d):
        if d is None or d.day <= 3:
            return d and d.replace(day=1)
        return date(d.year + d.month // 12, d.month % 12 + 1, 1)

    return {k: start(first.get(s)) for k, s in (("aqua_start", "Aqua"), ("snpp_start", "SNPP"),
                                                ("noaa20_start", "NOAA20"))}


def chain_sql(d: str, dates: dict) -> str:
    """SQL expression: the chain satellite for date expression `d`. A missing start date never takes over."""
    lit = lambda k: f"DATE '{dates.get(k) or '9999-12-31'}'"
    return (f"(CASE WHEN {d} >= {lit('noaa20_start')} THEN 'NOAA20' WHEN {d} >= {lit('snpp_start')} THEN 'SNPP' "
            f"WHEN {d} >= {lit('aqua_start')} THEN 'Aqua' ELSE 'Terra' END)")


def fit_ratios(con, glob: str, link: str, fit_years, metric: str, variant: str) -> pa.Table:
    src, tgt = LINKS[link]
    if metric not in ("n", "fd") or variant not in ("region", "noregion"):
        raise ValueError((metric, variant))
    years = ", ".join(str(int(y)) for y in fit_years)
    region = "region_id" if variant == "region" else "-1"
    # fd: one count per (satellite, cell, day, category); n: every detection
    con.execute(f"""CREATE OR REPLACE TEMP TABLE _fit_base AS
        SELECT y, region_id, stratum, month, count(*) FILTER (satellite = '{src}') AS src,
               count(*) FILTER (satellite = '{tgt}') AS tgt
        FROM (SELECT {'DISTINCT' if metric == 'fd' else ''} satellite, year(acq_date) AS y, month(acq_date) AS month,
                     {region} AS region_id, category AS stratum, cell_id, acq_date
              FROM read_parquet({q(glob)})
              WHERE {USABLE} AND satellite IN ('{src}', '{tgt}')
                AND list_contains([{years}]::INTEGER[], year(acq_date)))
        GROUP BY ALL""")

    def level(cols, where="TRUE"):
        c = "".join(f"{x}, " for x in cols)
        by = f"GROUP BY {', '.join(cols)}" if cols else ""
        return f"""(SELECT {c} sum(src) AS src, sum(src) + sum(tgt) AS nd, sum(tgt) / nullif(sum(src), 0) AS r,
                           quantile_cont(yr, 0.1) AS lo, quantile_cont(yr, 0.9) AS hi, count(yr) AS ny
                    FROM (SELECT {c} sum(src) AS src, sum(tgt) AS tgt, sum(tgt) / nullif(sum(src), 0) AS yr
                          FROM _fit_base WHERE {where} GROUP BY {', '.join(cols + ['y'])}) {by})"""

    landscape = f"stratum IN ({', '.join(map(str, sorted(settings.LANDSCAPE)))})"
    ladder = [("none", ["region_id", "stratum", "month"], "TRUE"), ("india", ["stratum", "month"], "TRUE"),
              ("stratum", ["stratum"], "TRUE"), ("landscape", [], landscape)]
    if variant == "noregion":
        del ladder[1]            # region_id is -1 everywhere, so 'none' already is the all-region level
    cand = " UNION ALL ".join(f"""
        SELECT g.region_id, g.stratum, g.month, {i} AS pri, '{name}' AS fallback, l.r, l.lo, l.hi, l.ny, l.nd
        FROM grid g JOIN {level(cols, where)} l ON {' AND '.join(f'l.{x} = g.{x}' for x in cols) or 'TRUE'}
        WHERE l.src > 0 AND (l.nd >= {int(settings.MIN_DETECTIONS)} OR {'TRUE' if name == 'landscape' else 'FALSE'})"""
                              for i, (name, cols, where) in enumerate(ladder))
    regions = f"SELECT DISTINCT region_id FROM read_parquet({q(glob)})" if variant == "region" else "SELECT -1 AS region_id"
    return con.sql(f"""
        WITH grid AS (SELECT region_id::INTEGER AS region_id, s::TINYINT AS stratum, m::TINYINT AS month
                      FROM ({regions}), range(6) t(s), range(1, 13) u(m)),
        cand AS ({cand}),
        best AS (SELECT * FROM cand QUALIFY row_number() OVER (PARTITION BY region_id, stratum, month ORDER BY pri) = 1)
        SELECT '{variant}' AS variant, '{link}' AS link, '{metric}' AS metric, region_id, stratum, month,
               r::DOUBLE AS r, (CASE WHEN ny >= 2 THEN lo ELSE r END)::DOUBLE AS r_lo,
               (CASE WHEN ny >= 2 THEN hi ELSE r END)::DOUBLE AS r_hi, coalesce(ny, 0)::INTEGER AS n_years,
               coalesce(nd, 0)::BIGINT AS n_detections, coalesce(fallback, 'landscape') AS fallback
        FROM grid LEFT JOIN best USING (region_id, stratum, month)
        ORDER BY region_id, stratum, month""").to_arrow_table()


def fit_all(con, glob: str, exclude_year: int | None = None) -> pa.Table:
    return pa.concat_tables([
        fit_ratios(con, glob, link, [y for y in settings.FIT_YEARS[link] if y != exclude_year], metric, variant)
        for link in LINKS for metric in ("n", "fd") for variant in ("region", "noregion")])


def ratio_tables(con, ratios: pa.Table, variant: str, metric: str, name: str) -> None:
    """Temp table `name`: one row per (region_id, stratum, month) with t, r, s (+ _lo, _hi);
    `name`_d: one row, the coarsest-level ratios (landscape if present), used when a key has no row."""
    con.register("_ratios_in", ratios)
    src = f"""(SELECT *, (CASE fallback WHEN 'landscape' THEN 3 WHEN 'stratum' THEN 2 WHEN 'india' THEN 1 ELSE 0 END)
                         * 1e15 + n_detections AS lvl
               FROM _ratios_in WHERE variant = {q(variant)} AND metric = {q(metric)})"""
    wide = ", ".join(f"max({c}) FILTER (link = '{l}') AS {p}{x}" for l, p in _PREFIX for c, x in _SFX)
    dflt = ", ".join(f"arg_max({c}, lvl) FILTER (link = '{l}') AS {p}{x}" for l, p in _PREFIX for c, x in _SFX)
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name} AS SELECT region_id, stratum, month, {wide} FROM {src} GROUP BY ALL")
    con.execute(f"CREATE OR REPLACE TEMP TABLE {name}_d AS SELECT {dflt} FROM {src}")


def ratio_join(w: str, variant: str, region: str, stratum: str, month: str) -> str:
    key = region if variant == "region" else "-1"
    return (f"LEFT JOIN {w} ON {w}.region_id = {key} AND {w}.stratum = {stratum} AND {w}.month = {month} "
            f"CROSS JOIN {w}_d")


def factor_sql(sat: str, w: str, sfx: str = "") -> str:
    """Product of ratios that converts satellite `sat` to NOAA-20 units (NULL for anything else)."""
    t, r, s = (f"coalesce({w}.{c}{sfx}, {w}_d.{c}{sfx})" for c in "trs")
    return (f"(CASE {sat} WHEN 'NOAA20' THEN 1 WHEN 'SNPP' THEN {s} WHEN 'Aqua' THEN {r} * {s} "
            f"WHEN 'Terra' THEN {t} * {r} * {s} END)")


def apply_weights(con, glob: str, ratios: pa.Table, variant: str, dates: dict, out_dir: Path) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ratio_tables(con, ratios, variant, "n", "_wn")
    for f in files(glob):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE _weighted AS
            SELECT * EXCLUDE (_f, _f_lo, _f_hi),
                   (CASE WHEN in_baseline_chain THEN _f ELSE 0 END)::REAL AS harm_weight,
                   (CASE WHEN in_baseline_chain THEN _f_lo ELSE 0 END)::REAL AS harm_weight_lo,
                   (CASE WHEN in_baseline_chain THEN _f_hi ELSE 0 END)::REAL AS harm_weight_hi
            FROM (SELECT p.*, (p.satellite = {chain_sql('p.acq_date', dates)} AND {USABLE}) AS in_baseline_chain,
                         {factor_sql('p.satellite', '_wn')} AS _f, {factor_sql('p.satellite', '_wn', '_lo')} AS _f_lo,
                         {factor_sql('p.satellite', '_wn', '_hi')} AS _f_hi
                  FROM read_parquet({q(f)}) p
                  {ratio_join('_wn', variant, 'p.region_id', 'p.category', 'month(p.acq_date)')})""")
        bad = con.execute("""SELECT count(*) FROM _weighted WHERE in_baseline_chain IS NULL OR (in_baseline_chain
            AND (harm_weight IS NULL OR harm_weight_lo IS NULL OR harm_weight_hi IS NULL))""").fetchone()[0]
        if bad:
            raise ValueError(f"{bad} points in {f} have no weight (ratios missing for variant {variant!r}?)")
        con.execute(f"""COPY (SELECT * FROM _weighted ORDER BY cell_id, acq_date) TO {q(out_dir / Path(f).name)}
            (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    con.execute("DROP TABLE IF EXISTS _weighted")
