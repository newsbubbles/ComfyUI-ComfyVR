// manifest.js — what a workflow needs, read from the workflow itself.
// Modern workflow json embeds, per node, properties.cnr_id (the registry
// id of the pack providing it) + properties.ver, and model loaders carry
// properties.models = [{name, url, directory}]. So the saved file already
// IS the provisioning manifest. This extractor is for DISPLAY and GPU
// sizing only: actual dependency resolution is delegated to comfy-cli on
// the remote box (writing our own resolver would be reinventing a
// commodity, per notes/run-on.md).

const collect = (nodes, packs, models) => {
  for (const n of nodes || []) {
    const p = n.properties || {};
    if (p.cnr_id && p.cnr_id !== 'comfy-core') {
      // keep the highest-information version string we see for a pack
      if (!packs.get(p.cnr_id)) packs.set(p.cnr_id, p.ver || '');
    }
    for (const m of p.models || []) {
      if (m && m.name && !models.has(m.name)) models.set(m.name, { name: m.name, url: m.url || '', directory: m.directory || '' });
    }
  }
};

export function workflowManifest(json) {
  const packs = new Map();
  const models = new Map();
  collect(json?.nodes, packs, models);
  for (const d of ((json?.definitions || {}).subgraphs || [])) collect(d.nodes, packs, models);
  return {
    packs: [...packs].map(([id, ver]) => ({ id, ver })),
    models: [...models.values()],
  };
}

// Total bytes of the workflow's models, by HEADing their urls (HuggingFace
// answers CORS on resolve urls; anything unanswerable counts as unknown).
// Feeds GPU tier suggestion: models must fit VRAM with working headroom.
export async function manifestSizes(manifest) {
  let known = 0;
  const unknown = [];
  await Promise.all(manifest.models.map(async (m) => {
    if (!m.url) { unknown.push(m.name); return; }
    try {
      const r = await fetch(m.url, { method: 'HEAD', redirect: 'follow' });
      const len = Number(r.headers.get('Content-Length') || 0);
      if (len > 0) { m.bytes = len; known += len; } else unknown.push(m.name);
    } catch (e) { unknown.push(m.name); }
  }));
  return { totalBytes: known, unknown };
}
