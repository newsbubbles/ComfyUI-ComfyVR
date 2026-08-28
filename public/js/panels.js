// panels.js — holographic machine-faces. Each panel draws an element tree
// (header + typed rows) to an offscreen canvas, uploaded as a texture on a
// cylinder-sector mesh bent onto its ring (inward-facing, additive, no
// depth). Substrate's renderer, schema-driven instead of accretor-driven.
import * as THREE from 'three';
import { colorForType } from './graph.js';

export const PW = 512;                      // canvas px width
const PAD = 18;
export const ROW_H = { header: 40, port: 22, slider: 40, combo: 40, seed: 40, toggle: 40, text: 84, textline: 40, button: 46, progress: 20, image: 150, readout: 24, opaque: 24, alert: 24 };
const ERR = '#ff6a6a';
const FONT = (px, bold) => `${bold ? 'bold ' : ''}${px}px Consolas, "Courier New", monospace`;
const NOTE_MAX_LINES = 40;

// Schema ranges are validation bounds, not sensible travel: KSampler steps
// declares max 10000, which makes one slider pixel worth ~50 steps. Curated
// soft ranges give common widgets a usable sweep (the range still expands to
// include whatever value the workflow stored, and fine-nudge can go beyond).
const SOFT_RANGES = {
  steps: [1, 150], cfg: [0, 30], guidance: [0, 30],
  width: [64, 2048], height: [64, 2048], crop_w: [0, 2048], crop_h: [0, 2048],
  batch_size: [1, 16], start_at_step: [0, 150], end_at_step: [0, 150],
  strength: [-2, 3], strength_model: [-4, 4], strength_clip: [-4, 4],
};

// Slider value <-> bar fraction, in one place so drawing and input agree.
// Uncurated ranges spanning more than ~3 decades map through log space
// (multiplicative quantities want log distance).
export function sliderFrac(r, v) {
  if (r.log) {
    const lo = Math.log(Math.max(r.min, r.logFloor)), hi = Math.log(Math.max(r.max, r.logFloor));
    return clamp01((Math.log(Math.max(Number(v) || 0, r.logFloor)) - lo) / (hi - lo || 1));
  }
  return clamp01((v - r.min) / (r.max - r.min || 1));
}
export function sliderValue(r, f) {
  if (r.log) {
    const lo = Math.log(Math.max(r.min, r.logFloor)), hi = Math.log(Math.max(r.max, r.logFloor));
    return Math.exp(lo + clamp01(f) * (hi - lo));
  }
  return r.min + clamp01(f) * (r.max - r.min);
}

const measure = document.createElement('canvas').getContext('2d');

const redrawQueue = new Set();
export function pumpRedraws(t, budget = 4) {
  let n = 0;
  for (const p of redrawQueue) {
    p.draw(t); redrawQueue.delete(p);
    if (++n >= budget) break;
  }
}

