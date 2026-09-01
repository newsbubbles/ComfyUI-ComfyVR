// destinations.js — where a queue can run. The local backend is implicit;
// a PEER is just an accessible address with the API exposed (no setup, no
// lifecycle: its owner started it with --listen and CORS open); a CLOUD
// destination carries a provider adapter and needs warm-up and lifecycle.
// Kinds differ on setup, never on experience: every destination is a
// ComfyClient with its own websocket, so runs land in the same space in
// parallel with the host's own.
import { ComfyClient, LOCAL } from './comfy.js';

let DESTS = [];
try { DESTS = JSON.parse(localStorage.getItem('cvr-destinations') || '[]'); } catch (e) { /* fresh */ }
const save = () => { try { localStorage.setItem('cvr-destinations', JSON.stringify(DESTS)); } catch (e) { /* private window */ } };

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

// The client for a destination, connected lazily. null/undefined = the
// primary client the caller already holds (returned as-is for symmetry).
export async function clientFor(dest, primary) {
  if (!dest) return primary;
  const d = typeof dest === 'string' ? DESTS.find(x => x.id === dest) : dest;
  if (!d) throw new Error('no destination ' + dest);
  let c = clients.get(d.id);
  if (!c) {
    c = new ComfyClient({ base: d.url });
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
const saveRigs = () => { try { localStorage.setItem('cvr-rigs', JSON.stringify(RIGS)); } catch (e) { /* private window */ } };

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
  start: (rig) => providerCall(name, 'start', { rig }),
  status: (dest) => providerCall(name, 'status', { podId: dest.podId }),
  stop: (dest) => providerCall(name, 'stop', { podId: dest.podId }),
  terminate: (dest) => providerCall(name, 'terminate', { podId: dest.podId }),
});

export const PROVIDERS = { runpod: cloudAdapter('runpod'), vast: cloudAdapter('vast') };

// Warm a rig into a live destination: start the pod, then poll until the
// backend serves. onPhase gets every status tick for cold-start theater.
export async function startRig(rigId, onPhase) {
  const rig = RIGS.find((r) => r.id === rigId);
  if (!rig) throw new Error('no rig ' + rigId);
  const P = PROVIDERS[rig.provider];
  if (!P) throw new Error('no provider ' + rig.provider);
  const { podId } = await P.start(rig);
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
  if (rig) upsertCloudDest(rig, { url: null });
  return out;
}
