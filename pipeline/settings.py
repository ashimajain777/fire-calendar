"""Shared constants and the single data-location config. See docs/CONTRACTS.md."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CATEGORY = {"agricultural": 0, "forest": 1, "grass_shrub": 2, "other_veg": 3,
            "urban": 4, "industrial": 5, "volcanic": 6, "offshore": 7}
LANDSCAPE = {0, 1, 2, 3}
HARMONIZED = {0, 1, 2, 3, 4, 5}
BASE_YEARS = range(2003, 2026)
CONF_MODIS_MIN = 30
MIN_DETECTIONS = 200
FIT_YEARS = {"terra_aqua": range(2003, 2012), "aqua_snpp": range(2013, 2022),
             "snpp_noaa20": range(2019, 2026)}
SATELLITES = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
MASK_MIN_DAYS = 30
MASK_MIN_YEARS = 3
MASK_WINDOW_YEARS = 5
MASK_MIN_MONTHS = 6
MASK_MIN_TYPED = 3

REGIONS = {
    "india": {
        "country_file_name": "India",
        "bbox": (68.0, 6.0, 98.0, 38.0),
        "clip_shapefile": "work/aux/ne_10m_admin_0_countries_ind.shp",
        "clip_name": "India",
        "buffer_deg": 0.1,
    }
}


def load_config() -> dict:
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def load_env() -> dict:
    """Read .env (if present) into os.environ without printing values."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
    return os.environ
