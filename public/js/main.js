// main.js — the space. Constellation of workflow hubs; drift, dock, edit,
// queue. Desktop controls now; every interaction is expressed as ray +
// point so VR controllers can slot in later.
import * as THREE from 'three';
import { parseWorkflow } from './graph.js';
import { Panel, pumpRedraws, PW } from './panels.js';
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
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x01050a);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3000);
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
let lastInput = performance.now();
const canvas = renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  audio.ensure();
  lastInput = performance.now();
  pdown = { x: e.clientX, y: e.clientY };
  dragMode = null;
  const hit = pick(e);
  if (hit && reachable(hit) && hit.rowInfo?.kind === 'slider') {
    sliderDrag = hit;
    dragMode = 'slider';
    applySlider(hit, e);
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
    const dx = e.clientX - pdown.x, dy = e.clientY - pdown.y;
    if (dragMode || Math.hypot(dx, dy) > 4) {
      dragMode = 'look';
      lastInput = performance.now();
      cam.yaw -= e.movementX * 0.0031;
      cam.pitch = THREE.MathUtils.clamp(cam.pitch - e.movementY * 0.0031, -1.5, 1.5);
      cam.anim = null; cam.dock = null;
      if (cam.level === 'panel') cam.level = 'hub';
    }
  } else {
    hover(e);
  }
});
canvas.addEventListener('pointerup', (e) => {
  lastInput = performance.now();
  if (dragMode === null && pdown) onClick(e);
  if (dragMode === 'slider') audio.tick();
  pdown = null; dragMode = null; sliderDrag = null;
});
canvas.addEventListener('wheel', (e) => {
  lastInput = performance.now();
  cam.vel.add(forward().multiplyScalar(e.deltaY < 0 ? 3.5 : -3.5));
  cam.anim = null;
});
addEventListener('keydown', (e) => {
  if (editorOpen()) return;
  lastInput = performance.now();
  if (e.key === 'Escape') { stepBack(); return; }
  if (e.key === 'm' || e.key === 'M') { audio.setMuted(!audio.muted); flashHint(audio.muted ? 'muted' : 'sound on'); return; }
  keys.add(e.key.toLowerCase());
  if (['w', 'a', 's', 'd', 'q', 'e'].includes(e.key.toLowerCase())) { cam.anim = null; cam.dock = null; if (cam.level === 'panel') cam.level = 'hub'; }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function pickTargets() {
  const out = [];
  for (const h of hubs) {
    if (h.sigil.mesh.visible) out.push(h.sigil.mesh);
    if (h.corePanel && h.corePanel.mesh.visible) out.push(h.corePanel.mesh);
    for (const p of h.panels.values()) if (p.mesh && p.mesh.visible) out.push(p.mesh);
    for (const gi of h.gallery) if (gi.mesh.visible) out.push(gi.mesh);
  }
  return out;
}

function pick(e) {
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
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

function reachable(hit) { return hit.dist < 10; }

let hotPanel = null;
function hover(e) {
  const hit = pick(e);
  const interactive = hit && reachable(hit) && hit.rowInfo && isInteractive(hit.rowInfo);
  canvas.style.cursor = hit ? (interactive ? 'pointer' : 'zoom-in') : 'grab';
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
  const row = hit.rowInfo.row, wg = row.widget;
  // slider bar spans px 196..398 of the canvas
  const cx = (ri.frac ?? 0) * (PW - 36) + 18;
  const f = THREE.MathUtils.clamp((cx - 196) / 202, 0, 1);
  let v = row.min + f * (row.max - row.min);
  if (row.step) v = Math.round(v / row.step) * row.step;
  if (row.int) v = Math.round(v);
  else v = Number(v.toFixed(4));
  if (v !== wg.value) {
    wg.value = v;
    audio.zip(f);
    row.onChange?.();
    hit.panel.dirty();
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
async function boot() {
  await client.detect();
  setStatus();
  client.onModeChange = setStatus;
  let list = [];
  try { list = await client.listLocalWorkflows(); } catch (e) { fail('workflow list failed: ' + e); }
  const jsons = [];
  for (const item of list) {
    try { jsons.push({ name: item.name, json: await client.loadLocalWorkflow(item.name) }); }
    catch (e) { fail(`load ${item.name}: ${e}`); }
  }
  const types = new Set();
  for (const { json } of jsons) for (const n of json.nodes || []) types.add(n.type);
  const schema = await client.schemaFor([...types]);

  const N = Math.max(jsons.length, 1);
  jsons.forEach(({ name, json }, i) => {
    const graph = parseWorkflow(json, schema);
    const hub = new Hub(scene, beams, { name, graph }, {
      audio,
      onQueue: (h) => { audio.queueSweep(); client.queue(h); flashHint('queued ' + h.name + (client.mode === 'demo' ? ' (simulated)' : '')); },
      onSave: async (h) => {
        const ok = await client.saveLocalWorkflow(h.name, h.rawWorkflow());
        flashHint(ok ? 'saved ' + h.name : 'save FAILED');
        audio.toggle(ok);
      },
    });
    const th = (i / N) * Math.PI * 2 - Math.PI / 2;
    hub.setPosition(new THREE.Vector3(Math.cos(th) * 95, (i % 2) * 8 - 4, Math.sin(th) * 95));
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
    for (const h of hubs) for (let k = 0; k < 3; k++) h.addGeneration(demoImage(h, null), '');
  }

  $('veil').classList.add('gone');
  flashHint('drag look · wasd/qe drift · shift hurry · click sigils and panels · esc back · m mute');
}
boot().catch((e) => fail('boot: ' + (e.stack || e)));

// ---------- frame loop ----------
const clock = new THREE.Clock();
let spacePulseTimer = 0;
let simT = 0;

function frame() {
  requestAnimationFrame(frame);
  tick(Math.min(clock.getDelta(), 0.05));
}

function tick(dt) {
  simT += dt;
  const t = simT;

  // camera animation
  if (cam.anim) {
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

  // hubs
  for (const h of hubs) {
    h.update(dt, t, cam.pos);
    h.billboards(camera.position);
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
        const c = a === 0 ? cam.pos.x : a === 1 ? cam.pos.y : cam.pos.z;
        while (v - c > WRAP / 2) v -= WRAP;
        while (v - c < -WRAP / 2) v += WRAP;
        p.array[idx] = v;
      }
      p.array[i * 3 + 1] += Math.sin(t * 0.3 + i) * 0.002;
    }
    p.needsUpdate = true;
  }
  window._sky.material.uniforms.uT.value = t;
  window._sky.position.copy(cam.pos);

  pumpRedraws(t, 4);
  renderer.render(scene, camera);
}
frame();

// Debug handle: drives the loop manually when rAF is throttled (hidden
// pane), and snapshots the GL canvas without preserveDrawingBuffer.
window.CVR = {
  hubs, cam, beams, client, camera, THREE,
  tick: (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) tick(dt); },
  fly: (i) => flyToHub(hubs[i]),
  look: (px, py, pz, lx, ly, lz) => { cam.anim = null; cam.dock = null; cam.pos.set(px, py, pz); syncAngles(new THREE.Vector3(lx, ly, lz)); },
  snap: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
};
