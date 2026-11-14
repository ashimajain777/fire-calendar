"""Validation of the harmonization: step removal, leave-one-year-out, breakdown. See docs/CONTRACTS.md §4.3, §5."""
import importlib
import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import settings

LINK_COLS = {"terra_aqua": ("n_terra", "n_aqua"), "aqua_snpp": ("n_aqua", "n_snpp"),
             "snpp_noaa20": ("n_snpp", "n_noaa20")}  # link -> (source, target) columns of the pre-aggregate
VARIANTS = ("region", "noregion")
COVERAGE_GATE = (0.6, 0.95)
MIN_BOX_OBSERVED = 50
DIRECT_YEARS = (2019, 2021)   # NOAA-20 starts 2018-04-01, so 2018 is partial

LOYO_SCHEMA = pa.schema([
    ("variant", pa.string()), ("link", pa.string()), ("metric", pa.string()), ("held_year", pa.int16()),
    ("unit_type", pa.string()), ("unit", pa.string()), ("observed", pa.float64()), ("predicted", pa.float64()),
    ("lo", pa.float64()), ("hi", pa.float64()), ("fit_years", pa.string())])
BREAKDOWN_SCHEMA = pa.schema([
    ("variant", pa.string()), ("link", pa.string()), ("group_type", pa.string()), ("grp", pa.int32()),
    ("mdape", pa.float64()), ("bias", pa.float64()), ("coverage", pa.float64()), ("n", pa.int32())])


def _in(codes) -> str:
    return "(" + ",".join(str(c) for c in sorted(codes)) + ")"


def _yearly(con, dekad_glob):
    return con.execute(f"""
        select year::int, sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21)::double, sum(harm_n)::double
        from read_parquet('{dekad_glob}', union_by_name = true)
        where category in {_in(settings.LANDSCAPE)} group by 1""").fetchall()


def step_stats(con, dekad_glob: str) -> dict:
    naive = {y: n for y, n, _ in _yearly(con, dekad_glob)}
    harm = {y: h for y, _, h in _yearly(con, dekad_glob)}

    def step(series):
        after = [series[y] for y in (2012, 2013, 2014) if y in series]
        before = [series[y] for y in (2009, 2010, 2011) if y in series]
        if not after or not before or sum(before) == 0:
            return None
        return float(np.mean(after) / np.mean(before))

    yoy = [harm[y] / harm[y - 1] for y in settings.BASE_YEARS
           if y != 2012 and y in harm and y - 1 in settings.BASE_YEARS and harm.get(y - 1)]
    p10, p90 = (float(x) for x in np.percentile(yoy, [10, 90])) if yoy else (None, None)
    return {"naive_step": step(naive), "harm_step": step(harm), "yoy_p10": p10, "yoy_p90": p90}


def annual_series(con, dekad_glob: str) -> pa.Table:
    return con.sql(f"""
        with y as (
            select year::smallint as year, sum(n_terra)::double as terra, sum(n_aqua)::double as aqua,
                   sum(n_snpp)::double as snpp, sum(n_noaa20)::double as noaa20,
                   sum(n_terra + n_aqua + n_snpp + n_noaa20 + n_noaa21)::double as naive,
                   sum(harm_n)::double as harm, sum(harm_n_lo)::double as harm_lo, sum(harm_n_hi)::double as harm_hi
            from read_parquet('{dekad_glob}', union_by_name = true)
            where category in {_in(settings.LANDSCAPE)} group by 1)
        select year, series, value
        from (unpivot y on terra, aqua, snpp, noaa20, naive, harm, harm_lo, harm_hi into name series value value)
        order by year, series""").to_arrow_table()


def _preagg(con, glob: str, metric: str) -> str:
    """One small table of per-satellite counts by (year, region, category, month, 1 deg box); returns its name."""
    if metric not in ("n", "fd"):
        raise ValueError(f"unknown metric {metric!r}")
    # fd: a 0.1 deg cell lies inside one 1 deg box, so distinct cell-days add up across boxes
    count = "count(*)" if metric == "n" else "count(distinct (cell_id, acq_date))"
    cols = ", ".join(f"{count} filter (where satellite = '{sat}') as n_{sat.lower()}"
                     for sat in ("Terra", "Aqua", "SNPP", "NOAA20"))
    name = f"_val_pre_{metric}"
    con.execute(f"""
        create or replace temp table {name} as
        select year(acq_date)::int as year, region_id, category::int as category, month(acq_date)::int as month,
               floor(lat)::int as lat1, floor(lon)::int as lon1, {cols}
        from read_parquet('{glob}', union_by_name = true)
        where conf_class != 'l' and category in {_in(settings.HARMONIZED)}
        group by all""")
    return name


