"""Strecke in Blender aufbauen und fuer das Spiel exportieren.

Aufruf:
  blender -b --factory-startup -P tools/blender/build_course.py -- lauberhorn
Eingabe:  data/work/<strecke>/terrain.npz, panorama.npz, course.json, public/courses/<strecke>/meta.json,
          data/work/assets.blend (Modelle aus build_assets.py)
Ausgabe:  public/courses/<strecke>/terrain_lod0.glb, terrain_lod1.glb, panorama.glb, course.glb
          data/work/<strecke>/<strecke>.blend  (zum Nachbearbeiten von Hand)

Blender-Koordinaten: X = Osten, Y = Norden (= -z im Spiel), Z = Hoehe ue. M.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import bpy  # noqa: E402
from bhelp import reset, export_glb, empty, vc_material, PI  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
COURSE = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "lauberhorn"
WORK = ROOT / "data" / "work" / COURSE
PUB = ROOT / "public" / "courses" / COURSE

reset()
T = np.load(WORK / "terrain.npz")
H4 = T["h"].astype(np.float64)
COL = T["col"]
STEP = float(T["step"])
CM = int(T["chunk"])
CX, CZ = (int(v) for v in T["chunks"])
NQ = CM // int(STEP)                       # Quads pro Block (LOD0)
SIZE_X, SIZE_Z = CX * CM, CZ * CM
meta = json.loads((PUB / "meta.json").read_text(encoding="utf-8"))
course = json.loads((WORK / "course.json").read_text(encoding="utf-8"))
rng = np.random.default_rng(3)


# ------------------------------------------------------------------ Hilfen
def coll(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def ground(x, z):
    """Hoehe an Weltposition (x, z) - gleiche Dreiecksteilung wie im Spiel."""
    fx = min(max(x / STEP, 0), H4.shape[1] - 1.001)
    fz = min(max(z / STEP, 0), H4.shape[0] - 1.001)
    i, j = int(fx), int(fz)
    u, v = fx - i, fz - j
    a, b, c, d = H4[j, i], H4[j, i + 1], H4[j + 1, i + 1], H4[j + 1, i]
    if u >= v:
        return a + (b - a) * u + (c - b) * v
    return a + (d - a) * v + (c - d) * u


def bnormals(hh, sx):
    gz, gx = np.gradient(hh, sx)
    n = np.stack([-gx, gz, np.ones_like(gx)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def grid_mesh(name, hh, cc, nn, sx, collection, loc=(0, 0, 0), skirt=0.0, x0=0.0, y0=0.0, drop=None):
    """Hoehenraster -> Mesh. Dreiecke wie im Spiel: (a,d,c) + (a,c,b)."""
    n, m = hh.shape
    jj, ii = np.mgrid[0:n, 0:m]
    co = np.stack([x0 + ii * sx, y0 - jj * sx, hh], -1).reshape(-1, 3)
    idx = jj * m + ii
    a, b = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel()
    c, d = idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
    tris = np.vstack([np.stack([a, d, c], 1), np.stack([a, c, b], 1)])
    if drop is not None:                       # Dreiecke entfernen (Loecher im Panorama)
        dq = drop[:-1, :-1].ravel()
        tris = tris[~np.r_[dq, dq]]
    normals = nn.reshape(-1, 3)
    colors = cc.reshape(-1, 3)
    if skirt:
        ring = np.concatenate([idx[0, :], idx[1:, -1], idx[-1, -2::-1], idx[-2:0:-1, 0]])
        k = len(co)
        sk = co[ring].copy()
        sk[:, 2] -= skirt
        co = np.vstack([co, sk])
        normals = np.vstack([normals, normals[ring]])
        colors = np.vstack([colors, colors[ring]])
        s0 = k + np.arange(len(ring))
        q1 = np.stack([ring, s0, np.roll(s0, -1)], 1)
        q2 = np.stack([ring, np.roll(s0, -1), np.roll(ring, -1)], 1)
        tris = np.vstack([tris, q1[:, ::-1], q2[:, ::-1]])  # nur Aussenseite
    tris = tris.astype(np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co))
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.loops.add(tris.size)
    me.loops.foreach_set("vertex_index", tris.ravel())
    me.polygons.add(len(tris))
    me.polygons.foreach_set("loop_start", np.arange(0, tris.size, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set("use_smooth", np.ones(len(tris), dtype=bool))
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    rgba = np.c_[colors / 255.0, np.ones(len(colors))].astype(np.float32)
    ca.data.foreach_set("color_srgb", rgba.ravel())
    me.color_attributes.active_color = ca
    me.normals_split_custom_set_from_vertices(normals.astype(np.float32))
    me.materials.append(vc_material())
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    ob.location = loc
    return ob


def load_assets():
    names = ["Tree_A", "Gate_Red", "Gate_Blue", "Pylon", "Station", "StartHouse", "FinishArch", "Tribune",
             "Banner", "Flag", "Fan_A", "Fan_B", "Fan_C"]
    with bpy.data.libraries.load(str(ROOT / "data" / "work" / "assets.blend"), link=False) as (src, dst):
        dst.objects = [n for n in names if n in src.objects]
    return {o.name: o.data for o in dst.objects}


def place(mesh, name, x, z, rot, collection, dy=0.0, props=None):
    ob = bpy.data.objects.new(name, mesh)
    collection.objects.link(ob)
    ob.location = (x, -z, ground(x, z) + dy)
    ob.rotation_euler = (0, 0, rot)
    for k, v in (props or {}).items():
        ob[k] = v
    return ob


def blender_angle(dx, dz):
    """Richtung im Spiel (dx, dz) -> Winkel in Blender-XY."""
    return math.atan2(-dz, dx)


def local_to_world(cx, cz, ang, lx, ly):
    """Lokale Koordinaten (lx quer, ly vorwaerts) relativ zu einem Punkt mit Blickrichtung ang."""
    rz = ang - PI / 2
    bx = cx + lx * math.cos(rz) - ly * math.sin(rz)
    by = -cz + lx * math.sin(rz) + ly * math.cos(rz)
    return bx, -by


# ------------------------------------------------------------------ Gelaende
print("Gelaende LOD0/LOD1")
c0, c1 = coll("Terrain_LOD0"), coll("Terrain_LOD1")
N4 = bnormals(H4, STEP)
H16 = H4[::4, ::4]
N16 = bnormals(H16, STEP * 4)
C16 = COL[::4, ::4]
q1 = NQ // 4
for cz in range(CZ):
    for cx in range(CX):
        j0, i0 = cz * NQ, cx * NQ
        sl = np.s_[j0:j0 + NQ + 1, i0:i0 + NQ + 1]
        grid_mesh(f"T0_{cx}_{cz}", H4[sl], COL[sl], N4[sl], STEP, c0, (cx * CM, -cz * CM, 0), skirt=10)
        j1, i1 = cz * q1, cx * q1
        sl = np.s_[j1:j1 + q1 + 1, i1:i1 + q1 + 1]
        grid_mesh(f"T1_{cx}_{cz}", H16[sl], C16[sl], N16[sl], STEP * 4, c1, (cx * CM, -cz * CM, 0), skirt=25)

# ------------------------------------------------------------------ Panorama
print("Panorama")
cp = coll("Panorama")
P = np.load(WORK / "panorama.npz")
PH, PC, PX0, PZ0, PRES = P["h"].astype(np.float64), P["col"], float(P["x0"]), float(P["z0"]), float(P["res"])


def pano_ring(name, stride, x_min, x_max, z_min, z_max, hole, lower_box, lower_by):
    i0 = max(int((x_min - PX0) / PRES), 0)
    i1 = min(int((x_max - PX0) / PRES), PH.shape[1] - 1)
    j0 = max(int((z_min - PZ0) / PRES), 0)
    j1 = min(int((z_max - PZ0) / PRES), PH.shape[0] - 1)
    hh = PH[j0:j1 + 1:stride, i0:i1 + 1:stride].copy()
    cc = PC[j0:j1 + 1:stride, i0:i1 + 1:stride]
    xs = PX0 + np.arange(i0, i1 + 1, stride) * PRES
    zs = PZ0 + np.arange(j0, j1 + 1, stride) * PRES
    X, Z = np.meshgrid(xs, zs)
    lb = (X > lower_box[0]) & (X < lower_box[1]) & (Z > lower_box[2]) & (Z < lower_box[3])
    hh[lb] -= lower_by
    core = (X >= 0) & (X <= SIZE_X) & (Z >= 0) & (Z <= SIZE_Z)
    for (jj, ii) in zip(*np.nonzero(core)):
        hh[jj, ii] = min(hh[jj, ii], ground(X[jj, ii], Z[jj, ii]) - 12)
    inside = (X > hole[0]) & (X < hole[1]) & (Z > hole[2]) & (Z < hole[3])
    drop = inside[:-1, :-1] & inside[1:, 1:] & inside[:-1, 1:] & inside[1:, :-1]
    drop = np.pad(drop, ((0, 1), (0, 1)))
    nn = bnormals(hh, PRES * stride)
    return grid_mesh(name, hh, cc, nn, PRES * stride, cp, (0, 0, 0), x0=xs[0], y0=-zs[0], drop=drop)


mx, mz = SIZE_X / 2, SIZE_Z / 2
R_NEAR = 9000
pano_ring("Panorama_Near", 2, mx - R_NEAR, mx + R_NEAR, mz - R_NEAR, mz + R_NEAR,
          hole=(200, SIZE_X - 200, 200, SIZE_Z - 200), lower_box=(0, 0, 0, 0), lower_by=0)
pano_ring("Panorama_Far", 8, -1e9, 1e9, -1e9, 1e9,
          hole=(mx - R_NEAR + 400, mx + R_NEAR - 400, mz - R_NEAR + 400, mz + R_NEAR - 400),
          lower_box=(mx - R_NEAR + 200, mx + R_NEAR - 200, mz - R_NEAR + 200, mz + R_NEAR - 200), lower_by=25)

# ------------------------------------------------------------------ Strecke
print("Strecke")
A = load_assets()
cc_ = coll("Course")
root = empty("Course", collection=cc_)
root["kind"] = "course"
root["name"] = meta["name"]

for k, g in enumerate(course["gates"]):
    ang = blender_angle(g["dx"], g["dz"])
    e = empty(f"Gate_{k:02d}", root, collection=cc_)
    e.location = (g["x"], -g["z"], ground(g["x"], g["z"]))
    e.rotation_euler = (0, 0, ang - PI / 2)
    e["kind"], e["index"], e["width"] = "gate", k, g["w"]
    mesh = A["Gate_Red"] if g["color"] == "red" else A["Gate_Blue"]
    for side in (-1, 1):
        wx, wz = local_to_world(g["x"], g["z"], ang, side * g["w"] / 2, 0)
        f = bpy.data.objects.new(f"Gate_{k:02d}_{'L' if side < 0 else 'R'}", mesh)
        cc_.objects.link(f)
        f.parent = e
        f.location = (side * g["w"] / 2, 0, ground(wx, wz) - e.location.z)

st = course["start"]
ang = blender_angle(st["dx"], st["dz"])
e = place(None, "Start", st["x"], st["z"], ang - PI / 2, cc_, props={"kind": "start"})
e.parent = None
place(A["StartHouse"], "StartHouse", st["x"], st["z"], ang - PI / 2, cc_, dy=-0.1)
for side in (-1, 1):
    x, z = local_to_world(st["x"], st["z"], ang, side * 6, 2)
    place(A["Flag"], f"StartFlag_{side}", x, z, ang - PI / 2, cc_)

fi = course["finish"]
ang = blender_angle(fi["dx"], fi["dz"])
e = place(None, "Finish", fi["x"], fi["z"], ang - PI / 2, cc_, props={"kind": "finish", "width": fi["w"]})
place(A["FinishArch"], "FinishArch", fi["x"], fi["z"], ang - PI / 2, cc_)
fans = [A["Fan_A"], A["Fan_B"], A["Fan_C"]]
for side in (-1, 1):
    tx, tz = local_to_world(fi["x"], fi["z"], ang, side * 34, 28)
    t = place(A["Tribune"], f"Tribune_{side}", tx, tz, ang - PI / 2 - side * PI / 2, cc_)
    for row in range(3):
        for col in range(16):
            lx = -11 + col * 1.45 + rng.uniform(-0.2, 0.2)
            ly = -row * 1.2 - 0.6
            # Fans relativ zur Tribuene (lokales +Y = Front)
            ta = t.rotation_euler.z
            bx = t.location.x + lx * math.cos(ta) - ly * math.sin(ta)
            by = t.location.y + lx * math.sin(ta) + ly * math.cos(ta)
            fan = bpy.data.objects.new(f"Fan_{side}_{row}_{col}", fans[rng.integers(3)])
            cc_.objects.link(fan)
            fan.location = (bx, by, t.location.z + 0.6 + row * 0.6)
            fan.rotation_euler = (0, 0, ta + rng.uniform(-0.3, 0.3))
    for k in range(3):
        x, z = local_to_world(fi["x"], fi["z"], ang, side * (24 + k * 3), -6)
        place(A["Flag"], f"FinishFlag_{side}_{k}", x, z, ang - PI / 2, cc_)

# Werbebanden im Zielhang und Zuschauer an Schluesselstellen
pts = np.array(course["points"])            # (x, y, z) alle 4 m
seg = np.diff(pts[:, [0, 2]], axis=0)
seg = np.vstack([seg, seg[-1:]])
dirs = seg / np.linalg.norm(seg, axis=1, keepdims=True)
f_idx = int(course["finish_s"] / course["points_step"])
for i in range(max(f_idx - 70, 0), f_idx - 3, 3):
    ang = blender_angle(*dirs[i])
    for side in (-1, 1):
        x, z = local_to_world(pts[i, 0], pts[i, 2], ang, side * 24, 0)
        place(A["Banner"], f"Banner_{i}_{side}", x, z, ang, cc_)
for sec in course["sections"]:
    if sec["name"] in ("Start",):
        continue
    i = min(int(sec["s"] / course["points_step"]), len(pts) - 1)
    ang = blender_angle(*dirs[i])
    side = 1 if rng.random() > 0.5 else -1
    for k in range(10):
        x, z = local_to_world(pts[i, 0], pts[i, 2], ang, side * rng.uniform(27, 33), rng.uniform(-15, 15))
        place(fans[rng.integers(3)], f"Fan_{sec['name']}_{k}", x, z, ang + PI / 2 * side + rng.uniform(-0.4, 0.4),
              cc_)
    x, z = local_to_world(pts[i, 0], pts[i, 2], ang, -side * 26, 0)
    place(A["Flag"], f"Flag_{sec['name']}", x, z, ang, cc_)

# Fangnetze an der Kurvenaussenseite
heading = np.unwrap(np.arctan2(dirs[:, 1], dirs[:, 0]))
curv = np.gradient(heading) / course["points_step"]
curv = np.convolve(curv, np.ones(9) / 9, mode="same")
flag = np.abs(curv) > 0.0028
flag = np.convolve(flag.astype(float), np.ones(15), mode="same") > 0
flag[:5] = False
flag[f_idx - 40:] = False
runs, cur = [], None
for i in range(len(pts)):
    side = -np.sign(curv[i]) if flag[i] else 0
    if side and cur and cur[0] == side:
        cur[1].append(i)
    else:
        if cur and len(cur[1]) > 4:
            runs.append(cur)
        cur = [side, [i]] if side else None
if cur and len(cur[1]) > 4:
    runs.append(cur)
net_runs = []
nv, nf, ncol = [], [], []
for side, idxs in runs:
    line = []
    for i in idxs:
        nx, nz = -dirs[i, 1], dirs[i, 0]       # links der Fahrtrichtung (Spiel-Koordinaten)
        line.append((pts[i, 0] + nx * 22 * side, pts[i, 2] + nz * 22 * side))
    net_runs.append([[round(x, 1), round(z, 1)] for x, z in line])
    base = len(nv)
    for x, z in line:
        g = ground(x, z)
        for hgt, colr in ((0, (0.85, 0.2, 0.12)), (2.6, (0.9, 0.25, 0.15)), (3.0, (0.97, 0.97, 0.97))):
            nv.append((x, -z, g + hgt))
            ncol.append(colr)
    for k in range(len(line) - 1):
        r0, r1 = base + k * 3, base + (k + 1) * 3
        for o in (0, 1):
            q = (r0 + o, r1 + o, r1 + o + 1, r0 + o + 1)
            nf.append(q)  # im Spiel doppelseitig gerendert
me = bpy.data.meshes.new("Nets")
me.from_pydata(nv, [], nf)
ca = me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
for i, c in enumerate(ncol):
    ca.data[i].color_srgb = (*c, 1)
me.color_attributes.active_color = ca
me.materials.append(vc_material())
nets = bpy.data.objects.new("Nets", me)
cc_.objects.link(nets)
nets["kind"] = "nets"
nets["runs"] = json.dumps(net_runs)
print(f"   Netze: {len(net_runs)} Abschnitte")

# Lifte
for k, lf in enumerate(meta["lifts"]):
    p = np.array(lf["pts"], float)
    if len(p) < 2:
        continue
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    if d[-1] < 80:
        continue
    n = max(int(d[-1] / 110), 1)
    s = np.linspace(0, d[-1], n + 1)
    px, pz = np.interp(s, d, p[:, 0]), np.interp(s, d, p[:, 1])
    e = empty(f"Lift_{k:02d}", collection=cc_)
    e["kind"], e["name"] = "lift", str(lf["name"] or "")
    cable = []
    for i in range(len(s)):
        j = min(i, len(s) - 2)
        ang = math.atan2(-(pz[j + 1] - pz[j]), px[j + 1] - px[j])
        if i in (0, len(s) - 1):
            place(A["Station"], f"Lift_{k:02d}_st{i}", px[i], pz[i], ang - PI / 2, cc_, dy=-0.5)
            cable.append([round(px[i], 1), round(ground(px[i], pz[i]) + 4.0, 1), round(pz[i], 1)])
        else:
            place(A["Pylon"], f"Lift_{k:02d}_p{i}", px[i], pz[i], ang, cc_, dy=-0.3)
            cable.append([round(px[i], 1), round(ground(px[i], pz[i]) + 11.7, 1), round(pz[i], 1)])
    e["cable"] = json.dumps(cable)

# ------------------------------------------------------------------ Export
print("Export")
export_glb(PUB / "terrain_lod0.glb", list(c0.objects), draco=True)
export_glb(PUB / "terrain_lod1.glb", list(c1.objects), draco=True)
export_glb(PUB / "panorama.glb", list(cp.objects), draco=True)
export_glb(PUB / "course.glb", list(cc_.objects), draco=False, extras=True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(WORK / f"{COURSE}.blend"))
print("OK course")
