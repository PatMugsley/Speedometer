import {
  Tracker, UNITS, speedIn, distIn, paceSecs, fmtPace, fmtDuration, fmt, bikingKcal, runningKcal,
} from './tracker.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let unit = store.get('unit', 'miles');
let weightKg = store.get('weightKg', 75);
let rides = store.get('rides', []);
const tracker = new Tracker();

let watchId = null;
let wakeLock = null;
let geoState = 'ok';      // ok | searching | denied | unsupported
let hiddenAt = null;
let interrupted = false;

// ---------- geolocation ----------
function startGeo() {
  if (!('geolocation' in navigator)) { geoState = 'unsupported'; return false; }
  geoState = 'searching';
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
  return true;
}
function stopGeo() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
function onPosition(p) {
  geoState = 'ok';
  const c = p.coords;
  tracker.addFix({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed, timestamp: p.timestamp }, Date.now());
  render();
}
function onGeoError(e) {
  if (e.code === 1) {
    geoState = 'denied';
    stopGeo();
    if (tracker.distance === 0) tracker.reset(); else tracker.pause();
    releaseWake();
  } else {
    geoState = 'searching';
  }
  render();
}

// ---------- wake lock ----------
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed (e.g. low battery); tracking still works */ }
}
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  if (tracker.state !== 'running') return;
  if (document.hidden) {
    hiddenAt = Date.now();
  } else {
    if (hiddenAt && Date.now() - hiddenAt > 3000) interrupted = true;
    hiddenAt = null;
    requestWake();
    render();
  }
});
window.addEventListener('beforeunload', e => {
  if (tracker.state !== 'idle') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- actions ----------
function start() {
  interrupted = false;
  tracker.start(Date.now());
  if (!startGeo()) { tracker.reset(); }
  requestWake();
  render();
}
function pause() { stopGeo(); tracker.pause(); releaseWake(); render(); }
function finish() {
  const ride = tracker.finish();
  stopGeo(); releaseWake();
  if (ride) {
    rides.unshift(ride);
    store.set('rides', rides);
    showSheet(ride, false);
  }
  render();
}
function discard() { stopGeo(); releaseWake(); tracker.reset(); render(); }

// ---------- rendering ----------
function render() {
  const t = tracker, u = UNITS[unit];
  $('speed').textContent = fmt(speedIn(unit, t.currentSpeed));
  $('speed-unit').textContent = u.speed;
  $('distance').textContent = fmt(distIn(unit, t.distance), 2);
  $('distance-unit').textContent = u.dist;
  $('pace').textContent = fmtPace(paceSecs(unit, t.paceSpeed));
  const avgPace = t.distance > 16 && t.movingTime > 0 ? t.movingTime / distIn(unit, t.distance) : null;
  $('avg-pace').textContent = fmtPace(avgPace);
  $('time').textContent = fmtDuration(t.elapsed);
  $('avg-speed').textContent = fmt(speedIn(unit, t.averageSpeed));
  $('max-speed').textContent = fmt(speedIn(unit, t.maxSpeed));
  document.querySelectorAll('.pace-unit').forEach(e => (e.textContent = u.pace));
  document.querySelectorAll('.speed-unit').forEach(e => (e.textContent = u.speed));
  document.querySelectorAll('#unit-seg button').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));

  // status
  let color = 'gray', text = 'Ready';
  if (geoState === 'denied') { color = 'red'; text = 'Location blocked'; }
  else if (t.state === 'paused') { color = 'orange'; text = 'Paused'; }
  else if (t.state === 'running') { color = t.hasSignal ? 'green' : 'yellow'; text = t.hasSignal ? 'GPS locked' : 'Searching for GPS…'; }
  $('dot').className = 'dot ' + color;
  $('status-text').textContent = text;

  // splits
  const splits = t.splits(unit);
  $('splits').hidden = splits.length === 0;
  if (splits.length) {
    const best = Math.min(...splits);
    $('splits-list').innerHTML = splits.map((s, i) => [i, s]).reverse().map(([i, s]) =>
      `<li><span>${u.dist} ${i + 1}</span><span>${s === best && splits.length > 1 ? '<span class="star">★</span>' : ''}${fmtPace(s)}${u.pace}</span></li>`).join('');
  }

  // notices
  const n = $('notice');
  if (geoState === 'denied') { n.hidden = false; n.className = 'notice error'; n.textContent = 'Location is blocked. Allow location access for this site in your browser settings, then tap Start.'; }
  else if (geoState === 'unsupported') { n.hidden = false; n.className = 'notice error'; n.textContent = 'This browser does not support location.'; }
  else if (interrupted && t.state === 'running') { n.hidden = false; n.className = 'notice'; n.textContent = 'The app was in the background, so part of the ride was not tracked. Keep the screen on and this page open.'; }
  else if (t.state === 'running' && !wakeLock && 'wakeLock' in navigator) { n.hidden = false; n.className = 'notice'; n.textContent = 'Keep this screen on while riding: the browser stops tracking when the screen locks.'; }
  else n.hidden = true;

  renderControls();
}

