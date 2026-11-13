"""Fetch ESA CCI / C3S land cover 2020 (300 m) for a bbox from Microsoft Planetary Computer (open, no login)
and write it as a GeoTIFF recoded to IGBP class numbers, so pipeline.classify can read it.
Used because no Earthdata login was available for MCD12Q1 (docs/DECISIONS.md D5)."""
import json
import sys
import urllib.parse
import urllib.request

import numpy as np
import rasterio
from rasterio.windows import from_bounds

# C3S LCCS class -> nearest IGBP class number
LCCS_TO_IGBP = {
    10: 12, 11: 12, 12: 12, 20: 12,          # cropland (rainfed, irrigated)
    30: 14, 40: 14,                          # cropland / natural vegetation mosaics
    50: 2, 60: 4, 61: 4, 62: 4, 70: 1, 71: 1, 72: 1, 80: 3, 81: 3, 82: 3, 90: 5,   # forests
    100: 8, 110: 9,                          # tree/shrub/herbaceous mosaics -> savannas
    120: 7, 121: 7, 122: 7,                  # shrubland
    130: 10,                                 # grassland
    140: 16, 150: 16, 151: 16, 152: 16, 153: 16,   # lichens, sparse vegetation -> barren
    160: 5, 170: 5,                          # flooded forest -> forest
    180: 11,                                 # flooded shrub/herbaceous -> wetland
    190: 13,                                 # urban
    200: 16, 201: 16, 202: 16,               # bare
    210: 17,                                 # water
    220: 15,                                 # snow and ice
}
HREFS = [
    "https://landcoverdata.blob.core.windows.net/esa-cci-lc/cog/v2.1.1/N00E045/2020/C3S-LC-L4-LCCS-Map-300m-P1Y-2020-v2.1.1-N00E045-lccs_class.tif",
    "https://landcoverdata.blob.core.windows.net/esa-cci-lc/cog/v2.1.1/N00E090/2020/C3S-LC-L4-LCCS-Map-300m-P1Y-2020-v2.1.1-N00E090-lccs_class.tif",
]


def sign(href: str) -> str:
    url = "https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=" + urllib.parse.quote(href, safe="")
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)["href"]


def main(w, s, e, n, out_prefix):
    lut = np.zeros(256, dtype=np.uint8)
    for k, v in LCCS_TO_IGBP.items():
        lut[k] = v
    outs = []
    for i, href in enumerate(HREFS):
        with rasterio.open(sign(href)) as src:
            b = src.bounds
            ww, ss, ee, nn = max(w, b.left), max(s, b.bottom), min(e, b.right), min(n, b.top)
            if ww >= ee or ss >= nn:
                continue
            win = from_bounds(ww, ss, ee, nn, src.transform).round_offsets().round_lengths()
            data = src.read(1, window=win)
            profile = src.profile.copy()
            profile.update(driver="GTiff", height=data.shape[0], width=data.shape[1],
                           transform=src.window_transform(win), dtype="uint8", nodata=0,
                           compress="deflate", tiled=True, blockxsize=512, blockysize=512, count=1)
            out = f"{out_prefix}_{i}.tif"
            with rasterio.open(out, "w", **profile) as dst:
                dst.write(lut[data], 1)
            vals, counts = np.unique(data, return_counts=True)
            unmapped = [int(v) for v in vals if v != 0 and v not in LCCS_TO_IGBP]
            print(out, data.shape, "crs", src.crs, "unmapped classes:", unmapped)
            outs.append(out)
    return outs


if __name__ == "__main__":
    w, s, e, n = map(float, sys.argv[1:5])
    main(w, s, e, n, sys.argv[5])
