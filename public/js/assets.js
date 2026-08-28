// assets.js — 3D outputs become objects, not pictures of objects. A
// gallery placard toggles between thumbnail and the actual asset,
// materialized in place at human scale. GLB/GLTF/OBJ/PLY load for real;
// gaussian splats (.splat/.ksplat/.spz, or a .ply whose header carries
// f_dc_0) render for real through gaussian-splats-3d, at native scale so
// a captured room stays a room you can step into.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { OBJLoader } from '../vendor/OBJLoader.js';
import { PLYLoader } from '../vendor/PLYLoader.js';
import { API } from './comfy.js';

const SPLAT_EXTS = new Set(['splat', 'ksplat', 'spz']);

// Gaussian PLYs declare their per-splat properties in a text header.
async function isGaussianPly(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-4095' } });
    const buf = await r.arrayBuffer();
    return new TextDecoder('latin1').decode(buf.slice(0, 4096)).includes('f_dc_0');
  } catch (e) { return false; }
}

async function loadSplat(url, ext) {
  // 600KB of renderer nobody pays for until the first splat materializes
  const GS = await import('../vendor/gaussian-splats-3d.module.js');
  const fmt = ext === 'ksplat' ? GS.SceneFormat.KSplat
    : ext === 'splat' ? GS.SceneFormat.Splat
    : GS.SceneFormat.Ply;
  const viewer = new GS.DropInViewer({
    sharedMemoryForWorkers: false,   // our servers send no cross-origin-isolation headers
    gpuAcceleratedSort: false,
  });
  await viewer.addSplatScene(url, {
    format: fmt,
    showLoadingUI: false,
    splatAlphaRemovalThreshold: 5,
    rotation: [1, 0, 0, 0],          // splat scenes are y-down; flip 180 about x
  });
  return viewer;
}

export function assetUrl(a) {
  return `${API}/view?filename=${encodeURIComponent(a.filename)}&subfolder=${encodeURIComponent(a.subfolder || '')}&type=${a.type}`;
}

// Toggle a gallery item between placard and materialized object.
export async function toggleAsset(hub, item, audio) {
  const st = item.assetState || (item.assetState = {});
  if (st.object) {
    hub.group.remove(st.object);
    if (st.isSplat) { st.viewerRef?.dispose?.(); st.isSplat = false; st.viewerRef = null; }
    else disposeTree(st.object);
    st.object = null;
    item.mesh.scale.setScalar(1);
    item.mesh.position.copy(item.to);
    audio?.toggle(false);
    return;
  }
  if (st.loading) return;
  st.loading = true;
  try {
    const url = assetUrl(item.asset);
    const ext = item.asset.filename.split('.').pop().toLowerCase();
    let obj;
    if (SPLAT_EXTS.has(ext) || (ext === 'ply' && await isGaussianPly(url))) {
      obj = await loadSplat(url, ext);
      st.isSplat = true;
      st.viewerRef = obj;
      // native scale, no normalization: a captured room stays walkable
      const holder = new THREE.Group();
      holder.add(obj);
      holder.position.copy(item.to || item.mesh.position);
      hub.group.add(holder);
      st.object = holder;
      item.mesh.scale.setScalar(0.35);
      item.mesh.position.copy(item.to).y -= 1.6;
      audio?.chime();
      return;
    }
    if (ext === 'glb' || ext === 'gltf') {
      obj = (await new GLTFLoader().loadAsync(url)).scene;
    } else if (ext === 'obj') {
      obj = await new OBJLoader().loadAsync(url);
      obj.traverse((o) => {
        if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xb9d8d2, roughness: 0.6, metalness: 0.1 });
      });
    } else {  // ply / splat: mesh if indexed, point cloud otherwise
      const geo = await new PLYLoader().loadAsync(url);
      const hasColor = !!geo.attributes.color;
      if (geo.index && geo.index.count > 0) {
        geo.computeVertexNormals();
        obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: hasColor ? 0xffffff : 0xb9d8d2, vertexColors: hasColor, roughness: 0.6,
        }));
      } else {
        obj = new THREE.Points(geo, new THREE.PointsMaterial({
          size: 0.012, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x9fe8dc, sizeAttenuation: true,
        }));
      }
    }
    // normalize to human scale, centered where the placard hangs
    const holder = new THREE.Group();
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = 1.7 / maxDim;
    const center = box.getCenter(new THREE.Vector3());
    obj.position.sub(center);
    holder.add(obj);
    holder.scale.setScalar(s);
    holder.position.copy(item.to || item.mesh.position);
    hub.group.add(holder);
    st.object = holder;
    item.mesh.scale.setScalar(0.35);   // placard shrinks to a pedestal tag
    item.mesh.position.copy(item.to).y -= 1.6;  // below the object (holograms ignore depth)
    audio?.chime();
  } catch (e) {
    console.warn('asset load failed', e);
    throw e;
  } finally {
    st.loading = false;
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose?.();
    }
  });
}
