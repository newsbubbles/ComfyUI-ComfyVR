// hubs.js — one workflow = one hub. Folded: a sigil billboard + beacon glow
// in the constellation. Unfolded: an amphitheater — concentric rings, one
// per topological depth, panels curved onto the ring cylinder facing the
// core, beams arcing tier to tier, gallery of generations on the rim.
import * as THREE from 'three';
import { topoLayers, colorForType, toApiFormat, randomizeSeeds, syncToRaw } from './graph.js';
import { Panel, widgetRow, portRow, buttonRow, progressRow, imageRow, readoutRow, glyphRow } from './panels.js';

const R0 = 7;          // ring 0 radius
const DR = 4.6;        // radius step per depth
const DY = 2.4;        // height step per depth
const GLYPHS = 'ΔΘΛΞΠΣΦΨΩ◇◈⌬⌖✦';

export class Hub {
  constructor(scene, beams, record, opts) {
    this.scene = scene;
    this.beams = beams;
    this.name = record.name;
    this.graph = record.graph;
    this.opts = opts;            // {audio, onQueue, onSave, onEdit}
    this.group = new THREE.Group();
    scene.add(this.group);
    this.layout = topoLayers(this.graph);
    this.maxDepth = this.layout.layers.length - 1;
    this.rimRadius = R0 + (this.maxDepth + 1) * DR;
    this.rimY = (this.maxDepth + 1) * DY;
    this.state = 'folded';       // folded | unfolding | open | folding
    this.foldT = 0;
    this.panels = new Map();     // nodeId -> Panel
    this.corePanel = null;
    this.gallery = [];           // {mesh, tex}
    this.status = 'idle';
    this.progress = 0;
    this.runningNode = null;
    this.glyph = GLYPHS[hashStr(this.name) % GLYPHS.length];
    // circular mean bearing of the DAG — the "face" of the amphitheater
    let sx = 0, sy = 0;
    for (const a of this.layout.angle.values()) { sx += Math.cos(a); sy += Math.sin(a); }
    this.meanAngle = Math.atan2(sy, sx);
    this.buildSigil();
  }

  setPosition(v) { this.group.position.copy(v); }
  center() { return this.group.position; }

  // ---------- sigil (folded LOD) ----------
  buildSigil() {
    this.sigil = new Panel({
      title: this.name, subtitle: 'workflow', accent: '#7ce8dc', worldWidth: 6.5, billboard: true,
      rows: [
        glyphRow(this.glyph, true),
        readoutRow(() => `${this.graph.nodes.size} nodes · ${this.graph.links.size} links`, () => this.status.toUpperCase()),
      ],
    });
    this.sigil.placeFlat(this.group, new THREE.Vector3(0, 0, 0));
    this.sigil.mesh.userData.hub = this;
    this.sigil.baseOpacity = 0.85;
    // beacon glow sprite
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0x59e6d2, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    spr.scale.setScalar(18);
    spr.renderOrder = 1;
    this.group.add(spr);
    this.beacon = spr;
  }

  // ---------- amphitheater (open LOD) ----------
  buildBowl() {
    if (this.panels.size) return;
    for (const [id, node] of this.graph.nodes) {
      const d = this.layout.depth.get(id);
      const theta = this.layout.angle.get(id) ?? 0;
      const accent = accentFor(node);
      const rows = [];
      const inSlots = node.linkInputs.map(li => ({ name: li.name, type: li.type, dir: 'in' }));
      const outSlots = node.outputs.map(o => ({ name: o.name, type: o.type, dir: 'out' }));
      const slots = [];
      for (let i = 0; i < Math.max(inSlots.length, outSlots.length); i++) {
        if (inSlots[i]) slots.push(inSlots[i]);
      }
      for (const s of outSlots) slots.push(s);
      if (slots.length) rows.push(portRow(slots));
      for (const wg of node.widgets) rows.push(widgetRow(wg, () => this.onEdited(node)));
      if (node.type.includes('KSampler')) rows.push(progressRow(() => (this.runningNode === id ? this.progress : 0)));
      if (node.hasImage) rows.push(imageRow('awaiting generation'));
      const p = new Panel({ title: node.title, subtitle: `#${id} d${d}`, accent, rows });
      const r = R0 + d * DR;
      p.place(this.group, r, theta, d * DY + p.worldHeight() / 2);
      // tilt ring panels slightly down toward the core
      p.mesh.rotateX(-0.1 - d * 0.015);
      p.foldAlpha = 0;
      p.userData = { nodeId: id, depth: d };
      p.mesh.userData.hub = this;
      this.panels.set(id, p);
      p.dirty();
    }
    this.buildCore();
    this.buildLinks();
  }