let lastControls = '';
function renderControls() {
  const s = tracker.state;
  if (s === lastControls) return;
  lastControls = s;
  const c = $('controls');
  if (s === 'idle') c.innerHTML = '<button class="btn green" data-act="start">Start</button>';
  else if (s === 'running') c.innerHTML = '<button class="btn orange" data-act="pause">Pause</button>';
  else c.innerHTML = '<button class="btn green" data-act="start">Resume</button><button class="btn blue" data-act="finish">Finish</button><button class="link-btn" data-act="discard">Discard ride</button>';
}
$('controls').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'start') start();
  else if (act === 'pause') pause();
  else if (act === 'finish') finish();
  else if (act === 'discard' && confirm('Discard this ride?')) discard();
});

$('unit-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  unit = b.dataset.unit;
  store.set('unit', unit);
  render(); renderHistory(); renderSettings();
});

// ---------- ride summary ----------
function rideSummaryHTML(ride) {
  const u = UNITS[unit];
  const avg = ride.movingTime > 0 ? ride.distanceMeters / ride.movingTime : 0;
  const row = (k, v) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`;
  const bike = Math.round(bikingKcal(weightKg, avg, ride.movingTime));
  const run = Math.round(runningKcal(weightKg, ride.distanceMeters));
  const splits = unit === 'miles' ? ride.mileSplits : ride.kmSplits;
  const best = Math.min(...splits);
  return `
    <div class="card">
      ${row('Distance', `${fmt(distIn(unit, ride.distanceMeters), 2)} ${u.dist}`)}
      ${row('Moving time', fmtDuration(ride.movingTime))}
      ${row('Total time', fmtDuration(ride.elapsed))}
      ${row('Avg pace', `${fmtPace(paceSecs(unit, avg))}${u.pace}`)}
      ${row('Avg speed', `${fmt(speedIn(unit, avg))} ${u.speed}`)}
      ${row('Max speed', `${fmt(speedIn(unit, ride.maxSpeed))} ${u.speed}`)}
    </div>
    <h2>Estimated calories</h2>
    <div class="card">${row('Biking', `${bike} kcal`)}${row('Running', `${run} kcal`)}</div>
    <p class="foot">Rough estimates based on your weight (set in Settings), average speed and distance. Running shows what the same distance would burn on foot.</p>
    ${splits.length ? `<h2>Splits</h2><div class="card">${splits.map((s, i) =>
      row(`${u.dist} ${i + 1}`, `${s === best && splits.length > 1 ? '<span class="star">★</span>' : ''}${fmtPace(s)}${u.pace}`)).join('')}</div>` : ''}`;
}

let sheetRide = null;
function showSheet(ride, canDelete) {
  sheetRide = ride;
  $('sheet-title').textContent = new Date(ride.startDate).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('sheet-body').innerHTML = rideSummaryHTML(ride);
  $('sheet-delete').hidden = !canDelete;
  $('sheet').hidden = false;
  $('sheet').scrollTop = 0;
}
$('sheet-back').addEventListener('click', () => { $('sheet').hidden = true; sheetRide = null; });
$('sheet-delete').addEventListener('click', () => {
  if (!sheetRide || !confirm('Delete this ride?')) return;
  rides = rides.filter(r => r.id !== sheetRide.id);
  store.set('rides', rides);
  $('sheet').hidden = true; sheetRide = null;
  renderHistory();
});

// ---------- history ----------
function renderHistory() {
  const u = UNITS[unit], el = $('history-list');
  if (!rides.length) { el.innerHTML = '<div class="empty"><b>No rides yet</b>Finished rides show up here.</div>'; return; }
  el.innerHTML = rides.map((r, i) => {
    const avg = r.movingTime > 0 ? r.distanceMeters / r.movingTime : 0;
    return `<button class="ride-item" data-i="${i}"><b>${new Date(r.startDate).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</b>
      <span>${fmt(distIn(unit, r.distanceMeters), 2)} ${u.dist} · ${fmtDuration(r.movingTime)} · ${fmtPace(paceSecs(unit, avg))}${u.pace}</span></button>`;
  }).join('');
}
$('history-list').addEventListener('click', e => {
  const b = e.target.closest('.ride-item');
  if (b) showSheet(rides[+b.dataset.i], true);
});

// ---------- settings ----------
function renderSettings() {
  const lb = unit === 'miles';
  $('weight').value = Math.round(lb ? weightKg * 2.20462 : weightKg);
  $('weight-unit').textContent = lb ? 'lb' : 'kg';
}
$('weight').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  if (!(v >= 50 && v <= 700)) { renderSettings(); return; }
  weightKg = unit === 'miles' ? v / 2.20462 : v;
  store.set('weightKg', weightKg);
  renderSettings();
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(rides, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `speedometer-rides-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- tabs ----------
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  for (const name of ['ride', 'history', 'settings']) $('view-' + name).hidden = name !== b.dataset.tab;
  if (b.dataset.tab === 'history') renderHistory();
  if (b.dataset.tab === 'settings') renderSettings();
});

// ---------- boot ----------
setInterval(() => { tracker.tick(Date.now()); if (!document.hidden) render(); }, 500);
render(); renderHistory(); renderSettings();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
