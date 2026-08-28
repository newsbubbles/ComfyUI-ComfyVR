// main.js — the space. Constellation of workflow hubs; drift, dock, edit,
// queue. Desktop controls now; every interaction is expressed as ray +
// point so VR controllers can slot in later.
import * as THREE from 'three';
import { parseWorkflow, typesAccepting, colorForType } from './graph.js';
import { Panel, pumpRedraws, PW, buttonRow } from './panels.js';
import { BeamSystem } from './beams.js';
import { Hub } from './hubs.js';
import { ComfyClient, demoImage } from './comfy.js';
import { Audio } from './audio.js';

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
// In XR the headset drives the camera's local pose; the rig is what our
// fly/dock logic moves. On desktop the rig sits at origin and the camera
// is driven directly, exactly as before.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
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
    // comfort: teleport instead of gliding while the headset is on
    cam.pos.copy(p1);
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

canvas.addEventListener('pointerdown', (e) => {
  audio.ensure();
  lastInput = performance.now();
  pdown = { x: e.clientX, y: e.clientY };
  dragMode = null; pendingGrab = null;
  const hit = pick(e);
  if (hit && reachable(hit) && hit.rowInfo) {
    const ri = hit.rowInfo;
    if (ri.kind === 'slider') {
      sliderDrag = hit;
      dragMode = 'slider';
      applySlider(hit, e);
    } else if (ri.kind === 'header' && hit.hub && hit.panel.userData?.nodeId != null) {
      pendingGrab = { kind: 'move', hit };
    } else if (ri.kind === 'port' && hit.hub && hit.panel.userData?.nodeId != null) {
      const s = portSlotAt(hit);
      if (s && s.dir === 'out') {
        pendingGrab = { kind: 'link', drag: { mode: 'new', hub: hit.hub, type: s.type, srcNode: s.node.id, srcSlot: s.index } };
      } else if (s && s.dir === 'in' && s.node.linkInputs[s.index]?.link != null) {
        const L = hit.hub.graph.links.get(s.node.linkInputs[s.index].link);
        if (L) pendingGrab = { kind: 'link', drag: { mode: 'retarget', hub: hit.hub, type: L.type, srcNode: L.src, srcSlot: L.srcSlot, linkId: L.id } };
      }
    }
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no real pointerId */ }
});
canvas.addEventListener('pointermove', (e) => {
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
    const moved = Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y) > 4;
    if (!dragMode && moved && pendingGrab) {
      if (pendingGrab.kind === 'move') beginMove(pendingGrab, e);
      else beginLink(pendingGrab.drag);
    }
    if (dragMode === 'move') { doMove(e); return; }
    if (dragMode === 'link') { doLinkDrag(e); return; }
    if (dragMode === 'look' || moved) {
      dragMode = 'look';
      cam.yaw -= e.movementX * 0.0031;
      cam.pitch = THREE.MathUtils.clamp(cam.pitch - e.movementY * 0.0031, -1.5, 1.5);
      cam.anim = null; cam.dock = null;
      if (cam.level === 'panel') cam.level = 'hub';
    }
    return;
  }
  hover(e);
});
canvas.addEventListener('pointerup', (e) => {
  lastInput = performance.now();
  if (dragMode === null && pdown) onClick(e);
  if (dragMode === 'slider') audio.tick();
  if (dragMode === 'move') endMove();
  if (dragMode === 'link') endLink(e);
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
  cam.vel.add(forward().multiplyScalar(e.deltaY < 0 ? 3.5 : -3.5));
  cam.anim = null;
});
addEventListener('keydown', (e) => {
  if (editorOpen()) return;
  lastInput = performance.now();
  if (e.key === 'Escape') {
    if (palette) { closePalette(); return; }
    stepBack(); return;
  }
  if (e.key === 'm' || e.key === 'M') { audio.setMuted(!audio.muted); flashHint(audio.muted ? 'muted' : 'sound on'); return; }
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
  drag.A = drag.hub.anchorFor(drag.srcNode, 'out', { srcSlot: drag.srcSlot });
  if (!drag.A) { linkDrag = null; dragMode = 'look'; return; }
  drag.drop = drag.A.clone();
  if (drag.mode === 'retarget') {
    const b = beams.beams.get(drag.hub.beamKey(drag.linkId));
    if (b) b.line.visible = false;
  }
  beams.addBeam('::drag', drag.A, drag.A.clone(), colorForType(drag.type), { alpha: 0.85, bulge: 0.08, group: '::drag' });
  for (const p of drag.hub.panels.values()) p.setHint({ type: drag.type, dir: 'in' });
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
    if (s && s.dir === 'in' && s.type === drag.type) {
      if (drag.mode === 'new') drag.hub.commitNewLink(drag.srcNode, drag.srcSlot, s.node.id, s.index);
      else drag.hub.retargetTo(drag.linkId, s.node.id, s.index);
      return;
    }
    return;  // incompatible port: no-op
  }
  if (!hit) {
    if (drag.mode === 'new') openPalette(drag);
    else { drag.hub.detachLink(drag.linkId); flashHint('link detached'); }
  }
}

