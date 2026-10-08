// Pure ride-tracking logic: no DOM, no geolocation. Fed GPS fixes by app.js.

export const UNITS = {
  miles: { meters: 1609.344, dist: 'mi', speed: 'mph', pace: '/mi' },
  kilometers: { meters: 1000, dist: 'km', speed: 'km/h', pace: '/km' },
};

export const speedIn = (unit, mps) => (mps * 3600) / UNITS[unit].meters;
export const distIn = (unit, meters) => meters / UNITS[unit].meters;
export const paceSecs = (unit, mps) => (mps > 0.3 ? UNITS[unit].meters / mps : null);

export function fmtPace(secs) {
  if (secs == null || !isFinite(secs) || secs >= 6000) return '--:--';
  const t = Math.round(secs);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function fmtDuration(secs) {
  const t = Math.floor(secs);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const fmt = (v, places = 1) => v.toFixed(places);

// Rough estimates (about ±20%): see the iOS app's Calories.swift for the reasoning.
export function bikingKcal(weightKg, avgSpeedMps, movingSecs) {
  const mph = avgSpeedMps * 2.23694;
  const met = mph < 10 ? 4.0 : mph < 12 ? 6.8 : mph < 14 ? 8.0 : mph < 16 ? 10.0 : mph < 20 ? 12.0 : 15.8;
  return (met * weightKg * movingSecs) / 3600;
}
export const runningKcal = (weightKg, meters) => 1.036 * weightKg * (meters / 1000);

export function haversine(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SMOOTHING = 0.35;
const MAX_ACCURACY = 30;      // meters
const MOVING_THRESHOLD = 0.5; // m/s
const PACE_WINDOW = 5000;     // ms
const MAX_FIX_AGE = 10000;    // ms
const MAX_GAP = 15;           // s: longer gaps (e.g. app backgrounded) are not counted

export class Tracker {
  constructor() { this.reset(); }

  reset() {
    this.state = 'idle'; // idle | running | paused
    this.startDate = null;
    this.currentSpeed = 0;   // m/s, smoothed
    this.paceSpeed = 0;      // m/s, averaged over PACE_WINDOW
    this.maxSpeed = 0;
    this.distance = 0;       // meters
    this.elapsed = 0;        // seconds, wall time while running
    this.movingTime = 0;     // seconds
    this.hasSignal = false;
    this.boundaries = { miles: [], kilometers: [] }; // cumulative moving time at each completed unit
    this._lastFix = null;
    this._lastTick = null;
    this._paceSamples = [];
  }

  start(now) {
    if (this.state === 'running') return;
    if (!this.startDate) this.startDate = now;
    this.state = 'running';
    this._lastTick = now;
    this._lastFix = null;
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this._lastFix = null;
    this._lastTick = null;
    this.currentSpeed = 0;
    this.paceSpeed = 0;
    this._paceSamples = [];
    this.hasSignal = false;
  }

  tick(now) {
    if (this.state !== 'running') return;
    this.elapsed += (now - this._lastTick) / 1000;
    this._lastTick = now;
    this._updatePace(now);
  }

  /** fix: {lat, lon, accuracy, speed (m/s or null), timestamp (ms)} */
  addFix(fix, now) {
    if (this.state !== 'running') return;
    if (!(fix.accuracy >= 0) || fix.accuracy > MAX_ACCURACY || Math.abs(now - fix.timestamp) > MAX_FIX_AGE) {
      this.hasSignal = false;
      return;
    }
    this.hasSignal = true;

    let raw = typeof fix.speed === 'number' && fix.speed >= 0 ? fix.speed : -1;
    const prev = this._lastFix;
    this._lastFix = fix;
    if (prev) {
      const dt = (fix.timestamp - prev.timestamp) / 1000;
      if (dt <= 0 || dt > MAX_GAP) return;
      const delta = haversine(prev, fix);
      const implied = delta / dt;
      // A jump far beyond the reported speed is a GPS glitch: skip it.
      if (implied > 40 || (raw >= 0 && implied > raw * 2 + 5)) return;
      if (raw < 0) raw = implied;
      // Ignore jitter while essentially stationary.
      if (raw >= MOVING_THRESHOLD && delta > fix.accuracy * 0.25) {
        this.distance += delta;
        this.movingTime += dt;
        this._recordSplits();
      }
    }

    const speed = Math.max(raw, 0);
    this.currentSpeed = speed < MOVING_THRESHOLD ? 0
      : this.currentSpeed * (1 - SMOOTHING) + speed * SMOOTHING;
    this.maxSpeed = Math.max(this.maxSpeed, speed);
    this._paceSamples.push({ t: now, v: speed < MOVING_THRESHOLD ? 0 : speed });
    this._updatePace(now);
  }

  _updatePace(now) {
    this._paceSamples = this._paceSamples.filter(s => now - s.t <= PACE_WINDOW);
    const n = this._paceSamples.length;
    this.paceSpeed = n ? this._paceSamples.reduce((a, s) => a + s.v, 0) / n : 0;
  }

  _recordSplits() {
    for (const u of Object.keys(UNITS)) {
      const reached = Math.floor(this.distance / UNITS[u].meters);
      const list = this.boundaries[u];
      while (list.length < reached) list.push(this.movingTime);
    }
  }

  splits(unit) {
    let prev = 0;
    return this.boundaries[unit].map(t => { const d = t - prev; prev = t; return d; });
  }

  get averageSpeed() { return this.movingTime > 0 ? this.distance / this.movingTime : 0; }

  /** Ends the ride; returns a ride record, or null when there is nothing worth saving. */
  finish() {
    const ride = this.distance > 10 ? {
      id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
      startDate: this.startDate,
      distanceMeters: this.distance,
      movingTime: this.movingTime,
      elapsed: this.elapsed,
      maxSpeed: this.maxSpeed,
      mileSplits: this.splits('miles'),
      kmSplits: this.splits('kilometers'),
    } : null;
    this.reset();
    return ride;
  }
}
