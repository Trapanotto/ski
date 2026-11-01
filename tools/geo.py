"""Gemeinsame Helfer: Koordinaten (LV95 <-> WGS84) und Mosaik-Laden."""
from pathlib import Path
import numpy as np


def lv95_to_wgs84(e, n):
    y = (np.asarray(e, float) - 2600000) / 1e6
    x = (np.asarray(n, float) - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lon * 100 / 36, lat * 100 / 36


def wgs84_to_lv95(lon, lat):
    """swisstopo-Naeherungsformel (Genauigkeit ~1 m)."""
    phi = (np.asarray(lat, float) * 3600 - 169028.66) / 10000
    lam = (np.asarray(lon, float) * 3600 - 26782.5) / 10000
    e = (2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi ** 2 - 44.54 * lam ** 3)
    n = (1200147.07 + 308807.95 * phi + 3745.25 * lam ** 2 + 76.63 * phi ** 2 - 194.56 * lam ** 2 * phi
         + 119.79 * phi ** 3)
    return e, n


def mosaic_max(folder, bounds, res):
    """Wie mosaic(), aber jedes Zielpixel = Maximum der feineren Quellpixel (z. B. Baumkronen)."""
    import rasterio
    e0, n0, e1, n1 = bounds
    W = int(round((e1 - e0) / res)) + 1
    H = int(round((n1 - n0) / res)) + 1
    out = np.full((H, W), -9999, np.float32)
    for f in sorted(Path(folder).glob("*.tif")):
        with rasterio.open(f) as s:
            a = s.read(1).astype(np.float32)
            a[a == s.nodata] = -9999
            f_ = int(round(res / s.res[0]))
            # Quellpixel-Zentren -> Zielknoten (Knoten liegen bei e0 + i*res)
            left, top = s.bounds.left, s.bounds.top
            hh, ww = a.shape
            ys, xs = np.mgrid[0:hh, 0:ww]
            ex = left + (xs + 0.5) * s.res[0]
            ny = top - (ys + 0.5) * s.res[1]
            ci = np.round((ex - e0) / res).astype(int)
            rj = np.round((n1 - ny) / res).astype(int)
            ok = (ci >= 0) & (ci < W) & (rj >= 0) & (rj < H)
            np.maximum.at(out, (rj[ok], ci[ok]), a[ok])
            del f_
    return out[None]


def mosaic(folder, bounds, res, resampling="bilinear", agg=None):
    """Alle GeoTIFFs eines Ordners auf ein Raster (bounds=E0,N0,E1,N1, res in m) bringen.

    Zeile 0 = Norden. Pixelzentren liegen auf E0 + i*res bzw. N1 - j*res (Knotenraster).
    """
    import rasterio
    from rasterio.merge import merge
    from rasterio.enums import Resampling

    files = sorted(Path(folder).glob("*.tif"))
    srcs = [rasterio.open(f) for f in files]
    e0, n0, e1, n1 = bounds
    # Knotenraster: Pixel mit Zentrum auf den Knoten -> Grenzen um res/2 erweitern
    b = (e0 - res / 2, n0 - res / 2, e1 + res / 2, n1 + res / 2)
    kw = {}
    if agg == "max":
        kw["method"] = "max"
    nod = -9999 if srcs[0].dtypes[0].startswith("float") else 0
    arr, _ = merge(srcs, bounds=b, res=res, resampling=getattr(Resampling, resampling), nodata=nod, **kw)
    for s in srcs:
        s.close()
    return arr
