"""Dekad table, baseline gaps and invariants. See docs/CONTRACTS.md sections 4.2, 4.3 and 5."""
import re
from pathlib import Path

import pyarrow as pa

from pipeline.harmonize import USABLE, chain_sql, factor_sql, files, q, ratio_join, ratio_tables

_SATS = ("terra", "Terra"), ("aqua", "Aqua"), ("snpp", "SNPP"), ("noaa20", "NOAA20"), ("noaa21", "NOAA21")
_YEAR = r"(\d{4})\.parquet$"


class InvariantError(Exception):
    pass


def dekad_sql(d: str) -> str:
    return f"(CASE WHEN day({d}) <= 10 THEN 1 WHEN day({d}) <= 20 THEN 2 ELSE 3 END)"


def build_gaps(con, glob: str, dates: dict) -> pa.Table:
    return con.sql(f"""
        WITH have AS (SELECT DISTINCT year(acq_date) AS y, month(acq_date) AS m, {dekad_sql('acq_date')} AS k, satellite
                      FROM read_parquet({q(glob)}) WHERE conf_class != 'l'),
        days AS (SELECT unnest(generate_series(a, b, INTERVAL 1 DAY))::DATE AS d
                 FROM (SELECT min(acq_date) AS a, max(acq_date) AS b FROM read_parquet({q(glob)}))),
        dk AS (SELECT DISTINCT year(d) AS y, month(d) AS m, {dekad_sql('d')} AS k FROM days),
        g AS (SELECT *, {chain_sql('make_date(y, m, k * 10 - 9)', dates)} AS chain_satellite FROM dk),
        pref(gap, fill, pri) AS (VALUES ('NOAA20', 'SNPP', 1), ('SNPP', 'NOAA20', 1), ('SNPP', 'Aqua', 2),
                                        ('Aqua', 'SNPP', 1), ('Aqua', 'Terra', 2), ('Terra', 'Aqua', 1))
        SELECT g.y::SMALLINT AS year, g.m::TINYINT AS month, g.k::TINYINT AS dekad, g.chain_satellite,
               arg_min(h.satellite, pref.pri) FILTER (h.satellite IS NOT NULL) AS filled_from
        FROM g
        LEFT JOIN pref ON pref.gap = g.chain_satellite
        LEFT JOIN have h ON h.y = g.y AND h.m = g.m AND h.k = g.k AND h.satellite = pref.fill
        WHERE NOT EXISTS (SELECT 1 FROM have c WHERE c.y = g.y AND c.m = g.m AND c.k = g.k
                          AND c.satellite = g.chain_satellite)
        GROUP BY ALL ORDER BY 1, 2, 3""").to_arrow_table()


