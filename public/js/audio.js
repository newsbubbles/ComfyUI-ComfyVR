// audio.js — everything synthesized, movie-computer diegetic. Lazy ctx on
// first gesture; 'm' toggles the master gain.
export class Audio {
  constructor() { this.ctx = null; this.muted = false; this._lastZip = 0; this._lastTick = 0; }

  ensure() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.startAmbient();
      return true;
    } catch (e) { return false; }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 0.5, this.ctx.currentTime + 0.1);
  }

  blip(freq, dur = 0.08, { type = 'sine', gain = 0.08, pan = 0, glide = 0 } = {}) {
    if (!this.ensure() || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + glide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  tick() {
    const now = performance.now();
    if (now - this._lastTick < 40) return;
    this._lastTick = now;
    this.blip(1750, 0.02, { type: 'square', gain: 0.022 });
  }

  zip(v) {
    const now = performance.now();
    if (now - this._lastZip < 28) return;
    this._lastZip = now;
    this.blip(300 + 900 * v, 0.03, { type: 'square', gain: 0.03 });
  }

  toggle(on) { this.blip(on ? 520 : 700, 0.05, { gain: 0.05 }); this.blip(on ? 780 : 470, 0.06, { gain: 0.05 }); }

  button() { [660, 880, 1320].forEach((f, i) => setTimeout(() => this.blip(f, 0.09, { gain: 0.06 }), i * 55)); }

  chime() { this.blip(660, 0.9, { gain: 0.045 }); this.blip(990, 1.2, { gain: 0.03 }); }

  dock() { this.blip(440, 0.4, { gain: 0.04 }); this.blip(659, 0.5, { gain: 0.028 }); }

  plink(pan = 0) { this.blip(1200 + Math.random() * 700, 0.09, { gain: 0.035, pan }); }

  accrete() { this.blip(160, 0.65, { type: 'sawtooth', gain: 0.035, glide: 900 }); }

  queueSweep() { this.blip(220, 0.5, { type: 'sawtooth', gain: 0.045, glide: 1100 }); this.button(); }

  startAmbient() {
    const t = this.ctx.currentTime;
    for (const [f, gv] of [[55, 0.016], [55.6, 0.012], [110.3, 0.006]]) {
      const o = this.ctx.createOscillator();
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.value = gv;
      o.connect(g); g.connect(this.master);
      o.start(t);
    }
    // air: filtered noise
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.6;
    const g = this.ctx.createGain(); g.gain.value = 0.014;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    // distant random blips; rate modulated by activity level
    this.activity = 0;
    const loop = () => {
      const delay = 2200 - Math.min(this.activity, 1) * 1700 + Math.random() * 2600;
      setTimeout(() => {
        if (!this.muted && Math.random() < 0.8) this.blip(900 + Math.random() * 1600, 0.07, { gain: 0.014, pan: Math.random() * 1.6 - 0.8 });
        loop();
      }, delay);
    };
    loop();
  }
}
