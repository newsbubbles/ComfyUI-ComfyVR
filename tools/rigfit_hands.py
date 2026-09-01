"""rigfit_hands.py — fit the ComfyVR hand armature onto any hand mesh.

The WebXR hand rig IS the target skeleton (notes/space-packs.md): 25
named joints per hand that every headset tracks. This script builds a
template armature whose 24 bones are named by their DISTAL joint, in
the same canonical open-palm pose as makeFakeJoints in wearables.js
(wrist at origin, fingers extending forward), fits it to a hand mesh,
binds with automatic weights, and exports a glb the wear layer can
drive joint-by-joint.

Run headless:

  blender --background --python tools/rigfit_hands.py -- \
      --input path/to/hand_mesh.(obj|glb|fbx) --output cvr_hands_x.glb
  blender --background --python tools/rigfit_hands.py -- \
      --test --output cvr_hands_test.glb

Mesh convention: a LEFT-ish hand, palm roughly flat, wrist at the
origin end, fingers extending along one axis. The fit is v1 uniform:
scale from wrist-to-middle-tip length, translate wrist to the mesh's
wrist end. Per-finger refinement can come later; automatic weights
forgive a lot at hand scale.
"""
import sys

import bpy
from mathutils import Vector

# Canonical joint positions, THE SAME TABLE as makeFakeJoints in
# wearables.js (three.js: x sideways, fingers toward -Z). Blender is
# Z-up and its glTF exporter maps Blender +Y to glTF -Z, so fingers
# extend +Y here and land at -Z in the exported glb, matching three.
FINGERS = [
    ("thumb", -0.035, [0.028, 0.055, 0.078, 0.095]),
    ("index-finger", -0.02, [0.075, 0.11, 0.135, 0.155, 0.17]),
    ("middle-finger", -0.001, [0.075, 0.115, 0.145, 0.168, 0.185]),
    ("ring-finger", 0.018, [0.072, 0.108, 0.137, 0.158, 0.173]),
    ("pinky-finger", 0.036, [0.068, 0.095, 0.117, 0.134, 0.147]),
]
NAMES5 = ["metacarpal", "phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"]
NAMES4 = ["metacarpal", "phalanx-proximal", "phalanx-distal", "tip"]

MIDDLE_TIP_LEN = 0.185  # wrist to middle fingertip in the template


def joint_table():
    """{joint-name: Vector} in Blender axes (x sideways, +y forward)."""
    J = {"wrist": Vector((0.0, 0.0, 0.0))}
    for fname, x, ds in FINGERS:
        names = NAMES4 if len(ds) == 4 else NAMES5
        for i, d in enumerate(ds):
            jx = x + (-d * 0.35 if fname == "thumb" else 0.0)
            J[f"{fname}-{names[i]}"] = Vector((jx, d, 0.0))
    return J


def chains():
    out = []
    for fname, _x, ds in FINGERS:
        names = NAMES4 if len(ds) == 4 else NAMES5
        out.append(["wrist"] + [f"{fname}-{n}" for n in names])
    return out


def build_template_armature():
    J = joint_table()
    arm = bpy.data.armatures.new("cvr-hand-rig")
    obj = bpy.data.objects.new("cvr-hand-rig", arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for chain in chains():
        parent = None
        for a, b in zip(chain[:-1], chain[1:]):
            bone = arm.edit_bones.new(b)          # named by DISTAL joint
            bone.head = J[a]
            bone.tail = J[b]
            if parent is not None:
                bone.parent = parent
                bone.use_connect = True
            parent = bone
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def fit_to_mesh(arm_obj, mesh_obj):
    """Uniform v1 fit: wrist at the mesh's wrist end, scaled to length."""
    bb = [mesh_obj.matrix_world @ Vector(c) for c in mesh_obj.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    length = hi.y - lo.y
    if length <= 0:
        raise RuntimeError("mesh has no extent along +Y (fingers must point +Y in blender space)")
    s = length / MIDDLE_TIP_LEN
    arm_obj.scale = (s, s, s)
    # wrist (armature origin) sits at the -Y end, centered in x/z
    arm_obj.location = Vector(((lo.x + hi.x) / 2.0, lo.y, (lo.z + hi.z) / 2.0))
    bpy.context.view_layer.update()
    return s


def bind(arm_obj, mesh_obj):
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def make_test_mesh():
    """A blocky articulated-looking hand: palm slab + five finger bars."""
    import bmesh
    mesh = bpy.data.meshes.new("test-hand")
    bm = bmesh.new()
    def box(cx, cy, cz, sx, sy, sz):
        r = bmesh.ops.create_cube(bm, size=1)
        verts = r["verts"]
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=verts)
        bmesh.ops.translate(bm, vec=(cx, cy, cz), verts=verts)
    box(0, 0.038, 0, 0.085, 0.075, 0.024)                    # palm
    for fname, x, ds in FINGERS:
        y0, y1 = ds[0], ds[-1]
        fx = x + (-(y0 + y1) / 2 * 0.35 if fname == "thumb" else 0)
        box(fx, (y0 + y1) / 2, 0, 0.016, (y1 - y0) + 0.02, 0.018)
    # dense enough that every small distal bone can own vertices; a
    # 48-vert blockout starves automatic weights and fails the sanity
    # check below (found by the first self-test run)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=6, use_grid_fill=True)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("test-hand", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def import_mesh(path):
    p = path.lower()
    before = set(bpy.data.objects)
    if p.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    elif p.endswith((".glb", ".gltf")):
        bpy.ops.import_scene.gltf(filepath=path)
    elif p.endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise RuntimeError("unsupported mesh format: " + path)
    new_meshes = [o for o in set(bpy.data.objects) - before if o.type == "MESH"]
    if not new_meshes:
        raise RuntimeError("no mesh in " + path)
    # join multi-part imports into one bind target
    bpy.ops.object.select_all(action="DESELECT")
    for o in new_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = new_meshes[0]
    if len(new_meshes) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    # walk, don't zip: valueless flags (--test) break pairwise parsing
    opts, i = {}, 0
    while i < len(argv):
        if argv[i] == "--test":
            opts["test"] = True
            i += 1
        elif argv[i] in ("--input", "--output") and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    test = opts.get("test", False)
    out = opts.get("output") or "cvr_hands_out.glb"

    bpy.ops.wm.read_factory_settings(use_empty=True)
    mesh_obj = make_test_mesh() if test else import_mesh(opts["input"])
    arm_obj = build_template_armature()
    s = fit_to_mesh(arm_obj, mesh_obj)
    bind(arm_obj, mesh_obj)

    # sanity before export: every bone should own SOME vertices
    groups = {g.name for g in mesh_obj.vertex_groups}
    bones = {b.name for b in arm_obj.data.bones}
    nonempty = set()
    for v in mesh_obj.data.vertices:
        for g in v.groups:
            if g.weight > 0.01:
                nonempty.add(mesh_obj.vertex_groups[g.group].name)
    print(f"[rigfit] bones={len(bones)} groups={len(groups)} nonempty={len(nonempty)} scale={s:.3f}")
    if len(bones) != 24:
        raise RuntimeError(f"expected 24 bones, built {len(bones)}")
    if len(nonempty) < 16:
        raise RuntimeError(f"automatic weights look broken: only {len(nonempty)} bones own vertices")

    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    arm_obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_yup=True)
    print("[rigfit] exported", out)


if __name__ == "__main__":
    main()