def build_dekad(con, glob: str, ratios: pa.Table, variant: str, dates: dict, gaps: pa.Table, out_dir: Path) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ratio_tables(con, ratios, variant, "n", "_wn")
    ratio_tables(con, ratios, variant, "fd", "_wf")
    con.register("_gaps_in", gaps)
    dk = dekad_sql("pt.acq_date")
    chain = chain_sql("make_date(a.year, a.month, a.dekad * 10 - 9)", dates)
    sat = f"coalesce(a.filled_from, {chain})"          # satellite the harmonized values come from
    counts = ", ".join(f"count(*) FILTER (satellite = '{s}' AND conf_class != 'l')::INTEGER AS n_{c}" for c, s in _SATS)
    for f in files(glob):
        year = re.search(_YEAR, f).group(1)
        con.execute(f"""CREATE OR REPLACE TEMP TABLE _dekad AS
            WITH p AS (
                SELECT pt.cell_id, pt.region_id, pt.acq_date, pt.category, pt.satellite, pt.conf_class, pt.frp,
                       pt.processing, year(pt.acq_date) AS year, month(pt.acq_date) AS month, {dk} AS dekad,
                       gp.filled_from,
                       CASE WHEN gp.filled_from IS NULL THEN pt.in_baseline_chain
                            ELSE pt.satellite = gp.filled_from AND {USABLE} END AS ok,
                       CASE WHEN gp.filled_from IS NULL THEN pt.harm_weight ELSE {factor_sql('pt.satellite', '_wn')} END AS w,
                       CASE WHEN gp.filled_from IS NULL THEN pt.harm_weight_lo ELSE {factor_sql('pt.satellite', '_wn', '_lo')} END AS w_lo,
                       CASE WHEN gp.filled_from IS NULL THEN pt.harm_weight_hi ELSE {factor_sql('pt.satellite', '_wn', '_hi')} END AS w_hi
                FROM read_parquet({q(f)}) pt
                LEFT JOIN _gaps_in gp ON gp.year = year(pt.acq_date) AND gp.month = month(pt.acq_date)
                                     AND gp.dekad = {dk} AND gp.filled_from IS NOT NULL
                {ratio_join('_wn', variant, 'pt.region_id', 'pt.category', 'month(pt.acq_date)')}),
            a AS (
                SELECT cell_id, year, month, dekad, category, min(region_id) AS region_id,
                       any_value(filled_from) AS filled_from, {counts},
                       count(*) FILTER (conf_class = 'l')::INTEGER AS n_lowconf,
                       coalesce(sum(w) FILTER (ok), 0) AS harm_n, coalesce(sum(w_lo) FILTER (ok), 0) AS harm_n_lo,
                       coalesce(sum(w_hi) FILTER (ok), 0) AS harm_n_hi,
                       count(DISTINCT acq_date) FILTER (ok) AS fd_base,
                       coalesce(sum(frp) FILTER (ok), 0) AS frp_sum, max(frp) FILTER (ok) AS frp_max,
                       max((processing = 'NRT')::INTEGER) AS processing,
                       count(*) FILTER (ok AND (w IS NULL OR w_lo IS NULL OR w_hi IS NULL)) AS n_null
                FROM p GROUP BY cell_id, year, month, dekad, category)
            SELECT a.cell_id, a.year::SMALLINT AS year, a.month::TINYINT AS month, a.dekad::TINYINT AS dekad,
                   a.category::TINYINT AS category, a.n_terra, a.n_aqua, a.n_snpp, a.n_noaa20, a.n_noaa21, a.n_lowconf,
                   a.harm_n::REAL AS harm_n, a.harm_n_lo::REAL AS harm_n_lo, a.harm_n_hi::REAL AS harm_n_hi,
                   a.fd_base::SMALLINT AS fd_base,
                   (CASE WHEN a.fd_base = 0 THEN 0 ELSE a.fd_base * {factor_sql(sat, '_wf')} END)::REAL AS harm_fd,
                   (CASE WHEN a.fd_base = 0 THEN 0 ELSE a.fd_base * {factor_sql(sat, '_wf', '_lo')} END)::REAL AS harm_fd_lo,
                   (CASE WHEN a.fd_base = 0 THEN 0 ELSE a.fd_base * {factor_sql(sat, '_wf', '_hi')} END)::REAL AS harm_fd_hi,
                   a.frp_sum::REAL AS frp_sum, a.frp_max::REAL AS frp_max,
                   (CASE WHEN a.filled_from IS NOT NULL THEN 3
                         ELSE CASE {chain} WHEN 'NOAA20' THEN 0 WHEN 'SNPP' THEN 1 WHEN 'Aqua' THEN 2 ELSE 4 END
                    END)::TINYINT AS harm_from,
                   coalesce(a.processing, 0)::TINYINT AS processing, a.n_null
            FROM a {ratio_join('_wf', variant, 'a.region_id', 'a.category', 'a.month')}""")
        bad = con.execute("""SELECT count(*) FROM _dekad WHERE n_null > 0 OR harm_fd IS NULL OR harm_fd_lo IS NULL
            OR harm_fd_hi IS NULL""").fetchone()[0]
        if bad:
            raise ValueError(f"{bad} dekad rows from {f} have no conversion ratio (variant {variant!r})")
        con.execute(f"""COPY (SELECT * EXCLUDE (n_null) FROM _dekad ORDER BY cell_id, year, month, dekad, category)
            TO {q(out_dir / f'dekad_{year}.parquet')} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)""")
    con.execute("DROP TABLE IF EXISTS _dekad")


def check_invariants(con, points_glob: str, dekad_glob: str) -> None:
    P, D = f"read_parquet({q(points_glob)})", f"read_parquet({q(dekad_glob)})"
    one = lambda sql: con.execute(sql).fetchone()[0]
    file_year = f"try_cast(regexp_extract(filename, '{_YEAR}', 1) AS INTEGER)"

    for f in files(points_glob):     # per file keeps memory small; a cross-file duplicate fails date_range
        if con.execute(f"""SELECT 1 FROM read_parquet({q(f)}) GROUP BY lat, lon, acq_date, acq_time, satellite
                           HAVING count(*) > 1 LIMIT 1""").fetchone():
            raise InvariantError("duplicates")
    if one(f"""SELECT count(*) FROM read_parquet({q(points_glob)}, filename = true)
               WHERE year(acq_date) IS DISTINCT FROM {file_year}""") or one(
           f"""SELECT count(*) FROM read_parquet({q(dekad_glob)}, filename = true)
               WHERE year IS DISTINCT FROM {file_year}"""):
        raise InvariantError("date_range")
    if one(f"SELECT coalesce(sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21 + n_lowconf), 0) FROM {D}") != one(
            f"SELECT count(*) FROM {P}"):
        raise InvariantError("conservation")
    if one(f"""
        WITH gf AS (SELECT DISTINCT year, month, dekad FROM {D} WHERE harm_from = 3),
        d AS (SELECT year, sum(harm_n::DOUBLE) AS h FROM {D} WHERE harm_from != 3 GROUP BY 1),
        p AS (SELECT year(acq_date) AS year, sum(harm_weight::DOUBLE) AS w FROM {P} pt
              WHERE NOT EXISTS (SELECT 1 FROM gf WHERE gf.year = year(pt.acq_date) AND gf.month = month(pt.acq_date)
                                AND gf.dekad = {dekad_sql('pt.acq_date')})
              GROUP BY 1)
        SELECT count(*) FROM d FULL JOIN p USING (year)
        WHERE abs(coalesce(h, 0) - coalesce(w, 0)) > 1e-4 * greatest(abs(coalesce(w, 0)), 1)"""):
        raise InvariantError("harm_equals_weights")
