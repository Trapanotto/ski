"""Kleine Helfer fuer die Blender-Skripte (stilisierte Low-Poly-Modelle mit Vertexfarben)."""
import math
import bpy
import bmesh
from mathutils import Matrix, Vector


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1.0,)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mat = None


def vc_material():
    """Ein Material, das nur die Vertexfarbe zeigt (Vorschau in Blender)."""
    global _mat
    if _mat and _mat.name in bpy.data.materials:
        return _mat
    m = bpy.data.materials.new("VertexColor")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    _mat = m
    return m


class Builder:
    """Sammelt farbige Grundkoerper in einem bmesh."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new("Col")

    def _paint(self, verts, color):
        c = hexrgb(color) if isinstance(color, str) else color
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            for lp in f.loops:
                lp[self.col] = c
        return faces

    @staticmethod
    def M(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        return (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(rot[2], 4, "Z")
                @ Matrix.Rotation(rot[1], 4, "Y") @ Matrix.Rotation(rot[0], 4, "X")
                @ Matrix.Diagonal(Vector((*scale, 1))))

    def box(self, size, loc=(0, 0, 0), rot=(0, 0, 0), color="#ffffff"):
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=self.M(loc, rot, size))
        return self._paint(r["verts"], color)

    def cyl(self, r1, r2, depth, loc=(0, 0, 0), rot=(0, 0, 0), color="#ffffff", seg=8):
        r = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r1,
                                  radius2=r2, depth=depth, matrix=self.M(loc, rot))
        return self._paint(r["verts"], color)

    def ball(self, radius, loc=(0, 0, 0), scale=(1, 1, 1), color="#ffffff", sub=1):
        r = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=radius,
                                       matrix=self.M(loc, (0, 0, 0), scale))
        return self._paint(r["verts"], color)

    def text(self, body, size, loc, rot, color, extrude=0.01, align="CENTER"):
        """Text als Mesh einbauen."""
        cu = bpy.data.curves.new("txt", "FONT")
        cu.body = body
        cu.size = size
        cu.extrude = extrude
        cu.align_x = align
        cu.align_y = "CENTER"
        ob = bpy.data.objects.new("txt", cu)
        bpy.context.scene.collection.objects.link(ob)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.transform(self.M(loc, rot))
        me2 = bpy.data.meshes.new("t2")
        tmp.to_mesh(me2)
        tmp.free()
        n0 = len(self.bm.verts)
        self.bm.from_mesh(me2)
        self.bm.verts.ensure_lookup_table()
        self._paint(self.bm.verts[n0:], color)
        bpy.data.objects.remove(ob)
        bpy.data.curves.remove(cu)
        bpy.data.meshes.remove(me)
        bpy.data.meshes.remove(me2)

    def obj(self, name, parent=None, loc=(0, 0, 0), collection=None):
        me = bpy.data.meshes.new(name)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me)
        self.bm.free()
        me.color_attributes.active_color = me.color_attributes["Col"]
        me.color_attributes.render_color_index = 0
        me.materials.append(vc_material())
        ob = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if parent:
            ob.parent = parent
        ob.location = loc
        return ob


def empty(name, parent=None, loc=(0, 0, 0), collection=None):
    ob = bpy.data.objects.new(name, None)
    (collection or bpy.context.scene.collection).objects.link(ob)
    ob.parent = parent
    ob.location = loc
    return ob


def export_glb(path, objects=None, draco=False, extras=False):
    bpy.ops.object.select_all(action="DESELECT")
    if objects is not None:
        for o in objects:
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=objects is not None,
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_extras=extras,
        export_yup=True, export_apply=True, export_normals=True, export_materials="EXPORT",
        export_draco_mesh_compression_enable=draco, export_draco_mesh_compression_level=7,
        export_draco_position_quantization=16, export_draco_color_quantization=8,
    )


def all_children(ob):
    out = [ob]
    for c in ob.children:
        out += all_children(c)
    return out


PI = math.pi