// Inward-facing cylinder sector with explicit UVs so text reads correctly
// from the hub core (substrate gotcha: canvas y-down vs mesh v-up, plus
// inside-view mirroring — both handled here, in one place).
function sectorGeometry(radius, arc, height, segs = 20) {
  const pos = [], uv = [], idx = [];
  for (let iy = 0; iy <= 1; iy++) {
    for (let ix = 0; ix <= segs; ix++) {
      const u = ix / segs;
      const th = (u - 0.5) * arc;         // centered on local -Z later via rotation
      pos.push(Math.sin(th) * radius, (iy - 0.5) * height, -Math.cos(th) * radius);
      // Viewer sits at the ring center looking outward: canvas left must
      // land at -theta (their left); flipY texture puts canvas top at v=1.
      uv.push(u, iy);
    }
  }
  for (let ix = 0; ix < segs; ix++) {
    const a = ix, b = ix + 1, c = segs + 1 + ix, d = segs + 1 + ix + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

let PANEL_SEQ = 1;

export class Panel {
  // rows: [{kind, ...}] — see builders below. worldWidth in scene units.
  constructor({ title, subtitle = '', accent = '#7ce8dc', rows = [], worldWidth = 4.4, billboard = false }) {
    this.id = PANEL_SEQ++;
    this.title = title; this.subtitle = subtitle; this.accent = accent;
    this.rows = rows;
    this.worldWidth = worldWidth;
    this.billboard = billboard;
    this.pxH = ROW_H.header + rows.reduce((s, r) => s + this.rowH(r), 0) + PAD;
    this.canvas = document.createElement('canvas');
    this.canvas.width = PW;
    this.canvas.height = this.pxH;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide, opacity: 0,
    });
    this.mesh = null;          // created in place()/placeFlat()
    this.hot = null;           // hovered row
    this.active = 0;           // execution glow 0..1
    this.baseOpacity = 0.95;
    this.dirty();
  }

  rowH(r) {
    if (r.kind === 'port') return ROW_H.port * r.lines;
    if (r.kind === 'text' && r.oneline) return ROW_H.textline;
    if (r.kind === 'note') {
      // full note body: height follows the wrapped text, computed once
      if (r._h == null) {
        measure.font = FONT(14);
        const lines = wrapText(measure, String(r.get() || ''), PW - 2 * PAD);
        r._lines = lines.slice(0, NOTE_MAX_LINES);
        r._more = lines.length - r._lines.length;
        r._h = 26 + Math.max(1, r._lines.length + (r._more > 0 ? 1 : 0)) * 18 + 8;
      }
      return r._h;
    }
    return ROW_H[r.kind] || 30;
  }

  worldHeight() { return this.worldWidth * this.pxH / PW; }

  // Curve onto a ring of the hub: radius r, centered at angle theta, height y.
  // Panels always face the ring axis (the hub centroid), so moving a panel
  // is just re-placing it — orientation follows for free.
  place(hubGroup, r, theta, y, tilt = 0) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.rotation.order = 'YXZ';
    this.tilt = tilt;
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = 10;
    hubGroup.add(this.mesh);
    this.placement = { r: -1, theta, y, arc: 0 };
    this.setPlacement(r, theta, y);
    return this.mesh;
  }

  setPlacement(r, theta, y) {
    const rebuild = Math.abs(r - this.placement.r) > 1e-4;
    this.placement = { r, theta, y, arc: this.worldWidth / r };
    if (rebuild) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = sectorGeometry(r, this.placement.arc, this.worldHeight());
    }
    this.mesh.rotation.set(this.tilt || 0, -theta - Math.PI / 2, 0);  // local -Z toward angle theta
    this.mesh.position.y = y;
  }

  // Flat billboard (core panels, sigils).
  placeFlat(parent, position) {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.worldWidth, this.worldHeight()), this.mat);
    this.mesh.position.copy(position);
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = 10;
    parent.add(this.mesh);
    return this.mesh;
  }

  // World position of a texel (u,v in canvas fractions, v measured from top).
  anchorWorld(u, vTop) {
    const out = new THREE.Vector3();
    if (!this.mesh) return out;
    if (this.billboard) {
      out.set((u - 0.5) * this.worldWidth, (0.5 - vTop) * this.worldHeight(), 0);
    } else {
      const { r, arc } = this.placement;
      const th = (u - 0.5) * arc;
      out.set(Math.sin(th) * r, (0.5 - vTop) * this.worldHeight(), -Math.cos(th) * r);
    }
    this.mesh.updateWorldMatrix(true, false);
    return this.mesh.localToWorld(out);
  }

  dirty() { redrawQueue.add(this); }

  rowAt(u, vTop) {
    const y = vTop * this.pxH;
    let acc = ROW_H.header;
    if (y < acc) return { row: null, kind: 'header' };
    for (const r of this.rows) {
      const h = this.rowH(r);
      if (y < acc + h) return { row: r, kind: r.kind, frac: (u * PW - PAD) / (PW - 2 * PAD), yFrac: (y - acc) / h };
      acc += h;
    }
    return { row: null, kind: 'body' };
  }

  rowRangePx(row) {
    let acc = ROW_H.header;
    for (const r of this.rows) {
      const h = this.rowH(r);
      if (r === row) return [acc, acc + h];
      acc += h;
    }
    return [0, 0];
  }

  draw(t = 0) {
    const g = this.canvas.getContext('2d');
    const W = PW, H = this.pxH, A = this.accent;
    g.clearRect(0, 0, W, H);
    // glass
    g.fillStyle = 'rgba(6,20,26,0.62)';
    roundRect(g, 1, 1, W - 2, H - 2, 10); g.fill();
    // errored panels flip to the red family until the next success or edit
    const B = this.errorMsg ? ERR : A;
    g.strokeStyle = withAlpha(B, this.errorMsg ? 0.95 : (this.active > 0.02 ? 0.95 : 0.5));
    g.lineWidth = this.errorMsg || this.active > 0.02 ? 2.5 : 1.25;
    roundRect(g, 1, 1, W - 2, H - 2, 10); g.stroke();
    if (this.errorMsg) {
      g.fillStyle = withAlpha(ERR, 0.9);
      g.font = FONT(12);
      g.textAlign = 'right';
      g.fillText('⚠', W - PAD - 60, ROW_H.header / 2 - 2);
      g.textAlign = 'left';
    }
    // header
    g.fillStyle = withAlpha(A, 0.14);
    g.fillRect(2, 2, W - 4, ROW_H.header - 6);
    g.fillStyle = A;
    g.font = FONT(19, true);
    g.textBaseline = 'middle';
    g.fillText(clip(g, this.title.toUpperCase(), W - 2 * PAD - 120), PAD, ROW_H.header / 2 - 2);
    g.font = FONT(13);
    g.fillStyle = withAlpha(A, 0.6);
    g.textAlign = 'right';
    g.fillText(this.subtitle, W - PAD, ROW_H.header / 2 - 2);
    g.textAlign = 'left';
    let y = ROW_H.header;
    for (const r of this.rows) {
      const h = this.rowH(r);
      this.drawRow(g, r, y, h, t);
      y += h;
    }
    // scanlines
    g.fillStyle = 'rgba(0,0,0,0.16)';
    for (let sy = 2; sy < H; sy += 4) g.fillRect(1, sy, W - 2, 1);
    this.tex.needsUpdate = true;
  }

  drawRow(g, r, y, h, t) {
    const W = PW, A = this.accent, hot = this.hot === r;
    const mid = y + h / 2;
    g.font = FONT(15);
    if (hot) { g.fillStyle = withAlpha(A, 0.07); g.fillRect(2, y, W - 4, h); }
    const label = (txt) => { g.fillStyle = withAlpha(A, 0.75); g.fillText(clip(g, txt, 168), PAD, mid); };
    switch (r.kind) {
      case 'port': {
        r.slots.forEach((s, i) => {
          const yy = y + ROW_H.port * (i + 0.5);
          const c = colorOr(s.type, A);
          const x = s.dir === 'in' ? PAD - 6 : W - PAD + 6;
          const hinted = this.hint && this.hint.type === s.type && this.hint.dir === s.dir;
          if (hinted) {
            g.strokeStyle = c; g.lineWidth = 2;
            g.beginPath(); g.arc(x, yy, 9 + 2 * Math.sin(performance.now() / 150), 0, Math.PI * 2); g.stroke();
          }
          g.fillStyle = c;
          g.beginPath();
          g.arc(x, yy, hinted ? 6 : 4.5, 0, Math.PI * 2); g.fill();
          g.fillStyle = withAlpha(c, hinted ? 1 : 0.8);
          g.textAlign = s.dir === 'in' ? 'left' : 'right';
          g.fillText(`${s.name}·${s.type}`, s.dir === 'in' ? PAD + 6 : W - PAD - 6, yy);
          g.textAlign = 'left';
        });
        break;
      }
      case 'slider': case 'seed': {
        label(r.name);
        const x0 = 196, x1 = W - PAD - 96;
        if (r.kind === 'slider') {
          const f = sliderFrac(r, r.get());
          g.strokeStyle = withAlpha(A, 0.35); g.lineWidth = 2;
          line(g, x0, mid, x1, mid);
          g.strokeStyle = A; g.lineWidth = 3;
          line(g, x0, mid, x0 + (x1 - x0) * f, mid);
          g.fillStyle = A;
          g.fillRect(x0 + (x1 - x0) * f - 2, mid - 8, 4, 16);
        } else {
          g.fillStyle = withAlpha(A, hot ? 1 : 0.7);
          g.font = FONT(14);
          g.fillText('⟳ reroll', x0, mid);
        }
        g.fillStyle = '#e8fffb';
        g.font = FONT(15, true);
        g.textAlign = 'right';
        g.fillText(fmtVal(r.get()), W - PAD, mid);
        g.textAlign = 'left';
        break;
      }
      case 'combo': {
        label(r.name);
        g.fillStyle = withAlpha(A, 0.8);
        g.textAlign = 'center';
        g.fillText('◂', 206, mid); g.fillText('▸', W - PAD - 10, mid);
        // amber = value auto-substituted (the stored one wasn't on the server)
        const subbed = !!r.widget?.substituted;
        g.fillStyle = subbed ? '#ffd54a' : '#e8fffb';
        g.font = FONT(15, true);
        g.fillText(clip(g, (subbed ? '≈ ' : '') + String(r.get()), W - PAD - 10 - 216 - 16), (216 + W - PAD - 20) / 2, mid);
        g.textAlign = 'left';
        break;
      }
      case 'toggle': {
        label(r.name);
        const on = !!r.get();
        g.strokeStyle = A; g.lineWidth = 1.5;
        roundRect(g, W - PAD - 54, mid - 10, 44, 20, 10); g.stroke();
        g.fillStyle = on ? A : withAlpha(A, 0.25);
        g.beginPath(); g.arc(W - PAD - 54 + (on ? 33 : 11), mid, 7, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'text': {
        g.fillStyle = withAlpha(A, 0.55);
        g.font = FONT(12);
        g.fillText(r.name.toUpperCase(), PAD, y + 12);
        g.fillStyle = '#d9fbf4';
        g.font = FONT(14);
        const lines = wrapText(g, String(r.get() || '·'), W - 2 * PAD);
        const maxLines = r.oneline ? 1 : 3;
        lines.slice(0, maxLines).forEach((ln, i) => g.fillText(i === maxLines - 1 && lines.length > maxLines ? ln.slice(0, -1) + '…' : ln, PAD, y + 30 + i * 18));
        if (hot) { g.fillStyle = withAlpha(A, 0.8); g.font = FONT(11); g.textAlign = 'right'; g.fillText('[edit]', W - PAD, y + 12); g.textAlign = 'left'; }
        break;
      }
      case 'note': {
        g.fillStyle = withAlpha(A, 0.55);
        g.font = FONT(12);
        g.fillText(r.name.toUpperCase(), PAD, y + 12);
        g.fillStyle = '#d9fbf4';
        g.font = FONT(14);
        (r._lines || []).forEach((ln, i) => g.fillText(ln, PAD, y + 30 + i * 18));
        if (r._more > 0) {
          g.fillStyle = withAlpha(A, 0.5);
          g.fillText(`… ${r._more} more lines`, PAD, y + 30 + (r._lines?.length || 0) * 18);
        }
        break;
      }
      case 'button': {
        g.strokeStyle = A; g.lineWidth = hot ? 2.5 : 1.5;
        roundRect(g, PAD, y + 7, W - 2 * PAD, h - 14, 8); g.stroke();
        g.fillStyle = withAlpha(A, hot ? 0.28 : 0.12);
        roundRect(g, PAD, y + 7, W - 2 * PAD, h - 14, 8); g.fill();
        g.fillStyle = A; g.font = FONT(17, true); g.textAlign = 'center';
        g.fillText(r.label, W / 2, mid);
        g.textAlign = 'left';
        break;
      }
      case 'progress': {
        const f = clamp01(r.get());
        g.fillStyle = withAlpha(A, 0.25);
        g.fillRect(PAD, mid - 4, W - 2 * PAD, 8);
        g.fillStyle = A;
        g.fillRect(PAD, mid - 4, (W - 2 * PAD) * f, 8);
        break;
      }
      case 'image': {
        const iw = W - 2 * PAD, ih = h - 12;
        g.strokeStyle = withAlpha(A, 0.5); g.lineWidth = 1;
        g.strokeRect(PAD, y + 6, iw, ih);
        if (r.img) {
          const s = Math.min(iw / r.img.width, ih / r.img.height);
          const dw = r.img.width * s, dh = r.img.height * s;
          g.save(); g.globalCompositeOperation = 'lighter';
          g.drawImage(r.img, PAD + (iw - dw) / 2, y + 6 + (ih - dh) / 2, dw, dh);
          g.restore();
        } else {
          g.fillStyle = withAlpha(A, 0.3); g.font = FONT(13); g.textAlign = 'center';
          g.fillText(r.placeholder || 'NO SIGNAL', W / 2, mid);
          g.textAlign = 'left';
        }
        break;
      }
      case 'alert': {
        const msg = r.get();
        if (msg) {
          g.fillStyle = withAlpha(ERR, 0.95);
          g.font = FONT(13);
          g.fillText('⚠ ' + clip(g, String(msg), W - 2 * PAD - 24), PAD, mid);
        }
        break;
      }
      case 'readout': {
        g.fillStyle = withAlpha(A, 0.75);
        g.fillText(clip(g, r.get(), 260), PAD, mid);
        g.fillStyle = '#e8fffb'; g.textAlign = 'right';
        g.fillText(clip(g, String(r.get2 ? r.get2() : ''), 200), W - PAD, mid);
        g.textAlign = 'left';
        break;
      }
      case 'opaque': {
        g.fillStyle = withAlpha(A, 0.5);
        g.fillText(clip(g, `${r.name}: ${JSON.stringify(r.get())}`, W - 2 * PAD), PAD, mid);
        break;
      }
      case 'glyphs': {
        g.fillStyle = withAlpha(A, 0.9); g.font = FONT(r.big ? 64 : 24); g.textAlign = 'center';
        g.fillText(r.text, W / 2, mid + (r.big ? 4 : 0));
        g.textAlign = 'left'; break;
      }
    }
  }

  setHot(row) { if (this.hot !== row) { this.hot = row; this.dirty(); } }

  setHint(hint) {
    const same = (!hint && !this.hint) || (hint && this.hint && hint.type === this.hint.type && hint.dir === this.hint.dir);
    if (!same) { this.hint = hint; this.dirty(); }
  }

  update(t) {
    if (!this.mesh) return;
    const flicker = 0.94 + 0.06 *Oise(t * 7 + this.id * 13.7);
    this.mat.opacity = this.baseOpacity * this.foldAlpha * flicker * (1 + this.active * 0.15);
    if (this.active > 0.001) this.active *= 0.985;
  }

  foldAlpha = 1;
  hint = null;
  errorMsg = null;

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
    this.mat.dispose(); this.tex.dispose();
    redrawQueue.delete(this);
  }
}

