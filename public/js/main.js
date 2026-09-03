// main.js — the space. Constellation of workflow hubs; drift, dock, edit,
// queue. Desktop controls now; every interaction is expressed as ray +
// point so VR controllers can slot in later.
import * as THREE from 'three';
import { parseWorkflow, workflowTypes, typesAccepting, typesProducing, colorForType, linkTypeMatches, schemaFromObjectInfo, BUILTIN_SCHEMA } from './graph.js';
import { Panel, FLOATERS, pumpRedraws, PW, buttonRow, readoutRow, glyphRow, logRow, progressRow, keysRow, kbufRow, keyIndexAt, sliderValue } from './panels.js';
import { BeamSystem } from './beams.js';
import { Hub } from './hubs.js';
import { ComfyClient, demoImage, scanOutputsForAssets, scanOutputsForMedia, summarizeApi, MESH_EXT } from './comfy.js';
import { toggleAsset } from './assets.js';
import { Audio } from './audio.js';
import { initAgent } from './agent.js';
import { getSetting, setSetting } from './settings.js';
import { makeDebugHands, makeFakeJoints } from './wearables.js';
import { listDestinations, addPeer, removeDestination, clientFor, cachedClient, listRigs, saveRig, removeRig, startRig, kickRig, stopDest, terminateDest, attachVolume, detachVolume, PROVIDERS, upsertCloudDest, syncRegistry, refreshCloudStates } from './destinations.js';
import { workflowManifest, manifestSizes } from './manifest.js';

const $ = (id) => document.getElementById(id);
const errBox = $('err');
function fail(m) { errBox.style.display = 'block'; errBox.textContent += m + '\n'; console.error(m); }
window.addEventListener('error', (e) => fail(e.message));
window.addEventListener('unhandledrejection', (e) => fail(String(e.reason)));

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x01050a);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3000);
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
// In XR the headset drives the camera's local pose; the rig is what our
// fly/dock logic moves. On desktop the rig sits at origin and the camera
// is driven directly, exactly as before.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
// lights exist solely for materialized 3D assets — every hologram is
// MeshBasic/additive and ignores them
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 5, 3);
scene.add(sun);
const camWorld = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- environment: aurora shell, stars, motes ----------
{
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1400, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uT: { value: 0 } },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform float uT;
        void main(){
          vec3 d = normalize(vP);
          float h = d.y*0.5+0.5;
          vec3 base = mix(vec3(0.004,0.012,0.022), vec3(0.010,0.030,0.045), pow(h,1.5));
          float band = sin(d.x*3.1 + uT*0.05) * sin(d.z*2.3 - uT*0.03);
          float aur = smoothstep(0.55, 1.0, band) * smoothstep(0.05, 0.4, h) * 0.06;
          base += vec3(0.1,0.9,0.7) * aur;
          gl_FragColor = vec4(base, 1.0);
        }`,
    })
  );
  scene.add(sky);
  window._sky = sky;
}
const stars = (() => {
  const N = 1600, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(900 + Math.random() * 400);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x9fd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(p);
  return p;
})();
function softDotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const MOTE_N = 600, WRAP = 130;
const motes = (() => {
  const pos = new Float32Array(MOTE_N * 3);
  for (let i = 0; i < MOTE_N * 3; i++) pos[i] = (Math.random() - 0.5) * WRAP;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x59e6d2, size: 0.7, map: softDotTexture(), transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  }));
  p.frustumCulled = false;
  scene.add(p);
  return p;
})();

// ---------- systems ----------
const audio = new Audio();
const beams = new BeamSystem(scene);
const client = new ComfyClient();
const hubs = [];
const raycaster = new THREE.Raycaster();

// ---------- camera state ----------
const cam = {
  yaw: 0, pitch: -0.1, vel: new THREE.Vector3(),
  pos: new THREE.Vector3(0, 26, 132),
  anim: null,            // {t, dur, p0, p1, l0, l1, then}
  dock: null,            // {panel, pos, look}
  level: 'space',        // space | hub | panel
  hub: null,
  mouse: { x: 0, y: 0 },
};
function syncAngles(look) {
  const d = look.clone().sub(cam.pos).normalize();
  cam.yaw = Math.atan2(-d.x, -d.z);
  cam.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
}
syncAngles(new THREE.Vector3(0, 0, 0));

function flyTo(p1, l1, dur = 1.6, then = null) {
  if (renderer.xr.isPresenting) {
    // comfort: teleport instead of gliding while the headset is on.
    // Land FACING the destination: the head pose is physical and cannot be
    // commanded, so counter-rotate the rig by the head's local yaw and the
    // user comes out looking at the target regardless of body bearing.
    cam.pos.copy(p1);
    const headYaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y;
    const d = l1.clone().sub(p1);
    if (d.x * d.x + d.z * d.z > 1e-6) xrState.yaw = Math.atan2(-d.x, -d.z) - headYaw;
    cam.anim = null; cam.dock = null;
    then?.();
    return;
  }
  const l0 = cam.pos.clone().add(forward().multiplyScalar(10));
  cam.anim = { t: 0, dur, p0: cam.pos.clone(), p1: p1.clone(), l0, l1: l1.clone(), then };
  cam.dock = null;
}
function forward() {
  return new THREE.Vector3(-Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch));
}

const HOME = { pos: new THREE.Vector3(0, 26, 132), look: new THREE.Vector3(0, 0, 0) };

function flyToHub(hub) {
  // stand opposite the DAG's mean bearing, half-way up the bowl, looking
  // into the tiers
  const dir = new THREE.Vector3(-Math.cos(hub.meanAngle), 0, -Math.sin(hub.meanAngle));
  const pos = hub.center().clone().add(dir.clone().multiplyScalar(11)).add(new THREE.Vector3(0, 5, 0));
  const look = hub.center().clone().sub(dir.clone().multiplyScalar(hub.rimRadius * 0.55)).add(new THREE.Vector3(0, hub.rimY * 0.5, 0));
  cam.level = 'hub'; cam.hub = hub;
  hub.unfold();
  flyTo(pos, look, 1.8);
  audio.dock();
}

function dockToPanel(panel, hub) {
  const center = panel.anchorWorld(0.5, 0.5);
  let normal;
  if (panel.billboard) {
    normal = cam.pos.clone().sub(center).normalize();
  } else {
    const axis = hub.center().clone().setY(center.y);
    normal = axis.sub(center).setY(0).normalize();   // inward, toward ring axis
  }
  const dist = panel.worldWidth * 0.62 + 1.2;
  cam.level = 'panel'; cam.hub = hub;
  flyTo(center.clone().add(normal.multiplyScalar(dist)), center, 1.1, () => {
    cam.dock = { panel, pos: cam.pos.clone(), look: center.clone() };
  });
  audio.dock();
}

function stepBack() {
  if (cam.level === 'panel' && cam.hub) {
    cam.dock = null;
    flyToHub(cam.hub);
  } else if (cam.level === 'hub') {
    cam.level = 'space'; cam.hub = null;
    flyTo(HOME.pos, HOME.look, 1.8);
  }
}

// ---------- input ----------
const keys = new Set();
let pdown = null, dragMode = null, sliderDrag = null;
let pendingGrab = null, moveDrag = null, linkDrag = null, palette = null;
let lastInput = performance.now();
const canvas = renderer.domElement;

// ---------- idle walk that owes you your spot back ----------
// The orbit can start whenever it likes because leaving costs nothing: it
// remembers exactly where you stood and how you faced, and your first mouse
// movement flies you home (a quick travel, not a teleport). Keyboard and
// wheel mean you are steering from wherever you are, so they cancel the
// return instead. Start time is long and jittered, re-rolled per episode.
let idleReturn = null;
let idleHover = null;
const rollIdleDelay = () => getSetting('idleDelayS') * 1000 * (1 + Math.random() * 0.5);
let idleDelayMs = rollIdleDelay();
function idleComeBack() {
  if (!idleReturn) return;
  const r = idleReturn;
  idleReturn = null; idleHover = null;
  idleDelayMs = rollIdleDelay();
  cam.level = r.level; cam.hub = r.hub;
  const drifted = cam.pos.distanceTo(r.pos) > 1 || Math.abs(cam.yaw - r.yaw) > 0.05;
  if (drifted) flyTo(r.pos, r.look, 0.9);
  else { cam.pos.copy(r.pos); syncAngles(r.look); }   // barely moved: just snap
}
function idleAbandon() { idleReturn = null; idleHover = null; idleDelayMs = rollIdleDelay(); }

canvas.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return;   // a second touch must not fight the first over the camera
  audio.ensure();
  try { THREE.AudioContext.getContext().resume(); } catch (err) { /* no positional audio yet */ }
  lastInput = performance.now();
  idleComeBack();   // touch has no hover; first tap after a walk goes home
  pdown = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
  dragMode = null; pendingGrab = null;
  const hit = pick(e);
  if (hit && reachable(hit) && hit.rowInfo) {
    const ri = hit.rowInfo;
    if (ri.kind === 'slider') {
      sliderDrag = hit;
      dragMode = 'slider';
      applySlider(hit, e);
    } else if (ri.kind === 'frame' && hit.hub && hit.panel.userData?.nodeId != null) {
      pendingGrab = { kind: 'move', hit };
    } else if (ri.kind === 'port' && hit.hub && hit.panel.userData?.nodeId != null) {
      const s = portSlotAt(hit);
      if (s && s.dir === 'out') {
        pendingGrab = { kind: 'link', drag: { mode: 'new', hub: hit.hub, type: s.type, srcNode: s.node.id, srcSlot: s.index } };
      } else if (s && s.dir === 'in' && s.node.linkInputs[s.index]?.link != null) {
        const L = hit.hub.graph.links.get(s.node.linkInputs[s.index].link);
        if (L) pendingGrab = { kind: 'link', drag: { mode: 'retarget', hub: hit.hub, type: L.type, srcNode: L.src, srcSlot: L.srcSlot, linkId: L.id } };
      } else if (s && s.dir === 'in') {
        // empty input: pull backward to find (or grow) something that feeds it
        pendingGrab = { kind: 'link', drag: { mode: 'reverse', hub: hit.hub, type: s.type, dstNode: s.node.id, dstSlot: s.index } };
      }
    }
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no real pointerId */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!e.isPrimary) return;
  cam.mouse.x = (e.clientX / innerWidth) * 2 - 1;
  cam.mouse.y = (e.clientY / innerHeight) * 2 - 1;
  if (dragMode === 'slider' && sliderDrag) {
    lastInput = performance.now();
    const hit = pick(e);
    if (hit && hit.panel === sliderDrag.panel) applySlider({ ...sliderDrag, rowInfo: { ...sliderDrag.rowInfo, frac: hit.rowInfo?.row === sliderDrag.rowInfo.row ? hit.rowInfo.frac : sliderDrag.rowInfo.frac } }, e, hit);
    return;
  }
  if (pdown) {
    lastInput = performance.now();
    // deltas from clientX, never movementX: Firefox-family browsers (Wolvic
    // on Quest included) report movementX for synthesized pointer events as
    // huge jumps, zeros, or undefined, which sent the camera spinning
    let dx = e.clientX - pdown.lx, dy = e.clientY - pdown.ly;
    pdown.lx = e.clientX; pdown.ly = e.clientY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { dx = 0; dy = 0; }
    dx = THREE.MathUtils.clamp(dx, -60, 60);
    dy = THREE.MathUtils.clamp(dy, -60, 60);
    const moved = Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y) > 4;
    if (!dragMode && moved && pendingGrab) {
      if (pendingGrab.kind === 'move') beginMove(pendingGrab, e);
      else beginLink(pendingGrab.drag);
    }
    if (dragMode === 'move') { doMove(e); return; }
    if (dragMode === 'link') { doLinkDrag(e); return; }
    if (dragMode === 'look' || moved) {
      dragMode = 'look';
      cam.yaw -= dx * 0.0031;
      cam.pitch = THREE.MathUtils.clamp(cam.pitch - dy * 0.0031, -1.5, 1.5);
      cam.anim = null; cam.dock = null;
      if (cam.level === 'panel') cam.level = 'hub';
    }
    return;
  }
  // bare mouse movement counts as presence: it holds off the idle walk, and
  // if the walk already wandered, a real jiggle (not a desk bump) flies home
  lastInput = performance.now();
  if (idleReturn) {
    idleHover = idleHover || { x: e.clientX, y: e.clientY, px: 0 };
    idleHover.px += Math.hypot(e.clientX - idleHover.x, e.clientY - idleHover.y);
    idleHover.x = e.clientX; idleHover.y = e.clientY;
    if (idleHover.px > 8) idleComeBack();
  }
  hover(e);
});
canvas.addEventListener('pointerup', (e) => {
  if (!e.isPrimary) return;
  lastInput = performance.now();
  if (dragMode === null && pdown) onClick(e);
  if (dragMode === 'slider') audio.tick();
  if (dragMode === 'move') endMove();
  if (dragMode === 'link') endLink(e);
  pdown = null; dragMode = null; sliderDrag = null; pendingGrab = null;
});
canvas.addEventListener('pointercancel', () => {
  // Wolvic cancels the pointer stream on some transitions; a stuck pdown
  // would keep steering the camera with stale state
  pdown = null; dragMode = null; sliderDrag = null; pendingGrab = null;
});
canvas.addEventListener('wheel', (e) => {
  lastInput = performance.now();
  if (dragMode === 'move' && moveDrag) {
    // wheel while holding a node pulls it radially between rings
    const p = moveDrag.panel;
    moveDrag.hub.moveNode(moveDrag.id, p.placement.theta, p.placement.y, p.placement.r + (e.deltaY > 0 ? 1.4 : -1.4));
    audio.zip(Math.min(1, p.placement.r / 40));
    return;
  }
  // wheel over a slider = fine nudge, one step per notch (shift = 10 steps)
  if (dragMode === null) {
    const hit = pick(e);
    const ri = hit?.rowInfo;
    if (palette && hit?.panel === palette.panel) { palettePage(e.deltaY > 0 ? 1 : -1); return; }
    if (browser && hit?.panel === browser.panel) { browser.page += e.deltaY > 0 ? 1 : -1; buildBrowser(); audio.tick(); return; }
    if (ri?.kind === 'slider' && ri.row?.widget) {
      const row = ri.row, wg = row.widget;
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = (row.step || (row.int ? 1 : 0.01)) * (e.shiftKey ? 10 : 1);
      let v = (Number(wg.value) || 0) + dir * step;
      if (row.int) v = Math.round(v);
      else v = Number(v.toFixed(4));
      v = THREE.MathUtils.clamp(v, row.hardMin ?? row.min, row.hardMax ?? row.max);
      if (v !== wg.value) {
        wg.value = v;
        audio.tick();
        row.onChange?.();
        hit.panel.dirty();
      }
      return;
    }
  }
  cam.vel.add(forward().multiplyScalar(e.deltaY < 0 ? 3.5 : -3.5));
  cam.anim = null;
  idleAbandon();   // wheel travel = steering from here, not going back
});
addEventListener('keydown', (e) => {
  if (editorOpen()) return;
  lastInput = performance.now();
  idleAbandon();   // keyboard = manual control from wherever you are
  if (e.key === 'Escape') {
    if (palette) { closePalette(); return; }
    if (settingsPanel) { closeSettings(); return; }
    if (browser) { closeBrowser(); return; }
    if (galleryCard) { hideGalleryCard(); return; }
    stepBack(); return;
  }
  const typer = palette || browser;
  if (typer) {
    // an open picker owns the keyboard: type to filter, Enter takes the top hit
    const rebuild = palette ? buildPalette : buildBrowser;
    if (e.key === 'Backspace') { typer.query = typer.query.slice(0, -1); typer.page = 0; rebuild(); return; }
    if (e.key === 'Enter') {
      if (palette?.first) addFromPalette(palette.first);
      else if (browser?.first) openWorkflow(browser.first);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typer.query += e.key;
      if (palette) palette.mode = 'list';   // search is global, leave the category view
      typer.page = 0;
      rebuild();
      audio.tick();
      return;
    }
  }
  if (e.key === 'm' || e.key === 'M') { audio.setMuted(!audio.muted); setSetting('muted', audio.muted); flashHint(audio.muted ? 'muted' : 'sound on'); return; }
  keys.add(e.key.toLowerCase());
  if (['w', 'a', 's', 'd', 'q', 'e'].includes(e.key.toLowerCase())) { cam.anim = null; cam.dock = null; if (cam.level === 'panel') cam.level = 'hub'; }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ---------- node moving ----------
function setRay(e) {
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
}
// Where the pointer ray meets the hub's vertical cylinder of given radius.
function rayCylinder(hub, radius) {
  const o = raycaster.ray.origin, d = raycaster.ray.direction, c = hub.center();
  const ox = o.x - c.x, oz = o.z - c.z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) return null;
  const b = 2 * (ox * d.x + oz * d.z);
  const q = ox * ox + oz * oz - radius * radius;
  const disc = b * b - 4 * a * q;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = (-b + s) / (2 * a);                 // exit face: what you see from inside the bowl
  const t0 = (-b - s) / (2 * a);
  if (q > 0 && t0 > 0) t = t0;                // outside the ring: near face
  if (t <= 0) return null;
  const p = o.clone().addScaledVector(d, t);
  return { theta: Math.atan2(p.z - c.z, p.x - c.x), y: p.y - c.y };
}
const wrapAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function beginMove(pg, e) {
  const p = pg.hit.panel, hub = pg.hit.hub;
  setRay(e);
  const at = rayCylinder(hub, p.placement.r);
  moveDrag = {
    hub, panel: p, id: p.userData.nodeId,
    offT: at ? wrapAng(p.placement.theta - at.theta) : 0,
    offY: at ? p.placement.y - at.y : 0,
  };
  dragMode = 'move';
  audio.tick();
}
function doMove(e) { setRay(e); doMoveRay(); }
function doMoveRay() {
  const at = rayCylinder(moveDrag.hub, moveDrag.panel.placement.r);
  if (at) moveDrag.hub.moveNode(moveDrag.id, at.theta + moveDrag.offT, at.y + moveDrag.offY);
}
function endMove() {
  audio.toggle(true);
  moveDrag = null;
}

// ---------- link dragging (rewire / new link / accrete) ----------
function portSlotAt(hit) {
  const row = hit.rowInfo.row;
  if (!row || row.kind !== 'port') return null;
  const li = Math.min(Math.floor(hit.rowInfo.yFrac * row.lines), row.lines - 1);
  const s = row.slots[li];
  const node = hit.hub?.graph.nodes.get(hit.panel.userData?.nodeId);
  if (!s || !node) return null;
  const index = s.dir === 'in'
    ? node.linkInputs.findIndex(x => x.name === s.name)
    : node.outputs.findIndex(x => x.name === s.name);
  if (index < 0) return null;
  return { ...s, index, node };
}

function beginLink(drag) {
  linkDrag = drag;
  dragMode = 'link';
  drag.A = drag.mode === 'reverse'
    ? drag.hub.anchorFor(drag.dstNode, 'in', { dstSlot: drag.dstSlot })
    : drag.hub.anchorFor(drag.srcNode, 'out', { srcSlot: drag.srcSlot });
  if (!drag.A) { linkDrag = null; dragMode = 'look'; return; }
  drag.drop = drag.A.clone();
  if (drag.mode === 'retarget') {
    const b = beams.beams.get(drag.hub.beamKey(drag.linkId));
    if (b) b.line.visible = false;
  }
  beams.addBeam('::drag', drag.A, drag.A.clone(), colorForType(drag.type), { alpha: 0.85, bulge: 0.08, group: '::drag' });
  // reverse drags hunt for producers, so halo the OUTPUT dots instead
  for (const p of drag.hub.panels.values()) p.setHint({ type: drag.type, dir: drag.mode === 'reverse' ? 'out' : 'in' });
  audio.tick();
}
function doLinkDrag(e) { setRay(e); doLinkDragRay(); }
function doLinkDragRay() {
  const dist = Math.max(4, linkDrag.A.distanceTo(camWorld));
  linkDrag.drop = raycaster.ray.at(dist, new THREE.Vector3());
  beams.updateBeam('::drag', linkDrag.A, linkDrag.drop);
}
function endLink(e) { finishLink(pick(e)); }
function finishLink(hit) {
  const drag = linkDrag;
  linkDrag = null;
  beams.removeBeam('::drag');
  for (const p of drag.hub.panels.values()) p.setHint(null);
  if (drag.mode === 'retarget') {
    const b = beams.beams.get(drag.hub.beamKey(drag.linkId));
    if (b) b.line.visible = true;
  }
  if (hit && hit.hub === drag.hub && hit.rowInfo?.kind === 'port') {
    const s = portSlotAt(hit);
    if (s && drag.mode === 'reverse') {
      if (s.dir === 'out' && linkTypeMatches(s.type, drag.type)) drag.hub.commitNewLink(s.node.id, s.index, drag.dstNode, drag.dstSlot);
      return;
    }
    if (s && s.dir === 'in' && linkTypeMatches(drag.type, s.type)) {
      if (drag.mode === 'new') drag.hub.commitNewLink(drag.srcNode, drag.srcSlot, s.node.id, s.index);
      else drag.hub.retargetTo(drag.linkId, s.node.id, s.index);
      return;
    }
    return;  // incompatible port: no-op
  }
  if (!hit) {
    if (drag.mode === 'new' || drag.mode === 'reverse') openPalette(drag);
    else { drag.hub.detachLink(drag.linkId); flashHint('link detached'); }
  }
}

// ---------- add-node palette: drop a beam into space, pick what grows there ----------
// Fuzzy filter matches what the stock frontend searches: type name, display
// name, and search_aliases. No query = types already in this workflow first.
function fuzzyScore(q, type) {
  const sc = SCHEMA[type];
  let best = 0;
  for (const hay of [type, sc.display || '', ...(sc.aliases || [])]) {
    const s = hay.toLowerCase();
    if (!s) continue;
    if (s.startsWith(q)) best = Math.max(best, 100 - s.length);
    else if (s.includes(q)) best = Math.max(best, 60 - s.indexOf(q));
    else {
      let i = 0;
      for (const ch of s) if (ch === q[i]) i++;
      if (i === q.length) best = Math.max(best, 20);
    }
  }
  return best;
}

function catOf(t) { return ((SCHEMA[t].category || 'other').split('/')[0] || 'other').toLowerCase(); }

// Suggestion tables in the spirit of the stock frontend's slot defaults:
// dropping a wire should offer what people actually reach for, not the
// alphabet. Curated per link type and pull direction.
const SUGGEST_OUT = {   // pulled forward from an output: likely consumers
  IMAGE: ['PreviewImage', 'SaveImage', 'VAEEncode', 'ImageScale', 'ImageUpscaleWithModel'],
  LATENT: ['VAEDecode', 'KSampler', 'LatentUpscale'],
  MODEL: ['KSampler', 'LoraLoader'],
  CONDITIONING: ['KSampler'],
  CLIP: ['CLIPTextEncode', 'CLIPSetLastLayer'],
  VAE: ['VAEDecode', 'VAEEncode'],
  MASK: ['InvertMask', 'ImageCompositeMasked'],
};
const SUGGEST_IN = {    // pulled backward from an empty input: likely producers
  MODEL: ['CheckpointLoaderSimple', 'UNETLoader', 'LoraLoader'],
  CLIP: ['CheckpointLoaderSimple', 'CLIPLoader'],
  VAE: ['CheckpointLoaderSimple', 'VAELoader'],
  LATENT: ['EmptyLatentImage', 'VAEEncode', 'KSampler'],
  IMAGE: ['LoadImage', 'VAEDecode'],
  CONDITIONING: ['CLIPTextEncode'],
  MASK: ['LoadImage'],
};

function paletteMatches(useCat) {
  // no drag = free add (empty hub, core button): every type in the install
  let all = !palette.drag ? Object.keys(SCHEMA)
    : palette.drag.mode === 'reverse'
    ? typesProducing(SCHEMA, palette.drag.type)
    : typesAccepting(SCHEMA, palette.drag.type);
  if (useCat && palette.cat) all = all.filter(t => catOf(t) === palette.cat);
  const q = palette.query.trim().toLowerCase();
  if (q) {
    return all.map(t => [t, fuzzyScore(q, t)]).filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }
  // Relevance tiers, not the alphabet: this workflow's own types, then the
  // curated suggestions for the pulled type, then vanilla core nodes, then
  // the long tail (which is what categories and search are for).
  const inHub = new Set([...palette.hub.graph.nodes.values()].map(n => n.type));
  const curated = palette.drag
    ? (palette.drag.mode === 'reverse' ? SUGGEST_IN : SUGGEST_OUT)[palette.drag.type] || []
    : [];
  const cIdx = new Map(curated.map((t, i) => [t, i]));
  const tier = (t) => (inHub.has(t) ? 0 : cIdx.has(t) ? 1 : BUILTIN_SCHEMA[t] ? 2 : 3);
  return all.slice().sort((a, b) => {
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 1) return cIdx.get(a) - cIdx.get(b);
    return (SCHEMA[a].display || a).localeCompare(SCHEMA[b].display || b);
  });
}

function addFromPalette(t) {
  const { drag, hub } = palette;
  const rel = palette.pos.clone().sub(hub.center());
  const place = { theta: Math.atan2(rel.z, rel.x), r: Math.hypot(rel.x, rel.z), y: rel.y };
  if (!drag) {
    // free add has no wire anchoring it near the bowl; keep the node on it
    place.r = Math.min(Math.max(place.r, 3.5), hub.rimRadius + 4);
    place.y = Math.min(Math.max(place.y, 0.6), hub.rimY + 8);
  }
  const pending = !drag ? null
    : drag.mode === 'reverse'
    ? { reverse: true, dstNode: drag.dstNode, dstSlot: drag.dstSlot, type: drag.type }
    : { srcNode: drag.srcNode, srcSlot: drag.srcSlot, type: drag.type };
  hub.addNodeAt(t, place, pending);
  closePalette();
}

function palettePage(dir) {
  if (!palette) return;
  palette.page += dir;
  buildPalette();
  audio.tick();
}

// Two views, both pinch-native for VR: a paged list of matching types, and
// a category drill-down built from each node's real category path. Typing
// still fuzzy-filters on desktop.
function buildPalette() {
  palette.panel?.dispose();
  const PAGE = 7;
  let items;
  if (palette.mode === 'cats') {
    const counts = new Map();
    for (const t of paletteMatches(false)) counts.set(catOf(t), (counts.get(catOf(t)) || 0) + 1);
    items = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({
      label: `${c.toUpperCase()} · ${n}`,
      act: () => { palette.cat = c; palette.mode = 'list'; palette.page = 0; buildPalette(); audio.tick(); },
    }));
    palette.first = null;
  } else {
    const types = paletteMatches(true);
    palette.first = types[0] || null;
    items = types.map(t => ({ label: (SCHEMA[t].display || t).toUpperCase(), act: () => addFromPalette(t) }));
  }
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  palette.page = Math.min(Math.max(0, palette.page), pages - 1);
  const slice = items.slice(palette.page * PAGE, palette.page * PAGE + PAGE);
  const inCat = palette.mode === 'list' && palette.cat;
  const rows = [
    readoutRow(() => (palette?.query ? '⌕ ' + palette.query : '⌕ type to filter'),
               () => (inCat && palette ? '⌸ ' + palette.cat : '')),
    palette.mode === 'cats' || inCat
      ? buttonRow('◂ BACK', () => { palette.mode = 'list'; palette.cat = null; palette.page = 0; buildPalette(); audio.tick(); })
      : buttonRow('⌸ BROWSE CATEGORIES', () => { palette.mode = 'cats'; palette.page = 0; buildPalette(); audio.tick(); }),
    ...(slice.length ? slice.map(it => buttonRow(it.label, it.act))
                     : [readoutRow(() => 'no matching node types', () => '')]),
    ...(pages > 1 ? [buttonRow(`◂  ${palette.page + 1} / ${pages}  ▸`, (frac) => palettePage(frac < 0.5 ? -1 : 1))] : []),
  ];
  const panel = new Panel({
    title: 'add node', subtitle: palette.drag ? palette.drag.type : 'any type',
    accent: palette.drag ? colorForType(palette.drag.type) : '#7ce8dc',
    rows, worldWidth: 3.0, billboard: true, floating: true,
  });
  panel.placeFlat(scene, palette.pos);
  panel.mesh.userData.palette = true;
  panel.dirty();
  palette.panel = panel;
}

let paletteExpanded = false;
// SCHEMA is lazily filled with only the types loaded workflows use; the
// palette should offer the whole install. object_info is already cached,
// so expand once, on first open.
function expandPaletteSchema() {
  if (!paletteExpanded && client.mode === 'live' && client.objectInfo) {
    Object.assign(SCHEMA, schemaFromObjectInfo(client.objectInfo, Object.keys(client.objectInfo)));
    paletteExpanded = true;
  }
}
function openPalette(drag) {
  closePalette();
  expandPaletteSchema();
  const any = drag.mode === 'reverse' ? typesProducing(SCHEMA, drag.type).length : typesAccepting(SCHEMA, drag.type).length;
  if (!any) return;
  palette = { panel: null, pos: drag.drop.clone(), hub: drag.hub, drag, query: '', first: null, mode: 'list', cat: null, page: 0 };
  buildPalette();
  audio.accrete();
}
// Free add: no wire, no type filter. The ✚ ADD NODE button on a hub's core
// opens this — the only way to grow a workflow that has nothing to pull from.
function openPaletteFree(hub) {
  closePalette();
  expandPaletteSchema();
  let pos;
  if (renderer.xr.isPresenting) {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    pos = head.addScaledVector(dir, 6);
  } else {
    pos = cam.pos.clone().add(forward().multiplyScalar(8));
  }
  palette = { panel: null, pos, hub, drag: null, query: '', first: null, mode: 'cats', cat: null, page: 0 };
  buildPalette();
  audio.accrete();
}
function closePalette() {
  if (!palette) return;
  if (hotPanel === palette.panel) hotPanel = null;   // never re-hot a disposed panel
  palette.panel?.dispose();
  palette = null;
}

// ---------- layout sidecar: arrangements survive without touching files ----------
let LAYOUTS = {};
const layoutTimers = new Map();
function wfKey(source, name) { return (source + '__' + name).replace(/[^\w .()\-]/g, '_').slice(0, 120); }
function scheduleLayoutSave(hub) {
  clearTimeout(layoutTimers.get(hub));
  layoutTimers.set(hub, setTimeout(() => {
    const key = wfKey(hub.source, hub.name);
    LAYOUTS[key] = hub.overrides;
    client.saveLayout(key, hub.overrides);
  }, 1200));
}
function applySidecarLayout(json, source, name) {
  const side = LAYOUTS[wfKey(source, name)];
  if (!side) return;
  const extra = json.extra = json.extra || {};
  const cvr = extra.comfyvr = extra.comfyvr || {};
  cvr.layout = { ...(cvr.layout || {}), ...side };
}

// ---------- workflow library: browse, open, and close from inside ----------
let libraryPanel = null;
let browser = null;
let wfIndex = [];

function buildLibrary() {
  libraryPanel = new Panel({
    title: 'workflow library', subtitle: '', accent: '#7ce8dc', worldWidth: 6.5, billboard: true,
    rows: [
      glyphRow('⌸', true),
      readoutRow(() => `${wfIndex.length} workflows`, () => `${hubs.length} open`),
      buttonRow('⌸ BROWSE', () => openBrowser()),
      buttonRow('✚ NEW WORKFLOW', () => newWorkflow()),
      buttonRow('⚙ SETTINGS', () => openSettings()),
    ],
  });
  libraryPanel.placeFlat(scene, new THREE.Vector3(0, 0, 0));
  libraryPanel.mesh.userData.library = true;
  libraryPanel.baseOpacity = 0.85;
  libraryPanel.dirty();
}

async function refreshWfIndex() {
  const local = await client.listLocalWorkflows().catch(() => []);
  const user = await client.listUserdataWorkflows().catch(() => []);
  const loc = local.filter(it => !it.name.startsWith('_'));   // _snap and friends are not workflows
  wfIndex = [
    ...loc.map(it => ({ name: it.name, source: 'local' })),
    ...user.filter(u => !loc.some(l => l.name === u.name)).map(u => ({ name: u.name, source: 'comfyui', path: u.path })),
  ];
  libraryPanel?.dirty();
}

// ---------- workflow from nothing: name it, save an empty graph, fly in ----------
async function createWorkflow(rawName) {
  let name = String(rawName || '').replace(/[^\w .()\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) name = 'untitled';
  const taken = new Set([...wfIndex.map(w => w.name.toLowerCase()), ...hubs.map(h => h.name.toLowerCase())]);
  let unique = name;
  for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${name} ${i}`;
  const json = { nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4, last_node_id: 0, last_link_id: 0 };
  const ok = await client.saveLocalWorkflow(unique, json);
  if (!ok) { flashHint('create FAILED'); audio.toggle(false); return; }
  await refreshWfIndex();
  await openWorkflow({ name: unique, source: 'local' });
}

