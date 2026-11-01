"""Rohdaten (swisstopo + OSM) -> Spieldaten und Blender-Eingaben.

Aufruf:  .venv\\Scripts\\python tools/process_course.py lauberhorn

Weltkoordinaten im Spiel: x = E - E0 (Osten), z = N1 - N (Sueden), y = Hoehe ue. M.
"""
import json
import sys
import struct
from pathlib import Path

import numpy as np
from scipy import ndimage
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from geo import mosaic, mosaic_max, wgs84_to_lv95  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STEP = 4.0          # Raster fuer Physik + Gelaende-Mesh (m)
HSCALE = 0.05       # Hoehen-Aufloesung im height.bin (m)

# Schluesselstellen: Anteil der Streckenlaenge (Hundschopf wird exakt eingerastet)
SECTIONS = {
    "lauberhorn": [
        ("Start", 0.0), ("Russisprung", 0.07), ("Traverse", 0.13), ("Hundschopf", None, (2638284, 1158687)),
        ("Minschkante", 0.27), ("Canadian Corner", 0.33), ("Alpweg", 0.42), ("Kernen-S", 0.50),
        ("Wasserstation", 0.55), ("Langentrejen", 0.62), ("Hanneggschuss", 0.71), ("Silberhornsprung", 0.79),
        ("Österreicherloch", 0.84), ("Ziel-S", 0.93), ("Zielsprung", 0.97),
    ],
}
SPLITS = {"lauberhorn": ["Hundschopf", "Kernen-S", "Hanneggschuss", "Ziel-S"]}


# Sonne am Nachmittag aus Suedwesten (Weltkoordinaten x=Ost, y=oben, z=Sued)
SUN = np.array([-0.62, 0.42, 0.66])
SUN = SUN / np.linalg.norm(SUN)
SHADOW_TINT = np.array([0.60, 0.68, 0.86], np.float32)   # Schatten im Schnee: kuehles Blau


# ---------------------------------------------------------------- Hilfen
def bake_shadow(h, res, x0, z0, sampler, max_d=6000.0):
    """Gelaendeschatten per Strahlmarsch Richtung Sonne. 1 = Sonne, 0 = Schatten (weicher Rand)."""
    H, W = h.shape
    jj, ii = np.mgrid[0:H, 0:W]
    X = (x0 + ii * res).astype(np.float64)
    Z = (z0 + jj * res).astype(np.float64)
    hd = SUN[[0, 2]] / np.linalg.norm(SUN[[0, 2]])
    tan = SUN[1] / np.linalg.norm(SUN[[0, 2]])
    occl = np.full(h.shape, -1e9, np.float32)
    d = res
    while d < max_d:
        hs = sampler(X + hd[0] * d, Z + hd[1] * d)
        occl = np.maximum(occl, ((hs - h - d * tan) / (1.5 + d * 0.02)).astype(np.float32))
        d = d + res if d < 60 else d * 1.07
    return np.clip(0.5 - occl, 0, 1)


def apply_light(col, h, lit, res):
    """Schatten (blau getoent) + leichte Muldenverdunkelung in die Vertexfarbe backen."""
    col = col.astype(np.float32)
    lit = ndimage.gaussian_filter(lit, 0.7)[..., None]
    col = col * (lit + (1 - lit) * SHADOW_TINT)
    cav = h - ndimage.gaussian_filter(h, max(1.0, 12.0 / res))
    col *= (1 + np.clip(cav * 0.012, -0.10, 0.04))[..., None]
    return col
def fill_nodata(a, bad):
    if not bad.any():
        return a
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def resample_line(p, step):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    s = np.arange(0, d[-1], step)
    return np.c_[np.interp(s, d, p[:, 0]), np.interp(s, d, p[:, 1])]


def smooth_line(p, win):
    k = np.ones(win) / win
    pad = win // 2
    out = p.copy()
    for c in range(2):
        q = np.pad(p[:, c], pad, mode="edge")
        out[:, c] = np.convolve(q, k, mode="valid")[: len(p)]
    out[0], out[-1] = p[0], p[-1]
    return out


