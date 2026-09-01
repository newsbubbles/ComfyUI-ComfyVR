// destinations.js — where a queue can run. The local backend is implicit;
// a PEER is just an accessible address with the API exposed (no setup, no
// lifecycle: its owner started it with --listen and CORS open); a CLOUD
// destination carries a provider adapter and needs warm-up and lifecycle.
// Kinds differ on setup, never on experience: every destination is a
// ComfyClient with its own websocket, so runs land in the same space in
// parallel with the host's own.
import { ComfyClient } from './comfy.js';

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

// Cloud provider adapters register here: {start, stop, status, endpoint,
// costPerHour, auth}. RunPod and Vast are the first two planned; the shape
// stays deliberately small so adding a provider is one file.
export const PROVIDERS = {};