function newWorkflow() {
  // a synthetic row rides the normal text-entry path: DOM editor on
  // desktop, in-space keyboard in XR — commit lands in onChange
  const row = { name: 'workflow name', oneline: true, widget: { value: '' } };
  row.get = () => row.widget.value;
  row.onChange = () => { createWorkflow(row.widget.value).catch((e) => flashHint('create failed: ' + (e.message || e))); };
  openEditor({ title: 'new workflow', accent: '#7ce8dc', disposed: false, dirty() {} }, row);
}

function isOpen(w) { return hubs.some(h => h.name === w.name); }

function browserItems() {
  const q = browser.query.trim().toLowerCase();
  let items = wfIndex;
  if (q) items = items.filter(w => w.name.toLowerCase().includes(q));
  return items.slice().sort((a, b) => {
    const ao = isOpen(a) ? 0 : 1, bo = isOpen(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

function buildBrowser() {
  browser.panel?.dispose();
  const PAGE = 8;
  const items = browserItems();
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  browser.page = Math.min(Math.max(0, browser.page), pages - 1);
  const slice = items.slice(browser.page * PAGE, browser.page * PAGE + PAGE);
  browser.first = slice.find(w => !isOpen(w)) || null;
  const rows = [
    readoutRow(() => (browser?.query ? '⌕ ' + browser.query : '⌕ type to filter'),
               () => '● open · right edge closes'),
    buttonRow('✚ NEW WORKFLOW', () => newWorkflow()),
    ...(slice.length ? slice.map(w => {
      const open = isOpen(w);
      return buttonRow(`${open ? '●' : '◌'} ${w.name.toUpperCase()}${w.source === 'local' ? ' ⬡' : ''}`, (frac) => {
        if (open && frac > 0.82) closeWorkflow(w.name);
        else if (open) { const h = hubs.find(x => x.name === w.name); closeBrowser(); flyToHub(h); }
        else openWorkflow(w);
      });
    }) : [readoutRow(() => 'no matching workflows', () => '')]),
    ...(pages > 1 ? [buttonRow(`◂  ${browser.page + 1} / ${pages}  ▸`, (frac) => { browser.page += frac < 0.5 ? -1 : 1; buildBrowser(); audio.tick(); })] : []),
  ];
  const panel = new Panel({ title: 'workflows', subtitle: String(wfIndex.length), accent: '#7ce8dc', rows, worldWidth: 3.6, billboard: true, floating: true });
  panel.placeFlat(scene, browser.pos);
  panel.mesh.userData.palette = true;   // same reachability rules as the palette
  panel.dirty();
  browser.panel = panel;
}

function openBrowser() {
  closeBrowser();
  closePalette();
  // in XR the head drives the view, not cam.yaw: place the panel where the
  // user is actually looking or it opens behind them
  let pos;
  if (renderer.xr.isPresenting) {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    pos = head.addScaledVector(dir, 8);
  } else {
    pos = cam.pos.clone().add(forward().multiplyScalar(11));
  }
  browser = { panel: null, page: 0, query: '', first: null, pos };
  buildBrowser();
  refreshWfIndex().then(() => { if (browser) buildBrowser(); });
  audio.accrete();
}
function closeBrowser() {
  if (!browser) return;
  if (hotPanel === browser.panel) hotPanel = null;
  browser.panel?.dispose();
  browser = null;
}

// ---------- settings: the workspace parameters view ----------
// Options accumulate here instead of growing hidden constants. Stored per
// device (localStorage), which is right for knobs like the splat budget.
let settingsPanel = null;
function closeSettings() {
  if (!settingsPanel) return;
  if (hotPanel === settingsPanel) hotPanel = null;
  settingsPanel.dispose();
  settingsPanel = null;
}

const IDLE_STEPS = [0, 30, 60, 120, 300];          // 0 = off
const RECALL_STEPS = [0, 1, 2, 3];
const SPLAT_STEPS = [50000, 150000, 300000, 0];    // 0 = full resolution

function buildSettings(pos) {
  // rebuild where the panel actually is: the user may have moved it
  const rebuild = () => buildSettings(settingsPanel ? settingsPanel.mesh.position.clone() : pos);
  closeSettings();
  const cycleRow = (label, k, steps, apply) => buttonRow(label, () => {
    const cur = getSetting(k);
    const next = steps[(steps.indexOf(cur) + 1) % steps.length];
    setSetting(k, next);
    apply?.(next);
    rebuild();
    audio.tick();
  });
  const idleS = getSetting('idleWalk') ? getSetting('idleDelayS') : 0;
  const rows = [
    readoutRow(() => 'saved on this device', () => ''),
    buttonRow(getSetting('muted') ? '○ SOUND OFF' : '● SOUND ON', () => {
      setSetting('muted', !getSetting('muted'));
      audio.setMuted(getSetting('muted'));
      rebuild();
    }),
    buttonRow(`☾ IDLE WALK · ${idleS ? idleS + 'S' : 'OFF'}`, () => {
      const next = IDLE_STEPS[(IDLE_STEPS.indexOf(idleS) + 1) % IDLE_STEPS.length];
      setSetting('idleWalk', next > 0);
      if (next > 0) setSetting('idleDelayS', next);
      idleAbandon();   // re-roll the timer under the new value
      rebuild();
      audio.tick();
    }),
    cycleRow(`⟲ RECALL LATEST · ${getSetting('recallLatest') || 'OFF'}`, 'recallLatest', RECALL_STEPS, null),
    cycleRow(`❖ VR SPLAT BUDGET · ${getSetting('splatBudget') ? Math.round(getSetting('splatBudget') / 1000) + 'K' : 'FULL'}`, 'splatBudget', SPLAT_STEPS, null),
    cycleRow(`✋ HANDS · ${getSetting('handStyle').toUpperCase()}`, 'handStyle', ['dots', 'robot'],
      () => applyHandStyle()),
    // Run On knobs (the dedicated remote-runs submenu comes with the pod
    // UI; these two are the money-safety floor and belong here NOW)
    cycleRow(`⏻ POD COOLDOWN · ${getSetting('runCooldownMin')}M`, 'runCooldownMin', [15, 30, 60, 120], null),
    cycleRow(`◎ POD SPEND CAP · ${getSetting('runCapUsd') ? '$' + getSetting('runCapUsd') : 'OFF'}`, 'runCapUsd', [0, 1, 5, 10, 25], null),
    buttonRow('⚡ REMOTE RUNS ▸', () => openRemoteRuns()),
  ];
  const panel = new Panel({ title: 'settings', subtitle: 'workspace', accent: '#7ce8dc', rows, worldWidth: 3.2, billboard: true, floating: true });
  panel.placeFlat(scene, pos);
  panel.mesh.userData.palette = true;   // always reachable, like the pickers
  panel.dirty();
  settingsPanel = panel;
}

function openSettings() {
  closeBrowser();
  closePalette();
  closeRemoteRuns();
  let pos;
  if (renderer.xr.isPresenting) {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    pos = head.addScaledVector(dir, 8);
  } else {
    pos = cam.pos.clone().add(forward().multiplyScalar(11));
  }
  buildSettings(pos);
  audio.accrete();
}

// ---------- run on picker: where should this workflow run ----------
const destState = (d) => (d.url ? 'SERVING' : d.stopped ? 'STOPPED' : d.podId ? 'STARTING' : 'COLD');

// After a resume, poll status until the pod serves, then bind the hub.
async function waitServing(d, h) {
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const st = await PROVIDERS[d.provider].status(d);
      if (st.url) {
        const rig = listRigs().find((r) => r.id === d.rigId);
        if (rig) upsertCloudDest(rig, { url: st.url, usdHr: st.usd_hr, stopped: false });
        if (h) bindDest(h, d.id);
        flashHint(d.name + ' is serving');
        return;
      }
      flashHint(`${d.name}: ${st.status || 'starting'}...`);
    } catch (e) { /* transient during restart */ }
  }
  flashHint(d.name + ' did not come back in 5 minutes · check the provider console');
}

function runOnLabel(h) {
  if (!h.dest) return '▸ RUN ON · LOCAL';
  const d = listDestinations().find((x) => x.id === h.dest);
  return '▸ RUN ON · ' + (d ? d.name : String(h.dest)).toUpperCase();
}

let runOnPanel = null;
function closeRunOnPicker() {
  if (!runOnPanel) return;
  if (hotPanel === runOnPanel) hotPanel = null;
  runOnPanel.dispose();
  runOnPanel = null;
}

function bindDest(h, destId) {
  h.dest = destId;
  if (h._destRow) { h._destRow.label = runOnLabel(h); h.corePanel?.dirty(); }
  closeRunOnPicker();
  flashHint(h.name + ' runs on ' + (destId ? destId : 'local'));
  audio.toggle(true);
}

async function openRunOnPicker(h) {
  closeRunOnPicker();
  // rows are built from the PROVIDER's live pod list, never cached page
  // state: another session, the watchdog, or the provider console may
  // have touched the pod since this page last looked
  buildRunOnPicker(h, true);
  await refreshCloudStates().catch(() => {});
  if (runOnPanel) buildRunOnPicker(h, false);
}

function buildRunOnPicker(h, checking) {
  const keepPos = runOnPanel?.mesh?.position.clone();
  closeRunOnPicker();
  const dests = listDestinations();
  const rows = [
    readoutRow(() => 'where should ' + h.name + ' run', () => (checking ? 'checking rigs...' : '')),
    buttonRow('⌂ LOCAL', () => bindDest(h, null)),
  ];
  for (const d of dests) {
    const state = d.kind === 'peer' ? 'PEER' : destState(d);
    if (state === 'STOPPED') {
      // with a volume, the disk persists what this workflow needs, so the
      // label says whether resume is instant or still has to install
      const wp = warmPlan(d.rigId, h);
      const suffix = wp ? ' · ' + wp.text : ' · same disk';
      rows.push(buttonRow(`▸ RESUME ${d.name.toUpperCase()}${suffix}`, () => {
        closeRunOnPicker();
        openPodPanel(d, h, 'resuming (disk as you left it)');
        PROVIDERS[d.provider].resume(d).catch((e) => flashHint(String(e.message || e)));
      }));
      continue;
    }
    rows.push(buttonRow(`${d.kind === 'peer' ? '⬡' : '☁'} ${d.name.toUpperCase()} · ${state}`, () => {
      if (d.kind === 'cloud' && !d.podId) { flashHint('that rig is cold · warm it below'); return; }
      bindDest(h, d.id);
      if (d.kind === 'cloud' && d.podId) { closeRunOnPicker(); openPodPanel(d, h); }   // watch it / act on it
    }));
  }
  // warm a rig FOR this workflow: its manifest rides into the bootstrap,
  // so the pod comes up with this workflow's models and packs. The
  // bootstrap only runs at pod CREATION, so a stopped husk warmed for
  // something else gets replaced, and the row says so.
  for (const r of listRigs()) {
    const d = dests.find((x) => x.id === 'cloud-' + r.id);
    if (d?.url || (d?.podId && !d?.stopped)) continue;   // live or starting: nothing to warm
    const replacing = !!d?.podId;
    // warm the rig FOR this workflow: its manifest rides into the bootstrap,
    // so the pod comes up with this workflow's models and packs. The pod
    // panel opens immediately so the whole cold start is watchable.
    const doWarm = () => {
      closeRunOnPicker();
      kickRig(r.id, { manifest: workflowManifest(h.rawWorkflow()) })
        .then((dd) => openPodPanel(dd, h, `building a fresh pod with ${h.name}'s models`))
        .catch((e) => flashHint(String(e.message || e)));
    };
    // REBUILD (was "warm fresh"): the bootstrap only runs at pod CREATION,
    // so a stopped husk warmed for something else cannot grow this
    // workflow's models on resume; it is terminated and made new.
    rows.push(buttonRow(`▸ ${replacing ? 'REBUILD' : 'WARM'} ${r.name.toUpperCase()} FOR ${h.name.toUpperCase()}`, () => {
      if (!replacing) return doWarm();
      flashHint('replacing the stopped pod with a fresh one');
      terminateDest(d.id).then(doWarm).catch((e) => flashHint(String(e.message || e)));
    }));
  }
  rows.push(buttonRow('✕ CLOSE', () => closeRunOnPicker()));
  const panel = new Panel({ title: 'run on', subtitle: h.name, accent: '#ffb86c', rows, worldWidth: 3.2, billboard: true, floating: true });
  // submenus dock IN THE PARENT'S PLANE, beside it, never over it and
  // never floating free in gaze space (user: think slot packing around
  // the parent, the quest menu grammar; see design.md docked workstation)
  let at;
  if (keepPos) {
    at = keepPos;   // a rebuild stays where the user may have dragged it
  } else if (h.corePanel?.mesh) {
    const pm = h.corePanel.mesh;
    pm.updateWorldMatrix(true, false);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pm.getWorldQuaternion(new THREE.Quaternion()));
    at = pm.getWorldPosition(new THREE.Vector3())
      .addScaledVector(right, h.corePanel.worldWidth / 2 + panel.worldWidth / 2 + 0.4);
  } else {
    at = cam.pos.clone().add(forward().multiplyScalar(9));
  }
  panel.placeFlat(scene, at);
  panel.mesh.userData.palette = true;
  panel.dirty();
  runOnPanel = panel;
  if (!keepPos) audio.accrete();
}

// ---------- pod presence: a live panel per warming/serving rig ----------
// The run-on picker vanishes on click, and a warm or resume used to run
// invisibly behind transient hints. This is the missing feedback: a
// persistent panel docked beside the workflow hub showing the rig's state,
// phase, elapsed cost, and the actions on it, with a boot-log tail on
// demand. One panel per destination id; it polls the provider itself.
const podPanels = new Map();   // destId -> pp

function podStateColor(s) {
  return s === 'SERVING' ? '#8ce99a'
    : (s === 'STOPPED' || s === 'COLD') ? '#9fb4c0'
    : s === 'ERROR' ? '#ff6a6a'
    : '#ffd54a';   // STARTING / warming
}
function podRowsKey(pp) { return pp.state + (pp.armed ? 'A' : '') + (pp.logOpen ? 'L' : ''); }

function podDockPos(hub, panel) {
  if (hub?.corePanel?.mesh) {
    const pm = hub.corePanel.mesh;
    pm.updateWorldMatrix(true, false);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pm.getWorldQuaternion(new THREE.Quaternion()));
    return pm.getWorldPosition(new THREE.Vector3())
      .addScaledVector(right, hub.corePanel.worldWidth / 2 + panel.worldWidth / 2 + 0.4);
  }
  return cam.pos.clone().add(forward().multiplyScalar(9));
}

