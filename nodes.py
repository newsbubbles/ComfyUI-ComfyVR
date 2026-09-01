"""nodes.py — ComfyVR's own nodes. First: CVR RigFit Hands.

The bridge in the make-hands ladder (notes/space-packs.md): a generated
hand mesh goes in, a skinned cvr_hands_*.glb comes out, saved into the
output dir under the WEAR convention so its placard wears it on pinch.
The heavy lifting is tools/rigfit_hands.py under headless Blender; the
node just finds the mesh, shells the tool, and reports the output.

Blender is found via COMFYVR_BLENDER, PATH, or the usual install dirs.
Local-first by design; if this ever heads to the registry, the
blender-shelling needs a review pass against registry standards first.
"""
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
RIGFIT = os.path.join(ROOT, "tools", "rigfit_hands.py")


def find_blender():
    cand = [os.environ.get("COMFYVR_BLENDER", "")]
    try:
        import shutil
        cand.append(shutil.which("blender") or "")
    except Exception:
        pass
    for base in (r"C:\Program Files\Blender Foundation", "/usr/bin", "/Applications/Blender.app/Contents/MacOS"):
        if os.path.isdir(base):
            if base.endswith("Blender Foundation"):
                for d in sorted(os.listdir(base), reverse=True):
                    cand.append(os.path.join(base, d, "blender.exe"))
            else:
                cand.append(os.path.join(base, "blender"))
    for c in cand:
        if c and os.path.isfile(c):
            return c
    return None


class CVRRigFitHands:
    """Fit the XRHand skeleton onto a hand mesh; output is wearable."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mesh_file": ("STRING", {"default": "", "tooltip": "mesh in the output or input dir (.glb/.obj/.fbx); ignored when a MESH is connected"}),
                "name": ("STRING", {"default": "hands"}),
            },
            "optional": {
                "mesh": ("MESH", {"tooltip": "chain straight from VoxelToMesh / mesh nodes; wins over mesh_file"}),
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "rig"
    CATEGORY = "comfyvr"

    def rig(self, mesh_file, name, mesh=None):
        import folder_paths
        out_dir = folder_paths.get_output_directory()
        src = None
        if mesh is not None:
            # a connected MESH chains without a file round-trip: write it
            # with core's own dependency-free glb writer, then fit that
            from comfy_extras.nodes_save_3d import save_glb
            src = os.path.join(out_dir, "_cvr_rigfit_src.glb")
            save_glb(mesh.vertices[0], mesh.faces[0], src)
        else:
            for base in (out_dir, folder_paths.get_input_directory()):
                p = os.path.join(base, mesh_file)
                if mesh_file and os.path.isfile(p):
                    src = p
                    break
        if not src:
            raise RuntimeError(f"mesh not found in output or input dir: {mesh_file}")
        blender = find_blender()
        if not blender:
            raise RuntimeError("no blender found: set COMFYVR_BLENDER to the executable")
        slug = re.sub(r"[^\w-]+", "-", name.strip()) or "hands"
        n = 1
        while os.path.exists(os.path.join(out_dir, f"cvr_hands_{slug}_{n:05d}.glb")):
            n += 1
        out_name = f"cvr_hands_{slug}_{n:05d}.glb"
        out_path = os.path.join(out_dir, out_name)
        r = subprocess.run(
            [blender, "--background", "--python", RIGFIT, "--", "--input", src, "--output", out_path],
            capture_output=True, text=True, timeout=600,
        )
        if not os.path.isfile(out_path):
            tail = (r.stdout + "\n" + r.stderr)[-800:]
            raise RuntimeError("rig-fit produced no glb; blender said:\n" + tail)
        # any filename array in the outputs reaches the space's scanners,
        # so the placard appears and its pinch WEARS the result
        return {"ui": {"3d": [{"filename": out_name, "subfolder": "", "type": "output"}]}}


NODE_CLASS_MAPPINGS = {"CVRRigFitHands": CVRRigFitHands}
NODE_DISPLAY_NAME_MAPPINGS = {"CVRRigFitHands": "CVR RigFit Hands"}