// ---------- accrete palette: drop a beam into space, pick what grows there ----------
function openPalette(drag) {
  closePalette();
  const candidates = typesAccepting(SCHEMA, drag.type).slice(0, 8);
  if (!candidates.length) return;
  const rows = candidates.map(t => buttonRow((SCHEMA[t].display || t).toUpperCase(), () => {
    const rel = palette.pos.clone().sub(drag.hub.center());
    const place = { theta: Math.atan2(rel.z, rel.x), r: Math.hypot(rel.x, rel.z), y: rel.y };
    drag.hub.addNodeAt(t, place, { srcNode: drag.srcNode, srcSlot: drag.srcSlot, type: drag.type });
    closePalette();
  }));
  const panel = new Panel({ title: 'accrete', subtitle: drag.type, accent: colorForType(drag.type), rows, worldWidth: 3.0, billboard: true });
  panel.placeFlat(scene, drag.drop);
  panel.mesh.userData.palette = true;
  panel.dirty();
  palette = { panel, pos: drag.drop.clone(), hub: drag.hub };
  audio.accrete();
}
function closePalette() {
  if (!palette) return;
  palette.panel.dispose();
  palette = null;
}

function pickTargets() {
  const out = [];
  for (const h of hubs) {
    if (h.sigil.mesh.visible) out.push(h.sigil.mesh);
    if (h.corePanel && h.corePanel.mesh.visible) out.push(h.corePanel.mesh);
    for (const p of h.panels.values()) if (p.mesh && p.mesh.visible) out.push(p.mesh);
    for (const gi of h.gallery) if (gi.mesh.visible) out.push(gi.mesh);
  }
  if (palette) out.push(palette.panel.mesh);
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

function reachable(hit) { return hit.dist < 10 || !!hit.object.userData.palette; }

let hotPanel = null;
function hover(e) {
  const hit = pick(e);
  const interactive = hit && reachable(hit) && hit.rowInfo && isInteractive(hit.rowInfo);
  let cursor = hit ? (interactive ? 'pointer' : 'zoom-in') : 'grab';
  if (hit && reachable(hit) && hit.hub && hit.panel?.userData?.nodeId != null) {
    if (hit.rowInfo?.kind === 'header') cursor = 'move';
    if (hit.rowInfo?.kind === 'port') cursor = 'crosshair';
  }
  canvas.style.cursor = cursor;
  const p = hit?.panel || null;
  if (hotPanel && hotPanel !== p) { hotPanel.setHot(null); hotPanel = null; }
  if (p && hit.rowInfo?.row && reachable(hit)) {
    if (p.hot !== hit.rowInfo.row) audio.tick();
    p.setHot(hit.rowInfo.row);
    hotPanel = p;
  } else if (p && hotPanel === p) {
    p.setHot(null);
  }
}

function isInteractive(ri) {
  return ri.row && ['slider', 'seed', 'combo', 'toggle', 'text', 'button'].includes(ri.kind);
}

function onClick(e) {
  const hit = pick(e);
  if (palette && (!hit || hit.panel !== palette.panel)) closePalette();
  if (!hit) return;
  const { panel, hub, gallery, rowInfo } = hit;
  if (gallery) {  // dock to a generation
    const center = hit.object.position.clone().applyMatrix4(hub.group.matrixWorld);
    const n = cam.pos.clone().sub(center).normalize();
    cam.level = 'panel'; cam.hub = hub;
    flyTo(center.clone().add(n.multiplyScalar(4)), center, 1.1);
    audio.dock();
    return;
  }
  if (!panel) return;
  if (hub && panel === hub.sigil) { flyToHub(hub); return; }
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
  let v = row.min + f * (row.max - row.min);
  if (row.step) v = Math.round(v / row.step) * row.step;
  if (row.int) v = Math.round(v);
  else v = Number(v.toFixed(4));
  if (v !== wg.value) {
    wg.value = v;
    audio.zip(f);
    row.onChange?.();
    panel.dirty();
  }
}

// ---------- text editor overlay (desktop affordance; VR uses phone later) ----------
const editorWrap = $('editor'), editorTa = $('editor-ta'), editorLabel = $('editor-label');
let editorCtx = null;
function editorOpen() { return editorWrap.style.display === 'flex'; }
function openEditor(panel, row) {
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
  statusChip.textContent = client.mode === 'live' ? '● LIVE ' + (client.backend || '') : '◌ DEMO — no ComfyUI backend';
  statusChip.className = client.mode;
}

// ---------- boot ----------
let SCHEMA = {};

function hubOpts() {
  return {
    audio,
    schema: SCHEMA,
    onQueue: (h) => { audio.queueSweep(); client.queue(h); flashHint('queued ' + h.name + (client.mode === 'demo' ? ' (simulated)' : '')); },
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
  await client.detect();
  setStatus();
  client.onModeChange = setStatus;
  let list = [];
  try { list = await client.listLocalWorkflows(); } catch (e) { fail('workflow list failed: ' + e); }
  const jsons = [];
  for (const item of list) {
    try { jsons.push({ name: item.name, json: await client.loadLocalWorkflow(item.name), source: 'local' }); }
    catch (e) { fail(`load ${item.name}: ${e}`); }
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
  for (const { json } of jsons) for (const n of json.nodes || []) types.add(n.type);
  const schema = await client.schemaFor([...types]);
  SCHEMA = schema;

  const N = Math.max(jsons.length, 1);
  const ringR = Math.max(95, N * 10);
  jsons.forEach(({ name, json, source }, i) => {
    const graph = parseWorkflow(json, schema);
    const hub = new Hub(scene, beams, { name, graph, source }, hubOpts());
    const th = (i / N) * Math.PI * 2 - Math.PI / 2;
    hub.setPosition(new THREE.Vector3(Math.cos(th) * ringR, (i % 2) * 8 - 4, Math.sin(th) * ringR));
    hubs.push(hub);
  });

  // constellation threads: hubs sharing a checkpoint
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

  // demo galleries so the rims aren't bare
  if (client.mode === 'demo') {
    for (const h of hubs) for (let k = 0; k < 3; k++) h.addGeneration(demoImage(h, null), '', { instant: true });
  }

  $('veil').classList.add('gone');
  flashHint('drag look · wasd/qe drift · click sigils/panels · drag headers to move nodes · drop a comfy png · esc back · m mute');

  backfillHistory().catch((e) => console.warn('history backfill', e));
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
    for (const out of Object.values(outputs)) {
      for (const im of out.images || []) {
        if (im.type !== 'output' || hub.gallery.length >= 8) continue;
        try {
          hub.addGeneration(await client.imageBitmap(im), '', { instant: true });
          recalled++;
        } catch (err) { /* image may have been deleted from disk */ }
      }
    }
  }
  if (recalled) flashHint(`${recalled} generation${recalled > 1 ? 's' : ''} recalled from history`);
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
  const missing = [...new Set((json.nodes || []).map(n => n.type))].filter(t => !SCHEMA[t]);
  if (missing.length) Object.assign(SCHEMA, await client.schemaFor(missing));
  let base = name.replace(/[\\/]/g, '_') || 'dropped', nm = base, i = 2;
  while (hubs.some(h => h.name === nm)) nm = `${base}-${i++}`;
  const graph = parseWorkflow(json, SCHEMA);
  const hub = new Hub(scene, beams, { name: nm, graph, source: 'dropped' }, hubOpts());
  hub.setPosition(cam.pos.clone().add(forward().multiplyScalar(70)));
  hubs.push(hub);
  if (bitmap) hub.addGeneration(bitmap, '', { instant: true });
  audio.accrete();
  flashHint('accreted ' + nm);
  flyToHub(hub);
  return hub;
}

// ---------- WebXR: the same space, headset on ----------
// Controllers AND hands share one input layer: Quest exposes hand-tracked
// pinch as select events on the same input sources, so every interaction
// below works with bare hands for free.
const xrState = { yaw: 0, turnLatch: false, controllers: [] };
const _mat4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _v3 = new THREE.Vector3();

if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
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
  camera.getWorldPosition(camWorld);
  cam.pos.copy(camWorld);
  syncAngles(camWorld.clone().add(_f.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(_q))));
  rig.position.set(0, 0, 0);
  rig.rotation.y = 0;
  camera.position.copy(cam.pos);
});

