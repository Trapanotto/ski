"""Vorschau-Render einer .blend (Workbench, Vertexfarben).
blender -b <datei.blend> -P tools/blender/preview.py -- <out.png> <cam_x> <cam_y> <cam_z> <ziel_x> <ziel_y> <ziel_z> [lens]
"""
import sys
import bpy
from mathutils import Vector

a = sys.argv[sys.argv.index("--") + 1:]
out = a[0]
cam_loc = Vector(map(float, a[1:4]))
target = Vector(map(float, a[4:7]))
lens = float(a[7]) if len(a) > 7 else 35

sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "VERTEX"
sc.display.shading.show_shadows = True
sc.display.shading.show_cavity = True
sc.render.resolution_x, sc.render.resolution_y = 1400, 800
sc.render.filepath = out
cam = bpy.data.objects.new("PrevCam", bpy.data.cameras.new("PrevCam"))
sc.collection.objects.link(cam)
cam.location = cam_loc
cam.rotation_euler = (target - cam_loc).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = lens
cam.data.clip_end = 100000
sc.camera = cam
bpy.ops.render.render(write_still=True)