// Open (or focus) the pod panel for a destination; seedPhase is the headline
// shown until the first poll returns.
function openPodPanel(dest, hub, seedPhase) {
  const prev = podPanels.get(dest.id);
  const t0 = prev?.t0 ?? Date.now();
  if (prev) closePodPanel(dest.id);
  const pp = {
    dest, hub, t0, state: 'STARTING', phase: seedPhase || 'starting',
    usdHr: dest.usdHr || 0, logLines: [], contents: null, armed: false, logOpen: false,
    panel: null, logPanel: null, timer: null, _rowsKey: null, _served: false,
  };
  podPanels.set(dest.id, pp);
  buildPodPanel(pp);
  pp.timer = setInterval(() => pollPod(pp), 5000);
  pollPod(pp);
  audio.accrete();
  return pp;
}

function closePodPanel(destId) {
  const pp = podPanels.get(destId);
  if (!pp) return;
  clearInterval(pp.timer);
  clearTimeout(pp._armT);
  closePodLog(pp);
  if (hotPanel === pp.panel) hotPanel = null;
  pp.panel?.dispose();
  podPanels.delete(destId);
}

function podElapsedMin(pp) { return Math.max(0, (Date.now() - pp.t0) / 60000); }

// What a rig's volume is known to hold: live probe first (from boot.log this
// run), else the last-known persisted on the rig. null when there is no
// volume or it has never been seen.
function rigVolumeContents(rigId, live) {
  const rig = listRigs().find((r) => r.id === rigId);
  if (!rig?.volumeId) return null;
  return live || rig.volumeContents || null;
}
// A volume can be ATTACHED but never probed (freshly created). The panel must
// still say so, otherwise a volume-backed rig looks identical to a bare one.
function rigVolume(rigId) {
  return listRigs().find((r) => r.id === rigId)?.volumeId ? listRigs().find((r) => r.id === rigId) : null;
}
function volumeLine(pp) {
  const c = rigVolumeContents(pp.dest.rigId, pp.contents);
  const rig = rigVolume(pp.dest.rigId);
  if (!c) return rig ? `volume · ${rig.dataCenter || ''} · not filled yet` : 'no volume · installs every time';
  const flags = [c.comfyui ? 'ComfyUI' : null, c.venv ? 'venv' : null].filter(Boolean).join(' ');
  return `volume · ${flags || 'empty'} · ${(c.models || []).length} model${(c.models || []).length === 1 ? '' : 's'}`;
}
// Turn the volume's contents into what THIS workflow's warm will actually do.
function warmPlan(rigId, hub, live) {
  const c = rigVolumeContents(rigId, live);
  // attached but never probed: this warm is the one that fills it
  if (!c) return rigVolume(rigId) ? { text: 'first fill (~15-20m)', ready: false } : null;
  if (!c.comfyui || !c.venv) return { text: 'full install (~15-20m)', ready: false };
  const want = (workflowManifest(hub.rawWorkflow()).models || []).map((m) => m.name);
  const have = new Set(c.models || []);
  const missing = want.filter((n) => !have.has(n));
  if (!missing.length) return { text: 'all cached · seconds', ready: true, missing: [] };
  return { text: `installs ${missing.length} model${missing.length === 1 ? '' : 's'}`, ready: false, missing };
}

function buildPodPanel(pp) {
  const keepPos = pp.panel?.mesh?.position.clone();
  if (pp.panel) { if (hotPanel === pp.panel) hotPanel = null; pp.panel.dispose(); }
  const d = pp.dest;
  const spend = () => (pp.usdHr || 0) * podElapsedMin(pp) / 60;
  const warming = pp.state === 'STARTING';
  const rows = [
    readoutRow(() => pp.state, () => pp.phase || ''),
    // cold start has no clean %, so the bar is an elapsed estimate against a
    // ~20min ceiling; it reads as motion, not a promise, and snaps full when
    // the backend actually answers
    progressRow(() => pp.state === 'SERVING' ? 1 : Math.min(0.95, podElapsedMin(pp) / 20)),
    readoutRow(() => (pp.usdHr ? '$' + Number(pp.usdHr).toFixed(2) + '/hr' : 'cost pending'),
      () => '~$' + spend().toFixed(2) + ' this run'),
  ];
  if (pp.hub) rows.push(readoutRow(() => 'for ' + pp.hub.name, () => pp.state === 'SERVING' ? 'bound · queue it' : ''));
  // volume feedback: what the persistent disk carries, and what this warm
  // will therefore do (the user's insight: warmup meaning IS the volume diff)
  if (rigVolume(pp.dest.rigId) || rigVolumeContents(pp.dest.rigId, pp.contents)) {
    rows.push(readoutRow(() => volumeLine(pp), () => {
      const wp = pp.hub && warmPlan(pp.dest.rigId, pp.hub, pp.contents);
      return wp ? 'warm: ' + wp.text : '';
    }));
  }
  rows.push(buttonRow(pp.logOpen ? '▾ HIDE BOOT LOG' : '▸ SHOW BOOT LOG', () => {
    pp.logOpen = !pp.logOpen;
    if (pp.logOpen) openPodLog(pp); else closePodLog(pp);
    buildPodPanel(pp);
  }));
  if (pp.state === 'SERVING' || warming) {
    rows.push(buttonRow('■ STOP · KEEP DISK', () => {
      pp.phase = 'stopping'; buildPodPanel(pp);
      stopDest(d.id)
        .then(() => { pp.state = 'STOPPED'; pp.phase = 'stopped, disk kept'; buildPodPanel(pp); })
        .catch((e) => flashHint(String(e.message || e)));
    }));
  }
  // terminate is destructive: its own armed two-tap row, never an edge zone.
  // Only when there IS a pod: offering it against nothing just errors.
  // TERMINATE ends the POD and its container disk. A network volume is a
  // separate, persistent thing that survives it: saying "pod + disk" beside a
  // volume-backed rig reads as if the volume dies too, which is the opposite
  // of why the volume exists.
  const volKept = !!rigVolume(d.rigId);
  const termLabel = pp.armed ? '✕ CONFIRM · END THE POD'
    : (volKept ? '✕ TERMINATE POD · volume kept' : '✕ TERMINATE · pod and its disk');
  if (d.podId) rows.push(buttonRow(termLabel, () => {
    if (!pp.armed) {
      pp.armed = true; buildPodPanel(pp);
      clearTimeout(pp._armT);
      pp._armT = setTimeout(() => { pp.armed = false; if (podPanels.has(d.id)) buildPodPanel(pp); }, 2600);
      return;
    }
    clearTimeout(pp._armT);
    pp.armed = false; pp.phase = 'terminating'; buildPodPanel(pp);
    terminateDest(d.id)
      .then(() => { flashHint(d.name + ' terminated'); closePodPanel(d.id); })
      .catch((e) => flashHint(String(e.message || e)));
  }));
  rows.push(buttonRow('✕ CLOSE PANEL · pod keeps running', () => closePodPanel(d.id)));

  const panel = new Panel({
    title: d.name, subtitle: 'rig · ' + (d.provider || ''),
    accent: podStateColor(pp.state), rows, worldWidth: 3.0, billboard: true, floating: true,
  });
  panel.placeFlat(scene, keepPos || podDockPos(pp.hub, panel));
  panel.mesh.userData.palette = true;   // click-through-safe like other floaters
  panel.dirty();
  pp.panel = panel;
  pp._rowsKey = podRowsKey(pp);
}

