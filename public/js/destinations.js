// destinations.js — where a queue can run. The local backend is implicit;
// a PEER is just an accessible address with the API exposed (no setup, no
// lifecycle: its owner started it with --listen and CORS open); a CLOUD
// destination carries a provider adapter and needs warm-up and lifecycle.
// Kinds differ on setup, never on experience: every destination is a
// ComfyClient with its own websocket, so runs land in the same space in
// parallel with the host's own.
import { ComfyClient, LOCAL } from './comfy.js';
import { getSetting } from './settings.js';

let DESTS = [];
try { DESTS = JSON.parse(localStorage.getItem('cvr-destinations') || '[]'); } catch (e) { /* fresh */ }

// The server's registry.json is the shared truth: localStorage is
// per-origin, and a rig set up on the desktop was invisible from the
// headset origin. localStorage stays as cache and static-demo fallback.
let syncing = false;
function pushRegistry() {
  if (syncing) return;
  fetch(LOCAL + '/registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: DESTS, rigs: RIGS }),
  }).catch(() => {});
}

export async function syncRegistry() {
  try {
    const r = await fetch(LOCAL + '/registry');
    if (!r.ok) return false;
    const d = await r.json();
    syncing = true;
    // server wins by id; local-only entries survive (they push back next save)
    const merge = (local, remote) => {
      const byId = new Map(local.map((x) => [x.id, x]));
      for (const x of remote || []) byId.set(x.id, x);
      return [...byId.values()];
    };
    DESTS = merge(DESTS, d.destinations);
    RIGS = merge(RIGS, d.rigs);
    syncing = false;
    save();
    saveRigs();
    return true;
  } catch (e) { syncing = false; return false; }   // static demo: no server
}

const save = () => {
  try { localStorage.setItem('cvr-destinations', JSON.stringify(DESTS)); } catch (e) { /* private window */ }
  pushRegistry();
};

const clients = new Map();   // dest id -> ComfyClient

export function listDestinations() { return DESTS.slice(); }

export function addPeer(name, url) {
  const id = 'peer-' + name.toLowerCase().replace(/[^\w-]+/g, '-');
  const d = { id, name, kind: 'peer', url: url.replace(/\/+$/, '') };
  DESTS = DESTS.filter(x => x.id !== id).concat(d);
  save();
  return d;
}

export function removeDestination(id) {
  DESTS = DESTS.filter(x => x.id !== id);
  clients.get(id)?.ws?.close?.();
  clients.delete(id);
  save();
}

// An https page cannot fetch a plain-http destination (mixed content):
// the headset path is https, LAN peers and vast pods are http. Register
// the destination with our python side once and ride this origin's
// /relay routes instead; http and the websocket both forward server-side.
async function relayBase(d) {
  const r = await fetch(LOCAL + '/relay/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: d.id, url: d.url }),
  });
  if (!r.ok) throw new Error('relay registration failed (HTTP ' + r.status + ')');
  return location.origin + LOCAL + '/relay/' + d.id;
}

// The already-connected client for a destination id, if any (sync;
// clients are created lazily by the first queue against them).
export function cachedClient(destId) {
  return clients.get(typeof destId === 'string' ? destId : destId?.id) || null;
}

// The client for a destination, connected lazily. null/undefined = the
// primary client the caller already holds (returned as-is for symmetry).
export async function clientFor(dest, primary) {
  if (!dest) return primary;
  const d = typeof dest === 'string' ? DESTS.find(x => x.id === dest) : dest;
  if (!d) throw new Error('no destination ' + dest);
  let c = clients.get(d.id);
  if (!c) {
    const mixed = location.protocol === 'https:' && d.url.startsWith('http://');
    c = new ComfyClient({ base: mixed ? await relayBase(d) : d.url });
    clients.set(d.id, c);
    await c.detect();
  }
  if (c.mode !== 'live') {
    // one more chance: transient boot, or the peer just came up
    await c.detect();
    if (c.mode !== 'live') throw new Error(`${d.name} is not reachable (${d.url})`);
  }
  return c;
}

// ---------- rigs: known-working cloud configs, saved after a run works ----
// A rig is what you'd need to stand the same machine up again: provider,
// GPU tier, image, volume, plus what it has PROVEN (packs/models that ran).
// Rigs are startable before queueing: warm the rig, then work.
let RIGS = [];
try { RIGS = JSON.parse(localStorage.getItem('cvr-rigs') || '[]'); } catch (e) { /* fresh */ }
const saveRigs = () => {
  try { localStorage.setItem('cvr-rigs', JSON.stringify(RIGS)); } catch (e) { /* private window */ }
  pushRegistry();
};

export function listRigs() { return RIGS.slice(); }

export function saveRig(rig) {
  const id = rig.id || 'rig-' + rig.name.toLowerCase().replace(/[^\w-]+/g, '-');
  const r = { proven: { packs: [], models: [] }, ...RIGS.find(x => x.id === id), ...rig, id };
  RIGS = RIGS.filter(x => x.id !== id).concat(r);
  saveRigs();
  return r;
}

export function removeRig(id) { RIGS = RIGS.filter(x => x.id !== id); saveRigs(); }

