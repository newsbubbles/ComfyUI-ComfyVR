// comfy.js — one client, two moods. LIVE talks to ComfyUI through the
// server's /api + /ws proxy; DEMO fabricates the same events from a
// topological walk so the space works cold. Events route to hubs by
// prompt_id.
import { BUILTIN_SCHEMA, schemaFromObjectInfo, topoLayers } from './graph.js';

// Two deployments, one frontend:
// - standalone: server.py serves us at / and proxies /api + /ws to ComfyUI
// - hosted: the ComfyUI-ComfyVR custom node serves us at /comfyvr/ on
//   ComfyUI's own server — same origin, no proxy, /api and /ws are real
export const HOSTED = location.pathname.startsWith('/comfyvr');
export const API = '/api';
export const LOCAL = HOSTED ? '/comfyvr/local' : '/local';

// 3D outputs (meshes, splats) hide in output dicts under pack-specific
// keys; detect them by extension anywhere in the arrays.
export const MESH_EXT = /\.(glb|gltf|obj|ply|splat)$/i;
export function scanOutputsForAssets(output) {
  const found = [];
  for (const val of Object.values(output || {})) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      const f = typeof item === 'string' ? item : item?.filename;
      if (typeof f === 'string' && MESH_EXT.test(f)) {
        found.push(typeof item === 'string'
          ? { filename: f, subfolder: '', type: 'output' }
          : { filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
      }
    }
  }
  return found;
}

export class ComfyClient {
  constructor() {
    this.mode = 'demo';
    this.clientId = 'comfyvr-' + Math.random().toString(36).slice(2, 10);
    this.objectInfo = null;
    this.prompts = new Map();      // prompt_id -> hub
    this.currentPrompt = null;     // prompt_id currently executing (ws "executing" lacks it on some events)
    this.onModeChange = null;
  }

  async detect() {
    try {
      if (HOSTED) {
        // served by ComfyUI itself: alive by definition, but confirm cheaply
        const r = await fetch(API + '/prompt');
        if (r.ok) { this.backend = location.origin; this.mode = 'live'; this.openSocket(); }
      } else {
        const h = await (await fetch('/health')).json();
        this.backend = h.backend;
        if (h.live) { this.mode = 'live'; this.openSocket(); }
      }
    } catch (e) {
      this.mode = 'demo';
    }
    this.onModeChange?.(this.mode);
    return this.mode;
  }

  // Schema for a set of node types: object_info when live, builtins beneath.
  async schemaFor(types) {
    let live = {};
    if (this.mode === 'live') {
      try {
        if (!this.objectInfo) this.objectInfo = await (await fetch(API + '/object_info')).json();
        live = schemaFromObjectInfo(this.objectInfo, types);
      } catch (e) {
        console.warn('object_info failed, using builtins', e);
      }
    }
    return { ...BUILTIN_SCHEMA, ...live };
  }

  async listLocalWorkflows() {
    return await (await fetch(LOCAL + '/workflows')).json();
  }

  // Workflows the user saved in the ComfyUI frontend (server-side userdata).
  async listUserdataWorkflows() {
    if (this.mode !== 'live') return [];
    try {
      const r = await fetch(API + '/userdata?dir=workflows&recurse=true&split=false');
      if (!r.ok) return [];
      const files = await r.json();
      return files
        .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.json'))
        .map(f => ({ name: f.replace(/\.json$/i, ''), path: 'workflows/' + f }));
    } catch (e) { return []; }
  }

  async loadUserdataWorkflow(path) {
    const r = await fetch(API + '/userdata/' + encodeURIComponent(path));
    if (!r.ok) throw new Error('userdata ' + r.status);
    return await r.json();
  }

  async loadLocalWorkflow(name) {
    return await (await fetch(LOCAL + '/workflows/' + encodeURIComponent(name))).json();
  }