// Rebuild only when the row set changes (buttons appear/disappear, arm, log
// toggle); otherwise just recolor by state and repaint the live getters.
function refreshPodPanel(pp) {
  if (!pp.panel || podRowsKey(pp) !== pp._rowsKey) buildPodPanel(pp);
  else { pp.panel.accent = podStateColor(pp.state); pp.panel.dirty(); }
  pp.logPanel?.dirty();
}

async function pollPod(pp) {
  const d = pp.dest;
  // No pod behind this destination: say so plainly. Reporting STARTING here
  // (and "checking..." forever when the status call then fails) is a panel
  // that lies, which is worse than no panel at all.
  if (!d.podId) {
    pp.state = 'COLD';
    pp.phase = 'no pod · use WARM to start one';
    refreshPodPanel(pp);
    return;
  }
  try {
    const st = await PROVIDERS[d.provider].status(d);
    pp.fails = 0;
    if (st.usd_hr != null) pp.usdHr = st.usd_hr;
    if (st.url) {
      pp.state = 'SERVING'; pp.phase = 'ready';
      const rig = listRigs().find((r) => r.id === d.rigId);
      if (rig) upsertCloudDest(rig, { url: st.url, usdHr: st.usd_hr, stopped: false });
      if (pp.hub && pp.hub.dest !== d.id) bindDest(pp.hub, d.id);
      // once, on the serve transition, record what the volume now holds: what
      // the boot probe saw PLUS what this warm's manifest installed. Next time
      // the space knows the volume's contents with no pod running.
      if (rig?.volumeId && !pp._served) {
        pp._served = true;
        const base = pp.contents || rig.volumeContents || { comfyui: false, venv: false, models: [], packs: [] };
        const man = pp.hub ? workflowManifest(pp.hub.rawWorkflow()) : { models: [], packs: [] };
        const models = [...new Set([...(base.models || []), ...(man.models || []).map((m) => m.name)])];
        const packs = [...new Set([...(base.packs || []), ...(man.packs || []).map((p) => p.id)])];
        saveRig({ ...rig, volumeContents: { comfyui: true, venv: true, models, packs, at: Date.now() } });
      }
    } else if (/exit|stop/.test(st.status || '')) {
      pp.state = 'STOPPED'; pp.phase = 'stopped, disk kept';
    } else {
      pp.state = 'STARTING';
      // the provider's "running" means the CONTAINER is up, which is not the
      // same as ComfyUI answering and is nothing like the workflow running.
      // Say which of the three we actually mean.
      pp.phase = /run/i.test(st.status || '') ? 'pod up · ComfyUI starting' : (st.status || 'warming');
    }
  } catch (e) {
    // a pod that has gone away answers nothing: surface it instead of
    // pretending to still be checking
    pp.fails = (pp.fails || 0) + 1;
    if (pp.fails >= 3) { pp.state = 'ERROR'; pp.phase = 'cannot read this pod (gone?) · ' + String(e.message || e).slice(0, 60); }
    else pp.phase = 'checking...';
  }
  // while it warms, tail boot.log for a real phase (and the log panel body)
  if (pp.state === 'STARTING') {
    try {
      const lg = await PROVIDERS[d.provider].logs(d);
      // boot.log dies with the log server right before ComfyUI takes the port,
      // so an empty read means "gone", not "nothing happened": keep what we saw
      // rather than blanking the panel at the exact moment it succeeded.
      if (Array.isArray(lg.lines) && lg.lines.length) pp.logLines = lg.lines;
      if (lg.phase) pp.phase = lg.phase;
      if (lg.contents) pp.contents = lg.contents;   // keep the last probe seen
      if (lg.serving) { pp.state = 'SERVING'; pp.phase = 'ready'; }
    } catch (e) { /* pod not answering yet */ }
  }
  refreshPodPanel(pp);
}

function openPodLog(pp) {
  closePodLog(pp);
  const panel = new Panel({
    title: 'boot log', subtitle: pp.dest.name, accent: '#7ce8dc',
    worldWidth: 3.8, billboard: true, floating: true,
    rows: [
      readoutRow(() => pp.phase || '', () => (pp.logLines?.length || 0) + ' lines'),
      logRow(() => pp.logLines || [], 16, 'waiting for the pod to write boot.log'),
    ],
  });
  const base = pp.panel?.mesh?.position?.clone() || cam.pos.clone().add(forward().multiplyScalar(9));
  base.y -= (pp.panel?.worldHeight?.() || 2) / 2 + panel.worldHeight() / 2 + 0.3;
  panel.placeFlat(scene, base);
  panel.mesh.userData.palette = true;
  panel.dirty();
  pp.logPanel = panel;
}
function closePodLog(pp) {
  if (!pp.logPanel) return;
  if (hotPanel === pp.logPanel) hotPanel = null;
  pp.logPanel.dispose();
  pp.logPanel = null;
}

// ---------- storage volumes: persist /workspace so a warm is seconds ----
// A RunPod network volume holds ComfyUI + the models across stop/terminate,
// so the multi-GB install runs ONCE and every later warm skips it. Volumes
// are datacenter-locked and mount only on SECURE pods, so attaching one
// pins the rig's datacenter and cloud. Creating a volume is a billed
// standing resource, so the create rows are armed two-tap and priced.
let volumePanel = null;
const VOL_DCS = ['EU-RO-1', 'US-KS-2', 'EU-CZ-1', 'EUR-IS-1'];   // the volume-capable DCs
const VOL_SIZE = 50;   // GB: ComfyUI venv ~5 + SDXL 6.5 + hunyuan ~5 + headroom
function closeVolumePanel() {
  if (!volumePanel) return;
  if (hotPanel === volumePanel) hotPanel = null;
  volumePanel.dispose();
  volumePanel = null;
}
async function openVolumePanel(rig, onDone) {
  closeVolumePanel();
  const provider = rig.provider;
  let existing = null;   // null while the account's volumes load
  const build = () => {
    const keep = volumePanel?.mesh?.position.clone();
    closeVolumePanel();
    const rows = [
      readoutRow(() => 'storage for ' + rig.name, () => existing == null ? 'checking...' : ''),
      readoutRow(() => 'a volume persists /workspace', () => '~$' + (VOL_SIZE * 0.07).toFixed(2) + '/mo · secure'),
    ];
    for (const v of existing || []) {
      rows.push(buttonRow(`◆ USE ${String(v.name).toUpperCase()} · ${v.size}GB · ${v.dataCenterId}`, () => {
        attachVolume(rig.id, v);
        flashHint(`${v.name} attached to ${rig.name} · secure · ${v.dataCenterId}`);
        closeVolumePanel(); onDone?.();
      }));
      // delete only OUR volumes (comfyvr-*), never a foreign data volume;
      // money-safety for a volume created in a DC that lacked the GPU
      if (/^comfyvr-/.test(v.name || '')) {
        const del = buttonRow(`✕ DELETE ${String(v.name).toUpperCase()}`, () => {
          if (!del.armed) { del.armed = true; flashHint('tap again · permanently deletes this volume and its contents'); setTimeout(() => { del.armed = false; }, 3500); return; }
          del.armed = false;
          PROVIDERS[provider].deleteVolume(v.id)
            .then(() => { flashHint(v.name + ' deleted'); existing = existing.filter((x) => x.id !== v.id); build(); })
            .catch((e) => flashHint(String(e.message || e)));
        });
        rows.push(del);
      }
    }
    for (const dc of VOL_DCS) {
      const mk = buttonRow(`＋ NEW ${VOL_SIZE}GB · ${dc}`, () => {
        if (!mk.armed) {
          mk.armed = true;
          flashHint(`tap again · creates a billed ${VOL_SIZE}GB volume in ${dc} (~$${(VOL_SIZE * 0.07).toFixed(2)}/mo)`);
          setTimeout(() => { mk.armed = false; }, 3500);
          return;
        }
        mk.armed = false;
        flashHint(`creating ${VOL_SIZE}GB volume in ${dc}...`);
        PROVIDERS[provider].createVolume({ name: 'comfyvr-' + rig.id, size: VOL_SIZE, dataCenterId: dc })
          .then((v) => { attachVolume(rig.id, v); flashHint(`volume ready in ${dc} · ${rig.name} is secure now · REBUILD once to fill it`); closeVolumePanel(); onDone?.(); })
          .catch((e) => flashHint(String(e.message || e)));
      });
      rows.push(mk);
    }
    rows.push(buttonRow('✕ CLOSE', () => closeVolumePanel()));
    const panel = new Panel({ title: 'add volume', subtitle: rig.name, accent: '#c5a3ff', rows, worldWidth: 3.4, billboard: true, floating: true });
    let at;
    if (keep) at = keep;
    else if (remotePanel?.mesh) {
      const pm = remotePanel.mesh; pm.updateWorldMatrix(true, false);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pm.getWorldQuaternion(new THREE.Quaternion()));
      at = pm.getWorldPosition(new THREE.Vector3()).addScaledVector(right, remotePanel.worldWidth / 2 + panel.worldWidth / 2 + 0.4);
    } else at = cam.pos.clone().add(forward().multiplyScalar(9));
    panel.placeFlat(scene, at);
    panel.mesh.userData.palette = true;
    panel.dirty();
    volumePanel = panel;
  };
  build();
  try { existing = (await PROVIDERS[provider].volumes()).volumes || []; } catch (e) { existing = []; }
  if (volumePanel) build();
}

// ---------- remote runs: destinations, rigs, and pods ----------
// The dedicated submenu the Run On directives call for. Swaps in place
// of the settings panel so it reads as submenu navigation; the floater
// registry handles pick/update/drag because the panel says floating.
let remotePanel = null;
function closeRemoteRuns() {
  if (!remotePanel) return;
  if (hotPanel === remotePanel) hotPanel = null;
  remotePanel.dispose();
  remotePanel = null;
}

function buildRemoteRuns(pos) {
  const rebuild = () => buildRemoteRuns(remotePanel ? remotePanel.mesh.position.clone() : pos);
  closeRemoteRuns();
  const dests = listDestinations();
  const rigs = listRigs();
  refreshCloudStates().then((chg) => { if (chg && remotePanel) rebuild(); }).catch(() => {});
  const rows = [readoutRow(() => `${dests.length} destination${dests.length === 1 ? '' : 's'} · ${rigs.length} rig${rigs.length === 1 ? '' : 's'}`, () => '')];
  // One action per row throughout (user feedback: no invisible click
  // zones, ever; destructive actions get their own explicit row).
  for (const d of dests) {
    if (d.kind !== 'peer') continue;
    rows.push(buttonRow(`⬡ ${d.name.toUpperCase()} · PEER`, () => flashHint(d.url)));
    rows.push(buttonRow(`✕ REMOVE PEER · ${d.name.toUpperCase()}`, () => {
      removeDestination(d.id);
      rebuild();
      audio.toggle(false);
    }));
  }
  // Rig rows reflect the ACTUAL state (a WARM button beside a running
  // pod lies). Cold: warm. Podded: status, stop, and an armed terminate.
  for (const r of rigs) {
    const d = dests.find((x) => x.id === 'cloud-' + r.id);
    if (!d?.podId) {
      rows.push(buttonRow(`▸ WARM · ${r.name.toUpperCase()} · ${r.provider.toUpperCase()}`, () => {
        flashHint('warming ' + r.name + ' (a cold start can take 20 minutes)');
        startRig(r.id, (st) => flashHint(`warming ${r.name}: ${st.status || '...'}`))
          .then((dd) => { flashHint(`${dd.name} is live`); rebuild(); })
          .catch((e) => flashHint(String(e.message || e)));
      }));
      continue;
    }
    const st = destState(d);
    const cost = d.usdHr ? ` · $${d.usdHr}/H` : '';
    rows.push(readoutRow(() => `☁ ${r.name.toUpperCase()} · ${st}${st === 'STOPPED' ? ' (disk only)' : cost}`, () => 'pod ' + (d.podId || '')));
    if (st === 'STOPPED') {
      rows.push(buttonRow(`▸ RESUME · ${r.name.toUpperCase()}`, () => {
        flashHint('resuming ' + r.name + ' (seconds, disk intact)');
        PROVIDERS[d.provider].resume(d)
          .then(() => waitServing(d, null).then(() => rebuild()))
          .catch((e) => flashHint(String(e.message || e)));
      }));
    } else {
      rows.push(buttonRow(`■ STOP · ${r.name.toUpperCase()}`, () => {
        stopDest(d.id)
          .then(() => { flashHint('stopped ' + r.name + ' · gpu billing ended'); rebuild(); })
          .catch((e) => flashHint(String(e.message || e)));
      }));
    }
    // persistent storage: a volume makes /workspace survive stop/terminate,
    // so the multi-GB install happens once and later warms are seconds
    if (r.volumeId) {
      rows.push(readoutRow(() => `◆ volume · ${r.dataCenter || ''}`, () => 'secure · disk persists'));
      const det = buttonRow(`✕ DETACH VOLUME · ${r.name.toUpperCase()}`, () => {
        if (!det.armed) { det.armed = true; flashHint('tap again · rig goes back to install-every-time'); setTimeout(() => { det.armed = false; }, 3500); return; }
        detachVolume(r.id); flashHint('volume detached from ' + r.name); rebuild();
      });
      rows.push(det);
    } else {
      rows.push(buttonRow(`◆ ADD STORAGE VOLUME · ${r.name.toUpperCase()}`, () => openVolumePanel(r, rebuild)));
    }
    const term = buttonRow(`✕ TERMINATE · ${r.name.toUpperCase()}`, () => {
      if (!term.armed) {
        term.armed = true;
        flashHint('tap TERMINATE again · everything on the pod is lost');
        setTimeout(() => { term.armed = false; }, 3500);
        return;
      }
      terminateDest(d.id)
        .then(() => { flashHint('terminated ' + r.name + ' · all billing ended'); rebuild(); })
        .catch((e) => flashHint(String(e.message || e)));
    });
    rows.push(term);
  }
  rows.push(buttonRow('✚ ADD PEER · NAME URL', () => {
    const row = { name: 'name http://host:8188', oneline: true, widget: { value: '' } };
    row.get = () => row.widget.value;
    row.onChange = () => {
      const m = String(row.widget.value).trim().match(/^(\S+)\s+(\S+)$/);
      if (!m) { flashHint('format: name http://host:8188'); return; }
      addPeer(m[1], m[2]);
      // http peers are fine even from the https headset page: clientFor
      // routes them through this origin's relay automatically
      flashHint('peer added · plain-http peers ride the relay · owner runs --listen with CORS open');
      rebuild();
      audio.accrete();
    };
    openEditor({ title: 'add peer', accent: '#7ce8dc', disposed: false, dirty() {} }, row);
  }));
  rows.push(buttonRow('⚙ BACK TO SETTINGS', () => {
    const p = remotePanel.mesh.position.clone();
    closeRemoteRuns();
    buildSettings(p);
    audio.tick();
  }));
  const panel = new Panel({ title: 'remote runs', subtitle: 'destinations · rigs', accent: '#ffb86c', rows, worldWidth: 3.4, billboard: true, floating: true });
  panel.placeFlat(scene, pos);
  panel.mesh.userData.palette = true;   // always reachable, like the pickers
  panel.dirty();
  remotePanel = panel;
}

function openRemoteRuns() {
  const pos = settingsPanel ? settingsPanel.mesh.position.clone()
    : cam.pos.clone().add(forward().multiplyScalar(11));
  closeSettings();
  buildRemoteRuns(pos);
  audio.accrete();
}