def loyo(con, glob: str, link: str, variant: str, metric: str = "n", pre: str | None = None) -> pa.Table:
    """Leave-one-year-out. `pre` names an existing _preagg table to reuse (same glob and metric)."""
    harmonize = importlib.import_module("pipeline.harmonize")  # lazy: built in parallel, faked in tests
    pre = pre or _preagg(con, glob, metric)
    src, tgt = LINK_COLS[link]
    years = list(settings.FIT_YEARS[link])
    present = {r[0] for r in con.execute(f"select distinct year from {pre} where {src} + {tgt} > 0").fetchall()}
    # a unit with no matching ratio is predicted as 0: the model has nothing to say there
    agg = (f"sum({tgt})::double as observed, coalesce(sum({src} * r), 0)::double as predicted, "
           f"coalesce(sum({src} * r_lo), 0)::double as lo, coalesce(sum({src} * r_hi), 0)::double as hi")
    out = []
    for held in years:
        if held not in present:
            continue
        fit_years = [y for y in years if y != held]
        con.register("_val_ratios", harmonize.fit_ratios(con, glob, link, fit_years, metric, variant))
        out.append(con.sql(f"""
            with p as (
                select p.*, r.r, r.r_lo, r.r_hi
                from {pre} p left join _val_ratios r
                  on r.stratum = p.category and r.month = p.month and r.region_id in (-1, p.region_id)
                where p.year = {held}),
            u as (
                select 'stratum_month' as unit_type, concat(category, '-', month) as unit, {agg} from p group by 1, 2
                union all
                select 'box1deg', concat(lat1, '_', lon1, '-', month), {agg} from p group by 1, 2
                having sum({tgt}) >= {MIN_BOX_OBSERVED}
                union all
                select 'region_month', month::varchar, {agg} from p group by 1, 2)
            select '{variant}' as variant, '{link}' as link, '{metric}' as metric, {held}::smallint as held_year,
                   u.*, '{",".join(map(str, fit_years))}' as fit_years
            from u order by unit_type, unit""").to_arrow_table().cast(LOYO_SCHEMA))
        con.unregister("_val_ratios")
    return pa.concat_tables(out) if out else LOYO_SCHEMA.empty_table()


def _metrics(obs, pred, lo, hi) -> dict:
    obs, pred, lo, hi = (np.asarray(a, dtype=float) for a in (obs, pred, lo, hi))
    pos = obs > 0
    return {"mdape": float(np.median(np.abs(pred[pos] - obs[pos]) / obs[pos])) if pos.any() else None,
            "bias": float((pred.sum() - obs.sum()) / obs.sum()) if obs.sum() > 0 else None,
            "coverage": float(np.mean((lo <= obs) & (obs <= hi))) if len(obs) else None,
            "n": int(len(obs))}


def _cols(table, mask):
    return [table[c].to_numpy()[mask] for c in ("observed", "predicted", "lo", "hi")]


def summarise_loyo(table) -> dict:
    unit_type = np.array(table["unit_type"].to_pylist(), dtype=object)
    return {str(ut): _metrics(*_cols(table, unit_type == ut)) for ut in sorted(set(unit_type))}


def breakdown(table) -> pa.Table:
    """By stratum and by month, from the stratum_month units of one variant and one link."""
    unit_type = np.array(table["unit_type"].to_pylist(), dtype=object)
    sm = unit_type == "stratum_month"
    if not sm.any():
        return BREAKDOWN_SCHEMA.empty_table()
    variant, link = table["variant"][0].as_py(), table["link"][0].as_py()
    parts = [u.split("-") for u in table["unit"].to_pylist()]  # "stratum-month"; other unit types never selected
    rows = []
    for i, group_type in enumerate(("stratum", "month")):
        key = np.array([int(p[i]) if ok else -1 for p, ok in zip(parts, sm)])
        for g in sorted(set(key[sm])):
            rows.append({"variant": variant, "link": link, "group_type": group_type, "grp": int(g),
                         **_metrics(*_cols(table, sm & (key == g)))})
    return pa.Table.from_pylist(rows, schema=BREAKDOWN_SCHEMA)


