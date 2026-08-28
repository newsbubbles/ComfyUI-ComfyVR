// hubs.js — one workflow = one hub. Folded: a sigil billboard + beacon glow
// in the constellation. Unfolded: an amphitheater — concentric rings, one
// per topological depth, panels curved onto the ring cylinder facing the
// core, beams arcing tier to tier, gallery of generations on the rim.
import * as THREE from 'three';
import { topoLayers, colorForType, toApiFormat, randomizeSeeds, applySeedControls, syncToRaw, createLink, retargetLink, removeLink, addNodeToGraph } from './graph.js';
import { Panel, widgetRow, portRow, buttonRow, progressRow, imageRow, readoutRow, glyphRow, alertRow } from './panels.js';

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
    this.source = record.source || 'local';
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
    // 3D layout overrides (moved/added nodes) persist inside the workflow's
    // extra field, which vanilla ComfyUI carries along untouched
    const extra = this.graph.raw.extra = this.graph.raw.extra || {};
    const cvr = extra.comfyvr = extra.comfyvr || {};
    this.overrides = cvr.layout = cvr.layout || {};
    this.buildSigil();
  }

  setPosition(v) { this.group.position.copy(v); }
  center() { return this.group.position; }

  // ---------- sigil (folded LOD) ----------
  buildSigil() {
    this.sigil = new Panel({
      title: this.name, subtitle: this.source, accent: '#7ce8dc', worldWidth: 6.5, billboard: true,
      rows: [
        glyphRow(this.glyph, true),
        readoutRow(() => `${this.graph.nodes.size} nodes · ${this.graph.links.size} links`, () => this.flashMsg || this.status.toUpperCase()),
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
    for (const node of this.graph.nodes.values()) this.buildPanel(node);
    this.buildCore();
    this.buildLinks();
  }

  buildPanel(node) {
    const id = node.id;
    const d = this.layout.depth.get(id) ?? 0;
    const ov = this.overrides[id];
    const theta = ov?.theta ?? this.layout.angle.get(id) ?? 0;
    const r = ov?.r ?? R0 + d * DR;
    const ringD = Math.max(0, Math.round((r - R0) / DR));
    const accent = accentFor(node);
    const rows = [];
    const slots = [
      ...node.linkInputs.map(li => ({ name: li.name, type: li.type, dir: 'in' })),
      ...node.outputs.map(o => ({ name: o.name, type: o.type, dir: 'out' })),
    ];
    if (slots.length) rows.push(portRow(slots));
    for (const wg of node.widgets) {
      rows.push(widgetRow(wg, () => {
        this.onEdited(node);
        if (wg.imageInput) this.refreshInputImage(node);
      }));
    }
    if (node.type.includes('KSampler')) rows.push(progressRow(() => (this.runningNode === id ? this.progress : 0)));
    const hasInputImage = node.widgets.some(w => w.imageInput);
    if (node.hasImage || hasInputImage) rows.push(imageRow(hasInputImage ? 'no image selected' : 'awaiting generation'));
    const p = new Panel({ title: node.title, subtitle: `#${id} d${d}`, accent, rows });
    const y = ov?.y ?? d * DY + p.worldHeight() / 2;
    p.place(this.group, r, theta, y, -0.1 - ringD * 0.015);
    p.foldAlpha = 0;
    p.userData = { nodeId: id, depth: ringD };
    p.mesh.userData.hub = this;
    this.panels.set(id, p);
    p.dirty();
    if (hasInputImage) this.refreshInputImage(node);
    return p;
  }

  // Show the file an input-image combo (LoadImage etc.) points at, straight
  // from the server's input dir. LoadImage never executes an output image,
  // so without this the panel stays blank forever.
  async refreshInputImage(node) {
    const wg = node.widgets.find(w => w.imageInput);
    if (!wg || !wg.value || !this.opts.loadInputImage) return;
    const bm = await Promise.resolve(this.opts.loadInputImage(String(wg.value))).catch(() => null);
    if (!bm) return;
    const p = this.panels.get(node.id);
    const imRow = p?.rows.find(r => r.kind === 'image');
    if (imRow) { imRow.img = bm; p.dirty(); }
  }

  // ---------- node moving (panels always face the centroid axis) ----------
  moveNode(id, theta, y, r = null) {
    const p = this.panels.get(id);
    if (!p) return;
    r = Math.min(Math.max(r ?? p.placement.r, 3.5), this.rimRadius + 8);
    y = Math.min(Math.max(y, 0.6), this.rimY + 8);
    p.setPlacement(r, theta, y);
    this.overrides[id] = { theta: +theta.toFixed(4), y: +y.toFixed(3), r: +r.toFixed(3) };
    this.refreshNodeBeams(id);
  }

  refreshNodeBeams(id) {
    for (const L of this.graph.links.values()) {
      if (L.src !== id && L.dst !== id) continue;
      const A = this.anchorFor(L.src, 'out', L), B = this.anchorFor(L.dst, 'in', L);
      if (A && B) this.beams.updateBeam(this.beamKey(L.id), A, B);
    }
  }

  // ---------- wiring surgery ----------
  addBeamFor(L) {
    const A = this.anchorFor(L.src, 'out', L), B = this.anchorFor(L.dst, 'in', L);
    if (A && B) {
      this.beams.addBeam(this.beamKey(L.id), A, B, colorForType(L.type), {
        away: this.center().clone(), alpha: 0.4, group: 'hub:' + this.name,
      });
    }
  }

  // Drop beams whose link no longer exists (createLink/retarget displace
  // whatever previously fed the same input).
  pruneBeams() {
    const prefix = `hub:${this.name}:`;
    for (const key of [...this.beams.beams.keys()]) {
      if (!key.startsWith(prefix)) continue;
      if (!this.graph.links.has(Number(key.slice(prefix.length)))) this.beams.removeBeam(key);
    }
  }

  commitNewLink(srcId, srcSlot, dstId, dstSlot) {
    const L = createLink(this.graph, srcId, srcSlot, dstId, dstSlot);
    if (!L) return null;
    this.pruneBeams();
    this.addBeamFor(L);
    this.opts.audio?.toggle(true);
    return L;
  }

  retargetTo(linkId, dstId, dstSlot) {
    const L = retargetLink(this.graph, linkId, dstId, dstSlot);
    if (!L) return null;
    this.pruneBeams();
    const A = this.anchorFor(L.src, 'out', L), B = this.anchorFor(L.dst, 'in', L);
    if (A && B) this.beams.updateBeam(this.beamKey(L.id), A, B);
    this.opts.audio?.toggle(true);
    return L;
  }

  detachLink(linkId) {
    removeLink(this.graph, linkId);
    this.beams.removeBeam(this.beamKey(linkId));
    this.opts.audio?.toggle(false);
  }

  // ---------- node adding (palette drop) ----------
  addNodeAt(type, place, pending = null) {
    const sc = this.opts.schema?.[type];
    const node = addNodeToGraph(this.graph, type, sc);
    if (!node) return null;
    this.overrides[node.id] = place;
    const p = this.buildPanel(node);
    p.foldAlpha = 1;
    p.mesh.visible = true;
    if (pending) {
      const slot = node.linkInputs.findIndex(li => li.type === pending.type && li.link == null);
      const use = slot >= 0 ? slot : node.linkInputs.findIndex(li => li.type === pending.type);
      if (use >= 0) this.commitNewLink(pending.srcNode, pending.srcSlot, node.id, use);
    }
    this.opts.audio?.accrete();
    return node;
  }

  buildCore() {
    const rows = [
      readoutRow(() => `depth ${this.maxDepth + 1} · ${this.graph.nodes.size} nodes`, () => this.flashMsg || this.status.toUpperCase()),
      alertRow(() => this.lastError),
      progressRow(() => this.progress),
      buttonRow('◈ QUEUE', () => this.opts.onQueue(this)),
      buttonRow('⟳ RESEED · SAVE ⬡', (frac) => (frac < 0.5 ? this.reseed() : this.opts.onSave(this))),
      imageRow('latest signal'),
    ];
    this.corePanel = new Panel({ title: this.name, subtitle: 'core', accent: '#7ce8dc', rows, worldWidth: 3.4, billboard: true });
    this.corePanel.placeFlat(this.group, new THREE.Vector3(0, 0.9, 0));
    this.corePanel.mesh.userData.hub = this;
    this.corePanel.foldAlpha = 0;
    this.coreImageRow = rows[rows.length - 1];
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
    // generous fold-out so a whole tall hub can be admired from outside
    const dist = camPos.distanceTo(this.center());
    if (this.state === 'folded' && dist < this.rimRadius + 26) this.unfold();
    if (this.state === 'open' && dist > this.rimRadius * 2 + 70) this.fold();

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
      if (gImg.birthT < 8) {
        gImg.birthT += dt;
        gImg.mesh.scale.setScalar(0.2 + 0.8 * Math.min(1, gImg.birthT / 0.5));
        const f = ease(Math.max(0, Math.min(1, (gImg.birthT - 3) / 4)));  // hold 3s, fly 4s
        gImg.mesh.position.lerpVectors(gImg.from, gImg.to, f);
        gImg.mesh.position.y += Math.sin(f * Math.PI) * 3;
      }
      gImg.mesh.material.opacity = 0.9 * ft * (0.92 + 0.08 * Math.sin(t * 2 + gImg.phase));
      gImg.mesh.visible = ft > 0.01;
      if (gImg.assetState?.object) {
        gImg.assetState.object.rotation.y += dt * 0.35;
        gImg.assetState.object.visible = ft > 0.01;
      }
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
    if (this.status !== 'running') this.onStatus('running');  // execution_start can race the /prompt response
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

  onExecuted(nodeId, imgBitmaps, assets = []) {
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
    if (assets?.length) {
      for (const a of assets) this.addAsset(a);
      this.opts.audio?.accrete();
    }
  }

  onPreview(bitmap) {
    if (this.coreImageRow) { this.coreImageRow.img = bitmap; this.corePanel?.dirty(); }
  }

  // ---------- gallery ----------
  // Generations cluster on the rim around the DAG's mean bearing (the side
  // you face from the stand point), newest nearest the center. A fresh one
  // is BORN beside the core — where you were watching the preview — holds a
  // few seconds, then flies up to its slot.
  gallerySlot(i) {
    const slotAngle = this.meanAngle + Math.ceil(i / 2) * 0.42 * (i % 2 ? 1 : -1);
    const r = this.rimRadius + 1.5;
    return new THREE.Vector3(Math.cos(slotAngle) * r, this.rimY + 2 + (i % 3) * 1.3, Math.sin(slotAngle) * r);
  }

  pushGalleryMesh(canvas, { instant = false, asset = null } = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), mat);
    mesh.renderOrder = 9;
    mesh.userData.hub = this;
    mesh.userData.gallery = true;
    const to = this.gallerySlot(this.gallery.length);
    const from = new THREE.Vector3(-Math.cos(this.meanAngle) * 2.6, 4.0, -Math.sin(this.meanAngle) * 2.6);
    mesh.position.copy(instant ? to : from);
    this.group.add(mesh);
    const item = { mesh, tex, phase: Math.random() * 6.28, birthT: instant ? Infinity : 0, from, to, asset };
    this.gallery.push(item);
    return item;
  }

  addGeneration(bitmap, caption = '', opts = {}) {
    return this.pushGalleryMesh(frameImage(bitmap, caption), opts);
  }

  // A 3D output gets a placard; clicking it materializes the real asset.
  addAsset(asset, opts = {}) {
    if (this.gallery.some(g => g.asset && g.asset.filename === asset.filename && g.asset.subfolder === asset.subfolder)) return null;
    return this.pushGalleryMesh(assetPlacard(asset), { ...opts, asset });
  }

  // ---------- errors: rejection payloads land on the panels that caused them ----------
  onExecError(d) {
    const msg = `${d.exception_type || 'error'}: ${String(d.exception_message || '').split('\n')[0]}`;
    this.lastError = msg;
    const p = this.panels.get(Number(d.node_id));
    if (p) { p.errorMsg = msg; p.dirty(); }
    this.flash('⚠ RUN FAILED');
    this.corePanel?.dirty();
    this.opts.audio?.toggle(false);
  }

  setNodeErrors(nodeErrors) {
    for (const [id, e] of Object.entries(nodeErrors || {})) {
      const p = this.panels.get(Number(id));
      if (!p) continue;
      const first = (e.errors || [])[0];
      p.errorMsg = first
        ? `${first.message}${first.extra_info?.input_name ? ` (${first.extra_info.input_name})` : ''}`
        : 'invalid';
      p.dirty();
    }
  }

  reportQueueError(e) {
    this.lastError = String(e.message || e);
    if (e.nodeErrors) this.setNodeErrors(e.nodeErrors);
    this.flash('⚠ QUEUE REJECTED');
    this.corePanel?.dirty();
  }

  clearErrors() {
    if (!this.lastError && ![...this.panels.values()].some(p => p.errorMsg)) return;
    this.lastError = null;
    for (const p of this.panels.values()) if (p.errorMsg) { p.errorMsg = null; p.dirty(); }
    this.corePanel?.dirty();
  }

  // ---------- edits ----------
  onEdited(node) {
    // touching an errored node clears its red state: the edit is the retry
    const p = this.panels.get(node.id);
    if (p?.errorMsg) { p.errorMsg = null; p.dirty(); }
    this.opts.onEdit?.(this, node);
  }

  reseed() { randomizeSeeds(this.graph); for (const p of this.panels.values()) p.dirty(); this.opts.audio?.toggle(true); }

  // A queued prompt used the current seeds; move the widgets on per their
  // control_after_generate so the next queue is a fresh execution.
  afterQueued() {
    if (applySeedControls(this.graph)) for (const p of this.panels.values()) p.dirty();
  }

  // Transient message on the core panel and sigil readouts (visible in XR,
  // where the DOM hint line does not exist).
  flash(msg, ms = 3500) {
    this.flashMsg = msg;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this.flashMsg = null; this.corePanel?.dirty(); this.sigil?.dirty(); }, ms);
    this.corePanel?.dirty(); this.sigil?.dirty();
  }

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

