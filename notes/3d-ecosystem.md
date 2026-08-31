# The ComfyUI 3D node ecosystem (cataloged 2026-08-31)

A survey of existing 3D node packs, grouped by function, with what
each means for comfyvr and the avatar pack. Primary index:
pozzettiandrea.github.io/ComfyUI-3D_nodes_index (94 packs tracked).
This file records the ones that matter to us; the index has the rest.

## Image/text to mesh (crowded, do not compete)

- **ComfyUI core**: Hunyuan3D-v2 nodes, TripoSplat (v0.23+), native
  GAUSSIAN type, SplatToMesh, SaveGLB, Load3D/Preview3D. The center
  of gravity keeps absorbing generation.
- **ComfyUI-3D-Pack** (MrForExample): the historical kitchen sink
  (TripoSR, InstantMesh, CRM, Zero123, 3DGS, NeRF). Still maintained
  (updates through 2026) but famously painful installs; core and
  focused wrappers have eaten most of its reasons to exist.
- **TRELLIS 2 wrappers**: ComfyUI-Trellis2 (visualbruno),
  ComfyUI-TRELLIS2 (PozzettiAndrea), ComfyUI-IF_Trellis (if-ai).
  Microsoft's 4B model, Dec 2025, open + commercial-ok, PBR output.
  The current open-weights quality bar for meshes.
- **Hunyuan3D 2.1 wrappers**: kijai's Hunyuan3DWrapper, visualbruno,
  niknah, Yuan-ManX variants. Plus ComfyUI-Hunyuan3D-Part
  (PozzettiAndrea) for part segmentation.
- **API lanes (zero VRAM)**: ComfyUI-Tripo (VAST-AI official),
  ComfyUI-Rodin (Deemos), BizyAir (siliconflow), and Meshy nodes now
  BUILT IN to core (MeshyRigModelNode et al).

## Splat generators (directly feeds comfyvr)

- **TripoSplat** in core: what make-vr-asset uses today.
- **ComfyUI-Sharp** (PozzettiAndrea, Apple SHARP): image to 3DGS.
  ALREADY INSTALLED in our ComfyUI.
- **ComfyUI-LiTo** (PozzettiAndrea, Apple LiTo): image to 3DGS, PLY
  export.
- **ComfyUI-SAM3DObjects** (PozzettiAndrea): meshes AND splats from
  single images via SAM 3D.
- **ComfyUI_HYWorld2** (AHEKOT): single image or PANORAMA to a whole
  3D SCENE as PLY/gaussian splats. This is the "the splat IS the
  scene" generator: a workflow whose output could be promoted to
  comfyvr's WORLD. Highest-leverage pack in this list for us.

## Rigging and animation (the avatar pack's neighborhood)

- **ComfyUI-UniRig** (PozzettiAndrea): auto skeleton + skinning,
  wraps UniRig (SIGGRAPH 2025) AND Make-It-Animatable (CVPR 2025,
  recommended for humanoids, sub-second), bundles its own Blender,
  self-contained install, outputs Mixamo-compatible rigged FBX.
  THIS KILLS OUR "nobody wrapped rigging" VACANCY CLAIM from the
  avatar research. Correction recorded in comfyvr-vrc-avatar.
- **ComfyUI-SkinToken / SkinTokens** (Rizzlord, Aero-Ex): skeleton +
  skin weights via headless Blender server. Second occupant.
- **MeshyRigModelNode**: rigging as an API call, in CORE. Third.
- **ComfyUI-mesh2motion** (jtydhr88): Mesh2Motion rigging with
  interactive editing.
- **Motion**: ComfyUI-HY-Motion1 / HyMotion (text to 3D human motion,
  FBX retarget, SMPL-H), ComfyUI-MotionDiff (Fannovel16),
  ComfyUI-MotionCapture (PozzettiAndrea, GVHMR video mocap),
  ComfyUI-SAM3DBody (human mesh + pose from one image).
  Text-to-motion driving a rigged avatar is already wired territory.
- **STILL VACANT after adversarial search: VRM export.** No node
  anywhere does glTF + VRMC_vrm packaging, humanoid bone mapping,
  meta/license. The avatar pack's buildable slot shrinks to exactly
  this plus the comfyvr try-on, and that is a BETTER position:
  depend on ComfyUI-UniRig for rigging instead of building it.

## Viewers and bridges (comfyvr's neighbors)

- **comfyui_GaussianViewer** (CarlMarkswx): splat PLY preview nodes.
- **ComfyUI-NKD-VFX-Tools**: GLB loading + splat previews.
- **ComfyStereo** (Dobidop): stereoscopic/VR viewing, the nearest
  thing to a VR display story besides us; still flat-canvas-first.
- **ComfyUI-Blender** (alexisrolland) and **ComfyUI-CUP** (AIGODLIKE):
  Blender bridges. **houdini-comfyui-bridge**: Houdini.
- **ComfyUI-TD** (JiSenHua): realtime STREAMING of 3D models and
  point clouds into TouchDesigner. Prior art for live 3D transport
  out of comfy; worth reading before we design multiplayer/presence.
- **comfyui-vrm-pose-editor** (ketle-man): poses existing VRM/GLB in
  comfy. Proof VRM tooling runs in comfy's web stack; posing only.

## Mesh processing and utility

- **ComfyUI-GeometryPack** (PozzettiAndrea): remesh/UV/decimate style
  geometry processing. ALREADY INSTALLED here (its prestartup wants a
  comfy_3d_viewers module it does not ship; the pack itself loads).
- **ComfyUI-UltraShape1** (jtydhr88): coarse mesh refinement.
- **ComfyUI-Paint3D-Nodes**: texture inpainting on meshes.
- **ComfyUI-TextureAlchemy / ComfyUI-Chord** (Ubisoft): PBR material
  estimation and generation.
- Depth stack (kijai mostly): DepthAnything V2/V3, Depth-Pro, Lotus,
  Marigold, MoGe, Geowizard. Feeds 2.5D, not our lane directly.

## Strategic reads

1. **One author owns the corner**: PozzettiAndrea maintains the
   index AND GeometryPack, UniRig, TRELLIS2, LiTo, Sharp,
   SAM3DBody/Objects, MotionCapture, Hunyuan3D-Part. Their packs
   PRODUCE what comfyvr DISPLAYS; two are already in our install.
   Natural ally; a comfyvr mention in their index would reach every
   3D-comfy user.
2. **Generation keeps sinking into core** (TripoSplat, Meshy API,
   Load3D). Anything we build must sit where core will not go:
   the VR surface, the VRM last mile, the try-on loop.
3. **The avatar chain today**: image gen (core) then mesh (core
   Hunyuan3D / TRELLIS2 wrapper) then rig (ComfyUI-UniRig) then VRM
   (NOBODY) then wear it in VR (only us). Build the two missing
   links, wire the rest as a subgraph template like make-vr-asset.
4. **HYWorld2 is the scene generator** for splat-as-world; a
   make-vr-world sample workflow is the obvious sequel to
   make-vr-asset.
