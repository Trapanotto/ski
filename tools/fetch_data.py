"""Einmaliger Download der Geodaten fuer eine Strecke (swisstopo + OSM-Pistenlinie).

Aufruf:  .venv\\Scripts\\python tools/fetch_data.py lauberhorn
Ergebnis: data/raw/<strecke>/...   (nicht im Git)
"""
import json
import sys
import math
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STAC = "https://data.geo.admin.ch/api/stac/v1"
UA = {"User-Agent": "TrapanottoSki/0.1 (https://github.com/Trapanotto/ski)"}


def lv95_to_wgs84(e, n):
    """Naeherungsformel von swisstopo (Genauigkeit ~1 m, reicht fuer bbox)."""
    y = (e - 2600000) / 1e6
    x = (n - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lon * 100 / 36, lat * 100 / 36


def stac_items(collection, bbox_wgs):
    url = f"{STAC}/collections/{collection}/items"
    params = {"bbox": ",".join(f"{v:.6f}" for v in bbox_wgs), "limit": 100}
    items = []
    while url:
        r = requests.get(url, params=params, headers=UA, timeout=60)
        r.raise_for_status()
        js = r.json()
        items += js["features"]
        url = next((l["href"] for l in js["links"] if l["rel"] == "next"), None)
        params = None
    return items


def latest_per_tile(items):
    """Pro 1-km-Kachel nur den neusten Jahrgang behalten."""
    best = {}
    for it in items:
        parts = it["id"].split("_")
        year, tile = parts[-2], parts[-1]
        if tile not in best or year > best[tile][0]:
            best[tile] = (year, it)
    return {t: v[1] for t, v in best.items()}


def tile_in_core(tile, core):
    e0, n0 = (int(v) * 1000 for v in tile.split("-"))
    return e0 < core[2] and e0 + 1000 > core[0] and n0 < core[3] and n0 + 1000 > core[1]


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(4):
        try:
            with requests.get(url, headers=UA, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            tmp.replace(dest)
            return True
        except Exception as ex:  # Netzwerkfehler: kurz warten, nochmals
            print("  retry", attempt + 1, ex)
            time.sleep(3)
    raise RuntimeError(f"Download fehlgeschlagen: {url}")


def fetch_tiles(collection, core, out, pick):
    w = lv95_to_wgs84(core[0], core[1])
    ne = lv95_to_wgs84(core[2], core[3])
    tiles = latest_per_tile(stac_items(collection, [w[0], w[1], ne[0], ne[1]]))
    tiles = {t: it for t, it in tiles.items() if tile_in_core(t, core)}
    n_new = 0
    for t, it in sorted(tiles.items()):
        href = next(a["href"] for k, a in it["assets"].items() if pick(k))
        n_new += download(href, out / href.rsplit("/", 1)[1])
    print(f"{collection}: {len(tiles)} Kacheln ({n_new} neu)")


def fetch_panorama(core, radius, out):
    """Ausschnitt aus swissALTIRegio (COG, 9.6 GB) per Range-Request lesen, nicht ganz laden."""
    dest = out / "panorama_regio.tif"
    if dest.exists():
        print("panorama: vorhanden")
        return
    import rasterio
    from rasterio.windows import from_bounds
    from rasterio.enums import Resampling

    url = "/vsicurl/https://data.geo.admin.ch/ch.swisstopo.swissaltiregio/swissaltiregio/swissaltiregio_2056_5728.tif"
    ce, cn = (core[0] + core[2]) / 2, (core[1] + core[3]) / 2
    b = (ce - radius, cn - radius, ce + radius, cn + radius)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_USE_HEAD="NO"):
        with rasterio.open(url) as src:
            print("panorama: Quelle", src.res, src.crs)
            target_res = 25.0
            win = from_bounds(*b, transform=src.transform)
            size = int(round(2 * radius / target_res))
            data = src.read(1, window=win, out_shape=(size, size), resampling=Resampling.bilinear)
            prof = dict(driver="GTiff", width=size, height=size, count=1, dtype=data.dtype, crs=src.crs,
                        transform=rasterio.transform.from_bounds(*b, size, size), compress="deflate",
                        nodata=src.nodata)
    out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dest, "w", **prof) as dst:
        dst.write(data, 1)
    print("panorama:", size, "x", size, "@", target_res, "m")


def fetch_lifts(out):
    download("https://data.geo.admin.ch/ch.swisstopo.bahnen-winter/bahnen-winter/bahnen-winter_2056.gpkg",
             out / "bahnen-winter_2056.gpkg")
    print("bahnen-winter: ok")


def fetch_osm_pistes(core, out):
    dest = out / "osm_pistes.json"
    if dest.exists():
        print("osm: vorhanden")
        return
    w = lv95_to_wgs84(core[0], core[1])
    ne = lv95_to_wgs84(core[2], core[3])
    q = (f'[out:json][timeout:90];(way["piste:type"="downhill"]({w[1]},{w[0]},{ne[1]},{ne[0]});'
         f'way["aerialway"]({w[1]},{w[0]},{ne[1]},{ne[0]}););out geom tags;')
    for attempt in range(6):   # oeffentlicher Server ist oft ausgelastet -> mit Pause wiederholen
        r = requests.post("https://overpass-api.de/api/interpreter", data={"data": q}, headers=UA, timeout=120)
        if r.ok:
            break
        print("  osm: Server ausgelastet, warte", 10 * 2 ** attempt, "s")
        time.sleep(10 * 2 ** attempt)
    r.raise_for_status()
    dest.write_text(r.text, encoding="utf-8")
    print("osm: pisten/bahnen", len(r.json()["elements"]))


def main(course):
    cfg = json.loads((ROOT / "tools" / "courses.json").read_text(encoding="utf-8"))[course]
    core = cfg["core_lv95"]
    out = ROOT / "data" / "raw" / course
    fetch_tiles("ch.swisstopo.swissalti3d", core, out / "alti3d_2m", lambda k: "_2_2056" in k and k.endswith(".tif"))
    fetch_tiles("ch.swisstopo.swisssurface3d-raster", core, out / "surface3d_05m", lambda k: k.endswith(".tif"))
    fetch_tiles("ch.swisstopo.swissimage-dop10", core, out / "swissimage_2m", lambda k: k.endswith("_2_2056.tif"))
    fetch_panorama(core, cfg["panorama_radius_m"], out)
    fetch_lifts(ROOT / "data" / "raw")
    fetch_osm_pistes(core, out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "lauberhorn")