// Placard for a 3D output: wireframe-diamond glyph + format + filename.
function assetPlacard(asset) {
  const c = document.createElement('canvas');
  c.width = c.height = 400;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(159,232,220,0.8)';
  g.lineWidth = 3;
  g.strokeRect(4, 4, 392, 392);
  g.save();
  g.translate(200, 170);
  g.strokeStyle = 'rgba(159,232,220,0.9)';
  g.lineWidth = 2.5;
  // isometric-ish cube
  const p = [[-70, -20], [0, -60], [70, -20], [70, 55], [0, 95], [-70, 55], [0, 15]];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [2, 6], [6, 4]];
  for (const [a, b] of edges) {
    g.beginPath(); g.moveTo(p[a][0], p[a][1]); g.lineTo(p[b][0], p[b][1]); g.stroke();
  }
  g.restore();
  const ext = (asset.filename.split('.').pop() || '').toUpperCase();
  g.fillStyle = 'rgba(191,255,244,0.95)';
  g.font = 'bold 44px Consolas, monospace';
  g.textAlign = 'center';
  g.fillText(ext, 200, 320);
  g.font = '16px Consolas, monospace';
  g.fillStyle = 'rgba(159,232,220,0.7)';
  const name = asset.filename.length > 34 ? asset.filename.slice(0, 33) + '…' : asset.filename;
  g.fillText(name, 200, 356);
  g.font = '14px Consolas, monospace';
  g.fillStyle = 'rgba(159,232,220,0.5)';
  g.fillText('◈ materialize', 200, 384);
  return c;
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