for (let ci = 0; ci < 2; ci++) {
  const c = renderer.xr.getController(ci);
  rig.add(c);
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
  if (!hit) return;
  const vrReach = hit.dist < 14 || !!hit.object.userData.palette;
  const ri = hit.rowInfo;
  if (vrReach && ri) {
    if (ri.kind === 'slider') { st.mode = 'slider'; applySliderFrac(hit.panel, ri.row, ri.frac); return; }
    if (ri.kind === 'header' && hit.hub && hit.panel.userData?.nodeId != null && !moveDrag) {
      setRayFromController(st.c);
      const p = hit.panel;
      const at = rayCylinder(hit.hub, p.placement.r);
      moveDrag = { hub: hit.hub, panel: p, id: p.userData.nodeId, offT: at ? wrapAng(p.placement.theta - at.theta) : 0, offY: at ? p.placement.y - at.y : 0 };
      st.mode = 'move';
      audio.tick();
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
      }
      return;
    }
    if (isInteractive(ri)) {
      if (ri.kind === 'text') return;   // text entry stays on desktop until the phone companion
      interact(hit.panel, hit.hub, ri);
      return;
    }
  }
  if (hit.gallery) return;
  if (hit.hub && hit.panel === hit.hub.sigil) { flyToHub(hit.hub); return; }
  if (hit.panel && hit.hub) dockToPanel(hit.panel, hit.hub);
}

function xrSelectEnd(st) {
  if (st.mode === 'link' && linkDrag) finishLink(st.hit);
  if (st.mode === 'move') endMove();
  if (st.mode === 'slider') audio.tick();
  st.mode = null;
  dragMode = null; sliderDrag = null; pendingGrab = null;
}

function xrControllersTick() {
  for (const st of xrState.controllers) {
    setRayFromController(st.c);
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
      if (hit.panel && hit.rowInfo?.row && hit.dist < 14) {
        if (hit.panel.hot !== hit.rowInfo.row) audio.tick();
        hit.panel.setHot(hit.rowInfo.row);
      }
    } else {
      st.rayLine.scale.z = 10;
      st.dot.visible = false;
    }
  }
}

function xrTick(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;                       // hands: no sticks, pinch = select
    const x = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
    const y = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
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
    // idle drift: orbit the current focus
    if (performance.now() - lastInput > 20000) {
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
  if (palette) {
    palette.panel.mesh.lookAt(camWorld);
    palette.panel.update(t);
  }

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
