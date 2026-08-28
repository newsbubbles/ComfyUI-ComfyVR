// graph.js — litegraph workflow JSON as the single source of truth.
// Parses it into a live structure panels can render and edit, derives the
// concentric-ring layout (topological depth), and converts back out to
// ComfyUI API format for /prompt.

// litegraph's canonical link-type colors, neonized for additive rendering.
export const LINK_COLORS = {
  MODEL: '#c5a3ff',
  CLIP: '#ffd54a',
  VAE: '#ff7a7a',
  CONDITIONING: '#ffb04a',
  LATENT: '#ff9cf9',
  IMAGE: '#6ec6ff',
  MASK: '#8ce99a',
  INT: '#9fb4c0',
  FLOAT: '#9fb4c0',
  STRING: '#9fb4c0',
};
// Unknown (custom-node) link types get a stable hashed hue instead of the
// fallback teal, so e.g. NEURO_* wires read as their own color family.
export function colorForType(t) {
  if (LINK_COLORS[t]) return LINK_COLORS[t];
  if (!t || t === '*') return '#7ce8dc';
  let h = 0;
  for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return hueHex(Math.abs(h) % 360);
}

function hueHex(hue) {
  const s = 0.7, l = 0.68;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const CONTROL_VALUES = ['fixed', 'increment', 'decrement', 'randomize'];
const SEED_NAMES = ['seed', 'noise_seed'];

// Minimal schemas for the standard nodes so DEMO mode (no /object_info)
// still renders real widgets. Shape matches what schemaFromObjectInfo emits.
// inputs are ordered: link inputs and widgets interleaved exactly as the
// node declares them, because widgets_values matches by declaration order.
export const BUILTIN_SCHEMA = {
  CheckpointLoaderSimple: {
    display: 'Load Checkpoint',
    inputs: [w('ckpt_name', 'combo', { options: ['sd_xl_base_1.0.safetensors', 'dreamshaper_8.safetensors'] })],
    outputs: ['MODEL', 'CLIP', 'VAE'],
  },
  LoraLoader: {
    display: 'Load LoRA',
    inputs: [
      l('model', 'MODEL'), l('clip', 'CLIP'),
      w('lora_name', 'combo', { options: ['add_detail.safetensors'] }),
      w('strength_model', 'float', { min: -4, max: 4, step: 0.05 }),
      w('strength_clip', 'float', { min: -4, max: 4, step: 0.05 }),
    ],
    outputs: ['MODEL', 'CLIP'],
  },
  CLIPTextEncode: {
    display: 'CLIP Text Encode',
    inputs: [l('clip', 'CLIP'), w('text', 'text', {})],
    outputs: ['CONDITIONING'],
  },
  EmptyLatentImage: {
    display: 'Empty Latent',
    inputs: [
      w('width', 'int', { min: 64, max: 4096, step: 64 }),
      w('height', 'int', { min: 64, max: 4096, step: 64 }),
      w('batch_size', 'int', { min: 1, max: 16, step: 1 }),
    ],
    outputs: ['LATENT'],
  },
  KSampler: {
    display: 'KSampler',
    inputs: [
      l('model', 'MODEL'), l('positive', 'CONDITIONING'), l('negative', 'CONDITIONING'), l('latent_image', 'LATENT'),
      w('seed', 'seed', {}),
      w('steps', 'int', { min: 1, max: 100, step: 1 }),
      w('cfg', 'float', { min: 0, max: 30, step: 0.1 }),
      w('sampler_name', 'combo', { options: ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc'] }),
      w('scheduler', 'combo', { options: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple'] }),
      w('denoise', 'float', { min: 0, max: 1, step: 0.01 }),
    ],
    outputs: ['LATENT'],
  },
  LatentUpscale: {
    display: 'Latent Upscale',
    inputs: [
      l('samples', 'LATENT'),
      w('upscale_method', 'combo', { options: ['nearest-exact', 'bilinear', 'area', 'bicubic', 'bislerp'] }),
      w('width', 'int', { min: 64, max: 8192, step: 64 }),
      w('height', 'int', { min: 64, max: 8192, step: 64 }),
      w('crop', 'combo', { options: ['disabled', 'center'] }),
    ],
    outputs: ['LATENT'],
  },
  VAEDecode: { display: 'VAE Decode', inputs: [l('samples', 'LATENT'), l('vae', 'VAE')], outputs: ['IMAGE'] },
  VAEEncode: { display: 'VAE Encode', inputs: [l('pixels', 'IMAGE'), l('vae', 'VAE')], outputs: ['LATENT'] },
  SaveImage: { display: 'Save Image', inputs: [l('images', 'IMAGE'), w('filename_prefix', 'text', { oneline: true })], outputs: [], hasImage: true },
  PreviewImage: { display: 'Preview Image', inputs: [l('images', 'IMAGE')], outputs: [], hasImage: true },
  LoadImage: {
    display: 'Load Image',
    inputs: [w('image', 'combo', { options: ['example.png'], imageInput: true })],
    outputs: ['IMAGE', 'MASK'],
    hasImage: true,
  },
};

function w(name, wtype, cfg) { return { name, kind: 'widget', wtype, ...cfg }; }
function l(name, type) { return { name, kind: 'link', type }; }

// Convert /object_info entries into the schema shape above, only for the
// node types we actually need (object_info can be megabytes).
export function schemaFromObjectInfo(objectInfo, types) {
  const out = {};
  for (const t of types) {
    const info = objectInfo[t];
    if (!info) continue;
    const inputs = [];
    for (const section of ['required', 'optional']) {
      const sec = (info.input || {})[section];
      if (!sec) continue;
      for (const [name, spec] of Object.entries(sec)) {
        const [ts, cfg] = Array.isArray(spec) ? [spec[0], spec[1] || {}] : [spec, {}];
        // forceInput: a widget-typed input the frontend renders as a link
        // socket instead. It has NO widgets_values entry, so treating it as
        // a widget consumes a stored value and shifts every value after it
        // (weight_decay suddenly holds "adam"). Must be a link input here.
        if (cfg.forceInput || cfg.defaultInput) {
          inputs.push(l(name, Array.isArray(ts) ? 'COMBO' : ts));
          continue;
        }
        if (Array.isArray(ts)) {
          // image_upload combos (LoadImage and friends) pick files from the
          // input dir; panels preview them via /view?type=input
          inputs.push(w(name, 'combo', { options: ts, imageInput: !!cfg.image_upload }));
        } else if (ts === 'COMBO' || Array.isArray(cfg.options)) {
          // New-style combo (V3 schema): type "COMBO" with options in the
          // config. Missing this turns the combo into a phantom link input,
          // which drops it from the widget list and shifts every stored
          // value after it into the wrong slot.
          inputs.push(w(name, 'combo', { options: cfg.options || [], imageInput: !!cfg.image_upload }));
        } else if (ts === 'INT') {
          const seed = SEED_NAMES.includes(name) || cfg.control_after_generate;
          inputs.push(w(name, seed ? 'seed' : 'int', { min: cfg.min ?? 0, max: Math.min(cfg.max ?? 1e9, 1e9), step: cfg.step ?? 1 }));
        } else if (ts === 'FLOAT') {
          inputs.push(w(name, 'float', { min: cfg.min ?? 0, max: Math.min(cfg.max ?? 100, 1e6), step: cfg.step ?? 0.01 }));
        } else if (ts === 'STRING') {
          inputs.push(w(name, 'text', { oneline: !cfg.multiline }));
        } else if (ts === 'BOOLEAN') {
          inputs.push(w(name, 'toggle', {}));
        } else if (typeof ts === 'string' && ts.includes('AUTOGROW')) {
          // V3 dynamic input group: the workflow node carries the real
          // sockets as dotted names (outputs.output0, outputs.output1, ...)
          inputs.push({ name, kind: 'autogrow' });
        } else {
          inputs.push(l(name, ts));
        }
      }
    }
    out[t] = {
      display: info.display_name || t,
      inputs,
      outputs: (info.output || []).map(o => (Array.isArray(o) ? 'COMBO' : o)),
      hasImage: !!(info.output_node && /image/i.test(t)) || t === 'LoadImage',
      liveOptions: true,  // combo options came from the running server, safe to snap against
      aliases: info.search_aliases || [],   // same keys the stock search fuzzes over
      category: info.category || '',
    };
  }
  return out;
}

// Parse a litegraph workflow into {nodes: Map, links: Map, order: [...]}.
// Each node: {id, type, title, schema, widgets:[{name,wtype,value,...}],
// linkInputs:[{name,type,link}], outputs:[{name,type,links:[...]}]}.
export function parseWorkflow(json, schema) {
  const nodes = new Map();
  const links = new Map();
  // Subgraphs / group nodes: legacy "workflow/Name" types, or (new-style)
  // node types that reference json.definitions.subgraphs entries. We render
  // them honestly but cannot queue them (the stock frontend flattens them
  // before submitting; we don't — yet).
  const subgraphIds = new Set(((json.definitions || {}).subgraphs || []).map(s => String(s.id)));
  const isSubgraph = (t) => typeof t === 'string' && (t.startsWith('workflow/') || t.startsWith('workflow>') || subgraphIds.has(t));
  for (const L of json.links || []) {
    links.set(L[0], { id: L[0], src: L[1], srcSlot: L[2], dst: L[3], dstSlot: L[4], type: L[5] });
  }
  for (const n of json.nodes || []) {
    const sub = isSubgraph(n.type);
    const sc = sub ? null : schema[n.type];
    const stored = Array.isArray(n.widgets_values) ? n.widgets_values.slice() : [];
    const widgets = [];
    const linkInputs = [];
    if (sc) {
      let vi = 0;
      // New-format nodes list every widget as an input entry carrying a
      // `widget` key, in the node's own order. When that order accounts for
      // every stored value, match values BY NAME: workflows saved against an
      // older node definition (a widget added or reordered since) would
      // otherwise shift every value after the change into the wrong slot.
      const declaredW = (n.inputs || []).filter(i => i.widget).map(i => i.name);
      const byName = declaredW.length && declaredW.length === stored.length
        ? new Map(declaredW.map((nm, i) => [nm, stored[i]])) : null;
      for (const inp of sc.inputs) {
        if (inp.kind === 'autogrow') {
          for (const i of n.inputs || []) {
            if (i.name === inp.name || i.name.startsWith(inp.name + '.')) {
              linkInputs.push({ name: i.name, type: i.type || '*', link: i.link ?? null });
            }
          }
        } else if (inp.kind === 'link') {
          const declared = (n.inputs || []).find(i => i.name === inp.name);
          linkInputs.push({ name: inp.name, type: inp.type, link: declared ? declared.link : null });
        } else if (byName) {
          const widget = { ...inp, value: byName.has(inp.name) ? byName.get(inp.name) : defaultFor(inp) };
          if (sc.liveOptions && inp.wtype === 'combo' && Array.isArray(inp.options) && inp.options.length
              && !inp.options.includes(widget.value)) {
            widget.value = inp.options[0];
            widget.substituted = true;
          }
          widgets.push(widget);
        } else {
          const widget = { ...inp, value: vi < stored.length ? stored[vi] : defaultFor(inp) };
          vi++;
          // A stored combo value the server no longer offers (someone else's
          // checkpoint names, a deleted input file) would fail /prompt
          // validation. Snap to the first real option and mark it, but only
          // against options that came from a live object_info.
          if (sc.liveOptions && inp.wtype === 'combo' && Array.isArray(inp.options) && inp.options.length
              && !inp.options.includes(widget.value)) {
            widget.value = inp.options[0];
            widget.substituted = true;
          }
          widgets.push(widget);
          if (inp.wtype === 'seed' && vi < stored.length && CONTROL_VALUES.includes(stored[vi])) {
            widgets.push({ name: 'control_after_generate', kind: 'widget', wtype: 'combo', options: CONTROL_VALUES, value: stored[vi], skipApi: true });
            vi++;
          }
        }
      }
    } else if (n.type === 'Note' || n.type === 'MarkdownNote') {
      // Notes are frontend-only decoration; the body is widgets_values[0].
      // Render the whole thing, not a clipped readout.
      widgets.push({ name: n.type === 'MarkdownNote' ? 'markdown' : 'note', kind: 'widget', wtype: 'note', value: String(stored[0] ?? '') });
    } else {
      // Unknown node type: render link inputs from the workflow itself and
      // widgets as opaque readouts. Still explorable, not editable.
      for (const i of n.inputs || []) linkInputs.push({ name: i.name, type: i.type, link: i.link });
      stored.forEach((v, k) => widgets.push({ name: 'value ' + k, kind: 'widget', wtype: 'opaque', value: v }));
    }
    // Converted widgets: litegraph can move a widget to a link input (seed
    // fed by a primitive, etc.) — the input entry carries a `widget` key.
    // The widget keeps its stored value; the link must render and win at
    // queue time (toApiFormat writes links after widget values).
    for (const i of n.inputs || []) {
      if (!i.widget) continue;
      if (!linkInputs.some(li => li.name === i.name)) {
        linkInputs.push({ name: i.name, type: i.type, link: i.link ?? null, converted: true });
      }
    }
    const outputs = (n.outputs || []).map(o => ({ name: o.name, type: o.type, links: (o.links || []).filter(id => links.has(id)) }));
    const declaredOrder = sc && (n.inputs || []).some(i => i.widget)
      ? (n.inputs || []).filter(i => i.widget).map(i => i.name) : null;
    nodes.set(n.id, {
      id: n.id, type: n.type,
      title: n.title || (sc ? sc.display : (sub ? '⌬ subgraph' : n.type)),
      schema: sc || null, widgets, linkInputs, outputs,
      // widget order the FILE declares; saves must respect it, not schema order
      widgetOrder: declaredOrder && declaredOrder.length === stored.length ? declaredOrder : null,
      hasImage: !!(sc && sc.hasImage),
      subgraph: sub,
    });
  }
  // Drop links whose endpoints are missing (defensive against hand edits).
  for (const [id, L] of [...links]) {
    if (!nodes.has(L.src) || !nodes.has(L.dst)) links.delete(id);
  }
  return { nodes, links, raw: json };
}

function defaultFor(inp) {
  if (inp.wtype === 'combo') return (inp.options || [''])[0];
  if (inp.wtype === 'text') return '';
  if (inp.wtype === 'toggle') return false;
  return inp.min ?? 0;
}

// Longest-path depth from source nodes -> concentric ring index.
export function topoLayers(graph) {
  const depth = new Map();
  const indeg = new Map();
  for (const id of graph.nodes.keys()) { depth.set(id, 0); indeg.set(id, 0); }
  for (const L of graph.links.values()) indeg.set(L.dst, indeg.get(L.dst) + 1);
  const queue = [...graph.nodes.keys()].filter(id => indeg.get(id) === 0);
  const seen = [];
  while (queue.length) {
    const id = queue.shift();
    seen.push(id);
    for (const L of graph.links.values()) {
      if (L.src !== id) continue;
      depth.set(L.dst, Math.max(depth.get(L.dst), depth.get(id) + 1));
      indeg.set(L.dst, indeg.get(L.dst) - 1);
      if (indeg.get(L.dst) === 0) queue.push(L.dst);
    }
  }
  // Cycles (shouldn't exist in Comfy graphs) fall into layer of last resort.
  const maxd = Math.max(0, ...depth.values());
  for (const id of graph.nodes.keys()) if (!seen.includes(id)) depth.set(id, maxd);
  const layers = [];
  for (const [id, d] of depth) {
    (layers[d] = layers[d] || []).push(id);
  }
  // Angle placement: sources spread evenly, deeper nodes at the mean angle
  // of their upstream nodes (reduces beam crossings), nudged apart.
  const angle = new Map();
  (layers[0] || []).forEach((id, i) => angle.set(id, (i / layers[0].length) * Math.PI * 2));
  for (let d = 1; d < layers.length; d++) {
    for (const id of layers[d] || []) {
      const ups = [...graph.links.values()].filter(L => L.dst === id).map(L => angle.get(L.src) ?? 0);
      let a = 0;
      if (ups.length) {
        // Circular mean, so angles near 0/2pi average correctly.
        const sx = ups.reduce((s, u) => s + Math.cos(u), 0), sy = ups.reduce((s, u) => s + Math.sin(u), 0);
        a = Math.atan2(sy, sx);
      }
      angle.set(id, a);
    }
    // Spread same-ring collisions.
    const ring = (layers[d] || []).slice().sort((x, y) => angle.get(x) - angle.get(y));
    const minGap = (Math.PI * 2) / Math.max(ring.length, 6);
    for (let i = 1; i < ring.length; i++) {
      const prev = angle.get(ring[i - 1]), cur = angle.get(ring[i]);
      if (cur - prev < minGap) angle.set(ring[i], prev + minGap);
    }
  }
  return { depth, layers, angle };
}

// Serialize the live structure back into the raw litegraph JSON: widget
// values, wiring, and node membership. 3D layout overrides live in
// raw.extra.comfyvr.layout (vanilla ComfyUI preserves unknown extra keys).
export function syncToRaw(graph) {
  for (const n of graph.raw.nodes || []) {
    const live = graph.nodes.get(n.id);
    if (!live) continue;
    if (live.schema) {
      n.widgets_values = live.widgetOrder
        ? live.widgetOrder.map((nm, i) => {
            const wg = live.widgets.find(x => x.name === nm);
            return wg ? wg.value : (n.widgets_values || [])[i];
          })
        : live.widgets.map(wg => wg.value);
    }
    for (const inp of n.inputs || []) {
      const li = live.linkInputs.find(l => l.name === inp.name);
      if (li) inp.link = li.link;
    }
    (n.outputs || []).forEach((o, i) => { o.links = (live.outputs[i]?.links || []).slice(); });
  }
  graph.raw.links = [...graph.links.values()].map(L => [L.id, L.src, L.srcSlot, L.dst, L.dstSlot, L.type]);
  graph.raw.last_link_id = Math.max(0, ...graph.links.keys());
  graph.raw.last_node_id = Math.max(0, ...graph.nodes.keys());
  return graph.raw;
}

// ------- graph surgery (wiring + node membership) -------
// All of these keep the three views consistent: graph.links, the src node's
// outputs[].links, and the dst node's linkInputs[].link.

export function removeLink(graph, id) {
  const L = graph.links.get(id);
  if (!L) return;
  const src = graph.nodes.get(L.src);
  if (src) {
    const out = src.outputs[L.srcSlot];
    if (out) out.links = out.links.filter(x => x !== id);
  }
  const dst = graph.nodes.get(L.dst);
  if (dst) {
    const inp = dst.linkInputs[L.dstSlot];
    if (inp && inp.link === id) inp.link = null;
  }
  graph.links.delete(id);
}

// New link src.slot -> dst.slot; an input holds one link, so any existing
// link on the destination is removed first. Returns the new link (or null).
export function createLink(graph, srcId, srcSlot, dstId, dstSlot) {
  const src = graph.nodes.get(srcId), dst = graph.nodes.get(dstId);
  if (!src || !dst) return null;
  const type = src.outputs[srcSlot]?.type;
  if (!type || dst.linkInputs[dstSlot]?.type !== type) return null;
  const old = dst.linkInputs[dstSlot].link;
  if (old != null) removeLink(graph, old);
  const id = Math.max(0, ...graph.links.keys(), graph.raw.last_link_id || 0) + 1;
  const L = { id, src: srcId, srcSlot, dst: dstId, dstSlot, type };
  graph.links.set(id, L);
  src.outputs[srcSlot].links.push(id);
  dst.linkInputs[dstSlot].link = id;
  return L;
}

export function retargetLink(graph, id, dstId, dstSlot) {
  const L = graph.links.get(id);
  if (!L) return null;
  const dst = graph.nodes.get(dstId);
  if (!dst || dst.linkInputs[dstSlot]?.type !== L.type) return null;
  if (dstId === L.dst && dstSlot === L.dstSlot) return L;
  const oldDst = graph.nodes.get(L.dst);
  if (oldDst && oldDst.linkInputs[L.dstSlot]?.link === id) oldDst.linkInputs[L.dstSlot].link = null;
  const existing = dst.linkInputs[dstSlot].link;
  if (existing != null) removeLink(graph, existing);
  L.dst = dstId; L.dstSlot = dstSlot;
  dst.linkInputs[dstSlot].link = id;
  return L;
}

// Create a node of `type` in both the live graph and the raw JSON.
export function addNodeToGraph(graph, type, sc) {
  if (!sc) return null;
  const id = Math.max(0, ...graph.nodes.keys(), graph.raw.last_node_id || 0) + 1;
  const widgets = [];
  const linkInputs = [];
  for (const inp of sc.inputs) {
    if (inp.kind === 'autogrow') continue;  // fresh nodes start with no grown slots
    if (inp.kind === 'link') linkInputs.push({ name: inp.name, type: inp.type, link: null });
    else {
      widgets.push({ ...inp, value: defaultFor(inp) });
      if (inp.wtype === 'seed') {
        widgets.push({ name: 'control_after_generate', kind: 'widget', wtype: 'combo', options: CONTROL_VALUES, value: 'randomize', skipApi: true });
      }
    }
  }
  const outputs = sc.outputs.map(t => ({ name: t, type: t, links: [] }));
  const node = { id, type, title: sc.display, schema: sc, widgets, linkInputs, outputs, hasImage: !!sc.hasImage };
  graph.nodes.set(id, node);
  graph.raw.nodes = graph.raw.nodes || [];
  graph.raw.nodes.push({
    id, type, pos: [80 * id, 60 * id], size: [320, 200], flags: {}, order: 0, mode: 0,
    inputs: linkInputs.map(li => ({ name: li.name, type: li.type, link: null })),
    outputs: outputs.map((o, i) => ({ name: o.name, type: o.type, links: [], slot_index: i })),
    properties: { 'Node name for S&R': type },
    widgets_values: widgets.map(w => w.value),
  });
  graph.raw.last_node_id = id;
  return node;
}

// Remove a node and every link touching it, from both the live graph and
// the raw JSON.
export function removeNodeFromGraph(graph, id) {
  const node = graph.nodes.get(id);
  if (!node) return false;
  for (const [lid, L] of [...graph.links]) {
    if (L.src === id || L.dst === id) removeLink(graph, lid);
  }
  graph.nodes.delete(id);
  graph.raw.nodes = (graph.raw.nodes || []).filter(n => n.id !== id);
  return true;
}

// Node types (from a schema map) that can receive an output of `type`.
export function typesAccepting(schema, type, excludeType = null) {
  const out = [];
  for (const [t, sc] of Object.entries(schema)) {
    if (t === excludeType) continue;
    if (sc.inputs.some(i => i.kind === 'link' && i.type === type)) out.push(t);
  }
  return out;
}

// Frontend-only node types: they never reach the server. Reroute is a
// passthrough, PrimitiveNode injects its value into whatever it feeds,
// Notes are decoration.
const FRONTEND_ONLY = new Set(['Reroute', 'Note', 'MarkdownNote', 'PrimitiveNode']);

// Follow a link upstream through Reroute chains to the real producer.
function resolveUpstream(graph, L) {
  let cur = L, guard = 0;
  while (cur && guard++ < 64) {
    const src = graph.nodes.get(cur.src);
    if (!src || src.type !== 'Reroute') return cur;
    const upId = src.linkInputs[0]?.link;
    cur = upId != null ? graph.links.get(upId) : null;
  }
  return null;
}

// ComfyUI API ("prompt") format: {id: {class_type, inputs}}.
export function toApiFormat(graph) {
  const api = {};
  for (const node of graph.nodes.values()) {
    if (FRONTEND_ONLY.has(node.type)) continue;
    if (node.subgraph) throw new Error(`"${node.title}" is a subgraph — comfyvr can't queue those yet (flatten it in ComfyUI first)`);
    if (!node.schema) throw new Error(`no schema for node type ${node.type} — is that custom node installed?`);
    const inputs = {};
    for (const wg of node.widgets) {
      if (wg.skipApi) continue;
      inputs[wg.name] = wg.value;
    }
    for (const li of node.linkInputs) {
      if (li.link == null) continue;
      let L = graph.links.get(li.link);
      if (L) L = resolveUpstream(graph, L);
      if (!L) continue;
      const src = graph.nodes.get(L.src);
      if (src?.type === 'PrimitiveNode') { inputs[li.name] = src.widgets[0]?.value; continue; }
      inputs[li.name] = [String(L.src), L.srcSlot];
    }
    api[String(node.id)] = { class_type: node.type, inputs };
  }
  return api;
}

export function randomizeSeeds(graph) {
  for (const node of graph.nodes.values()) {
    for (const wg of node.widgets) {
      if (wg.wtype === 'seed') wg.value = Math.floor(Math.random() * 1e15);
    }
  }
}

// Apply each seed's control_after_generate once a prompt has been queued
// (the queued run uses the current seed; the widget then moves on). Without
// this, an untouched re-queue is byte-identical and ComfyUI's output cache
// executes nothing.
export function applySeedControls(graph) {
  let changed = false;
  for (const node of graph.nodes.values()) {
    for (let i = 1; i < node.widgets.length; i++) {
      const wg = node.widgets[i];
      if (wg.name !== 'control_after_generate') continue;
      const seed = node.widgets[i - 1];
      if (!seed || seed.wtype !== 'seed') continue;
      if (wg.value === 'randomize') { seed.value = Math.floor(Math.random() * 1e15); changed = true; }
      else if (wg.value === 'increment') { seed.value = (Number(seed.value) || 0) + 1; changed = true; }
      else if (wg.value === 'decrement') { seed.value = Math.max(0, (Number(seed.value) || 0) - 1); changed = true; }
    }
  }
  return changed;
}