  async saveLocalWorkflow(name, json) {
    const r = await fetch(LOCAL + '/workflows/' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json),
    });
    return r.ok;
  }

  async history(maxItems = 64) {
    if (this.mode !== 'live') return {};
    try {
      const r = await fetch(API + '/history?max_items=' + maxItems);
      return r.ok ? await r.json() : {};
    } catch (e) { return {}; }
  }

  async imageBitmap(im) {
    const url = `${API}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${im.type}`;
    return await createImageBitmap(await (await fetch(url)).blob());
  }

  // ---------- live path ----------
  openSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${this.clientId}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.onWsMessage(ev);
    this.ws.onclose = () => {
      if (this.mode === 'live') setTimeout(() => this.openSocket(), 3000);
    };
  }

  hubFor(promptId) { return this.prompts.get(promptId || this.currentPrompt); }

  async onWsMessage(ev) {
    if (typeof ev.data !== 'string') {
      // Binary preview frame: [u32 event][u32 imgType][jpeg/png bytes]
      const view = new DataView(ev.data);
      if (view.getUint32(0) !== 1) return;
      const blob = new Blob([ev.data.slice(8)], { type: view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg' });
      const bm = await createImageBitmap(blob);
      this.hubFor(null)?.onPreview(bm);
      return;
    }
    const msg = JSON.parse(ev.data);
    const d = msg.data || {};
    const hub = this.hubFor(d.prompt_id);
    switch (msg.type) {
      case 'execution_start':
        this.currentPrompt = d.prompt_id;
        this.hubFor(d.prompt_id)?.onStatus('running');
        break;
      case 'executing':
        if (d.node === null) { hub?.onExecuting(null); }
        else hub?.onExecuting(d.node);
        break;
      case 'progress':
        hub?.onProgress(d.value, d.max);
        break;
      case 'executed': {
        if (!hub) break;
        const imgs = (d.output && d.output.images) || [];
        const bitmaps = [];
        for (const im of imgs.slice(0, 4)) {
          try { bitmaps.push(await this.imageBitmap(im)); }
          catch (e) { console.warn('view fetch failed', e); }
        }
        hub.onExecuted(d.node, bitmaps, scanOutputsForAssets(d.output));
        break;
      }
      case 'execution_success':
      case 'execution_error':
      case 'execution_interrupted':
        if (msg.type === 'execution_error') hub?.onExecError(d);
        hub?.onStatus(msg.type === 'execution_success' ? 'done' : 'error');
        if (d.prompt_id) this.prompts.delete(d.prompt_id);
        break;
      case 'status':
        this.queueRemaining = d.status?.exec_info?.queue_remaining ?? this.queueRemaining ?? 0;
        this.onQueueCount?.(this.queueRemaining);
        break;
    }
  }

  async queue(hub) {
    if (this.mode !== 'live') return this.demoRun(hub);
    // extra_pnginfo makes the outputs self-describing: every image saved
    // through comfyvr embeds its workflow, so it can accrete back later
    const body = {
      prompt: hub.apiPrompt(),
      client_id: this.clientId,
      extra_data: { extra_pnginfo: { workflow: hub.rawWorkflow() } },
    };
    const r = await fetch(API + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.prompt_id) {
      this.prompts.set(j.prompt_id, hub);
      hub.onStatus('queued');
      return j.prompt_id;
    }
    // Rejection carries the real story: error.message plus node_errors
    // keyed by node id. Throw it all so the caller can light up panels.
    console.warn('queue rejected', j);
    const err = new Error(j.error?.message || `queue rejected (HTTP ${r.status})`);
    err.nodeErrors = j.node_errors || null;
    throw err;
  }

  // ---------- demo path: same events, fabricated ----------
  async demoRun(hub) {
    if (hub.status === 'running') return;
    hub.onStatus('running');
    const { layers } = topoLayers(hub.graph);
    const order = layers.flat();
    for (const id of order) {
      const node = hub.graph.nodes.get(id);
      hub.onExecuting(id);
      if (node.type.includes('KSampler')) {
        const steps = Number(node.widgets.find(w => w.name === 'steps')?.value || 20);
        for (let s = 1; s <= steps; s++) {
          hub.onProgress(s, steps);
          await sleep(2600 / steps);
        }
      } else {
        await sleep(220 + Math.random() * 260);
      }
      const bitmaps = node.hasImage && node.type !== 'LoadImage' ? [demoImage(hub, node)] : [];
      hub.onExecuted(id, bitmaps);
    }
    hub.onExecuting(null);
    hub.onStatus('done');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A procedural "generation": seeded gradient nebula + glyph, substrate-grade.
export function demoImage(hub, node) {
  const seed = Number(hub.graph.nodes.values().next().value?.widgets?.[0]?.value) || 1;
  const rng = mulberry32((hashy(hub.name) ^ seed ^ (Date.now() & 0xffff)) >>> 0);
  const c = document.createElement('canvas');
  c.width = c.height = 384;
  const g = c.getContext('2d');
  const hue = Math.floor(rng() * 360);
  const grad = g.createLinearGradient(0, 0, 384, 384);
  grad.addColorStop(0, `hsl(${hue},70%,12%)`);
  grad.addColorStop(1, `hsl(${(hue + 80) % 360},80%,22%)`);
  g.fillStyle = grad; g.fillRect(0, 0, 384, 384);
  for (let i = 0; i < 26; i++) {
    const x = rng() * 384, y = rng() * 384, r = 20 + rng() * 130;
    const bl = g.createRadialGradient(x, y, 0, x, y, r);
    bl.addColorStop(0, `hsla(${(hue + rng() * 120) | 0},90%,${40 + rng() * 30}%,${0.08 + rng() * 0.14})`);
    bl.addColorStop(1, 'transparent');
    g.fillStyle = bl;
    g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.6})`;
    g.fillRect(rng() * 384, rng() * 384, rng() < 0.9 ? 1 : 2, rng() < 0.9 ? 1 : 2);
  }
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = '20px Consolas, monospace';
  g.fillText('DEMO ' + (seed % 100000), 12, 372);
  return c;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashy(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h >>> 0; }
