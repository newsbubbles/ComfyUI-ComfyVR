// beams.js — links as arcs of light between panel anchors; pulses as bright
// points traveling them. Beams are static polylines (recomputed only when a
// hub folds/unfolds); pulses share one Points buffer.
import * as THREE from 'three';

const SEGS = 26;
const MAX_PULSES = 512;

export class BeamSystem {
  constructor(scene) {
    this.scene = scene;
    this.beams = new Map();     // key -> {pts:[Vector3], line, color, group}
    this.pulses = [];           // {beam, t, speed, size}
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3));
    const dot = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    this.pulsePoints = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 0.8, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, sizeAttenuation: true,
    }));
    this.pulsePoints.renderOrder = 20;
    this.pulsePoints.frustumCulled = false;
    scene.add(this.pulsePoints);
  }

  // A and B world Vector3; bulge pushes the arc's midpoint away from `away`
  // (the hub core) so beams arc over the amphitheater tiers.
  addBeam(key, A, B, colorHex, { away = null, bulge = 0.22, alpha = 0.5, group = 'default' } = {}) {
    this.removeBeam(key);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    if (away) {
      const out = mid.clone().sub(away);
      const len = out.length() || 1;
      mid.add(out.multiplyScalar((A.distanceTo(B) * bulge) / len));
    } else {
      mid.y += A.distanceTo(B) * bulge * 0.4;
    }
    const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
    const pts = curve.getPoints(SEGS);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorHex), transparent: true, opacity: alpha,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 5;
    this.scene.add(line);
    const beam = { key, pts, line, color: new THREE.Color(colorHex), baseAlpha: alpha, group, len: curveLen(pts) };
    this.beams.set(key, beam);
    return beam;
  }

  removeBeam(key) {
    const b = this.beams.get(key);
    if (!b) return;
    b.line.geometry.dispose(); b.line.material.dispose(); b.line.removeFromParent();
    this.pulses = this.pulses.filter(p => p.beam !== b);
    this.beams.delete(key);
  }

  removeGroup(group) {
    for (const [k, b] of [...this.beams]) if (b.group === group) this.removeBeam(k);
  }

  setGroupAlpha(group, f) {
    for (const b of this.beams.values()) if (b.group === group) b.line.material.opacity = b.baseAlpha * f;
  }

  pulse(key, { speed = 14, size = 1 } = {}) {
    const b = this.beams.get(key);
    if (!b || this.pulses.length >= MAX_PULSES) return null;
    const p = { beam: b, t: 0, speed: speed / Math.max(b.len, 0.001), size };
    this.pulses.push(p);
    return p;
  }

  // Fire a pulse on every beam in a group at once (execution wavefronts).
  pulseWhere(pred, opts) {
    for (const b of this.beams.values()) if (pred(b)) this.pulse(b.key, opts);
  }

  update(dt, onArrive) {
    const pos = this.pulsePoints.geometry.attributes.position;
    const col = this.pulsePoints.geometry.attributes.color;
    let n = 0;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += p.speed * dt;
      if (p.t >= 1) {
        this.pulses.splice(i, 1);
        if (onArrive) onArrive(p);
        continue;
      }
      const f = p.t * SEGS, k = Math.min(Math.floor(f), SEGS - 1), fr = f - k;
      const a = p.beam.pts[k], b = p.beam.pts[k + 1];
      pos.setXYZ(n, a.x + (b.x - a.x) * fr, a.y + (b.y - a.y) * fr, a.z + (b.z - a.z) * fr);
      col.setXYZ(n, p.beam.color.r * 1.4, p.beam.color.g * 1.4, p.beam.color.b * 1.4);
      n++;
    }
    this.pulsePoints.geometry.setDrawRange(0, n);
    pos.needsUpdate = true; col.needsUpdate = true;
    return n;
  }
}

function curveLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += pts[i].distanceTo(pts[i - 1]);
  return s;
}