  buildCore() {
    const rows = [
      readoutRow(() => `depth ${this.maxDepth + 1} · ${this.graph.nodes.size} nodes`, () => this.status.toUpperCase()),
      progressRow(() => this.progress),
      buttonRow('◈ QUEUE', () => this.opts.onQueue(this)),
      buttonRow('⟳ RESEED · SAVE ⬡', (frac) => (frac < 0.5 ? this.reseed() : this.opts.onSave(this))),
      imageRow('latest signal'),
    ];
    this.corePanel = new Panel({ title: this.name, subtitle: 'core', accent: '#7ce8dc', rows, worldWidth: 3.4, billboard: true });
    this.corePanel.placeFlat(this.group, new THREE.Vector3(0, 0.9, 0));
    this.corePanel.mesh.userData.hub = this;
    this.corePanel.foldAlpha = 0;
    this.coreImageRow = rows[4];
    this.corePanel.dirty();
  }

  buildLinks() {
    for (const [id, L] of this.graph.links) {
      const A = this.anchorFor(L.src, 'out', L);
      const B = this.anchorFor(L.dst, 'in', L);
      if (!A || !B) continue;
      this.beams.addBeam(this.beamKey(id), A, B, colorForType(L.type), {
        away: this.center().clone(), alpha: 0.4, group: 'hub:' + this.name,
      });
    }
    this.beams.setGroupAlpha('hub:' + this.name, 0);
  }

  beamKey(linkId) { return `hub:${this.name}:${linkId}`; }

  anchorFor(nodeId, dir, L) {
    const p = this.panels.get(nodeId);
    const node = this.graph.nodes.get(nodeId);
    if (!p || !node) return null;
    const ports = p.rows.find(r => r.kind === 'port');
    if (!ports) return p.anchorWorld(dir === 'in' ? 0.02 : 0.98, 0.5);
    const idx = ports.slots.findIndex(s =>
      dir === 'in' ? s.dir === 'in' && s.name === node.linkInputs[L.dstSlot]?.name
                   : s.dir === 'out' && s.name === node.outputs[L.srcSlot]?.name);
    const [y0] = p.rowRangePx(ports);
    const vTop = (y0 + 22 * ((idx < 0 ? 0 : idx) + 0.5)) / p.pxH;
    return p.anchorWorld(dir === 'in' ? 0.02 : 0.98, vTop);
  }

  // ---------- fold / unfold ----------
  unfold() {
    if (this.state === 'open' || this.state === 'unfolding') return;
    this.buildBowl();
    this.state = 'unfolding';
    this.foldT = 0;
    this.opts.audio?.accrete();
  }

  fold() {
    if (this.state === 'folded' || this.state === 'folding') return;
    this.state = 'folding';
  }

  update(dt, t, camPos) {
    // LOD with hysteresis; explicit unfold() also honored.
    const dist = camPos.distanceTo(this.center());
    if (this.state === 'folded' && dist < this.rimRadius + 26) this.unfold();
    if (this.state === 'open' && dist > this.rimRadius + 46) this.fold();

    if (this.state === 'unfolding') {
      this.foldT = Math.min(1, this.foldT + dt / 1.4);
      if (this.foldT >= 1) this.state = 'open';
    } else if (this.state === 'folding') {
      this.foldT = Math.max(0, this.foldT - dt / 0.7);
      if (this.foldT <= 0) this.state = 'folded';
    }
    const ft = ease(this.foldT);

    // stagger panels by depth during unfold
    for (const p of this.panels.values()) {
      const dNorm = (p.userData.depth + 1) / (this.maxDepth + 2);
      const local = Math.max(0, Math.min(1, (ft - dNorm * 0.55) / 0.45));
      p.foldAlpha = local;
      const s = 0.4 + 0.6 * local;
      p.mesh.scale.setScalar(Math.max(s, 0.001));
      p.mesh.visible = local > 0.01;
      p.update(t);
    }
    if (this.corePanel) {
      this.corePanel.foldAlpha = ft;
      this.corePanel.mesh.visible = ft > 0.01;
      this.corePanel.update(t);
    }
    this.beams.setGroupAlpha('hub:' + this.name, Math.max(0, ft - 0.5) * 2 * 0.4 * (this.status === 'running' ? 1.6 : 1));

    // sigil is the inverse; both it and the beacon scale with distance so
    // the constellation stays readable as a map from anywhere
    const far = Math.max(1, dist / 55);
    this.sigil.foldAlpha = 1 - ft;
    this.sigil.mesh.visible = ft < 0.98;
    this.sigil.mesh.scale.setScalar(far);
    this.sigil.update(t);
    this.beacon.material.opacity = (1 - ft) * (0.35 + 0.15 * Math.sin(t * 1.7 + this.sigil.id));
    const pulse = this.status === 'running' ? 1 + 0.3 * Math.sin(t * 6) : 1;
    this.beacon.scale.setScalar(18 * far * pulse);

    for (const gImg of this.gallery) {
      gImg.mesh.material.opacity = 0.9 * ft * (0.92 + 0.08 * Math.sin(t * 2 + gImg.phase));
      gImg.mesh.visible = ft > 0.01;
    }
  }