// ------- row builders (bound to live widget objects) -------
export function widgetRow(wg, onChange) {
  const base = { name: wg.name, get: () => wg.value, widget: wg, onChange };
  switch (wg.wtype) {
    case 'int': case 'float': {
      const isInt = wg.wtype === 'int';
      const step = wg.step ?? (isInt ? 1 : 0.01);
      const hardMin = wg.min ?? 0, hardMax = wg.max ?? 100;
      let [lo, hi] = SOFT_RANGES[wg.name] || [hardMin, hardMax];
      lo = Math.max(hardMin, lo); hi = Math.min(hardMax, hi);
      if (hi <= lo) { lo = hardMin; hi = hardMax; }
      const v = Number(wg.value);
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const log = !SOFT_RANGES[wg.name] && lo >= 0 && hi / Math.max(lo, step, 1e-9) > 1000;
      return {
        ...base, kind: 'slider', min: lo, max: hi, hardMin, hardMax, step, int: isInt,
        log, logFloor: Math.max(step, isInt ? 1 : 1e-4),
      };
    }
    case 'seed': return { ...base, kind: 'seed' };
    case 'combo': return { ...base, kind: 'combo', options: wg.options || [] };
    case 'toggle': return { ...base, kind: 'toggle' };
    case 'text': return { ...base, kind: 'text', oneline: !!wg.oneline };
    case 'note': return { ...base, kind: 'note' };
    default: return { ...base, kind: 'opaque' };
  }
}
export function portRow(slots) { return { kind: 'port', slots, lines: slots.length }; }
export function buttonRow(label, onClick) { return { kind: 'button', label, onClick }; }
export function progressRow(getter) { return { kind: 'progress', get: getter }; }
export function imageRow(placeholder) { return { kind: 'image', img: null, placeholder }; }
export function readoutRow(get, get2) { return { kind: 'readout', get, get2 }; }
export function alertRow(get) { return { kind: 'alert', get }; }
export function glyphRow(text, big = false) { return { kind: 'glyphs', text, big }; }

// ------- small helpers -------
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function colorOr(type, fallback) {
  if (!type || type === '*') return fallback;
  return colorForType(type);
}
function clip(g, s, w) {
  s = String(s);
  if (g.measureText(s).width <= w) return s;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
function wrap(g, s, w) {
  const words = s.split(/\s+/); const out = []; let cur = '';
  for (const wd of words) {
    const test = cur ? cur + ' ' + wd : wd;
    if (g.measureText(test).width > w && cur) { out.push(cur); cur = wd; }
    else cur = test;
  }
  if (cur) out.push(cur);
  return out;
}
// Paragraph-aware wrapping: blank lines and line breaks survive.
function wrapText(g, s, w) {
  const out = [];
  for (const para of String(s).split(/\r?\n/)) {
    if (!para.trim()) { out.push(''); continue; }
    out.push(...wrap(g, para, w));
  }
  return out;
}
function fmtVal(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v > 1e9 ? v.toExponential(3) : String(v);
  return v.toFixed(Math.abs(v) < 10 ? 2 : 1);
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function Oise(t) { return Math.sin(t) * 0.5 + Math.sin(t * 2.7 + 1.3) * 0.3 + Math.sin(t * 5.9) * 0.2; }