def chain_ways(ways, height_at):
    """OSM-Abschnitte zu einer Linie verketten, Start = hoechster Punkt."""
    segs = [np.array(w) for w in ways]
    start_i = max(range(len(segs)), key=lambda i: max(height_at(*segs[i][0]), height_at(*segs[i][-1])))
    s = segs.pop(start_i)
    if height_at(*s[-1]) > height_at(*s[0]):
        s = s[::-1]
    line = [s]
    while True:
        end = line[-1][-1]
        best, rev, bd = None, False, 8.0
        for i, g in enumerate(segs):
            for r, p in ((False, g[0]), (True, g[-1])):
                d = np.hypot(*(p - end))
                if d < bd:
                    best, rev, bd = i, r, d
        if best is None:
            break
        g = segs.pop(best)
        line.append(g[::-1] if rev else g)
    return np.vstack(line)


def read_gpkg_lines(path, bounds):
    """Linien aus einer GeoPackage-Tabelle lesen (WKB, ohne GDAL)."""
    import sqlite3
    con = sqlite3.connect(path)
    (table,) = con.execute("select table_name from gpkg_contents").fetchone()
    out = []
    e0, n0, e1, n1 = bounds
    for blob, name, typ in con.execute(f"select geom, name, type from '{table}'"):
        flags = blob[3]
        env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
        wkb = memoryview(blob)[8 + env:]
        lines = []

        def parse(off):
            bo = "<" if wkb[off] == 1 else ">"
            (gt,) = struct.unpack_from(bo + "I", wkb, off + 1)
            off += 5
            dim = 3 if (gt > 1000 or gt & 0x80000000) else 2
            base = gt % 1000 if gt < 0x80000000 else gt & 0xFFFF
            if base == 2:
                (n,) = struct.unpack_from(bo + "I", wkb, off)
                off += 4
                pts = np.frombuffer(wkb[off: off + n * 8 * dim], dtype=bo + "f8").reshape(n, dim)[:, :2]
                lines.append(pts.copy())
                return off + n * 8 * dim
            if base == 5:
                (n,) = struct.unpack_from(bo + "I", wkb, off)
                off += 4
                for _ in range(n):
                    off = parse(off)
                return off
            raise ValueError(f"Geometrietyp {gt}")

        try:
            parse(0)
        except ValueError:
            continue
        for ln in lines:
            if (ln[:, 0].max() > e0 and ln[:, 0].min() < e1 and ln[:, 1].max() > n0 and ln[:, 1].min() < n1):
                out.append({"name": name, "type": typ, "pts": ln})
    return out