// A cloud destination is a rig with a live pod behind it. Starting a rig
// creates/updates the destination; url is only set while the pod serves.
export function upsertCloudDest(rig, patch) {
  const id = 'cloud-' + rig.id;
  const old = DESTS.find(x => x.id === id) || {};
  const d = { ...old, id, name: rig.name, kind: 'cloud', provider: rig.provider, rigId: rig.id, ...patch };
  DESTS = DESTS.filter(x => x.id !== id).concat(d);
  if (patch && 'url' in patch) clients.delete(id);   // endpoint moved: old client is stale
  save();
  return d;
}

// Cloud provider adapters. Adapters never hold API keys: every call goes
// through the python side (LOCAL/provider/<name>/<action>), which owns key
// custody, talks to the provider API, and NORMALIZES the shapes, so the
// js adapter is the same for every provider and adding one is one python
// function. status() also probes the pod's ComfyUI, so url is only set
// once the backend actually serves.
async function providerCall(name, action, body) {
  const r = await fetch(`${LOCAL}/provider/${name}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ? d.error + (d.fix ? ' · ' + d.fix : '') : `${name} ${action} HTTP ${r.status}`);
  return d;
}

const cloudAdapter = (name) => ({
  pricing: () => providerCall(name, 'pricing'),
  pods: () => providerCall(name, 'pods'),
  start: (rig) => providerCall(name, 'start', { rig }),
  status: (dest) => providerCall(name, 'status', { podId: dest.podId }),
  stop: (dest) => providerCall(name, 'stop', { podId: dest.podId }),
  resume: (dest) => providerCall(name, 'resume', { podId: dest.podId }),
  terminate: (dest) => providerCall(name, 'terminate', { podId: dest.podId }),
});

export const PROVIDERS = { runpod: cloudAdapter('runpod'), vast: cloudAdapter('vast') };

// Reconcile every rig's pod state from the PROVIDER's own pod list, the
// only truth that survives other sessions, other origins, the watchdog,
// and the provider console. Pods match rigs by the comfyvr-<rigid> name
// (vast: label). Returns true when anything changed.
export async function refreshCloudStates() {
  const providers = [...new Set(RIGS.map((r) => r.provider))];
  let changed = false;
  for (const prov of providers) {
    let pods;
    try { pods = (await PROVIDERS[prov].pods()).pods || []; } catch (e) { continue; }
    for (const rig of RIGS.filter((r) => r.provider === prov)) {
      const pod = pods.find((p) => p.name === 'comfyvr-' + rig.id);
      const d = DESTS.find((x) => x.id === 'cloud-' + rig.id) || {};
      const next = pod
        ? { podId: pod.podId, url: pod.url || null, stopped: /exited|stopped/.test(pod.status), usdHr: pod.usd_hr ?? d.usdHr }
        : { podId: null, url: null, stopped: false };
      if (d.podId !== next.podId || d.url !== next.url || !!d.stopped !== next.stopped) {
        upsertCloudDest(rig, next);
        changed = true;
      }
    }
  }
  return changed;
}

// Warm a rig into a live destination: start the pod, then poll until the
// backend serves. onPhase gets every status tick for cold-start theater.
// extra.manifest ({packs, models} from the workflow itself) rides into
// the bootstrap so the pod installs what the workflow needs.
export async function startRig(rigId, onPhase, extra) {
  const rig = RIGS.find((r) => r.id === rigId);
  if (!rig) throw new Error('no rig ' + rigId);
  const P = PROVIDERS[rig.provider];
  if (!P) throw new Error('no provider ' + rig.provider);
  // the watchdog contract rides in with the rig: idle cooldown and spend
  // cap, rig override first, workspace settings as the default
  const { podId } = await P.start({
    ...rig,
    ...extra,
    cooldownMin: rig.cooldownMin ?? getSetting('runCooldownMin'),
    capUsd: rig.capUsd ?? getSetting('runCapUsd'),
  });
  upsertCloudDest(rig, { podId, url: null });
  const t0 = Date.now();
  for (;;) {
    const st = await P.status({ podId });
    onPhase?.(st);
    if (st.url) return upsertCloudDest(rig, { podId, url: st.url, usdHr: st.usd_hr });
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error(rig.name + ' took >15min to serve; check the provider console');
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// Stop the pod behind a cloud destination (gpu billing ends; volume keeps).
export async function stopDest(destId) {
  const d = DESTS.find((x) => x.id === destId);
  if (!d || d.kind !== 'cloud') throw new Error('not a cloud destination: ' + destId);
  const out = await PROVIDERS[d.provider].stop(d);
  const rig = RIGS.find((r) => r.id === d.rigId);
  if (rig) upsertCloudDest(rig, { url: null, stopped: true });
  return out;
}

// Terminate it: everything on the pod is gone, all billing ends.
export async function terminateDest(destId) {
  const d = DESTS.find((x) => x.id === destId);
  if (!d || d.kind !== 'cloud') throw new Error('not a cloud destination: ' + destId);
  const out = await PROVIDERS[d.provider].terminate(d);
  const rig = RIGS.find((r) => r.id === d.rigId);
  if (rig) upsertCloudDest(rig, { url: null, podId: null, stopped: false });
  return out;
}