  billboards(camPos) {
    if (this.sigil.mesh.visible) this.sigil.mesh.lookAt(camPos);
    if (this.corePanel && this.corePanel.mesh.visible) this.corePanel.mesh.lookAt(camPos);
    for (const gImg of this.gallery) if (gImg.mesh.visible) gImg.mesh.lookAt(camPos);
  }

  // ---------- execution events (live ws and demo sim share this surface) ----------
  onStatus(s) { this.status = s; this.sigil.dirty(); this.corePanel?.dirty(); }

  onExecuting(nodeId) {
    if (nodeId == null) { this.runningNode = null; this.onStatus('idle'); return; }
    this.runningNode = Number(nodeId);
    this.progress = 0;
    const p = this.panels.get(this.runningNode);
    if (p) { p.active = 1; p.dirty(); }
    // data arrives INTO this node: pulse its incoming beams
    for (const [id, L] of this.graph.links) {
      if (L.dst === this.runningNode) this.beams.pulse(this.beamKey(id), { speed: 18 });
    }
    this.opts.audio?.plink();
  }

  onProgress(v, max) {
    this.progress = max ? v / max : 0;
    const p = this.panels.get(this.runningNode);
    if (p) p.dirty();
    this.corePanel?.dirty();
  }

  onExecuted(nodeId, imgBitmaps) {
    const id = Number(nodeId);
    const p = this.panels.get(id);
    if (p) {
      for (const L of this.graph.links.values()) {
        if (L.src === id) this.beams.pulse(this.beamKey(L.id), { speed: 14 });
      }
      const imRow = p.rows.find(r => r.kind === 'image');
      if (imRow && imgBitmaps?.length) { imRow.img = imgBitmaps[0]; p.dirty(); }
    }
    if (imgBitmaps?.length) {
      if (this.coreImageRow) { this.coreImageRow.img = imgBitmaps[0]; this.corePanel.dirty(); }
      for (const bm of imgBitmaps) this.addGeneration(bm);
      this.opts.audio?.chime();
    }
  }

  onPreview(bitmap) {
    if (this.coreImageRow) { this.coreImageRow.img = bitmap; this.corePanel?.dirty(); }
  }

  // ---------- gallery ----------
  addGeneration(bitmap, caption = '') {
    const tex = new THREE.CanvasTexture(frameImage(bitmap, caption));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), mat);
    mesh.renderOrder = 9;
    mesh.userData.hub = this;
    mesh.userData.gallery = true;
    const i = this.gallery.length;
    const theta = i * 2.399963;                     // golden angle around the rim
    const r = this.rimRadius + 1.5;
    mesh.position.set(Math.cos(theta) * r, this.rimY + 2 + (i % 3) * 1.3, Math.sin(theta) * r);
    this.group.add(mesh);
    this.gallery.push({ mesh, tex, phase: Math.random() * 6.28 });
  }

  // ---------- edits ----------
  onEdited(node) { this.opts.onEdit?.(this, node); }

  reseed() { randomizeSeeds(this.graph); for (const p of this.panels.values()) p.dirty(); this.opts.audio?.toggle(true); }

  apiPrompt() { return toApiFormat(this.graph); }
  rawWorkflow() { return syncToRaw(this.graph); }
}

function accentFor(node) {
  const primary = node.outputs[0]?.type;
  if (primary) return colorForType(primary);
  if (node.hasImage) return colorForType('IMAGE');
  return '#7ce8dc';
}

function ease(x) { return x * x * (3 - 2 * x); }
function hashStr(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(140,255,235,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

function frameImage(bitmap, caption) {
  const c = document.createElement('canvas');
  c.width = c.height = 400;
  const g = c.getContext('2d');
  const s = Math.min(384 / bitmap.width, 384 / bitmap.height);
  const dw = bitmap.width * s, dh = bitmap.height * s;
  g.drawImage(bitmap, (400 - dw) / 2, (400 - dh) / 2, dw, dh);
  g.strokeStyle = 'rgba(124,232,220,0.75)';
  g.lineWidth = 3;
  g.strokeRect(4, 4, 392, 392);
  if (caption) {
    g.fillStyle = 'rgba(124,232,220,0.9)';
    g.font = '16px Consolas, monospace';
    g.fillText(caption, 12, 390);
  }
  return c;
}