// ---------- provenance card: what made this image ----------
let galleryCard = null;
function showGalleryCard(hub, item) {
  hideGalleryCard();
  const m = item.meta;
  if (!m) { flashHint('no provenance on this one'); return; }
  const rows = [];
  if (m.model) rows.push(readoutRow(() => 'model', () => String(m.model).slice(0, 32)));
  const facts = [m.seed != null ? 'seed ' + m.seed : null, m.steps != null ? m.steps + ' steps' : null,
                 m.cfg != null ? 'cfg ' + m.cfg : null].filter(Boolean).join(' · ');
  if (facts) rows.push(readoutRow(() => facts, () => m.size || ''));
  if (m.prompt) rows.push({ kind: 'note', name: 'prompt', get: () => String(m.prompt).slice(0, 600) });
  if (!rows.length) { flashHint('no provenance on this one'); return; }
  const panel = new Panel({ title: 'provenance', subtitle: '', accent: '#6ec6ff', rows, worldWidth: 3.2, billboard: true });
  const wp = item.mesh.position.clone().applyMatrix4(hub.group.matrixWorld);
  const toCam = cam.pos.clone().sub(wp).normalize();
  const right = new THREE.Vector3().crossVectors(toCam, UP).normalize();
  panel.placeFlat(scene, wp.addScaledVector(right, -3.9).addScaledVector(toCam, 0.6));
  panel.dirty();
  galleryCard = panel;
  audio.tick();
}
function hideGalleryCard() {
  if (!galleryCard) return;
  if (hotPanel === galleryCard) hotPanel = null;
  galleryCard.dispose();
  galleryCard = null;
}

async function openWorkflow(w) {
  try {
    const json = w.source === 'local' ? await client.loadLocalWorkflow(w.name) : await client.loadUserdataWorkflow(w.path);
    if (!json || !Array.isArray(json.nodes)) { flashHint('not a workflow: ' + w.name); return; }
    const missing = [...workflowTypes(json)].filter(t => !SCHEMA[t]);
    if (missing.length) Object.assign(SCHEMA, await client.schemaFor(missing));
    applySidecarLayout(json, w.source, w.name);
    const graph = parseWorkflow(json, SCHEMA);
    const hub = new Hub(scene, beams, { name: w.name, graph, source: w.source }, hubOpts());
    // stand it in the widest gap on the horizon ring
    const ringR = Math.max(95, (hubs.length + 1) * 10);
    let th = 0;
    const angles = hubs.map(h => Math.atan2(h.center().z, h.center().x)).sort((a, b) => a - b);
    if (angles.length) {
      let best = -1;
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i], b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
        if (b - a > best) { best = b - a; th = a + (b - a) / 2; }
      }
    }
    hub.setPosition(new THREE.Vector3(Math.cos(th) * ringR, (hubs.length % 2) * 8 - 4, Math.sin(th) * ringR));
    hubs.push(hub);
    rebuildSpaceThreads();
    closeBrowser();
    audio.accrete();
    flashHint('opened ' + w.name);
    flyToHub(hub);
  } catch (e) {
    flashHint('open failed: ' + (e.message || e));
  }
}

function closeWorkflow(name) {
  const i = hubs.findIndex(h => h.name === name);
  if (i < 0) return;
  const h = hubs[i];
  if (cam.hub === h) { cam.hub = null; cam.dock = null; }
  clearTimeout(layoutTimers.get(h));
  layoutTimers.delete(h);
  h.dispose();
  hubs.splice(i, 1);
  rebuildSpaceThreads();
  audio.toggle(false);
  flashHint('closed ' + name);
  libraryPanel?.dirty();
  if (browser) buildBrowser();
}

// constellation threads between hubs sharing a checkpoint; rebuilt whenever
// the set of open hubs changes
function rebuildSpaceThreads() {
  for (const key of [...beams.beams.keys()]) if (key.startsWith('space:')) beams.removeBeam(key);
  const byCkpt = new Map();
  for (const h of hubs) {
    for (const n of h.graph.nodes.values()) {
      for (const wg of n.widgets) {
        if (wg.name === 'ckpt_name') {
          if (!byCkpt.has(wg.value)) byCkpt.set(wg.value, []);
          byCkpt.get(wg.value).push(h);
        }
      }
    }
  }
  for (const [ckpt, hs] of byCkpt) {
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      beams.addBeam(`space:${ckpt}:${i}:${j}`, hs[i].center().clone(), hs[j].center().clone(),
        '#c5a3ff', { alpha: 0.14, bulge: 0.12, group: 'space' });
    }
  }
}

// Every free-floating panel, ONE list: picking, per-frame updates, and
// title-bar drags all read this. A panel missing from a hardcoded list is
// invisible or untouchable in ways that only surface in a headset —
// settings shipped both ways before this existed.
function floaters() {
  // panels built with {floating: true} enroll themselves on place and
  // leave on dispose (FLOATERS in panels.js), so nothing to keep in sync
  return [...FLOATERS];
}

function pickTargets() {
  const out = [];
  for (const h of hubs) {
    if (h.sigil.mesh.visible) out.push(h.sigil.mesh);
    if (h.corePanel && h.corePanel.mesh.visible) out.push(h.corePanel.mesh);
    for (const p of h.panels.values()) if (p.mesh && p.mesh.visible) out.push(p.mesh);
    for (const gi of h.gallery) if (gi.mesh.visible) out.push(gi.mesh);
  }
  for (const p of floaters()) if (p.mesh) out.push(p.mesh);
  if (libraryPanel?.mesh) out.push(libraryPanel.mesh);
  if (wrist?.panel.mesh && renderer.xr.isPresenting) out.push(wrist.panel.mesh);
  return out;
}

function pick(e) {
  setRay(e);
  return pickRay();
}
function pickRay() {
  const hits = raycaster.intersectObjects(pickTargets(), false);
  const h = hits[0];
  if (!h) return null;
  const panel = h.object.userData.panel || null;
  const hub = h.object.userData.hub || null;
  const gallery = !!h.object.userData.gallery;
  let rowInfo = null;
  if (panel && h.uv) rowInfo = panel.rowAt(h.uv.x, 1 - h.uv.y);
  return { object: h.object, panel, hub, gallery, rowInfo, dist: h.distance, uv: h.uv };
}

// The boundary between TRAVEL and TOUCH: inside it, clicks and pinches act
// on the surface (grab, edit, delete); beyond it they take you there.
// Generous on purpose: repositioning nodes wants enough standoff to keep
// the workflow's context in view while you drag.
const REACH = 16;      // desktop
const REACH_XR = 21;   // headset rays are shakier; touch reaches further
function reachable(hit) { return hit.dist < REACH || !!hit.object.userData.palette || !!hit.object.userData.library; }

// Right corner of a node header is the ✕: tap to arm, tap again to delete.
// ---------- grab frame reveal ----------
// The frame must announce itself or it is exactly the invisible edge zone we
// banned. Quest reveals a panel's border as your hand nears it, so do that:
// ONE shared outline that adopts the hovered panel's own (already grown)
// geometry, parented to it so it inherits the transform for free. Never a
// canvas repaint: a texture upload per hover is the cost the render budget
// is trying to delete, and this is one extra draw call for the whole scene.
let frameGlow = null, glowPanel = null;
function revealFrame(panel) {
  // Docked in front of a node you deliberately travelled to, the outline has
  // nothing left to teach: you already know the border is there and that it
  // drags. Reserve the reveal for panels you are merely looking at.
  if (cam.dock?.panel === panel) { hideFrame(); return; }
  if (panel === glowPanel) return;
  hideFrame();
  if (!panel?.mesh?.geometry) return;
  const geo = new THREE.EdgesGeometry(panel.mesh.geometry, 30);
  if (!frameGlow) {
    frameGlow = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      transparent: true, opacity: 0.55, depthTest: false,
    }));
    frameGlow.renderOrder = 11;
  } else {
    frameGlow.geometry.dispose();
    frameGlow.geometry = geo;
  }
  frameGlow.material.color.set(panel.accent || '#7ce8dc');
  panel.mesh.add(frameGlow);
  glowPanel = panel;
}
function hideFrame() {
  if (frameGlow && frameGlow.parent) frameGlow.parent.remove(frameGlow);
  glowPanel = null;
}

function inDeleteZone(hit) {
  return hit.rowInfo?.kind === 'header' && hit.panel?.deletable && (hit.rowInfo.frac ?? 0) > 0.78;
}
function armOrDelete(panel, hub) {
  if (!panel.deleteArmed) {
    panel.deleteArmed = true;
    panel.dirty();
    audio.tick();
    clearTimeout(panel._delTimer);
    panel._delTimer = setTimeout(() => { panel.deleteArmed = false; panel.dirty(); }, 2600);
    return;
  }
  clearTimeout(panel._delTimer);
  const id = panel.userData.nodeId;
  const title = hub.graph.nodes.get(id)?.title || 'node';
  if (hub.deleteNode(id)) flashHint('deleted ' + title);
}

let hotPanel = null;
function hover(e) {
  const hit = pick(e);
  const interactive = hit && reachable(hit) && hit.rowInfo && isInteractive(hit.rowInfo);
  let cursor = hit ? (interactive ? 'pointer' : 'zoom-in') : 'grab';
  if (hit && reachable(hit) && hit.hub && hit.panel?.userData?.nodeId != null) {
    if (hit.rowInfo?.kind === 'header') cursor = inDeleteZone(hit) ? 'pointer' : 'move';
    if (hit.rowInfo?.kind === 'port') cursor = 'crosshair';
  }
  canvas.style.cursor = cursor;
  const p = hit?.panel || null;
  const hh = !!(p && reachable(hit) && hit.rowInfo?.kind === 'header' && p.deletable);
  if (hotPanel && hotPanel !== p && hotPanel.hotHeader) { hotPanel.hotHeader = false; hotPanel.dirty(); }
  if (p && p.hotHeader !== hh) { p.hotHeader = hh; p.dirty(); }
  if (hotPanel && hotPanel !== p) { hotPanel.setHot(null); hotPanel = null; }
  if (p && reachable(hit)) revealFrame(p); else hideFrame();
  if (hh) hotPanel = p;
  if (p && hit.rowInfo?.row && reachable(hit)) {
    if (p.hot !== hit.rowInfo.row) audio.tick();
    p.setHot(hit.rowInfo.row);
    p.setHotFrac(hit.rowInfo.frac);
    hotPanel = p;
  } else if (p && hotPanel === p) {
    p.setHot(null);
  }
}

function isInteractive(ri) {
  return ri.row && ['slider', 'seed', 'combo', 'toggle', 'text', 'button', 'keys', 'kbuf'].includes(ri.kind);
}

function onClick(e) {
  const hit = pick(e);
  if (palette && (!hit || hit.panel !== palette.panel)) closePalette();
  if (browser && (!hit || (hit.panel !== browser.panel && !hit.object.userData.library))) closeBrowser();
  if (galleryCard && (!hit || !hit.gallery)) hideGalleryCard();
  if (!hit) return;
  const { panel, hub, gallery, rowInfo } = hit;
  if (gallery) {
    const item = hub.gallery.find(g => g.mesh === hit.object);
    if (item?.asset && HANDS_GLB.test(item.asset.filename)) {  // wearables wear
      wearFromOutput(hub, item).catch(e => flashHint('wear failed: ' + (e.message || e)));
      return;
    }
    if (item?.asset) {  // placard <-> real 3D object
      toggleAsset(hub, item, audio, { xr: renderer.xr.isPresenting }).catch(e => flashHint('asset load failed: ' + (e.message || e)));
      return;
    }
    if (item?.video) {
      item.video.muted = !item.video.muted;
      item.video.play().catch(() => {});
      flashHint(item.video.muted ? 'video muted' : 'video sound on');
      if (item.meta) showGalleryCard(hub, item);
      return;
    }
    if (item?.audioEl) {
      if (item.audioEl.paused) item.audioEl.play().catch(() => {});
      else item.audioEl.pause();
      audio.tick();
      return;
    }
    if (item?.meta) showGalleryCard(hub, item);
    // dock to a generation
    const center = hit.object.position.clone().applyMatrix4(hub.group.matrixWorld);
    const n = cam.pos.clone().sub(center).normalize();
    cam.level = 'panel'; cam.hub = hub;
    flyTo(center.clone().add(n.multiplyScalar(4)), center, 1.1);
    audio.dock();
    return;
  }
  if (!panel) return;
  if (hub && panel === hub.sigil) { flyToHub(hub); return; }
  if (reachable(hit) && inDeleteZone(hit) && hub && panel.userData?.nodeId != null) { armOrDelete(panel, hub); return; }
  if (reachable(hit) && rowInfo && isInteractive(rowInfo)) { interact(panel, hub, rowInfo); return; }
  if (hub) dockToPanel(panel, hub);
}

function interact(panel, hub, ri) {
  const row = ri.row, wg = row.widget;
  switch (ri.kind) {
    case 'slider': break; // handled on pointerdown/drag
    case 'seed':
      wg.value = Math.floor(Math.random() * 1e15);
      audio.toggle(true); row.onChange?.(); panel.dirty();
      break;
    case 'combo': {
      const opts = row.options.length ? row.options : [row.get()];
      const cx = ri.frac * (PW - 36);
      const dir = cx < (PW - 36) * 0.4 ? -1 : 1;
      const i = Math.max(0, opts.indexOf(wg.value));
      wg.value = opts[(i + dir + opts.length) % opts.length];
      delete wg.substituted;   // a deliberate pick clears the auto-sub marker
      audio.toggle(dir > 0); row.onChange?.(); panel.dirty();
      break;
    }
    case 'toggle':
      wg.value = !wg.value;
      audio.toggle(!!wg.value); row.onChange?.(); panel.dirty();
      break;
    case 'text':
      openEditor(panel, row);
      break;
    case 'button':
      audio.button();
      row.onClick?.(ri.frac);
      break;
    case 'keys': {
      row.onKey?.(row.keys[keyIndexAt(row, ri.frac)]);
      break;
    }
    case 'kbuf': {
      // pinch the text itself to put the caret there, using the layout the
      // last draw stashed on the row (monospace: column is arithmetic)
      if (!kbd || row !== kbd.bufRow || !row._hit) break;
      const { first, lines, charW, count } = row._hit;
      const localY = (ri.yFrac ?? 0) * panel.rowH(row);
      const li = Math.max(0, Math.min(count - 1, Math.round((localY - 32) / 19)));
      const line = lines[first + li];
      if (line) {
        const col = Math.max(0, Math.min(line.t.length, Math.round((ri.frac ?? 0) * (PW - 36) / charW)));
        kbd.caret = line.s + col;
      } else {
        kbd.caret = kbd.buffer.length;
      }
      audio.tick();
      kbd.panel.dirty();
      break;
    }
  }
}

function applySlider(hit, e, fresh) {
  const ri = fresh?.rowInfo?.row === hit.rowInfo.row ? fresh.rowInfo : hit.rowInfo;
  applySliderFrac(hit.panel, hit.rowInfo.row, ri.frac);
}
function applySliderFrac(panel, row, frac) {
  const wg = row.widget;
  // slider bar spans px 196..398 of the canvas
  const cx = (frac ?? 0) * (PW - 36) + 18;
  const f = THREE.MathUtils.clamp((cx - 196) / 202, 0, 1);
  let v = sliderValue(row, f);
  if (row.step) v = Math.round(v / row.step) * row.step;
  if (row.int) v = Math.round(v);
  else v = Number(v.toFixed(4));
  v = THREE.MathUtils.clamp(v, row.hardMin ?? row.min, row.hardMax ?? row.max);
  if (v !== wg.value) {
    wg.value = v;
    audio.zip(f);
    row.onChange?.();
    panel.dirty();
  }
}

// ---------- text editor overlay (desktop) ----------
const editorWrap = $('editor'), editorTa = $('editor-ta'), editorLabel = $('editor-label');
let editorCtx = null;
function editorOpen() { return editorWrap.style.display === 'flex'; }
function openEditor(panel, row) {
  // the DOM editor cannot render inside an immersive session; in XR the
  // in-space keyboard takes over (pinch keys, or dictate through the mic)
  if (renderer.xr.isPresenting) { openKbd(panel, row); return; }
  editorCtx = { panel, row };
  editorLabel.textContent = `${panel.title} · ${row.name}`;
  editorTa.value = String(row.get() ?? '');
  editorWrap.style.display = 'flex';
  editorTa.focus(); editorTa.select();
  audio.tick();
}
function closeEditor(commit) {
  if (commit && editorCtx) {
    editorCtx.row.widget.value = editorTa.value;
    editorCtx.row.onChange?.();
    editorCtx.panel.dirty();
    audio.toggle(true);
  }
  editorWrap.style.display = 'none';
  editorCtx = null;
}
editorTa.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
  if (e.key === 'Escape') closeEditor(false);
  e.stopPropagation();
});
$('editor-ok').addEventListener('click', () => closeEditor(true));
$('editor-cancel').addEventListener('click', () => closeEditor(false));

