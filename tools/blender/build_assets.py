"""Modelle fuer das Spiel bauen (stilisiert, Low-Poly, Vertexfarben).

Aufruf:
  blender -b --factory-startup -P tools/blender/build_assets.py
Ergebnis: public/models/skier.glb, public/models/props.glb, data/work/assets.blend
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bpy  # noqa: E402
from bhelp import Builder, reset, empty, export_glb, all_children, PI  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)

RED = "#d52b1e"
RED_D = "#a51f16"
WHITE = "#f4f6f8"
BLACK = "#1d2126"
VISOR = "#20344a"
SKIN = "#e0b48f"
GOLD = "#e8b400"


# ------------------------------------------------------------------ Fahrer
def skier(name, female=False):
    s = 0.95 if female else 1.0
    sh = 0.17 if female else 0.20          # Schulterbreite (halb)
    root = empty(name)
    root.location = (3.0 if female else 0.0, 0, 0)

    for side, x in (("L", -0.11), ("R", 0.11)):
        b = Builder()
        b.box((0.075, 2.05, 0.022), (0, 0.05, 0.011), color=RED)
        b.box((0.03, 1.9, 0.004), (0, 0.05, 0.024), color=WHITE)
        b.box((0.075, 0.2, 0.02), (0, 1.13, 0.05), (0.45, 0, 0), color=RED)
        b.box((0.075, 0.12, 0.02), (0, -0.98, 0.02), (-0.2, 0, 0), color=BLACK)
        b.obj(f"ski_{side}", root, (x * s, 0, 0))
        b = Builder()
        b.box((0.12, 0.3, 0.2), (0, 0.02, 0.1), color=BLACK)
        b.box((0.125, 0.12, 0.04), (0, 0.05, 0.16), color=WHITE)
        b.obj(f"boot_{side}", root, (x * s, 0, 0.022))

    pelvis_h = 0.98 * s
    b = Builder()
    b.box((0.34 * s, 0.21, 0.17), (0, 0, 0), color=RED)
    pelvis = b.obj("pelvis", root, (0, 0, pelvis_h))

    for side, x in (("L", -0.11), ("R", 0.11)):
        b = Builder()
        b.cyl(0.09 * s, 0.075 * s, 0.42 * s, (0, 0, -0.21 * s), color=RED)
        b.box((0.03, 0.01, 0.38 * s), (x * 0.5, 0.085 * s, -0.21 * s), color=WHITE)
        b.ball(0.075 * s, (0, 0, -0.42 * s), color=RED_D)
        thigh = b.obj(f"thigh_{side}", pelvis, (x * s, 0, -0.02))
        b = Builder()
        b.cyl(0.07 * s, 0.062 * s, 0.4 * s, (0, 0, -0.2 * s), color=RED)
        b.box((0.025, 0.01, 0.34 * s), (x * 0.5, 0.068 * s, -0.2 * s), color=WHITE)
        b.obj(f"shin_{side}", thigh, (0, 0, -0.42 * s))

    b = Builder()
    b.box((sh * 2, 0.22, 0.52 * s), (0, 0, 0.28 * s), color=RED)
    b.box((sh * 2 + 0.01, 0.1, 0.06), (0, 0.06, 0.46 * s), color=WHITE)         # Schulterband
    b.box((0.13, 0.012, 0.045), (0, 0.113, 0.33 * s), color=WHITE)                # Schweizerkreuz
    b.box((0.045, 0.012, 0.13), (0, 0.113, 0.33 * s), color=WHITE)
    b.text("TRAPANOTTO", 0.055, (0, -0.115, 0.38 * s), (PI / 2, 0, 0), WHITE, extrude=0.004)
    b.text("SKI TEAM", 0.04, (0, -0.115, 0.31 * s), (PI / 2, 0, 0), GOLD, extrude=0.004)
    b.ball(0.075, (-sh, 0, 0.47 * s), color=RED)
    b.ball(0.075, (sh, 0, 0.47 * s), color=RED)
    torso = b.obj("torso", pelvis, (0, 0, 0.06))

    b = Builder()
    b.cyl(0.05, 0.05, 0.08, (0, 0, 0.02), color=SKIN)
    b.ball(0.135, (0, 0.0, 0.13), (1, 1.12, 0.95), color=WHITE, sub=2)
    b.box((0.03, 0.29, 0.02), (0, 0.0, 0.25), color=RED)
    b.box((0.21, 0.06, 0.075), (0, 0.13, 0.12), color=VISOR)
    b.box((0.12, 0.05, 0.05), (0, 0.11, 0.03), color=SKIN)
    if female:
        b.ball(0.06, (0, -0.15, 0.06), (0.8, 1, 1.6), color="#5a3a22")
        b.cyl(0.035, 0.02, 0.18, (0, -0.17, -0.06), (0.25, 0, 0), color="#5a3a22")
    b.obj("head", torso, (0, 0, 0.56 * s))

    for side, x in (("L", -1), ("R", 1)):
        b = Builder()
        b.cyl(0.058, 0.05, 0.3 * s, (0, 0, -0.15 * s), color=RED)
        upper = b.obj(f"upperarm_{side}", torso, (x * (sh + 0.03), 0, 0.46 * s))
        b = Builder()
        b.cyl(0.05, 0.045, 0.27 * s, (0, 0, -0.135 * s), color=RED)
        b.ball(0.05, (0, 0.01, -0.29 * s), color=BLACK)
        fore = b.obj(f"forearm_{side}", upper, (0, 0, -0.3 * s))
        b = Builder()
        b.cyl(0.018, 0.018, 0.12, (0, 0, 0.0), color=BLACK)
        b.cyl(0.009, 0.007, 1.15, (0, 0, -0.6), color="#c9ced6", seg=6)
        b.cyl(0.04, 0.04, 0.01, (0, 0, -1.1), color=BLACK, seg=8)
        b.obj(f"pole_{side}", fore, (0, 0.02, -0.29 * s))
    return root


# ------------------------------------------------------------------ Requisiten
def tree(name, snowy):
    b = Builder()
    green = "#2c5a3c" if not snowy else "#3a6650"
    b.cyl(0.04, 0.03, 0.16, (0, 0, 0.08), color="#5b3b26", seg=5)
    tiers = [(0.33, 0.10, 0.42), (0.26, 0.34, 0.38), (0.19, 0.56, 0.32), (0.11, 0.76, 0.26)]
    for r, z, h in tiers:
        b.cyl(r, 0.0, h, (0, 0, z + h / 2), color=green, seg=7)
        sn = 0.75 if snowy else 0.55
        b.cyl(r * sn, 0.0, h * sn, (0, 0, z + h * (1 - sn) + h * sn / 2 + 0.01), color=WHITE, seg=7)
    return b.obj(name)


def tree_far(name):
    """Sehr einfache Tanne fuer grosse Distanz (wenige Dreiecke)."""
    b = Builder()
    b.cyl(0.3, 0.0, 0.88, (0, 0, 0.56), color="#2f5a40", seg=5)
    b.cyl(0.14, 0.0, 0.3, (0, 0, 0.86), color=WHITE, seg=5)
    return b.obj(name)


def chalet(name):
    b = Builder()
    b.box((1.02, 1.02, 0.12), (0, 0, 0.06), color="#8f8a86")
    b.box((1.0, 1.0, 0.5), (0, 0, 0.37), color="#8a5634")
    for sx in (-0.3, 0.0, 0.3):
        for sy in (-0.505, 0.505):
            b.box((0.12, 0.012, 0.13), (sx, sy, 0.42), color="#ffe7a8")
            b.box((0.16, 0.008, 0.02), (sx, sy, 0.34), color=WHITE)
    b.box((1.0, 0.08, 0.03), (0, -0.56, 0.3), color="#6d4126")    # Balkon
    roof = b.box((1.18, 1.22, 0.32), (0, 0, 0.78), color=WHITE)
    for f in roof:
        for lp in f.loops:
            v = lp.vert
            if v.co.z > 0.8:
                v.co.y = 0.0
    b.box((1.2, 0.04, 0.03), (0, 0.6, 0.62), color="#5b3b26")
    b.box((1.2, 0.04, 0.03), (0, -0.6, 0.62), color="#5b3b26")
    b.box((0.08, 0.08, 0.16), (0.3, 0.2, 0.9), color="#7a7470")   # Kamin
    return b.obj(name)


def gate(name, color):
    """Eine Torflagge (zwei Stangen + Tuch). Ein Tor = zwei Flaggen."""
    b = Builder()
    for px in (-0.4, 0.4):
        b.cyl(0.022, 0.02, 1.9, (px, 0, 0.95), color=color, seg=6)
    b.box((0.82, 0.02, 0.72), (0, 0, 1.42), color=color)
    b.box((0.6, 0.025, 0.12), (0, 0, 1.42), color=WHITE)
    return b.obj(name)


def pylon(name):
    b = Builder()
    b.box((0.9, 0.9, 0.5), (0, 0, 0.25), color="#9a9a96")
    b.cyl(0.32, 0.22, 12, (0, 0, 6), color="#8a929c", seg=8)
    b.box((5.0, 0.35, 0.35), (0, 0, 12), color="#6f7782")
    for x in (-2.3, 2.3):
        b.box((0.3, 1.2, 0.3), (x, 0, 11.75), color="#3c4249")
    return b.obj(name)


def station(name):
    b = Builder()
    b.box((10, 7, 4.5), (0, 0, 2.25), color="#b9b4ac")
    b.box((10.2, 7.2, 0.4), (0, 0, 4.7), color=WHITE)
    b.box((2.5, 0.05, 2.2), (0, -3.52, 1.1), color="#2a3542")
    b.box((6, 0.3, 0.8), (0, 3.6, 4), color=RED)
    return b.obj(name)


def start_house(name):
    b = Builder()
    # Nach hinten offen, damit die Verfolgerkamera freie Sicht hat
    for x in (-3, 3):
        b.box((0.3, 4, 4.2), (x, -2, 2.1), color="#8a5634")
    roof = b.box((7, 5, 0.6), (0, -2, 4.5), color=WHITE)
    b.box((6.2, 0.15, 0.7), (0, 0.1, 3.9), color=RED)
    b.text("START", 0.45, (0, 0.2, 3.9), (PI / 2, 0, PI), WHITE, extrude=0.02)
    b.box((6, 4.2, 0.25), (0, -2, 0.12), color="#6d4126")
    b.box((0.06, 0.06, 0.9), (-0.6, 0.0, 0.5), color="#c9ced6")
    b.box((0.06, 0.06, 0.9), (0.6, 0.0, 0.5), color="#c9ced6")
    b.box((1.2, 0.05, 0.05), (0, 0.0, 0.55), color=GOLD)   # Startstab
    del roof
    return b.obj(name)


def finish_arch(name):
    b = Builder()
    for x in (-20, 20):
        b.box((1.2, 1.2, 7), (x, 0, 3.5), color=RED)
        b.box((1.3, 1.3, 0.4), (x, 0, 7.1), color=WHITE)
    b.box((41, 0.6, 1.8), (0, 0, 6.3), color=RED)
    for y, rz in ((0.32, PI), (-0.32, 0)):
        b.text("TRAPANOTTO SKI TEAM", 1.0, (0, y, 6.3), (PI / 2, 0, rz), WHITE, extrude=0.03)
    b.box((5, 0.5, 1.8), (0, 0, 8.5), color=BLACK)
    b.text("ZIEL", 1.0, (0, 0.27, 8.5), (PI / 2, 0, PI), GOLD, extrude=0.03)
    return b.obj(name)


def tribune(name):
    b = Builder()
    for i in range(5):
        b.box((24, 1.2, 0.6 + i * 0.6), (0, -i * 1.2, (0.6 + i * 0.6) / 2), color="#7d8691")
    b.box((24.4, 0.2, 1.0), (0, 0.65, 0.5), color=RED)
    b.text("HOPP SCHWIIZ", 0.6, (0, 0.77, 0.5), (PI / 2, 0, PI), WHITE, extrude=0.02)
    return b.obj(name)


def spectator(name, jacket):
    b = Builder()
    b.cyl(0.13, 0.11, 0.8, (0, 0, 0.4), color="#2b2f36", seg=6)
    b.cyl(0.19, 0.16, 0.6, (0, 0, 1.05), color=jacket, seg=6)
    b.ball(0.12, (0, 0, 1.47), color=SKIN)
    b.cyl(0.12, 0.05, 0.16, (0, 0, 1.6), color=jacket, seg=6)
    return b.obj(name)


def banner(name):
    b = Builder()
    b.box((8, 0.08, 0.9), (0, 0, 0.45), color=WHITE)
    b.box((8, 0.09, 0.18), (0, 0, 0.85), color=RED)
    for y, rz in ((0.05, PI), (-0.05, 0)):
        b.text("TRAPANOTTO", 0.42, (0, y, 0.4), (PI / 2, 0, rz), RED, extrude=0.01)
    return b.obj(name)


def flag(name):
    b = Builder()
    b.cyl(0.04, 0.03, 6, (0, 0, 3), color="#c9ced6", seg=6)
    b.box((1.4, 0.03, 1.4), (0.72, 0, 5.2), color=RED)
    b.box((0.85, 0.035, 0.25), (0.72, 0, 5.2), color=WHITE)
    b.box((0.25, 0.035, 0.85), (0.72, 0, 5.2), color=WHITE)
    return b.obj(name)


def main():
    reset()
    m = skier("Skier_M", female=False)
    f = skier("Skier_F", female=True)
    export_glb(OUT / "skier.glb", all_children(m) + all_children(f))

    props = [
        tree("Tree_A", False), tree("Tree_B", True), tree_far("Tree_Far"), chalet("Chalet"), gate("Gate_Red", RED),
        gate("Gate_Blue", "#1f5fbf"), pylon("Pylon"), station("Station"), start_house("StartHouse"),
        finish_arch("FinishArch"), tribune("Tribune"), banner("Banner"), flag("Flag"),
        spectator("Fan_A", "#d52b1e"), spectator("Fan_B", "#f4c430"), spectator("Fan_C", "#2b6cb0"),
    ]
    export_glb(OUT / "props.glb", props)
    for p in props:  # fuer den Export versetzt, im Spiel liegen alle im Ursprung
        p.location.x = 10 + props.index(p) * 12
    (ROOT / "data" / "work").mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "data" / "work" / "assets.blend"))
    print("OK assets")


main()
