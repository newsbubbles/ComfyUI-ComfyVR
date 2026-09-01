// wearables.js — outputs you wear instead of look at. The WebXR hand rig
// IS the standard: 25 named joints per hand, tracked by the headset. A
// wearable drives its parts from those joints every frame. First form:
// rigid segments per phalanx (no skinning) — articulated hands from
// nothing but joint poses. Skinned glb hands ride the same driver later.
import * as THREE from 'three';

// finger chains, each a run of XRHand joint names from knuckle to tip
const CHAINS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];
const SEGMENTS = CHAINS.flatMap(chain =>
  chain.slice(0, -1).map((a, i) => [a, chain[i + 1]]));

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

// The debug wearable: chunky articulated segments, unmistakably not the
// stock joint dots. Exists to prove the wear pipeline before generated
// hands do; also just looks like robot hands, which is a feature.
export function makeDebugHands(scene) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb8c4cc, metalness: 0.85, roughness: 0.35,
    emissive: 0x0a2a26, emissiveIntensity: 0.6,
  });
  const group = new THREE.Group();
  group.visible = false;
  const parts = SEGMENTS.map(([a, b]) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.0065, 1, 8), mat);
    m.userData.pair = [a, b];
    group.add(m);
    return m;
  });
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.022, 0.075), mat);
  group.add(palm);
  scene.add(group);

  return {
    group,
    // joints: a map of XRHand joint names to Object3Ds with live world
    // matrices (three's hand.joints, or a fake rig on desktop)
    update(joints) {
      const wrist = joints?.wrist;
      if (!wrist || wrist.visible === false) { group.visible = false; return; }
      group.visible = true;
      for (const m of parts) {
        const [an, bn] = m.userData.pair;
        const A = joints[an], B = joints[bn];
        if (!A || !B) { m.visible = false; continue; }
        m.visible = true;
        _a.setFromMatrixPosition(A.matrixWorld);
        _b.setFromMatrixPosition(B.matrixWorld);
        const len = Math.max(0.008, _a.distanceTo(_b));
        m.position.lerpVectors(_a, _b, 0.5);
        m.scale.set(1, len, 1);
        m.quaternion.setFromUnitVectors(_up, _b.sub(_a).normalize());
      }
      // palm block spans wrist toward the middle knuckle
      const mk = joints['middle-finger-metacarpal'] || joints['middle-finger-phalanx-proximal'];
      _a.setFromMatrixPosition(wrist.matrixWorld);
      if (mk) {
        _b.setFromMatrixPosition(mk.matrixWorld);
        palm.position.lerpVectors(_a, _b, 0.6);
        palm.quaternion.copy(wrist.quaternion ?? palm.quaternion);
        palm.quaternion.setFromRotationMatrix(wrist.matrixWorld);
      } else {
        palm.position.copy(_a);
      }
    },
    dispose() {
      scene.remove(group);
      for (const c of group.children) c.geometry.dispose();
      mat.dispose();
    },
  };
}

// The skinned wearable: a glb from tools/rigfit_hands.py (24 bones named
// by their distal WebXR joint). Bones are driven ABSOLUTELY from joint
// pair world positions, the same way the rigid segments are: position at
// the proximal joint, +Y (the blender bone axis) aligned to the segment.
// No reliance on rest offsets means live hand proportions never
// accumulate error down a chain; twist stays unconstrained, like the
// rigid driver, which hands mostly forgive.
export async function makeSkinnedHands(scene, url) {
  const { GLTFLoader } = await import('../vendor/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  let skinned = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) throw new Error('no skinned mesh in ' + url);
  skinned.frustumCulled = false;
  const bones = {};
  for (const b of skinned.skeleton.bones) bones[b.name] = b;
  const group = new THREE.Group();
  group.visible = false;
  group.add(root);
  scene.add(group);
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4();
  const _one = new THREE.Vector3(1, 1, 1);
  return {
    group,
    update(joints) {
      const wrist = joints?.wrist;
      if (!wrist || wrist.visible === false) { group.visible = false; return; }
      group.visible = true;
      for (const chain of CHAINS) {
        for (let i = 1; i < chain.length; i++) {
          const b = bones[chain[i]];
          const A = joints[chain[i - 1]], B = joints[chain[i]];
          if (!b || !A || !B) continue;
          _a.setFromMatrixPosition(A.matrixWorld);
          _b.setFromMatrixPosition(B.matrixWorld);
          _q.setFromUnitVectors(_up, _b.sub(_a).normalize());
          _m.compose(_a, _q, _one);
          b.parent.updateWorldMatrix(true, false);
          _mi.copy(b.parent.matrixWorld).invert();
          _m.premultiply(_mi);
          _m.decompose(b.position, b.quaternion, b.scale);
          b.scale.set(1, 1, 1);
          b.updateMatrixWorld(true);   // children read a fresh parent world
        }
      }
    },
    dispose() {
      scene.remove(group);
      skinned.geometry.dispose();
      (Array.isArray(skinned.material) ? skinned.material : [skinned.material]).forEach((m) => m.dispose());
    },
  };
}

// A fake open-palm joint rig for desktop testing: same shape as
// hand.joints, static pose, placed by a base matrix.
export function makeFakeJoints(base) {
  const J = {};
  const put = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    o.updateMatrix();
    o.matrixWorld.multiplyMatrices(base, o.matrix);
    o.visible = true;
    J[name] = o;
  };
  put('wrist', 0, 0, 0);
  const fingers = [
    ['thumb', -0.035, [0.028, 0.055, 0.078, 0.095]],
    ['index-finger', -0.02, [0.075, 0.11, 0.135, 0.155, 0.17]],
    ['middle-finger', -0.001, [0.075, 0.115, 0.145, 0.168, 0.185]],
    ['ring-finger', 0.018, [0.072, 0.108, 0.137, 0.158, 0.173]],
    ['pinky-finger', 0.036, [0.068, 0.095, 0.117, 0.134, 0.147]],
  ];
  const names5 = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
  const names4 = ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'];
  for (const [f, x, ds] of fingers) {
    const names = ds.length === 4 ? names4 : names5;
    ds.forEach((d, i) => put(`${f}-${names[i]}`, x + (f === 'thumb' ? -d * 0.35 : 0), 0, -d));
  }
  return J;
}