// ---------- in-space keyboard: text entry that never leaves the headset ----------
// Pinchable key rows for short fields, a mic key for prompts: dictation is
// recorded in the browser and transcribed by a local whisper sidecar
// (speakwright) through the server, so audio never leaves the machine.
let kbd = null;
const KB_LETTER_ROWS = [
  'qwertyuiop'.split(''),
  "asdfghjkl'".split(''),
  'zxcvbnm,.-'.split(''),
];
// prompt syntax needs its own layer: (word:1.2), [a:b:0.5], {x|y}, <lora:...>
const KB_SYM_ROWS = [
  '()[]{}<>:;'.split(''),
  ',.|_-+=/\\*'.split(''),
  '\'"!?@#%&~^'.split(''),
];
// bottom row shaped like a keyboard's: a real spacebar, the mic as a key
function kbBottomKeys(sym, mic = '🎤') { return ['✕', '⇧', sym ? 'ABC' : 'SYM', '◂', 'SPACE', '▸', mic, '⌫', 'OK']; }
const KB_BOTTOM_W = [0.9, 1, 1.1, 0.7, 2.6, 0.7, 1, 1, 1.2];
// A keyboard is a HAND-scale object, not a wall panel. One world unit is one
// metre (the wrist watch hangs 3cm off a tracked grip), so the old 3.8m board
// put a single key at 38cm: wider than the hand pressing it, and you had to
// stand back to see the whole thing. Real keys are ~19mm; a poke target wants
// more than that, so ~5cm keys within arm's reach. Panel textures are a fixed
// 512px wide regardless of worldWidth, so shrinking costs no legibility, it
// buys 7x the pixel density.
const KB_WIDTH = 0.52;   // 10 columns -> ~5.2cm keys
const KB_DIST = 0.60;    // arm's reach, not across the room
const KB_DROP = 0.22;    // ~20 degrees under the eye line, like a desk tray
function openKbd(panel, row) {
  closeKbd(false);
  const xform = (k) => (kbd?.caps ? k.toUpperCase() : k);
  const gridRows = KB_LETTER_ROWS.map(keys => keysRow(keys.slice(), kbdKey, { xform }));
  const bottomRow = keysRow(kbBottomKeys(false), kbdKey, { small: true, w: KB_BOTTOM_W });
  const bufRow = kbufRow(row.name, () => kbd?.buffer ?? '', row.oneline ? 2 : 4);
  bufRow.caret = () => kbd?.caret ?? 0;
  const rows = [
    bufRow,
    keysRow('1234567890'.split(''), kbdKey),
    ...gridRows,
    bottomRow,
  ];
  const kp = new Panel({ title: 'type', subtitle: panel.title, accent: panel.accent, rows, worldWidth: KB_WIDTH, billboard: true, floating: true });
  // place where the head actually looks (XR lesson: cam.yaw is stale while
  // presenting), dropped under the eye line so it reads as a tray you type on
  const head = camera.getWorldPosition(new THREE.Vector3());
  const dir = camera.getWorldDirection(new THREE.Vector3());
  kp.placeFlat(scene, head.addScaledVector(dir, KB_DIST).add(new THREE.Vector3(0, -KB_DROP, 0)));
  kp.mesh.userData.palette = true;   // same always-reachable rule as the palette
  kp.dirty();
  const buffer = String(row.get() ?? '');
  kbd = { panel: kp, target: { panel, row }, buffer, caret: buffer.length, caps: false, sym: false, rec: null, micLabel: '🎤', gridRows, bottomRow, bufRow };
  audio.accrete();
}
function kbdSetSym(sym) {
  kbd.sym = sym;
  const src = sym ? KB_SYM_ROWS : KB_LETTER_ROWS;
  kbd.gridRows.forEach((row, i) => { row.keys = src[i].slice(); });
  kbd.bottomRow.keys = kbBottomKeys(sym, kbd.micLabel);
  kbd.panel.dirty();
}
function kbdSetMic(label) {
  kbd.micLabel = label;
  kbd.bottomRow.keys = kbBottomKeys(kbd.sym, label);
  kbd.panel.dirty();
}
function kbdInsert(txt) {
  const c = kbd.caret;
  kbd.buffer = kbd.buffer.slice(0, c) + txt + kbd.buffer.slice(c);
  kbd.caret = c + txt.length;
}
function closeKbd(commit) {
  if (!kbd) return;
  const { target, buffer, rec, panel } = kbd;
  if (hotPanel === panel) hotPanel = null;
  kbd = null;                       // null first: a pending rec.onstop drops its transcript
  try { rec?.stop(); } catch (e) { /* already stopped */ }
  panel.dispose();
  if (commit && !target.panel.disposed) {
    target.row.widget.value = buffer;
    target.row.onChange?.();
    target.panel.dirty();
    audio.toggle(true);
  }
}
function kbdKey(k) {
  if (!kbd) return;
  switch (k) {
    case '⇧': kbd.caps = !kbd.caps; break;
    case 'SYM': kbdSetSym(true); break;
    case 'ABC': kbdSetSym(false); break;
    case '◂': kbd.caret = Math.max(0, kbd.caret - 1); break;
    case '▸': kbd.caret = Math.min(kbd.buffer.length, kbd.caret + 1); break;
    case 'SPACE': kbdInsert(' '); break;
    case '⌫':
      if (kbd.caret > 0) {
        kbd.buffer = kbd.buffer.slice(0, kbd.caret - 1) + kbd.buffer.slice(kbd.caret);
        kbd.caret--;
      }
      break;
    case '🎤': case '●': kbdMic(); return;
    case '…': return;   // transcription in flight; the key answers when done
    case '✕': closeKbd(false); return;
    case 'OK': closeKbd(true); return;
    default: kbdInsert(kbd.caps ? k.toUpperCase() : k);
  }
  audio.tick();
  kbd.panel.dirty();
}
async function kbdMic() {
  if (!kbd) return;
  if (kbd.rec) {                    // second tap: stop and transcribe
    const rec = kbd.rec;
    kbd.rec = null;
    kbdSetMic('…');
    rec.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!kbd) { stream.getTracks().forEach(t => t.stop()); return; }
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (!kbd) return;             // keyboard closed mid-recording: drop it
      try {
        const text = await client.stt(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        if (kbd && text) {
          const before = kbd.buffer.slice(0, kbd.caret);
          kbdInsert((before && !/\s$/.test(before) ? ' ' : '') + text);
        }
      } catch (e) {
        flashHint('dictation failed: ' + (e.message || e));
      }
      if (kbd) kbdSetMic('🎤');
    };
    rec.start();
    kbd.rec = rec;
    kbdSetMic('●');
    audio.tick();
  } catch (e) {
    // most likely a denied or unanswered mic permission dialog
    flashHint('mic unavailable: ' + (e.message || e));
    audio.toggle(false);
  }
}

// ---------- HUD ----------
const statusChip = $('status'), hintEl = $('hint');
let hintTimer = null;
function flashHint(msg) {
  hintEl.textContent = msg;
  hintEl.style.opacity = 1;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (hintEl.style.opacity = 0.35), 2600);
}
function setStatus() {
  const q = client.mode === 'live' && client.queueRemaining ? ` · ◈ ${client.queueRemaining} in queue` : '';
  statusChip.textContent = client.mode === 'live' ? '● LIVE ' + (client.backend || '') + q : '◌ DEMO — no ComfyUI backend';
  wrist?.panel.dirty();
  statusChip.className = client.mode;
  // the demo is a storefront: visitors need the way home to the repo
  const gh = document.getElementById('ghlink');
  if (gh) gh.style.display = client.mode === 'demo' ? 'flex' : 'none';
}

// ---------- boot ----------
let SCHEMA = {};
let agentApi = null;

// Queue a hub. Throws on rejection so the agent's queue tool can report
// the reason; the in-space error state lights up either way.
async function queueHub(h) {
  if (!h.graph.nodes.size) {
    flashHint('nothing to run yet · ✚ ADD NODE first');
    throw new Error('nothing to run yet: the graph is empty');
  }
  audio.queueSweep();
  try {
    // a hub bound to a destination runs THERE, in parallel with local
    // runs: each destination client owns its own socket and prompt routing
    const c = await clientFor(h.dest, client);
    await c.queue(h);
    h.clearErrors();
    h.afterQueued();   // the queued run has its seeds; move them on
    const where = h.dest ? ' on ' + (typeof h.dest === 'string' ? h.dest : h.dest.name) : '';
    flashHint('queued ' + h.name + where + (c.mode === 'demo' ? ' (simulated)' : ''));
  } catch (e) {
    h.onStatus('error');
    h.reportQueueError(e);
    flashHint(String(e.message || e));
    audio.toggle(false);
    throw e;
  }
}

function hubOpts() {
  return {
    audio,
    schema: SCHEMA,
    onLayout: scheduleLayoutSave,
    audioListener,
    // outputs are fetched from the backend that MADE them: a hub bound
    // to a destination views through that destination's client, so a
    // pod-run wearable or video resolves on the pod, not the local dir
    mediaURL: (m, h) => ((h?.dest && cachedClient(h.dest)) || client).viewURL(m),
    loadInputImage: (filename) =>
      client.mode === 'live' ? client.imageBitmap({ filename, subfolder: '', type: 'input' }) : null,
    onAddNode: (h) => openPaletteFree(h),
    // ▸ RUN ON row: opens a picker panel (one action per row, no cycling,
    // no click zones). The label IS the egress label: a hub bound
    // elsewhere says so right above QUEUE.
    destRow: (h) => {
      const row = buttonRow(runOnLabel(h), () => { openRunOnPicker(h); audio.tick(); });
      h._destRow = row;
      return row;
    },
    onRecall: (h) => recallMore(h).catch((e) => flashHint('recall failed: ' + (e.message || e))),
    onQueue: (h) => queueHub(h).catch(() => {}),   // errors already shown in-space
    onSave: async (h) => {
      // userdata/dropped hubs save a LOCAL copy — never overwrite the
      // user's real ComfyUI workflows until this serializer has more miles
      const ok = await client.saveLocalWorkflow(h.name.replace(/[\\/]/g, '_'), h.rawWorkflow());
      flashHint(ok ? `saved ${h.source !== 'local' ? 'local copy of ' : ''}${h.name}` : 'save FAILED');
      audio.toggle(ok);
    },
  };
}

async function boot() {
  audio.setMuted(getSetting('muted'));
  syncRegistry();   // rigs/destinations from the server; fire-and-forget
  await client.detect();
  setStatus();
  client.onModeChange = setStatus;
  client.onQueueCount = setStatus;
  LAYOUTS = await client.loadLayouts();
  let list = [];
  try { list = await client.listLocalWorkflows(); } catch (e) { fail('workflow list failed: ' + e); }
  const jsons = [];
  for (const item of list) {
    if (item.name.startsWith('_')) continue;   // scratch files, not workflows
    try {
      const json = await client.loadLocalWorkflow(item.name);
      // empty nodes is a real (just-created) workflow, not junk
      if (Array.isArray(json.nodes)) jsons.push({ name: item.name, json, source: 'local' });
    } catch (e) {
      // live mode: the red box, someone can act on it. Demo: a stranger's
      // first impression should not be a parse error over the stars.
      if (client.mode === 'live') fail(`load ${item.name}: ${e}`);
      else console.warn('demo workflow skipped', item.name, e);
    }
  }
  // the user's real workflows, saved server-side by the ComfyUI frontend
  const userdata = await client.listUserdataWorkflows();
  for (const item of userdata.slice(0, 12)) {
    if (jsons.some(j => j.name === item.name)) continue;
    try {
      const json = await client.loadUserdataWorkflow(item.path);
      if (json && Array.isArray(json.nodes) && json.nodes.length) jsons.push({ name: item.name, json, source: 'comfyui' });
    } catch (e) { console.warn('userdata load failed', item.path, e); }
  }
  const types = new Set();
  for (const { json } of jsons) for (const t of workflowTypes(json)) types.add(t);
  const schema = await client.schemaFor([...types]);
  SCHEMA = schema;

  const N = Math.max(jsons.length, 1);
  const ringR = Math.max(95, N * 10);
  jsons.forEach(({ name, json, source }, i) => {
    applySidecarLayout(json, source, name);
    const graph = parseWorkflow(json, schema);
    const hub = new Hub(scene, beams, { name, graph, source }, hubOpts());
    const th = (i / N) * Math.PI * 2 - Math.PI / 2;
    hub.setPosition(new THREE.Vector3(Math.cos(th) * ringR, (i % 2) * 8 - 4, Math.sin(th) * ringR));
    hubs.push(hub);
  });

  rebuildSpaceThreads();
  buildLibrary();
  refreshWfIndex();

  // demo galleries so the rims aren't bare
  if (client.mode === 'demo') {
    for (const h of hubs) for (let k = 0; k < 3; k++) h.addGeneration(demoImage(h, null), '', { instant: true });
  }

  $('veil').classList.add('gone');
  flashHint('drag look · wasd/qe drift · click sigils/panels · drag headers to move nodes · drop a comfy png · esc back · m mute');

  backfillHistory().catch((e) => console.warn('history backfill', e))
    .then(() => recallFromDisk())          // after history, so dedupe sees it
    .catch((e) => console.warn('disk recall', e));
  recallShowcase().catch((e) => console.warn('showcase recall', e));

  applyHandStyle();   // late on purpose: boot() starts before `worn` exists

  // J0 agent bridge: the page answers tool calls relayed by the server
  agentApi = initAgent({
    hubs: () => hubs,
    wfIndex: () => wfIndex,
    client,
    openWorkflow,
    queueHub,
    flashHint,
    audio,
  });
}

// cvr_demo_* files in the output dir become assets on the first hub, so
// demo content (sample splats etc.) is reachable from any device with no
// workflow run. Interim scaffolding until disk-wide gallery recall lands.
async function recallShowcase() {
  const files = await client.listOutputFiles();
  const demos = files.filter(f => /^cvr_demo_/i.test(f.filename) && MESH_EXT.test(f.filename));
  if (!demos.length || !hubs.length) return;
  const hub = hubs[0];
  let added = 0;
  for (const f of demos) {
    if (hub.addAsset({ filename: f.filename, subfolder: '', type: 'output' }, { instant: true })) added++;
  }
  if (added) flashHint(`showcase: ${added} demo asset${added > 1 ? 's' : ''} on ${hub.name}`);
}
boot().catch((e) => fail('boot: ' + (e.stack || e)));

// ---------- history back-fill: past generations find their hubs ----------
// History entries carry the API prompt they ran; match its (id:class_type)
// signature against each hub's graph and hang the outputs on the best fit.
async function backfillHistory() {
  const hist = await client.history(64);
  const entries = Object.values(hist);
  if (!entries.length) return;
  const sigs = hubs.map(h => {
    const s = new Set();
    for (const n of h.graph.nodes.values()) s.add(`${n.id}:${n.type}`);
    return s;
  });
  let recalled = 0;
  for (const e of entries) {
    const prompt = e.prompt?.[2];
    const outputs = e.outputs || {};
    if (!prompt) continue;
    const keys = Object.entries(prompt).map(([id, n]) => `${id}:${n.class_type}`);
    if (!keys.length) continue;
    let best = -1, bestScore = 0;
    sigs.forEach((s, i) => {
      const score = keys.filter(k => s.has(k)).length / keys.length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0 || bestScore < 0.7) continue;
    const hub = hubs[best];
    if (hub.gallery.length >= 8) continue;
    const meta = summarizeApi(prompt);
    for (const out of Object.values(outputs)) {
      for (const im of out.images || []) {
        if (im.type !== 'output' || hub.gallery.length >= 8) continue;
        try {
          const item = hub.addGeneration(await client.imageBitmap(im), '', { instant: true, meta });
          item.media = im;   // filename rides along so disk recall can dedupe
          recalled++;
        } catch (err) { /* image may have been deleted from disk */ }
      }
      for (const a of scanOutputsForAssets(out)) {
        if (hub.gallery.length >= 10) break;
        if (hub.addAsset(a, { instant: true })) recalled++;
      }
      for (const m of scanOutputsForMedia(out)) {
        if (hub.gallery.length >= 10) break;
        const item = m.kind === 'video'
          ? hub.addVideoGen(m, client.viewURL(m), { instant: true, meta })
          : hub.addAudioGen(m, client.viewURL(m), { instant: true, meta });
        if (item) recalled++;
      }
    }
  }
  if (recalled) flashHint(`${recalled} generation${recalled > 1 ? 's' : ''} recalled from history`);
}

// ---------- disk recall: the output folder is the durable gallery ----------
// History dies with the ComfyUI process, but the PNGs on disk carry their
// api prompt in a tEXt chunk. Scan newest-first (headers only, via Range),
// match prompts to open hubs by node signature, hang just the LATEST few
// per hub, and index the rest for the core panel's RECALL row.
const diskIndex = new Map();   // hub -> older unhung entries, newest-first

function hubSig(h) {
  const s = new Set();
  for (const n of h.graph.nodes.values()) {
    s.add(`${n.id}:${n.type}`);
    if (n.subgraph) s.add(`${n.id}:*`);   // flattened runs emit parent:child ids
  }
  return s;
}

function matchHubByPrompt(sigs, prompt) {
  const keys = Object.entries(prompt).map(([id, n]) => ({
    exact: `${id}:${n.class_type}`,
    sub: `${String(id).split(':')[0]}:*`,
  }));
  if (!keys.length) return null;
  let best = -1, bestScore = 0;
  sigs.forEach((s, i) => {
    const score = keys.filter(k => s.has(k.exact) || s.has(k.sub)).length / keys.length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= 0.7 ? hubs[best] : null;
}

async function pngPrompt(media) {
  try {
    const r = await fetch(client.viewURL(media), { headers: { Range: 'bytes=0-65535' } });
    const chunks = pngTextChunks(await r.arrayBuffer());
    return chunks.prompt ? JSON.parse(chunks.prompt) : null;
  } catch (e) { return null; }   // truncated chunk, deleted file, non-comfy png
}

async function hangDiskItem(hub, entry) {
  const sub = entry.subfolder || '';
  if (hub.gallery.some(g => g.media?.filename === entry.filename && (g.media?.subfolder || '') === sub)) return false;
  try {
    const media = { filename: entry.filename, subfolder: sub, type: 'output' };
    const item = hub.addGeneration(await client.imageBitmap(media), '', { instant: true, meta: summarizeApi(entry.prompt) });
    item.media = media;
    return true;
  } catch (e) { return false; }
}

async function recallFromDisk() {
  const want = getSetting('recallLatest');
  const pngs = (await client.listOutputFiles()).filter(f => f.type === 'output' && /\.png$/i.test(f.filename));
  if (!pngs.length || !hubs.length) return;
  const sigs = hubs.map(hubSig);
  const hungPer = new Map();
  let hung = 0;
  const SCAN_CAP = 160, BATCH = 8;   // bounded boot work; RECALL pages deeper
  for (let at = 0; at < Math.min(pngs.length, SCAN_CAP); at += BATCH) {
    const batch = pngs.slice(at, at + BATCH);
    const prompts = await Promise.all(batch.map(pngPrompt));
    for (let i = 0; i < batch.length; i++) {
      if (!prompts[i]) continue;
      const hub = matchHubByPrompt(sigs, prompts[i]);
      if (!hub) continue;
      const entry = { ...batch[i], prompt: prompts[i] };
      const n = hungPer.get(hub) || 0;
      if (want && n < want && await hangDiskItem(hub, entry)) { hungPer.set(hub, n + 1); hung++; }
      else { if (!diskIndex.has(hub)) diskIndex.set(hub, []); diskIndex.get(hub).push(entry); }
    }
  }
  if (hung) flashHint(`${hung} recalled from disk`);
}

async function recallMore(hub) {
  const rest = diskIndex.get(hub) || [];
  if (!rest.length) { flashHint('nothing older on disk for ' + hub.name); return; }
  let n = 0;
  for (const entry of rest.splice(0, 6)) if (await hangDiskItem(hub, entry)) n++;
  flashHint(n ? `${n} more from disk` : 'those were already hanging');
  audio.accrete();
}

// ---------- drop a ComfyUI PNG (or workflow .json) into the space ----------
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer?.files || []) {
    try { await ingestFile(f); } catch (err) { fail('drop: ' + err); }
  }
});