def choose_variant(summary: dict) -> tuple[str, str]:
    def score(v):
        m = [link.get("region_month", {}).get("mdape") for link in summary[v].values()]
        return float(np.mean(m)) if m and None not in m else float("inf")

    def eligible(v):
        cov = [link.get("region_month", {}).get("coverage") for link in summary[v].values()]
        return bool(cov) and all(c is not None and COVERAGE_GATE[0] <= c <= COVERAGE_GATE[1] for c in cov)

    # "noregion" first so that min() returns it on an exact tie
    variants = sorted(summary, key=lambda v: v != "noregion")
    scores = {v: score(v) for v in variants}
    pool = [v for v in variants if eligible(v)]
    chosen = min(pool or variants, key=scores.get)
    listing = ", ".join(f"{v} {scores[v]:.4f}" for v in variants)
    lo, hi = COVERAGE_GATE
    if not pool:
        why = (f"Neither variant has whole-region monthly band coverage within {lo:.0%} to {hi:.0%} on every link, "
               f"so the lower error was used without the coverage check")
    elif len(pool) < len(variants):
        why = f"Only {chosen} has whole-region monthly band coverage within {lo:.0%} to {hi:.0%} on every link"
    elif len(set(scores.values())) == 1:
        why = "The variants tie, so the simpler one without regions was kept"
    else:
        why = "It has the lower error and its band coverage passes the check"
    return chosen, (f"Chose {chosen}. Mean leave-one-year-out median absolute error of whole-region monthly totals "
                    f"across links (as a fraction): {listing}. {why}.")


def _direct(con, pre: str) -> pa.Table:
    """LOYO for a direct Aqua -> NOAA-20 stratum x month ratio of totals; harmonize has no such link."""
    y0, y1 = DIRECT_YEARS
    return con.sql(f"""
        with d as (
            select year, category, month, sum(n_aqua)::double as s, sum(n_noaa20)::double as t
            from {pre} where year between {y0} and {y1} group by all),
        held as (select distinct year as h from d),
        rat as (
            select h, category, month, sum(t) / nullif(sum(s), 0) as r,
                   quantile_cont(t / s, 0.1) filter (where s > 0) as r_lo,
                   quantile_cont(t / s, 0.9) filter (where s > 0) as r_hi
            from d, held where year != h group by all)
        select d.year, d.month, sum(t) as observed, coalesce(sum(s * r), 0) as predicted,
               coalesce(sum(s * r_lo), 0) as lo, coalesce(sum(s * r_hi), 0) as hi
        from d left join rat on rat.h = d.year and rat.category = d.category and rat.month = d.month
        group by all""").to_arrow_table()


def direct_aqua_noaa20(con, glob: str, pre: str | None = None) -> dict:
    t = _direct(con, pre or _preagg(con, glob, "n"))
    m = _metrics(*_cols(t, slice(None)))
    return {k: m[k] for k in ("mdape", "coverage", "n")}


def write_validation(con, points_glob: str, dekad_glob: str, out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pre = _preagg(con, points_glob, "n")
    tables, breakdowns, summary = [], [], {}
    for variant in VARIANTS:
        for link in settings.FIT_YEARS:
            t = loyo(con, points_glob, link, variant, "n", pre=pre)
            tables.append(t)
            breakdowns.append(breakdown(t))
            summary.setdefault(variant, {})[link] = summarise_loyo(t)
    chosen, reason = choose_variant(summary)
    result = {"chosen_variant": chosen, "reason": reason, "step": step_stats(con, dekad_glob), "loyo": summary,
              "direct_aqua_noaa20": direct_aqua_noaa20(con, points_glob, pre=pre),
              "mask_counts": {}, "category_counts": {}}  # the two counts are filled by the orchestrator
    pq.write_table(annual_series(con, dekad_glob), out_dir / "annual_series.parquet", compression="zstd")
    pq.write_table(pa.concat_tables(tables), out_dir / "loyo.parquet", compression="zstd")
    pq.write_table(pa.concat_tables(breakdowns), out_dir / "breakdown.parquet", compression="zstd")
    (out_dir / "summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
