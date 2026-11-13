"""Grid ids. See docs/CONTRACTS.md section 3."""
import math

CELL_ID_SQL = "(LEAST(floor((lat + 90) * 10), 1799) * 3600 + LEAST(floor((lon + 180) * 10), 3599))::INTEGER"
CELL001_SQL = "(LEAST(floor((lat + 90) * 100), 17999) * 36000 + LEAST(floor((lon + 180) * 100), 35999))::BIGINT"
REGION_ID_SQL = "(LEAST(floor((lat + 90) / 5), 35) * 72 + LEAST(floor((lon + 180) / 5), 71))::INTEGER"


def _idx(v: float, scale: float, n: int) -> int:
    return min(int(math.floor(v * scale)), n - 1)


def cell_id(lat: float, lon: float) -> int:
    return _idx(lat + 90, 10, 1800) * 3600 + _idx(lon + 180, 10, 3600)


def cell001_id(lat: float, lon: float) -> int:
    return _idx(lat + 90, 100, 18000) * 36000 + _idx(lon + 180, 100, 36000)


def region_id(lat: float, lon: float) -> int:
    return _idx(lat + 90, 0.2, 36) * 72 + _idx(lon + 180, 0.2, 72)


def cell_center(cid: int) -> tuple[float, float]:
    return (cid // 3600) / 10 - 90 + 0.05, (cid % 3600) / 10 - 180 + 0.05