async function ingestFile(f) {
  if (/\.json$/i.test(f.name)) {
    const json = JSON.parse(await f.text());
    if (Array.isArray(json.nodes)) await accreteHub(f.name.replace(/\.json$/i, ''), json, null);
    else flashHint('json has no nodes — not a workflow');
    return;
  }
  if (f.type === 'image/png' || /\.png$/i.test(f.name)) {
    const buf = await f.arrayBuffer();
    const meta = pngTextChunks(buf);
    const wf = meta.workflow ? JSON.parse(meta.workflow) : null;
    if (!wf || !Array.isArray(wf.nodes)) { flashHint('no workflow embedded in that png'); return; }
    const bm = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
    await accreteHub(f.name.replace(/\.png$/i, ''), wf, bm);
  }
}

// Minimal PNG text-chunk reader: tEXt and uncompressed iTXt. ComfyUI
// embeds the litegraph JSON under the "workflow" keyword.
function pngTextChunks(buf) {
  const dv = new DataView(buf);
  const out = {};
  if (dv.byteLength < 8 || dv.getUint32(0) !== 0x89504e47) return out;
  let off = 8;
  while (off + 12 <= dv.byteLength) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    if ((type === 'tEXt' || type === 'iTXt') && off + 8 + len <= dv.byteLength) {
      const data = new Uint8Array(buf, off + 8, len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = new TextDecoder().decode(data.subarray(0, nul));
        let txt = null;
        if (type === 'tEXt') {
          txt = new TextDecoder('latin1').decode(data.subarray(nul + 1));
        } else if (data[nul + 1] === 0) {  // iTXt, uncompressed only
          let p = nul + 3;
          while (p < data.length && data[p] !== 0) p++;
          p++;
          while (p < data.length && data[p] !== 0) p++;
          p++;
          txt = new TextDecoder().decode(data.subarray(p));
        }
        if (txt) out[key] = txt;
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

// A dropped workflow unfolds where you're looking — provenance accretion.
async function accreteHub(name, json, bitmap) {
  const missing = [...workflowTypes(json)].filter(t => !SCHEMA[t]);
  if (missing.length) Object.assign(SCHEMA, await client.schemaFor(missing));
  let base = name.replace(/[\\/]/g, '_') || 'dropped', nm = base, i = 2;
  while (hubs.some(h => h.name === nm)) nm = `${base}-${i++}`;
  applySidecarLayout(json, 'dropped', nm);
  const graph = parseWorkflow(json, SCHEMA);
  const hub = new Hub(scene, beams, { name: nm, graph, source: 'dropped' }, hubOpts());
  hub.setPosition(cam.pos.clone().add(forward().multiplyScalar(70)));
  hubs.push(hub);
  rebuildSpaceThreads();
  libraryPanel?.dirty();
  if (bitmap) hub.addGeneration(bitmap, '', { instant: true });
  audio.accrete();
  flashHint('unfolded ' + nm);
  flyToHub(hub);
  return hub;
}

// ---------- WebXR: the same space, headset on ----------
// Controllers AND hands share one input layer: Quest exposes hand-tracked
// pinch as select events on the same input sources, so every interaction
// below works with bare hands for free.
const xrState = { yaw: 0, turnLatch: false, controllers: [] };

// ---------- visible hands: joint poses rendered as constellation-matter ----------
// The runtime tracks 25 joints per hand but composites nothing; unrendered
// hands read as "no hand tracking" on video. Glowing joint spheres, sized by
// the runtime's own joint radii, make the hands part of the aesthetic.
const handViz = [];
{
  const geo = new THREE.SphereGeometry(1, 6, 6);
  for (let hi = 0; hi < 2; hi++) {
    const hand = renderer.xr.getHand(hi);
    rig.add(hand);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({
      color: 0x7ce8dc, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }), 25);
    inst.frustumCulled = false;
    inst.renderOrder = 25;
    inst.visible = false;
    scene.add(inst);
    handViz.push({ hand, inst });
  }
}
const _hm = new THREE.Matrix4(), _hp = new THREE.Vector3();
// worn[i] replaces hand i's rendering with a wearable driven by the same
// joints — the first rung of the wearable layer (see notes/space-packs.md)
const worn = [null, null];
function wearHands(which = 'debug') {
  unwearHands();
  for (let i = 0; i < 2; i++) worn[i] = makeDebugHands(scene);
  flashHint('wearing: ' + which + ' hands');
  audio.toggle(true);
}
function unwearHands() {
  for (let i = 0; i < 2; i++) { worn[i]?.dispose(); worn[i] = null; }
}
function applyHandStyle() {
  if (getSetting('handStyle') === 'robot') { if (!worn[0]) wearHands('robot'); }
  else unwearHands();
}
function updateHands() {
  for (let hi = 0; hi < handViz.length; hi++) {
    const { hand, inst } = handViz[hi];
    const joints = hand.joints || {};
    if (worn[hi]) {
      worn[hi].update(joints);
      inst.visible = false;
      continue;
    }
    let n = 0;
    for (const name in joints) {
      const j = joints[name];
      if (!j.visible) continue;
      j.getWorldPosition(_hp);
      const r = (j.jointRadius || 0.008) * (name.endsWith('-tip') ? 1.35 : 1);
      _hm.makeScale(r, r, r).setPosition(_hp);
      inst.setMatrixAt(n++, _hm);
    }
    inst.count = n;
    inst.visible = n > 0 && renderer.xr.isPresenting;
    if (n) inst.instanceMatrix.needsUpdate = true;
  }
}
const _mat4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _v3 = new THREE.Vector3();

if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      // browser speaks WebXR but no headset runtime answered — say so
      // somewhere findable instead of silently not showing the button
      $('status').title = 'WebXR present, but no immersive-vr runtime (headset not detected)';
      console.info('[comfyvr] WebXR present, immersive-vr unsupported — is the headset runtime (SteamVR/Oculus) running?');
      return;
    }
    const b = document.createElement('button');
    b.textContent = '◈ ENTER VR';
    b.style.cssText = 'position:absolute;bottom:14px;right:16px;pointer-events:auto;background:rgba(124,232,220,0.12);color:#7ce8dc;border:1px solid rgba(124,232,220,0.5);border-radius:4px;padding:8px 18px;cursor:pointer;letter-spacing:2px;font-family:Consolas,monospace;';
    $('hud').appendChild(b);
    b.onclick = async () => {
      try {
        const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
        renderer.xr.setSession(s);
      } catch (e) { fail('xr session: ' + e); }
    };
  }).catch(() => {});
}
renderer.xr.addEventListener('sessionstart', () => {
  audio.ensure();
  xrState.yaw = cam.yaw;              // keep facing what you faced
  cam.anim = null; cam.dock = null;
});
renderer.xr.addEventListener('sessionend', () => {
  disposeWrist();
  camera.getWorldPosition(camWorld);
  cam.pos.copy(camWorld);
  syncAngles(camWorld.clone().add(_f.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(_q))));
  rig.position.set(0, 0, 0);
  rig.rotation.y = 0;
  camera.position.copy(cam.pos);
});

// ---------- wrist HUD: the exit that bare hands lack, plus VR status ----------
// The system escape (palm up, pinch the floating logo) is hidden knowledge;
// a watch on the left wrist is not. Also the only HUD visible inside XR.
let wrist = null;
const AGENT_MIC_IDLE = '🎤 AGENT';
let wristRec = null;
async function wristMic(row) {
  if (wristRec) {                     // second tap: stop, transcribe, queue for the harness
    const rec = wristRec;
    wristRec = null;
    row.label = '… SENDING';
    wrist?.panel.dirty();
    rec.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach(tr => tr.stop());
      try {
        const text = await client.stt(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        if (text) { agentApi?.hear(text); flashHint('🎤 ' + text); audio.toggle(true); }
      } catch (e) {
        flashHint('agent mic failed: ' + (e.message || e));
      }
      row.label = AGENT_MIC_IDLE;
      wrist?.panel.dirty();
    };
    rec.start();
    wristRec = rec;
    row.label = '● LISTENING · TAP TO SEND';
    wrist.panel.dirty();
    audio.tick();
  } catch (e) {
    flashHint('mic unavailable: ' + (e.message || e));
  }
}
function attachWrist(grip, ci) {
  if (!wrist) {
    const micRow = buttonRow(AGENT_MIC_IDLE, () => wristMic(micRow));
    const rows = [
      readoutRow(() => (client.mode === 'live' ? '● LIVE' : '◌ DEMO'),
                 () => (client.queueRemaining ? '◈ ' + client.queueRemaining + ' queued' : '')),
      micRow,
      buttonRow('⌸ WORKFLOWS', () => openBrowser()),
      buttonRow('✚ NEW', () => newWorkflow()),
      buttonRow('⚙ SETTINGS', () => openSettings()),
      buttonRow('⌂ BACK OUT', () => { stepBack(); audio.dock?.(); }),
      buttonRow('⏏ EXIT VR', () => renderer.xr.getSession()?.end()),
    ];
    wrist = { panel: new Panel({ title: 'comfyvr', rows, worldWidth: 0.2, frame: 0 }) };
  }
  const mesh = wrist.panel.mesh || wrist.panel.placeFlat(grip, new THREE.Vector3());
  if (mesh.parent !== grip) grip.add(mesh);
  // watch-face pose: above the wrist; orientation is per-frame lookAt in the
  // tick, so the face follows the eyes like every core panel
  mesh.position.set(0, 0.03, 0.1);
  mesh.rotation.set(-1.0, 0, 0);   // first-frame pose only
  wrist.grip = grip;
  wrist.ci = ci ?? 0;
  wrist.panel.foldAlpha = 1;
  wrist.panel.dirty();
}
function disposeWrist() { if (wrist) { wrist.panel.dispose(); wrist = null; } }

for (let ci = 0; ci < 2; ci++) {
  const c = renderer.xr.getController(ci);
  rig.add(c);
  const grip = renderer.xr.getControllerGrip(ci);
  rig.add(grip);
  grip.addEventListener('connected', (e) => { if (e.data?.handedness === 'left') attachWrist(grip, ci); });
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  const rayLine = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({
    color: 0x7ce8dc, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthTest: false,
  }));
  rayLine.scale.z = 10;
  c.add(rayLine);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xbffff4, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false })
  );
  dot.renderOrder = 30;
  dot.visible = false;
  scene.add(dot);
  const st = { c, rayLine, dot, hit: null, mode: null };
  c.addEventListener('selectstart', () => xrSelectStart(st));
  c.addEventListener('selectend', () => xrSelectEnd(st));
  xrState.controllers.push(st);
}

function setRayFromController(c) {
  _mat4.identity().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_mat4);
}

function xrSelectStart(st) {
  const hit = st.hit;
  if (!hit) {
    // pinch the void and pull yourself through it — hands' locomotion
    st.mode = 'pull';
    st.pullLast = st.c.position.clone();
    return;
  }
  const vrReach = hit.dist < REACH_XR || !!hit.object.userData.palette || !!hit.object.userData.library;
  const ri = hit.rowInfo;
  if (vrReach && ri) {
    // floating panels (keyboard, settings, pickers, provenance) move by
    // their title bar: pinch it and the panel rides the ray at its distance
    // The grab frame is the ONLY thing that moves a panel now. That frees the
    // header and the whole body to mean travel, so "pinch the node to go to
    // it" works at 7m and at 50m without a distance rule deciding for you.
    if (ri.kind === 'frame') {
      if (floatingPanel(hit.panel)) {
        st.mode = 'float';
        st.floatPanel = hit.panel;
        st.floatDist = hit.dist;
        audio.tick();
        return;
      }
      if (hit.hub && hit.panel.userData?.nodeId != null && !moveDrag) { armMoveDrag(st, hit); return; }
    }
    if (ri.kind === 'header' && floatingPanel(hit.panel)) {
      st.mode = 'float';
      st.floatPanel = hit.panel;
      st.floatDist = hit.dist;
      audio.tick();
      return;
    }
    if (ri.kind === 'slider') { st.mode = 'slider'; applySliderFrac(hit.panel, ri.row, ri.frac); return; }
    if (ri.kind === 'header' && hit.hub && hit.panel.userData?.nodeId != null && inDeleteZone(hit)) {
      armOrDelete(hit.panel, hit.hub);
      return;
    }
    if (ri.kind === 'port' && hit.hub && hit.panel.userData?.nodeId != null && !linkDrag) {
      const s = portSlotAt(hit);
      if (s && s.dir === 'out') {
        beginLink({ mode: 'new', hub: hit.hub, type: s.type, srcNode: s.node.id, srcSlot: s.index });
        if (linkDrag) st.mode = 'link';
      } else if (s && s.dir === 'in' && s.node.linkInputs[s.index]?.link != null) {
        const L = hit.hub.graph.links.get(s.node.linkInputs[s.index].link);
        if (L) {
          beginLink({ mode: 'retarget', hub: hit.hub, type: L.type, srcNode: L.src, srcSlot: L.srcSlot, linkId: L.id });
          if (linkDrag) st.mode = 'link';
        }
      } else if (s && s.dir === 'in') {
        beginLink({ mode: 'reverse', hub: hit.hub, type: s.type, dstNode: s.node.id, dstSlot: s.index });
        if (linkDrag) st.mode = 'link';
      }
      return;
    }
    if (isInteractive(ri)) {
      interact(hit.panel, hit.hub, ri);   // text rows open the in-space keyboard
      return;
    }
  }
  if (hit.gallery) {
    const item = hit.hub?.gallery.find(g => g.mesh === hit.object);
    if (item?.asset && HANDS_GLB.test(item.asset.filename)) {
      wearFromOutput(hit.hub, item).catch((e) => flashHint('wear failed: ' + (e.message || e)));
      return;
    }
    if (item?.asset) { toggleAsset(hit.hub, item, audio, { xr: true }).catch(() => {}); return; }
    if (item?.video) { item.video.muted = !item.video.muted; item.video.play().catch(() => {}); return; }
    if (item?.audioEl) {
      if (item.audioEl.paused) item.audioEl.play().catch(() => {});
      else item.audioEl.pause();
      return;
    }
    // dock to the image, same as a desktop click (flyTo teleports while
    // presenting — same comfort model as pinching a sigil); teleport FIRST
    // so the provenance card places itself relative to where you land
    const center = hit.object.position.clone().applyMatrix4(hit.hub.group.matrixWorld);
    const n = cam.pos.clone().sub(center).normalize();
    cam.level = 'panel'; cam.hub = hit.hub;
    flyTo(center.clone().add(n.multiplyScalar(4)), center, 1.1);
    audio.dock();
    if (item?.meta) showGalleryCard(hit.hub, item);
    return;
  }
  if (hit.hub && hit.panel === hit.hub.sigil) { flyToHub(hit.hub); return; }
  if (hit.panel && hit.hub) {
    // Body, header, anything that is not a control: travel. Grabbing lives on
    // the frame, so the body no longer has to guess between move and dock.
    dockToPanel(hit.panel, hit.hub);
  }
}

function floatingPanel(p) {
  return p && floaters().includes(p) ? p : null;
}

function armMoveDrag(st, hit) {
  setRayFromController(st.c);
  const p = hit.panel;
  const at = rayCylinder(hit.hub, p.placement.r);
  moveDrag = { hub: hit.hub, panel: p, id: p.userData.nodeId, offT: at ? wrapAng(p.placement.theta - at.theta) : 0, offY: at ? p.placement.y - at.y : 0 };
  st.mode = 'move';
  audio.tick();
}

function xrSelectEnd(st) {
  if (st.mode === 'link' && linkDrag) finishLink(st.hit);
  if (st.mode === 'move') endMove();
  if (st.mode === 'slider') audio.tick();
  st.mode = null; st.pressHit = null; st.pressStart = null; st.floatPanel = null;
  dragMode = null; sliderDrag = null; pendingGrab = null;
}

