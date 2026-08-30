// agent.js — the J0 bridge executor. The server relays tool calls here over
// a websocket; the live page answers them, because the space is the source
// of truth for spatial state. Every mutating tool goes through the same code
// paths as a pinch, so the user watches the agent work.
import { HOSTED, LOCAL } from './comfy.js';

// say() is hard-capped: the holodeck register is enforced by the tool, not
// by hoping the model stays brief.
const SAY_MAX = 220;

export function initAgent(ctx) {
  const { hubs, wfIndex, client, openWorkflow, flashHint, audio } = ctx;

  // push-to-talk utterances queue here until the harness drains them with
  // listen(); the page never interprets speech, it only carries it
  const heard = [];

  function findHub(name) {
    if (!name) {
      const open = hubs();
      if (open.length === 1) return open[0];
      throw new Error('which workflow? pass name; open: ' + open.map(h => h.name).join(', '));
    }
    const n = String(name).toLowerCase();
    const h = hubs().find(x => x.name.toLowerCase() === n)
      || hubs().find(x => x.name.toLowerCase().includes(n));
    if (!h) throw new Error(`no open workflow matching "${name}"; open: ` + hubs().map(x => x.name).join(', '));
    return h;
  }
  function findNode(hub, nodeId) {
    const node = hub.graph.nodes.get(Number(nodeId)) || hub.graph.nodes.get(String(nodeId));
    if (!node) throw new Error(`no node ${nodeId} in ${hub.name}`);
    return node;
  }
  const trim = (v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 77) + '…' : v);

  const tools = {
    __list__: () => Object.keys(tools).filter(k => k !== '__list__'),

    space_state: () => ({
      mode: client.mode,
      backend: client.backend || null,
      queued: client.queueRemaining || 0,
      workflows: hubs().map(h => ({
        name: h.name, status: h.status,
        nodes: h.graph.nodes.size, gallery: h.gallery.length,
        error: h.lastError || null,
      })),
    }),

    list_workflows: () => wfIndex().map(w => ({ name: w.name, source: w.source, open: hubs().some(h => h.name === w.name) })),

    describe_workflow: ({ workflow }) => {
      const h = findHub(workflow);
      const byType = {};
      for (const L of h.graph.links.values()) byType[L.type] = (byType[L.type] || 0) + 1;
      return {
        name: h.name, status: h.status,
        nodes: [...h.graph.nodes.values()].map(n => ({
          id: n.id, type: n.type, title: n.title,
          widgets: Object.fromEntries(n.widgets.map(w => [w.name, trim(w.value)])),
        })),
        links: byType,
      };
    },

    read_node: ({ workflow, nodeId }) => {
      const h = findHub(workflow);
      const n = findNode(h, nodeId);
      const panel = h.panels.get(n.id);
      return {
        id: n.id, type: n.type, title: n.title,
        widgets: n.widgets.map(w => ({ name: w.name, value: w.value, type: w.wtype, options: w.options?.slice(0, 40) })),
        inputs: n.linkInputs.map(li => ({ name: li.name, type: li.type, connected: li.link != null })),
        error: panel?.errorMsg || null,
      };
    },

    read_errors: ({ workflow }) => {
      const h = findHub(workflow);
      return {
        core: h.lastError || null,
        nodes: [...h.panels].map(([id, p]) => (p.errorMsg
          ? { id, title: h.graph.nodes.get(id)?.title, error: p.errorMsg } : null)).filter(Boolean),
      };
    },

    gallery: ({ workflow }) => {
      const h = findHub(workflow);
      return h.gallery.map(g => ({
        kind: g.video ? 'video' : g.audioEl ? 'audio' : g.asset ? '3d' : 'image',
        file: g.asset?.filename,
        meta: g.meta || null,
      }));
    },

    open_workflow: async ({ name }) => {
      const n = String(name || '').toLowerCase();
      const already = hubs().find(h => h.name.toLowerCase().includes(n));
      if (already) return { open: already.name, already: true };
      const w = wfIndex().find(x => x.name.toLowerCase() === n)
        || wfIndex().find(x => x.name.toLowerCase().includes(n));
      if (!w) throw new Error(`no workflow matching "${name}"`);
      await openWorkflow(w);
      return { open: w.name, already: false };
    },

    // the agent's pointing finger: panel glow when the bowl is unfolded,
    // beacon burst plus a sigil flash when the hub is folded on the horizon
    highlight: ({ workflow, nodeId }) => {
      const h = findHub(workflow);
      if (nodeId == null) { h.beaconBurst = 1; return { highlighted: h.name }; }
      const n = findNode(h, nodeId);
      const p = h.panels.get(n.id);
      if (p) { p.active = 1.6; p.dirty(); }
      else { h.beaconBurst = 1; h.flash('◈ ' + n.title); }
      audio.tick();
      return { highlighted: n.title, folded: !p };
    },

    // the graph is the truth and panels are views: mutations work whether
    // the hub is unfolded or a sigil on the horizon
    set_widget: ({ workflow, nodeId, widget, value }) => {
      const h = findHub(workflow);
      const n = findNode(h, nodeId);
      const wg = n.widgets.find(w => w.name === widget);
      if (!wg) throw new Error(`node ${nodeId} has no widget "${widget}"; has: ` + n.widgets.map(w => w.name).join(', '));
      if (wg.wtype === 'combo' && wg.options?.length && !wg.options.includes(value)) {
        throw new Error(`"${value}" is not an option; near: ` + wg.options.slice(0, 8).join(', '));
      }
      const v = typeof wg.value === 'number' ? Number(value) : wg.wtype === 'toggle' ? !!value : value;
      if (typeof wg.value === 'number' && !Number.isFinite(v)) throw new Error(`"${value}" is not a number`);
      wg.value = v;
      delete wg.substituted;
      h.onEdited(n);
      if (wg.imageInput) h.refreshInputImage(n);
      const p = h.panels.get(n.id);
      if (p) { p.active = 1.2; p.dirty(); }
      audio.tick();
      return { node: n.title, widget, value: v, folded: !p };
    },

    listen: () => heard.splice(0, heard.length),

    say: async ({ text }) => {
      const t = String(text || '').trim();
      if (!t) throw new Error('nothing to say');
      if (t.length > SAY_MAX) {
        throw new Error(`too long for the ear (${t.length} > ${SAY_MAX} chars): speak the summary, put detail on a panel`);
      }
      const r = await fetch(LOCAL + '/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: t }),
      });
      if (!r.ok) {
        let msg = 'tts ' + r.status;
        try { msg = (await r.json()).error || msg; } catch (e) { /* not json */ }
        throw new Error(msg);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      el.addEventListener('ended', () => URL.revokeObjectURL(url));
      await el.play();
      flashHint('◉ ' + t);
      return { spoke: t.length };
    },
  };

  let ws = null;
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
    + (HOSTED ? '/comfyvr/local/agent' : '/local/agent');
  function connect() {
    try { ws = new WebSocket(wsUrl); } catch (e) { setTimeout(connect, 5000); return; }
    ws.onmessage = async (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      let res;
      try {
        const fn = tools[d.tool];
        if (!fn) throw new Error(`unknown tool "${d.tool}"; tools: ` + tools.__list__().join(', '));
        res = { id: d.id, ok: true, result: await fn(d.args || {}) };
      } catch (e) {
        res = { id: d.id, ok: false, error: String(e.message || e) };
      }
      try { ws.send(JSON.stringify(res)); } catch (e) { /* link died mid-answer */ }
    };
    ws.onclose = () => setTimeout(connect, 5000);   // hosted mode 404s until ComfyUI restarts; stay quiet
    ws.onerror = () => {};
  }
  connect();

  return {
    hear: (text) => { heard.push({ at: new Date().toISOString(), text: String(text) }); },
  };
}