# ---------------------------------------------------------------- Hauptteil
def main(course):
    cfg = json.loads((ROOT / "tools" / "courses.json").read_text(encoding="utf-8"))[course]
    E0, N0 = cfg["origin_lv95"]
    CX, CZ = cfg["chunks"]
    CM = cfg["chunk_m"]
    E1, N1 = E0 + CX * CM, N0 + CZ * CM
    B = (E0, N0, E1, N1)
    raw = ROOT / "data" / "raw" / course
    work = ROOT / "data" / "work" / course
    pub = ROOT / "public" / "courses" / course
    work.mkdir(parents=True, exist_ok=True)
    pub.mkdir(parents=True, exist_ok=True)

    print("1/7 Hoehenmodell 2 m")
    dem = mosaic(raw / "alti3d_2m", B, 2.0)[0].astype(np.float32)
    dem = fill_nodata(dem, dem < -1000)
    H2, W2 = dem.shape

    def sample(arr, res, E, N, order=1):
        E, N = np.atleast_1d(E), np.atleast_1d(N)
        return ndimage.map_coordinates(arr, [(N1 - N) / res, (E - E0) / res], order=order, mode="nearest")

    print("2/7 Oberflaechenmodell + Luftbild")
    surf = mosaic_max(raw / "surface3d_05m", B, 2.0)[0].astype(np.float32)
    ndsm = np.where(surf > -1000, surf - dem, 0).clip(0, 60)
    rgb = mosaic(raw / "swissimage_2m", B, 2.0)[:3].astype(np.float32)
    r, g, b = rgb
    bright = (r + g + b) / 3

    print("3/7 Rennstrecke")
    osm = json.loads((raw / "osm_pistes.json").read_text(encoding="utf-8"))
    ways = []
    for el in osm["elements"]:
        tags = el.get("tags", {})
        if (el["id"] in cfg.get("osm_way_ids", [])) or (cfg.get("osm_piste_name") and tags.get("name") == cfg["osm_piste_name"]):
            lon = [p["lon"] for p in el["geometry"]]
            lat = [p["lat"] for p in el["geometry"]]
            e, n = wgs84_to_lv95(lon, lat)
            ways.append(np.c_[e, n])
    if cfg.get("osm_splice"):
        # Wege in der angegebenen Reihenfolge: jeder naechste Weg wird an seinem Punkt
        # betreten, der dem bisherigen Ende am naechsten liegt (Luecken gerade ueberbrueckt).
        byid = {}
        for el in osm["elements"]:
            if el["id"] in cfg["osm_way_ids"]:
                e, n = wgs84_to_lv95([p["lon"] for p in el["geometry"]], [p["lat"] for p in el["geometry"]])
                byid[el["id"]] = np.c_[e, n]
        parts = [byid[cfg["osm_way_ids"][0]]]
        for wid in cfg["osm_way_ids"][1:]:
            nxt = byid[wid]
            k = int(np.argmin(np.hypot(nxt[:, 0] - parts[-1][-1, 0], nxt[:, 1] - parts[-1][-1, 1])))
            parts.append(nxt[k + 1:] if np.hypot(*(nxt[k] - parts[-1][-1])) < 1 else nxt[k:])
        line = np.vstack(parts)
    else:
        line = chain_ways(ways, lambda e, n: float(sample(dem, 2, e, n)[0]))
    line = resample_line(line, 2.0)
    line = smooth_line(smooth_line(line, 11), 11)
    line = resample_line(line, 2.0)
    finish_i = len(line) - 25
    if "start_alt" in cfg or "finish_alt" in cfg:
        hl = sample(dem, 2, line[:, 0], line[:, 1])
        i0 = int(np.argmax(hl <= cfg.get("start_alt", 1e9))) if "start_alt" in cfg else 0
        line = line[i0:]
        hl = hl[i0:]
        if "finish_alt" in cfg and (hl <= cfg["finish_alt"]).any():
            fi = int(np.argmax(hl <= cfg["finish_alt"]))
            line = line[: fi + 45]          # ~90 m Auslauf nach dem Ziel
            finish_i = fi
        else:
            finish_i = len(line) - 25
    finish_i = min(finish_i, len(line) - 25)
    L = len(line) * 2.0
    print(f"   Laenge {L:.0f} m, Start {sample(dem, 2, *line[0])[0]:.0f} m, Ende {sample(dem, 2, *line[-1])[0]:.0f} m")

    # Abstand jedes 2-m-Pixels zur Mittellinie
    mask = np.ones_like(dem, dtype=bool)
    dense = resample_line(line, 0.5)
    rows = np.clip(np.round((N1 - dense[:, 1]) / 2).astype(int), 0, H2 - 1)
    cols = np.clip(np.round((dense[:, 0] - E0) / 2).astype(int), 0, W2 - 1)
    mask[rows, cols] = False
    dist = ndimage.distance_transform_edt(mask) * 2.0

    print("4/7 Schneedecke + Pistenpraeparation")
    g_soft = ndimage.gaussian_filter(dem, 0.8)
    g_piste = ndimage.gaussian_filter(dem, 3.0)
    w = np.clip(1 - (dist - 16) / 14, 0, 1)
    snow = g_soft * (1 - w) + g_piste * w
    h4 = snow[::2, ::2].copy()
    H4, W4 = h4.shape
    assert (H4, W4) == (CZ * CM // 4 + 1, CX * CM // 4 + 1), (H4, W4)

    print("5/7 Baeume + Gebaeude aus Oberflaechenmodell")
    tall = ndsm > 3.0
    # Rauheit der Oberflaeche: Baumkronen rau, Daecher glatt
    m1 = ndimage.uniform_filter(surf, 3)
    m2 = ndimage.uniform_filter(surf * surf, 3)
    rough = np.sqrt(np.clip(m2 - m1 * m1, 0, None))
    gy2, gx2 = np.gradient(dem, 2.0)
    terrain_slope = np.degrees(np.arctan(np.hypot(gx2, gy2)))
    greenish = (g >= r * 0.92) & (g > b * 1.02)
    shadow = bright < 60
    treeish = tall & (greenish | shadow | (rough > 1.4))
    treeish = ndimage.binary_opening(treeish, iterations=1)
    built = (tall & ~greenish & ~shadow & (rough < 1.4) & (terrain_slope < 32) & (dist > 8)
             & ~ndimage.binary_dilation(treeish, iterations=1))
    built = ndimage.binary_opening(built, iterations=1)
    lab, nlab = ndimage.label(built)
    buildings = []
    for i, sl in enumerate(ndimage.find_objects(lab)):
        if sl is None:
            continue
        m = lab[sl] == i + 1
        area = m.sum() * 4.0
        if not (30 <= area <= 1500):
            continue
        yy, xx = np.nonzero(m)
        E = E0 + (xx + sl[1].start) * 2.0
        N = N1 - (yy + sl[0].start) * 2.0
        pts = np.c_[E - E.mean(), N - N.mean()]
        ev, evec = np.linalg.eigh(np.cov(pts.T) + np.eye(2) * 1e-6)
        ax = evec[:, 1]
        u, v = pts @ ax, pts @ evec[:, 0]
        ln, wd = np.ptp(u) + 2.0, np.ptp(v) + 2.0
        if wd < 5 or area / (ln * wd) < 0.45:
            continue
        hgt = float(np.percentile(ndsm[sl][m], 85))
        if not (3 <= hgt <= 22):
            continue
        ce, cn = E.mean(), N.mean()
        buildings.append([round(ce - E0, 1), round(N1 - cn, 1), round(ln, 1), round(wd, 1),
                          round(float(np.arctan2(-ax[1], ax[0])), 3), round(hgt, 1)])
    print(f"   Gebaeude {len(buildings)}")

    cell = 4  # 8 m Raster fuer Baeume
    Ht, Wt = H2 // cell, W2 // cell
    tm = treeish[: Ht * cell, : Wt * cell].reshape(Ht, cell, Wt, cell)
    frac = tm.mean(axis=(1, 3))
    nd = np.where(treeish, ndsm, 0)[: Ht * cell, : Wt * cell].reshape(Ht, cell, Wt, cell).max(axis=(1, 3))
    rng = np.random.default_rng(7)
    jj, ii = np.nonzero(frac >= 0.3)
    tx = (ii * cell + cell / 2) * 2.0 + rng.uniform(-3, 3, len(ii))
    tz = (jj * cell + cell / 2) * 2.0 + rng.uniform(-3, 3, len(ii))
    th = np.clip(nd[jj, ii], 4, 35)
    tdist = ndimage.map_coordinates(dist, [tz / 2, tx / 2], order=0)
    keep = (tdist > 20) & (tx > 0) & (tz > 0) & (tx < E1 - E0) & (tz < N1 - N0)
    tx, tz, th = tx[keep], tz[keep], th[keep]
    rank = rng.permutation(len(tx))  # zufaellige Reihenfolge -> Client kann ausduennen
    tx, tz, th = tx[rank], tz[rank], th[rank]
    trees = np.c_[tx * 10, tz * 10, th * 10].round().astype("<u2")
    (pub / "trees.bin").write_bytes(trees.tobytes())
    print(f"   Baeume {len(tx)}")

    print("6/7 Farben, Tore, Lifte")
    gy, gx = np.gradient(h4, STEP)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    tdens = ndimage.uniform_filter(treeish.astype(np.float32), 5)[::2, ::2]
    pw = w[::2, ::2]
    noise = ndimage.gaussian_filter(rng.standard_normal((H4, W4)), 2) * 6
    col = np.zeros((H4, W4, 3), np.float32)
    snow_c = np.array([236, 242, 250], np.float32)
    forest_c = np.array([200, 212, 226], np.float32)
    piste_c = np.array([247, 249, 253], np.float32)
    rock_c = np.array([112, 106, 104], np.float32)
    col[:] = snow_c
    col = col * (1 - tdens[..., None] * 0.9) + forest_c * (tdens[..., None] * 0.9)
    col = col * (1 - pw[..., None]) + piste_c * pw[..., None]
    rk = np.clip((slope - 38) / 10, 0, 1)[..., None]
    col = col * (1 - rk) + rock_c * rk
    col += noise[..., None]

    # Panorama frueh laden: dient auch als Schattenwerfer (z. B. Eiger, Lauberhorn-Grat)
    import rasterio
    with rasterio.open(raw / "panorama_regio.tif") as src:
        pb = src.bounds
        pan = src.read(1).astype(np.float32)
    pan = fill_nodata(pan, pan < -100)
    pres = (pb.right - pb.left) / pan.shape[1]
    px0 = pb.left + pres / 2 - E0
    pz0 = N1 - (pb.top - pres / 2)

    def height_any(X, Z):
        """Hoehe an Weltkoordinaten: Kernraster (4 m), ausserhalb Panorama (25 m)."""
        hc = ndimage.map_coordinates(h4, [Z / STEP, X / STEP], order=1, mode="constant", cval=np.nan)
        hp = ndimage.map_coordinates(pan, [(Z - pz0) / pres, (X - px0) / pres], order=1, mode="nearest")
        return np.where(np.isnan(hc), hp, hc)

    print("   Gelaendeschatten (Kern)")
    lit = bake_shadow(h4, STEP, 0.0, 0.0, height_any)
    col = apply_light(col, h4, lit, 4)
    col = col.clip(0, 255).astype(np.uint8)

    # Tore entlang der Linie
    t = np.gradient(line, axis=0)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    theta = np.unwrap(np.arctan2(N1 - line[:, 1] - 0, line[:, 0]) * 0)  # Platzhalter fuer Form
    ang = np.unwrap(np.arctan2(-t[:, 1], t[:, 0]))  # Winkel in Welt (x, z=Sued)
    curv = np.gradient(ang) / 2.0
    curv = ndimage.gaussian_filter1d(curv, 15)
    world = np.c_[line[:, 0] - E0, N1 - line[:, 1]]
    wt = np.c_[np.cos(ang), np.sin(ang)]
    wn = np.c_[-wt[:, 1], wt[:, 0]]
    ys = sample(h4, STEP, line[:, 0], line[:, 1])
    gates = []
    gi = 40
    while gi < finish_i - 30:
        off = float(np.clip(curv[gi] * 1500, -5, 5))
        c = world[gi] + wn[gi] * off
        gates.append({"i": int(gi), "s": gi * 2.0, "x": round(float(c[0]), 2), "z": round(float(c[1]), 2),
                      "dx": round(float(wt[gi, 0]), 4), "dz": round(float(wt[gi, 1]), 4), "w": 12.0})
        step = 38 if abs(curv[gi]) > 0.004 else 44
        gi += step
    for k, gt in enumerate(gates):
        gt["y"] = round(float(sample(h4, STEP, gt["x"] + E0, N1 - gt["z"])[0]), 2)
        gt["color"] = "red" if k % 2 == 0 else "blue"

    secs = []
    for item in SECTIONS.get(course) or [tuple(x) for x in cfg.get("sections", [["Start", 0.0]])]:
        if item[1] is None:
            e, n = item[2]
            si = int(np.argmin(np.hypot(line[:, 0] - e, line[:, 1] - n)))
        else:
            si = int(item[1] * (finish_i))
        secs.append({"name": item[0], "s": si * 2.0})
    secs.sort(key=lambda s: s["s"])
    splits = [s["s"] for s in secs if s["name"] in (SPLITS.get(course) or cfg.get("splits", []))]

    lifts = []
    for lf in read_gpkg_lines(ROOT / "data" / "raw" / "bahnen-winter_2056.gpkg", B):
        p = lf["pts"]
        inside = (p[:, 0] > E0) & (p[:, 0] < E1) & (p[:, 1] > N0) & (p[:, 1] < N1)
        if inside.mean() < 0.5:
            continue
        p = p[inside]
        lifts.append({"name": lf["name"], "type": lf["type"],
                      "pts": [[round(float(e - E0), 1), round(float(N1 - n), 1)] for e, n in p]})
    print(f"   Tore {len(gates)}, Abschnitte {len(secs)}, Lifte {len(lifts)}")

    # Pisten (fuer Karte)
    pistes = []
    for el in osm["elements"]:
        tg = el.get("tags", {})
        if tg.get("piste:type") == "downhill" and "geometry" in el:
            e, n = wgs84_to_lv95([p["lon"] for p in el["geometry"]], [p["lat"] for p in el["geometry"]])
            pistes.append({"d": tg.get("piste:difficulty", ""),
                           "pts": [[round(float(a - E0), 1), round(float(N1 - c), 1)] for a, c in zip(e, n)]})

    print("7/7 Schreiben")
    hmin = float(np.floor(h4.min()))
    q = np.round((h4 - hmin) / HSCALE).clip(0, 65535).astype("<u2")
    (pub / "height.bin").write_bytes(q.tobytes())
    course_pts = [[round(float(x), 2), round(float(y), 2), round(float(z), 2)]
                  for (x, z), y in zip(world[::2], ys[::2])]
    meta = {
        "id": course, "name": cfg["name"], "place": cfg["place"],
        "origin_lv95": [E0, N1], "step": STEP, "W": W4, "H": H4, "hmin": hmin, "hscale": HSCALE,
        "chunk": CM, "chunks": [CX, CZ], "size": [E1 - E0, N1 - N0],
        "trees": int(len(tx)), "buildings": buildings, "lifts": lifts,
        "course": {"length": round(L, 1), "finish_s": finish_i * 2.0, "points_step": 4.0,
                   "points": course_pts, "gates": gates, "sections": secs, "splits": splits,
                   "start": {"x": round(float(world[2, 0]), 2), "z": round(float(world[2, 1]), 2),
                             "dx": round(float(wt[2, 0]), 4), "dz": round(float(wt[2, 1]), 4)},
                   "finish": {"x": round(float(world[finish_i, 0]), 2), "z": round(float(world[finish_i, 1]), 2),
                              "dx": round(float(wt[finish_i, 0]), 4), "dz": round(float(wt[finish_i, 1]), 4),
                              "y": round(float(ys[finish_i]), 2), "w": 40.0}},
        "pistes": pistes,
        "sun": [round(float(v), 4) for v in SUN],
        "attribution": "Geodaten © swisstopo · Pistenlinien © OpenStreetMap-Mitwirkende (ODbL)",
    }
    (pub / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    np.savez_compressed(work / "terrain.npz", h=h4, col=col, step=STEP, chunk=CM, chunks=np.array([CX, CZ]))
    (work / "course.json").write_text(json.dumps(meta["course"]), encoding="utf-8")

    # Panorama (25 m) mit Farben; Blender duennt es fuer Nah-/Fernring aus
    pgy, pgx = np.gradient(pan, pres)
    pslope = np.degrees(np.arctan(np.hypot(pgx, pgy)))
    pc = np.zeros(pan.shape + (3,), np.float32)
    pc[:] = snow_c
    low = np.clip((1300 - pan) / 400, 0, 1)[..., None]           # Talboden: weniger Schnee
    pc = pc * (1 - low * 0.35) + np.array([150, 160, 150], np.float32) * (low * 0.35)
    prk = np.clip((pslope - 36) / 12, 0, 1)[..., None]
    pc = pc * (1 - prk) + np.array([96, 92, 94], np.float32) * prk
    lake = (pan < 600) & (pslope < 1.0)
    pc[lake] = [70, 105, 140]
    print("   Gelaendeschatten (Panorama)")
    ph2 = pan[::2, ::2]
    plit = bake_shadow(ph2, pres * 2, px0, pz0, height_any, max_d=9000)
    plit = ndimage.zoom(plit, 2, order=1)[: pan.shape[0], : pan.shape[1]]
    plit = np.pad(plit, ((0, pan.shape[0] - plit.shape[0]), (0, pan.shape[1] - plit.shape[1])), mode="edge")
    pc = apply_light(pc, pan, plit, pres)
    np.savez_compressed(work / "panorama.npz", h=pan, col=pc.clip(0, 255).astype(np.uint8),
                        x0=px0, z0=pz0, res=pres)
    print(f"   Panorama {pan.shape} @ {pres:.0f} m")

    # Karte (Schummerung + Strecke)
    ls = np.array([-1, -1, 1.2]) / np.linalg.norm([-1, -1, 1.2])
    nrm = np.dstack([-gx, gy, np.ones_like(gx)])
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    shade = np.clip(nrm @ ls, 0, 1)
    img = (col.astype(np.float32) * (0.45 + 0.6 * shade[..., None])).clip(0, 255).astype(np.uint8)
    Image.fromarray(img).resize((W4 // 2, H4 // 2), Image.LANCZOS).save(pub / "map.jpg", quality=85)

    # Kontrollbild fuer Baeume/Gebaeude
    dbg = np.dstack([bright] * 3).clip(0, 255).astype(np.uint8)
    dbg[treeish] = [20, 140, 40]
    dbg[built] = [220, 40, 40]
    dbg[dist < 3] = [30, 60, 255]
    Image.fromarray(dbg).resize((W2 // 2, H2 // 2)).save(work / "debug_landcover.jpg", quality=80)
    print("fertig")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "lauberhorn")