function xrControllersTick() {
  for (const st of xrState.controllers) {
    setRayFromController(st.c);
    if (st.mode === 'pull') {
      // hand delta in rig space, rotated to world, amplified — space is big
      _v3.copy(st.pullLast).sub(st.c.position).applyAxisAngle(UP, xrState.yaw);
      cam.pos.addScaledVector(_v3, 4);
      st.pullLast.copy(st.c.position);
      st.dot.visible = false;
      continue;
    }
    if (st.mode === 'float' && st.floatPanel) {
      const p = floatingPanel(st.floatPanel);   // may have been rebuilt away
      if (p) {
        p.mesh.position.copy(raycaster.ray.at(st.floatDist, _v3));
        // pickers rebuild their panels in place; keep their anchor with it
        if (browser && p === browser.panel) browser.pos.copy(p.mesh.position);
        if (palette && p === palette.panel) palette.pos.copy(p.mesh.position);
      }
      st.dot.visible = false;
      continue;
    }
    if (st.mode === 'move' && moveDrag) { doMoveRay(); st.dot.visible = false; continue; }
    if (st.mode === 'link' && linkDrag) { doLinkDragRay(); st.hit = pickRay(); continue; }
    if (st.mode === 'slider' && st.hit) {
      const h2 = pickRay();
      if (h2 && h2.panel === st.hit.panel && h2.rowInfo?.row === st.hit.rowInfo?.row) {
        applySliderFrac(h2.panel, h2.rowInfo.row, h2.rowInfo.frac);
      }
      continue;
    }
    const hit = pickRay();
    st.hit = hit;
    if (hit) {
      st.rayLine.scale.z = Math.max(0.3, hit.dist);
      st.dot.visible = true;
      st.dot.position.copy(raycaster.ray.at(hit.dist, _v3));
      // the cursor dot shrinks on near surfaces (the wrist watch especially):
      // full size at 4+ units, a quarter size when touching-close
      st.dot.scale.setScalar(THREE.MathUtils.clamp(hit.dist / 4, 0.25, 1));
      if (hit.panel && hit.dist < REACH_XR) revealFrame(hit.panel); else hideFrame();
      if (hit.panel && hit.rowInfo?.row && hit.dist < REACH_XR) {
        if (hit.panel.hot !== hit.rowInfo.row) audio.tick();
        hit.panel.setHot(hit.rowInfo.row);
        hit.panel.setHotFrac(hit.rowInfo.frac);
      }
    } else {
      st.rayLine.scale.z = 10;
      st.dot.visible = false;
      hideFrame();
    }
  }
}

// ---------- wearables from outputs ----------
// The cvr_hands_*.glb convention (notes/space-packs.md): a workflow whose
// output lands under this name made HANDS, so pinching its placard wears
// it instead of standing it in the world. Take it off via ✋ HANDS in
// settings (any style re-wears the default layer).
const HANDS_GLB = /^cvr_hands_.*\.glb$/i;
async function wearFromOutput(h, item) {
  const url = ((h?.dest && cachedClient(h.dest)) || client).viewURL(item.asset);
  unwearHands();
  const { makeSkinnedHands } = await import('./wearables.js');
  for (let i = 0; i < 2; i++) worn[i] = await makeSkinnedHands(scene, url);
  flashHint('wearing ' + item.asset.filename + ' · take off via ✋ HANDS in settings');
  audio.toggle(true);
}

// ---------- fingertip poke (field request 2026-09-01) ----------
// Any fingertip on either hand presses what it touches: within HOVER of a
// panel surface the tip drives the same hot-row path the ray uses, and
// crossing PRESS fires the same interact() a pinch would, once per touch
// (released past RELEASE, so one poke is one press). Sliders track the
// finger while touched. Ray and poke coexist: poke runs after the ray
// tick, so up close the touched row wins the highlight.
const POKE_TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
const POKE = { hover: 0.09, press: 0.018, release: 0.05, behind: -0.04 };
const pokeDown = new Map();   // "<hand>:<tip>" -> {panel, row}
const _pokeV = new THREE.Vector3(), _pokeTip = new THREE.Vector3();

// (u, vTop, depth) of a world point against a panel's surface; depth > 0
// is in front of the face. Flat panels are a plane in local space; curved
// ones (node panels) are an arc of radius placement.r facing the center.
function pokeSurface(p, world) {
  const l = p.mesh.worldToLocal(_pokeV.copy(world));
  const H = p.worldHeight();
  if (p.billboard || !p.placement) {
    return { u: l.x / p.worldWidth + 0.5, vTop: 0.5 - l.y / H, depth: l.z };
  }
  const { r, arc } = p.placement;
  return { u: Math.atan2(l.x, -l.z) / arc + 0.5, vTop: 0.5 - l.y / H, depth: r - Math.hypot(l.x, l.z) };
}

// Panels a hand could touch at all: the wrist watch and floating panels
// always (they live at arm's length by design), hub panels only when the
// hand is inside that hub's bowl.
function pokePanels(handPos) {
  const out = [];
  if (renderer.xr.isPresenting && wrist?.panel) out.push(wrist.panel);
  out.push(...floaters());
  if (libraryPanel) out.push(libraryPanel);
  for (const h of hubs) {
    if (!h.corePanel) continue;
    if (handPos.distanceTo(h.center()) > (h.rimRadius || 10) + 3) continue;
    out.push(h.corePanel, ...h.panels.values());
  }
  return out.filter((p) => p?.mesh?.visible);
}

function pokeStep(key, tip, panels) {
  let best = null;
  for (const p of panels) {
    const s = pokeSurface(p, tip);
    if (s.u < -0.02 || s.u > 1.02 || s.vTop < -0.02 || s.vTop > 1.02) continue;
    if (s.depth < POKE.behind || s.depth > POKE.hover) continue;
    if (!best || Math.abs(s.depth) < Math.abs(best.s.depth)) best = { p, s };
  }
  const held = pokeDown.get(key);
  if (!best) { pokeDown.delete(key); return; }
  const { p, s } = best;
  const ri = p.rowAt(s.u, s.vTop);
  if (ri.row) {
    if (p.hot !== ri.row) audio.tick();
    p.setHot(ri.row);
    p.setHotFrac(ri.frac);
  }
  if (held) {
    if (ri.kind === 'slider' && ri.row === held.row && p === held.panel) applySliderFrac(p, ri.row, ri.frac);
    if (s.depth > POKE.release) pokeDown.delete(key);
    return;
  }
  if (s.depth < POKE.press && ri.row && isInteractive(ri)) {
    pokeDown.set(key, { panel: p, row: ri.row });
    if (ri.kind === 'slider') applySliderFrac(p, ri.row, ri.frac);
    else interact(p, p.mesh.userData.hub || null, ri);
  }
}

function pokeTick() {
  for (let hi = 0; hi < handViz.length; hi++) {
    const joints = handViz[hi].hand.joints;
    const wj = joints?.wrist;
    if (!wj || !wj.visible) continue;
    wj.getWorldPosition(_pokeV);
    const near = pokePanels(_pokeV);
    if (!near.length) continue;
    for (const tip of POKE_TIPS) {
      const j = joints[tip];
      if (!j || !j.visible) continue;
      j.getWorldPosition(_pokeTip);
      pokeStep(hi + ':' + tip, _pokeTip, near);
    }
  }
}

function xrTick(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;                       // hands: no sticks, pinch = select
    // xr-standard puts the thumbstick at axes[2,3], but not every runtime
    // complies; take whichever pair actually carries signal, and never let
    // a non-finite axis reach the camera
    const A = (i) => (Number.isFinite(gp.axes[i]) ? gp.axes[i] : 0);
    const hi = gp.axes.length >= 4 && (Math.abs(A(2)) + Math.abs(A(3)) >= Math.abs(A(0)) + Math.abs(A(1)));
    const x = hi ? A(2) : A(0);
    const y = hi ? A(3) : A(1);
    if (src.handedness === 'left') {
      if (Math.abs(x) > 0.15 || Math.abs(y) > 0.15) {
        camera.getWorldQuaternion(_q);
        _f.set(0, 0, -1).applyQuaternion(_q); _f.y = 0; _f.normalize();
        _r.crossVectors(_f, UP);
        cam.pos.addScaledVector(_f, -y * dt * 10).addScaledVector(_r, x * dt * 10);
        cam.dock = null;
      }
    } else {
      if (Math.abs(x) > 0.7 && !xrState.turnLatch) {
        xrState.yaw -= Math.sign(x) * Math.PI / 6;
        xrState.turnLatch = true;
        audio.tick();
      }
      if (Math.abs(x) < 0.3) xrState.turnLatch = false;
      if (Math.abs(y) > 0.2) cam.pos.y += -y * dt * 6;
    }
  }
  xrControllersTick();
  pokeTick();
}

// ---------- frame loop ----------
const clock = new THREE.Clock();
let spacePulseTimer = 0;
let simT = 0;

// setAnimationLoop instead of rAF: required for WebXR frame pacing, and
// identical on desktop.
renderer.setAnimationLoop(() => tick(Math.min(clock.getDelta(), 0.05)));

function tick(dt) {
  simT += dt;
  const t = simT;

  // camera: headset drives the view in XR (we move the rig); desktop as before
  const xrOn = renderer.xr.isPresenting;
  if (xrOn) {
    xrTick(dt);
    rig.position.copy(cam.pos);
    rig.rotation.y = xrState.yaw;
  } else if (cam.anim) {
    const a = cam.anim;
    a.t += dt / a.dur;
    const f = a.t >= 1 ? 1 : a.t * a.t * (3 - 2 * a.t);
    cam.pos.lerpVectors(a.p0, a.p1, f);
    const look = new THREE.Vector3().lerpVectors(a.l0, a.l1, f);
    camera.position.copy(cam.pos);
    camera.lookAt(look);
    if (a.t >= 1) { syncAngles(a.l1); cam.anim = null; a.then?.(); }
  } else if (cam.dock) {
    // parallax sway while docked
    const right = new THREE.Vector3().crossVectors(forward(), new THREE.Vector3(0, 1, 0)).normalize();
    camera.position.copy(cam.dock.pos)
      .addScaledVector(right, cam.mouse.x * 0.35)
      .addScaledVector(new THREE.Vector3(0, 1, 0), -cam.mouse.y * 0.25);
    cam.pos.copy(cam.dock.pos);
    camera.lookAt(cam.dock.look);
  } else {
    const spd = keys.has('shift') ? 26 : 9;
    const f = forward();
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    if (keys.has('w')) cam.vel.addScaledVector(f, spd * dt);
    if (keys.has('s')) cam.vel.addScaledVector(f, -spd * dt);
    if (keys.has('a')) cam.vel.addScaledVector(right, -spd * dt);
    if (keys.has('d')) cam.vel.addScaledVector(right, spd * dt);
    if (keys.has('q')) cam.vel.y -= spd * dt;
    if (keys.has('e')) cam.vel.y += spd * dt;
    // idle drift: orbit the current focus, after first remembering the spot
    // and facing the user left, so coming back is free
    if (getSetting('idleWalk') && performance.now() - lastInput > idleDelayMs) {
      if (!idleReturn) {
        idleReturn = {
          pos: cam.pos.clone(),
          look: cam.pos.clone().addScaledVector(forward(), 10),
          yaw: cam.yaw, level: cam.level, hub: cam.hub,
        };
      }
      const center = cam.hub ? cam.hub.center() : new THREE.Vector3(0, 0, 0);
      const off = cam.pos.clone().sub(center);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.02);
      cam.pos.copy(center).add(off);
      cam.yaw += dt * 0.02;
    }
    cam.pos.addScaledVector(cam.vel, dt);
    cam.vel.multiplyScalar(Math.pow(0.04, dt));
    camera.position.copy(cam.pos);
    const look = cam.pos.clone().add(forward());
    camera.lookAt(look);
  }

  camera.getWorldPosition(camWorld);

  // hubs
  for (const h of hubs) {
    h.update(dt, t, camWorld);
    h.billboards(camWorld);
  }
  for (const p of floaters()) {
    p.mesh.lookAt(camWorld);
    p.update(t);
  }
  if (galleryCard) {
    galleryCard.mesh.lookAt(camWorld);
    galleryCard.update(t);
  }
  if (libraryPanel) {
    libraryPanel.mesh.lookAt(camWorld);
    // scale with distance like sigils, so the library reads from the horizon
    libraryPanel.mesh.scale.setScalar(Math.max(1, camWorld.distanceTo(libraryPanel.mesh.position) / 55));
    libraryPanel.update(t);
  }
  if (wrist && renderer.xr.isPresenting) {
    // With bare hands, three's grip space receives NO pose once getHand()
    // exists (the hand branch wins in WebXRController.update), so the watch
    // rides the hand's actual wrist joint; controllers keep the grip.
    const wj = handViz[wrist.ci]?.hand.joints?.wrist;
    const parent = (wj && wj.visible) ? wj : wrist.grip;
    const mesh = wrist.panel.mesh;
    if (mesh && parent && mesh.parent !== parent) {
      parent.add(mesh);
      // dorsal side of the wrist, a touch up the forearm, watch-like
      mesh.position.set(0, 0.04, 0.06);
    }
    // watch face billboards to the eyes like every core panel: readable at
    // any wrist angle instead of only at the one tuned tilt
    mesh?.lookAt(camWorld);
    wrist.panel.update(t);
  }
  if (renderer.xr.isPresenting) updateHands();

  // occasional pulse along constellation threads
  spacePulseTimer -= dt;
  if (spacePulseTimer <= 0) {
    spacePulseTimer = 3 + Math.random() * 4;
    const spaceBeams = [...beams.beams.values()].filter(b => b.group === 'space');
    if (spaceBeams.length) beams.pulse(spaceBeams[(Math.random() * spaceBeams.length) | 0].key, { speed: 30, size: 1.4 });
  }

  const nPulses = beams.update(dt, () => audio.plink(Math.random() * 1.4 - 0.7));
  if (audio.ctx) audio.activity = nPulses / 12;

  // motes wrap around the camera
  {
    const p = motes.geometry.attributes.position;
    for (let i = 0; i < MOTE_N; i++) {
      for (let a = 0; a < 3; a++) {
        const idx = i * 3 + a;
        let v = p.array[idx];
        const c = a === 0 ? camWorld.x : a === 1 ? camWorld.y : camWorld.z;
        while (v - c > WRAP / 2) v -= WRAP;
        while (v - c < -WRAP / 2) v += WRAP;
        p.array[idx] = v;
      }
      p.array[i * 3 + 1] += Math.sin(t * 0.3 + i) * 0.002;
    }
    p.needsUpdate = true;
  }
  window._sky.material.uniforms.uT.value = t;
  window._sky.position.copy(camWorld);

  pumpRedraws(t, 4);
  renderer.render(scene, camera);
}

// Debug handle: drives the loop manually when rAF is throttled (hidden
// pane), and snapshots the GL canvas without preserveDrawingBuffer.
window.CVR = {
  hubs, cam, beams, client, camera, THREE,
  openPalette, openPaletteFree, pal: () => palette,
  newWorkflow, createWorkflow,
  openBrowser, wf: () => browser, openWorkflow, closeWorkflow, showGalleryCard,
  openSettings, settings: () => settingsPanel, recallFromDisk, recallMore, diskIndex: () => diskIndex,
  openRemoteRuns, remoteRuns: () => remotePanel,
  wearHands, unwearHands,
  wearPose: (joints) => { worn[0]?.update(joints); return 'posed'; },
  wearSkinned: async (url = '/media/cvr_hands_test.glb') => {
    unwearHands();
    const { makeSkinnedHands } = await import('./wearables.js');
    for (let i = 0; i < 2; i++) worn[i] = await makeSkinnedHands(scene, url);
    flashHint('wearing: skinned glb');
    return 'skinned hands on';
  },
  addPeer, listDestinations, removeDestination,
  listRigs, saveRig, removeRig, stopDest, terminateDest,
  manifest: async (hubName) => {
    const h = hubs.find((x) => x.name.toLowerCase().includes(String(hubName).toLowerCase()));
    if (!h) throw new Error('no hub ' + hubName);
    const m = workflowManifest(h.rawWorkflow());
    return { ...m, ...(await manifestSizes(m)) };
  },
  // optional hubName: the pod installs that workflow's packs and models
  // (the workflow IS the manifest) so the rig comes up ready to run it
  startRig: (rigId, hubName) => {
    const h = hubName ? hubs.find((x) => x.name.toLowerCase().includes(String(hubName).toLowerCase())) : null;
    if (hubName && !h) throw new Error('no hub ' + hubName);
    const extra = h ? { manifest: workflowManifest(h.rawWorkflow()) } : undefined;
    return startRig(rigId, (st) => flashHint(`warming ${rigId}: ${st.status || '...'}`), extra)
      .then((d) => { flashHint(`${d.name} is live`); return d; });
  },
  runOn: (hubName, destId) => {
    const h = hubs.find(x => x.name.toLowerCase().includes(String(hubName).toLowerCase()));
    if (!h) throw new Error('no hub ' + hubName);
    h.dest = destId || null;
    return `${h.name} runs on ${destId || 'local'}`;
  },
  // pod presence: open the live panel for a rig's destination (docked at the
  // named hub if given). Does not start anything by itself, just watches.
  podPanel: (rigId, hubName) => {
    const d = listDestinations().find(x => x.id === 'cloud-' + rigId || x.rigId === rigId);
    if (!d) throw new Error('no cloud destination for rig ' + rigId);
    const h = hubName ? hubs.find(x => x.name.toLowerCase().includes(String(hubName).toLowerCase())) : null;
    openPodPanel(d, h);
    return 'pod panel open for ' + d.name;
  },
  podPanels: () => [...podPanels.values()].map(pp => ({ dest: pp.dest.id, state: pp.state, phase: pp.phase })),
  closePodPanel,
  wearDemo: () => {
    if (!worn[0]) wearHands('robot');
    const at = cam.pos.clone().add(forward().multiplyScalar(1.1)).add(new THREE.Vector3(0, -0.15, 0));
    const base = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z);
    worn[0].update(makeFakeJoints(base));
    return 'demo hand posed ahead';
  },
  openKbd, kbd: () => kbd, kbdKey,
  _poke: { step: pokeStep, surface: pokeSurface, panels: pokePanels, down: pokeDown },
  hear: (t) => agentApi?.hear(t),
  idleTest: () => { lastInput = performance.now() - idleDelayMs - 1000; },
  idleState: () => ({ walking: !!idleReturn, delayS: Math.round(idleDelayMs / 1000) }),
  tick: (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) tick(dt); },
  fly: (i) => flyToHub(hubs[i]),
  look: (px, py, pz, lx, ly, lz) => { cam.anim = null; cam.dock = null; cam.pos.set(px, py, pz); syncAngles(new THREE.Vector3(lx, ly, lz)); },
  snap: (w = 1280, h = 760) => {
    const collapsed = renderer.domElement.width === 0 || renderer.domElement.height === 0;
    if (collapsed) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  },
};
