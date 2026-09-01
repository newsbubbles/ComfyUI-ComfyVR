// settings.js — workspace parameters. localStorage-backed so it works in
// every mode including the zero-install static demo; per-device on purpose
// (a splat budget is a property of the hardware in front of you). Each
// subsystem reads live through getSetting; the settings panel writes.
const DEFAULTS = {
  muted: false,
  idleWalk: true,       // the constellation drifts while you're away
  idleDelayS: 60,       // seconds of quiet before it starts (jitter added)
  recallLatest: 1,      // outputs hung per workflow at boot from the disk scan
  splatBudget: 150000,  // XR splat decimation target; 0 = full resolution
  handStyle: 'dots',    // 'dots' (joint constellation) or 'robot' (segments)
  runCooldownMin: 30,   // idle minutes before the watchdog stops a cloud pod
  runCapUsd: 0,         // per-pod spend ceiling in USD; 0 = no cap
};

let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('cvr-settings') || '{}')); } catch (e) { /* fresh device */ }

export function getSetting(k) { return S[k]; }
export function setSetting(k, v) {
  S[k] = v;
  try { localStorage.setItem('cvr-settings', JSON.stringify(S)); } catch (e) { /* private window */ }
}
