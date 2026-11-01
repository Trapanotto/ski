import * as THREE from 'three';
import { World, QSET, type Quality } from './world';
import { Input } from './input';
import { Skier } from './skier';
import { Race, fmt, type Mode, GATE_PENALTY } from './race';
import { CameraRig, CAM_MODES } from './camera';
import { Effects } from './effects';
import { Sound } from './audio';
import { GhostRecorder, sampleGhost, loadBest, saveBest, type Best } from './ghost';

const COURSES = [
  { id: 'lauberhorn', name: 'Lauberhorn', place: 'Wengen', info: '≈4,1 km · 2315 → 1280 m', ready: true },
  { id: 'montlachaux', name: 'Mont Lachaux', place: 'Crans-Montana', info: '≈2,3 km · 2210 → 1545 m', ready: true },
  { id: 'engiadina', name: 'Engiadina', place: 'St. Moritz', info: '≈2,5 km · 2745 → 2040 m', ready: true },
  { id: 'beltrametti', name: 'Silvano Beltrametti', place: 'Lenzerheide', info: 'Weltcupfinal', ready: false },
  { id: 'granbecca', name: 'Gran Becca', place: 'Zermatt / Cervinia', info: 'Höchste Abfahrt', ready: false },
];
const MODE_HINT: Record<Mode, string> = {
  race: `Auf Zeit durch alle Tore. Verpasstes Tor = +${GATE_PENALTY} s. Beste Fahrt wird als Geist gespeichert.`,
  training: 'Ohne Strafzeit. Im Pausenmenü direkt zu jeder Schlüsselstelle springen.',
  freeride: 'Frei über den ganzen Berg – ohne Tore und Netze. Sprünge, Drehungen, Lifte (T).',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem('trapanotto-ski:' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('trapanotto-ski:' + k, v); } catch { /* egal */ } },
};

// ------------------------------------------------------------------ Zustand
const input = new Input();
if (input.isTouch) document.body.classList.add('touch');
const sound = new Sound();
let courseId = 'lauberhorn';
let rider: 'M' | 'F' = store.get('rider', 'M') as 'M' | 'F';
let mode: Mode = store.get('mode', 'race') as Mode;
let quality: Quality = store.get('quality', input.isTouch ? 'low' : 'mid') as Quality;

let renderer: THREE.WebGLRenderer | null = null;
let world: World | null = null;
let loadedKey = '';
let rig: CameraRig;
let skier: Skier | null = null;
let ghost: Skier | null = null;
let ghostOn = true;
let race: Race | null = null;
let fx: Effects | null = null;
let best: Best | null = null;
let rec = new GhostRecorder();
let running = false;
let paused = false;
let countdown = 0;
let finishTimer = 0;
let msgTimer = 0;
let sectionTimer = 0;
let outTimer = 0;
let lastAir = 0;
let wasCrashed = false;
let bestAir = 0;
let mapImg: HTMLImageElement | null = null;
const prevPos = new THREE.Vector3();

// ------------------------------------------------------------------ Menue
function buildMenu() {
  const wrap = $('courses');
  wrap.innerHTML = '';
  for (const c of COURSES) {
    const b = document.createElement('button');
    b.className = 'opt course' + (c.id === courseId ? ' sel' : '');
    b.disabled = !c.ready;
    b.innerHTML = `<span><b>${c.name}</b><br><small>${c.place}</small></span><small>${c.ready ? c.info : 'bald verfügbar'}</small>`;
    b.onclick = () => { courseId = c.id; buildMenu(); };
    wrap.appendChild(b);
  }
  const pick = (sel: string, attr: string, val: string) =>
    document.querySelectorAll<HTMLButtonElement>(`${sel} .opt`).forEach((b) => b.classList.toggle('sel', b.dataset[attr] === val));
  pick('#riders', 'rider', rider);
  pick('#modes', 'mode', mode);
  pick('#quality', 'q', quality);
  $('modehint').textContent = MODE_HINT[mode];
  $('help').innerHTML = input.isTouch
    ? 'Links wischen = lenken (nach oben = Hocke, nach unten = bremsen) · Rechts: Hocke halten, Sprung'
    : '<kbd>←</kbd><kbd>→</kbd> lenken · <kbd>↑</kbd> Hocke / anschieben · <kbd>↓</kbd> bremsen · <kbd>Leertaste</kbd> springen · '
      + '<kbd>C</kbd> Kamera · <kbd>R</kbd> Neustart · <kbd>G</kbd> Geist · <kbd>T</kbd> Lift (Freeride) · <kbd>Esc</kbd> Pause · Gamepad geht auch';
}
document.querySelectorAll<HTMLButtonElement>('#riders .opt').forEach((b) =>
  (b.onclick = () => { rider = b.dataset.rider as 'M' | 'F'; store.set('rider', rider); buildMenu(); }));
document.querySelectorAll<HTMLButtonElement>('#modes .opt').forEach((b) =>
  (b.onclick = () => { mode = b.dataset.mode as Mode; store.set('mode', mode); buildMenu(); }));
document.querySelectorAll<HTMLButtonElement>('#quality .opt').forEach((b) =>
  (b.onclick = () => { quality = b.dataset.q as Quality; store.set('quality', quality); buildMenu(); }));
$('play').onclick = () => void play();
$('resume').onclick = () => setPause(false);
$('restart').onclick = () => { setPause(false); startRun(); };
$('tomenu').onclick = toMenu;
$('again').onclick = () => { $('result').classList.add('hidden'); startRun(); };
$('resmenu').onclick = toMenu;
buildMenu();

function show(id: string, on: boolean) { $(id).classList.toggle('hidden', !on); }

function toMenu() {
  running = false; paused = false;
  show('pause', false); show('result', false); show('hud', false); show('touch', false); show('menu', true);
  sound.pause(true);
}

// ------------------------------------------------------------------ Laden
async function play() {
  sound.init();
  show('menu', false);
  const key = `${courseId}:${quality}`;
  if (key !== loadedKey) {
    show('loading', true);
    const bar = $('loadbar'), txt = $('loadtext');
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({
        canvas: $('game') as HTMLCanvasElement, antialias: quality !== 'low', logarithmicDepthBuffer: true,
        powerPreference: 'high-performance',
      });
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.9;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      rig = new CameraRig(innerWidth / innerHeight);
      addEventListener('resize', resize);
    }
    renderer.shadowMap.enabled = QSET[quality].shadows;
    renderer.setPixelRatio(Math.min(devicePixelRatio, QSET[quality].pixel));
    resize();
    if (world) disposeScene(world.scene);
    world = new World();
    try {
      await world.load(courseId, quality, (f, t) => { bar.style.width = `${Math.round(f * 100)}%`; if (t) txt.textContent = t; });
    } catch (e) {
      txt.textContent = 'Fehler beim Laden: ' + (e as Error).message;
      throw e;
    }
    fx = new Effects(world.scene);
    mapImg = new Image();
    mapImg.src = `${import.meta.env.BASE_URL}courses/${courseId}/map.jpg`;
    loadedKey = key;
    // Erstes Bild rendern, damit Shader kompiliert sind
    renderer.compile(world.scene, rig.cam);
    show('loading', false);
  }
  startRun();
}

function disposeScene(s: THREE.Scene) {
  s.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

function resize() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight, false);
  rig.cam.aspect = innerWidth / innerHeight;
  rig.cam.updateProjectionMatrix();
}

// ------------------------------------------------------------------ Lauf
function startRun(fromS = 0) {
  if (!world) return;
  const w = world;
  if (skier) w.scene.remove(skier.holder);
  if (ghost) w.scene.remove(ghost.holder);
  skier = new Skier(w.skierTemplates[rider], rider === 'F');
  skier.freeride = mode === 'freeride';
  w.scene.add(skier.holder);
  best = mode === 'freeride' ? null : loadBest(courseId, rider);
  ghost = null;
  if (best && fromS === 0) {
    ghost = new Skier(w.skierTemplates[rider], rider === 'F', true);
    ghost.holder.visible = ghostOn;
    w.scene.add(ghost.holder);
  }
  race = new Race(w, mode, best?.splits ?? null);
  race.reset(fromS);
  wireEvents();
  rec = new GhostRecorder();
  fx?.clearTrail();
  if (fromS === 0) {
    const p = w.start.pos.clone().addScaledVector(w.start.fwd, -2.5);
    skier.place(p, w.start.fwd, w);
    countdown = mode === 'freeride' ? 0 : 3.2;
  } else {
    const p = race.track.point(fromS);
    skier.place(p, race.track.dirAt(fromS), w, 6);
    countdown = 0;
    race.state = 'ready';
    if (mode !== 'freeride') { race.state = 'running'; }
  }
  if (mode === 'freeride') race.state = 'ready';
  finishTimer = 0; outTimer = 0; lastAir = 0;
  prevPos.copy(skier.pos);
  rig.mode = rig.mode === 3 ? 0 : rig.mode;
  rig.intro = countdown > 0.6;
  rig.snap(skier, w);
  show('hud', true); show('touch', input.isTouch); show('result', false);
  $('tLift').classList.toggle('hidden', mode !== 'freeride');
  $('split').textContent = ''; $('split').className = '';
  input.clearEvents();
  running = true; paused = false;
  sound.pause(false);
  if (fromS === 0 && mode !== 'freeride') message('3', 1);
  if (mode === 'freeride') message('Freeride', 1.5);
  buildSectionJump();
}

function wireEvents() {
  if (!skier || !race) return;
  const sk = skier;
  sk.events = {
    onCrash: (r) => { message(r === 'Baum' ? 'Autsch!' : 'Sturz!', 1.5); sound.thump(0.8); rig.bump(1); },
    onLand: (imp, air) => {
      if (air > 0.35) { lastAir = air; bestAir = Math.max(bestAir, air); }
      if (imp > 4) { rig.bump(imp / 20); sound.thump(Math.min(0.6, imp / 25)); fx?.burst(sk.pos, Math.floor(imp * 2), 4, 3); }
      if (mode === 'freeride' && air > 0.8) {
        const turns = Math.round(Math.abs(sk.spin) / (Math.PI * 2) * 2) / 2;
        message(turns >= 1 ? `${turns * 360}°  ·  ${air.toFixed(1)} s` : `${air.toFixed(1)} s Luft`, 1.4);
      }
    },
    onJump: () => fx?.burst(sk.pos, 12, 2, 2),
  };
  race.events = {
    onStart: () => { sound.beep(1320, 0.25, 0.25); },
    onGate: (_g, ok) => { if (!ok) { message(mode === 'race' ? `Tor verpasst +${GATE_PENALTY} s` : 'Tor verpasst', 1.2); sound.beep(220, 0.25, 0.2); } },
    onSplit: (_i, t, diff) => {
      const el = $('split');
      el.textContent = diff === null ? fmt(t) : fmt(diff, true);
      el.className = diff === null ? '' : diff <= 0 ? 'good' : 'bad';
      sound.beep(990, 0.1, 0.15);
      setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
    },
    onSection: (name) => {
      if (name === 'Start') return;
      $('section').textContent = name;
      $('section').classList.add('show');
      sectionTimer = 2.2;
    },
    onFinish: (t) => {
      finishTimer = 3.2;
      const el = $('split');
      if (best) { const d = t - best.time; el.textContent = fmt(d, true); el.className = d <= 0 ? 'good' : 'bad'; }
      message(mode === 'race' && (!best || t < best.time) ? 'Bestzeit!' : 'Ziel', 3);
    },
  };
}

function message(t: string, dur: number) { $('msg').textContent = t; msgTimer = dur; }

function setPause(p: boolean) {
  if (!running) return;
  paused = p;
  show('pause', p);
  sound.pause(p);
}

function buildSectionJump() {
  const wrap = $('sectionjump');
  wrap.innerHTML = '';
  if (!world || mode === 'race') return;
  for (const s of world.meta.course.sections) {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = s.name;
    b.onclick = () => { setPause(false); startRun(Math.max(0, s.s - 30)); if (s.s === 0) startRun(); };
    wrap.appendChild(b);
  }
}

function showResult() {
  if (!race || !skier) return;
  running = false;
  const t = race.total;
  const isBest = mode === 'race' && (!best || t < best.time);
  if (isBest) {
    saveBest(courseId, rider, { time: t, splits: race.splitTimes, frames: rec.frames, rider, date: new Date().toISOString() });
  }
  $('restitle').textContent = isBest ? 'Neue Bestzeit!' : 'Ziel';
  $('restime').textContent = fmt(t);
  const names = world!.meta.course.sections;
  const splitNames = world!.meta.course.splits.map((s) => names.find((n) => Math.abs(n.s - s) < 1)?.name ?? '');
  let rows = race.splitTimes.map((st, i) => {
    const b = best?.splits?.[i];
    const d = b != null ? `<span class="${st - b <= 0 ? 'pos' : 'neg'}">${fmt(st - b, true)}</span>` : '';
    return `<tr><td>${splitNames[i] || 'Zwischenzeit ' + (i + 1)}</td><td>${fmt(st)} ${d}</td></tr>`;
  }).join('');
  rows += `<tr><td>Tore</td><td>${race.passed} / ${world!.gates.length}${race.missed ? ` (${race.missed} verpasst${mode === 'race' ? `, +${race.penalty} s` : ''})` : ''}</td></tr>`;
  rows += `<tr><td>Höchsttempo</td><td>${Math.round(skier.topSpeed * 3.6)} km/h</td></tr>`;
  if (best && !isBest) rows += `<tr><td>Bestzeit</td><td>${fmt(best.time)} <span class="neg">${fmt(t - best.time, true)}</span></td></tr>`;
  $('resdetail').innerHTML = `<table>${rows}</table>`;
  show('result', true);
}

// ------------------------------------------------------------------ Schleife
const STEP = 1 / 120;
let acc = 0;
let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!renderer || !world || !skier || !race) return;
  input.update(dt);
  if (input.take('pause')) setPause(!paused);
  if (running && !paused) {
    if (input.take('restart')) startRun();
    if (input.take('camera')) { rig.next(); message(CAM_MODES[rig.mode], 0.8); }
    if (input.take('ghost')) { ghostOn = !ghostOn; if (ghost) ghost.holder.visible = ghostOn; message(ghostOn ? 'Geist an' : 'Geist aus', 0.8); }
    if (input.take('lift') && mode === 'freeride') useLift();
    simulate(dt);
  } else {
    input.clearEvents();
  }
  world.update(rig.cam, skier.pos);
  renderer.render(world.scene, rig.cam);
}
requestAnimationFrame(frame);

function simulate(dt: number) {
  const w = world!, sk = skier!, r = race!;
  // Countdown
  let frozen = false;
  if (countdown > 0) {
    const before = Math.ceil(countdown - 0.2);
    countdown -= dt;
    const after = Math.ceil(countdown - 0.2);
    if (after !== before) {
      if (after > 0) { message(String(after), 1); sound.beep(660, 0.12); }
      else { message('Los!', 0.8); }
    }
    frozen = countdown > 0.2;
  }
  const wasIntro = rig.intro;
  rig.intro = countdown > 0.6;
  if (wasIntro && !rig.intro) rig.snap(sk, w);
  const done = r.state === 'finished';
  if (import.meta.env.DEV && (window as unknown as { __ski?: { autopilot: boolean } }).__ski?.autopilot) autopilot();
  acc += dt;
  while (acc >= STEP) {
    acc -= STEP;
    prevPos.copy(sk.pos);
    sk.step(STEP, done ? null : input, w, frozen);
    if (done) sk.vel.multiplyScalar(Math.exp(-STEP * 1.2));
    r.update(STEP, prevPos, sk.pos);
  }
  if (r.state === 'running') rec.record(dt, sk.pos.x, sk.pos.y, sk.pos.z, sk.yaw, sk.lean, sk.tuck);

  // Nach Sturz wieder aufstellen
  if (sk.crashed <= 0 && wasCrashed) respawn();
  wasCrashed = sk.crashed > 0;

  // Ausserhalb der Strecke (Rennen/Training)
  if (mode !== 'freeride' && r.state === 'running') {
    if (r.dist > 70) {
      outTimer += dt;
      if (outTimer > 0.1 && msgTimer <= 0) message('Zurück auf die Strecke!', 1);
      if (r.dist > 140 || outTimer > 6) { respawn(); if (mode === 'race') r.penalty += 5; message('+5 s', 1.2); }
    } else outTimer = 0;
  }

  sk.updateVisual(dt, w);
  if (ghost && best) {
    const g = sampleGhost(best.frames, r.state === 'ready' ? 0 : r.time);
    if (g) {
      ghost.pos.set(g.x, g.y, g.z); ghost.yaw = g.yaw; ghost.tuck = g.tuck;
      ghost.updateVisual(dt, w);
      ghost.holder.visible = ghostOn && !g.done;
    }
  }
  rig.update(dt, sk, w);
  fx?.update(dt, sk, w);
  const nearFinish = w.finish.pos.distanceTo(sk.pos);
  sound.update(sk.speed, sk.carve, sk.skid, sk.airborne, Math.max(0, 1 - nearFinish / 400));
  if (sk.compression > 0.3) rig.bump(sk.compression * 0.05);

  if (done) {
    finishTimer -= dt;
    if (finishTimer <= 0 && running) showResult();
  }
  hud(dt);
}

/** Test-Autopilot: zielt auf das naechste Tor bzw. einen Punkt voraus. */
function autopilot() {
  const w = world!, sk = skier!, r = race!;
  const g = w.gates[r.nextGate];
  const ahead = r.track.point(r.s + 20 + sk.speed * 0.6);
  const tgt = g && g.s - r.s < 40 + sk.speed ? g.pos : ahead;
  const want = Math.atan2(tgt.z - sk.pos.z, tgt.x - sk.pos.x);
  const d = Math.atan2(Math.sin(want - sk.yaw), Math.cos(want - sk.yaw));
  input.steer = Math.max(-1, Math.min(1, d * 3));
  input.tuck = Math.abs(d) < 0.25;
  input.brake = Math.abs(d) > 1.2;
}

function respawn() {
  const w = world!, sk = skier!, r = race!;
  if (mode === 'freeride') { sk.vel.set(0, 0, 0); sk.place(sk.pos, sk.dir.clone(), w); return; }
  const s = Math.max(0, r.s - 15);
  sk.place(r.track.point(s), r.track.dirAt(s), w, 8);
  r.track.reset(s);
  outTimer = 0;
  rig.snap(sk, w);
}

function useLift() {
  const w = world!, sk = skier!;
  let bestL = null, bd = 300;
  for (const l of w.lifts) {
    const d = Math.hypot(l.bottom.x - sk.pos.x, l.bottom.z - sk.pos.z);
    if (d < bd) { bd = d; bestL = l; }
  }
  if (!bestL) { message('Kein Lift in der Nähe', 1.2); return; }
  const p = bestL.top.clone().addScaledVector(bestL.dir, 25);
  sk.place(p, bestL.dir.clone().negate(), w);
  rig.snap(sk, w);
  message(bestL.name ? `Lift ${bestL.name}` : 'Lift', 1.4);
}

function hud(dt: number) {
  const sk = skier!, r = race!, w = world!;
  if (mode === 'freeride') {
    $('timer').textContent = 'FREERIDE';
    $('info').innerHTML = `${Math.round(sk.pos.y)} m ü. M.<br>Sprung ${lastAir.toFixed(1)} s · Rekord ${bestAir.toFixed(1)} s`;
  } else {
    $('timer').textContent = fmt(r.state === 'ready' ? 0 : r.total);
    $('info').innerHTML = `Tor ${Math.min(r.nextGate + 1, w.gates.length)}/${w.gates.length}` +
      (r.missed ? `<br>${r.missed} verpasst` : '') + (ghost && best ? `<br>Bestzeit ${fmt(best.time)}` : '');
  }
  $('speed').querySelector('b')!.textContent = String(Math.round(sk.speed * 3.6));
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) $('msg').textContent = ''; }
  if (sectionTimer > 0) { sectionTimer -= dt; if (sectionTimer <= 0) $('section').classList.remove('show'); }
  drawMap();
}

function drawMap() {
  const c = $('minimap') as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  const w = world!, sk = skier!;
  const S = c.width;
  const span = 1100;                     // Meter im Ausschnitt
  const mpp = w.hf.sizeX / (mapImg?.naturalWidth || 1);
  g.save();
  g.clearRect(0, 0, S, S);
  g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#e8eef5'; g.fillRect(0, 0, S, S);
  const k = S / span;
  const ox = sk.pos.x - span / 2, oz = sk.pos.z - span / 2;
  if (mapImg?.complete && mapImg.naturalWidth) {
    g.drawImage(mapImg, ox / mpp, oz / mpp, span / mpp, span / mpp, 0, 0, S, S);
  }
  g.strokeStyle = '#d52b1e'; g.lineWidth = 2.5; g.beginPath();
  w.points.forEach((p, i) => { const x = (p.x - ox) * k, y = (p.z - oz) * k; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
  if (mode !== 'freeride' && race) {
    const ng = w.gates[race.nextGate];
    if (ng) { g.fillStyle = '#1f5fbf'; g.beginPath(); g.arc((ng.pos.x - ox) * k, (ng.pos.z - oz) * k, 4, 0, 7); g.fill(); }
  }
  g.translate(S / 2, S / 2);
  g.rotate(sk.yaw + Math.PI / 2);
  g.fillStyle = '#14202c'; g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 3); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke();
  g.restore();
}

// Testschnittstelle (nur im Entwicklungsmodus)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ski = {
    get state() {
      return skier && race ? {
        pos: skier.pos.toArray().map((v) => +v.toFixed(1)), speed: +(skier.speed * 3.6).toFixed(1), s: race.s, dist: +race.dist.toFixed(1),
        state: race.state, time: +race.time.toFixed(2), gate: race.nextGate, missed: race.missed, crashed: skier.crashed > 0,
        air: skier.airborne, yaw: +skier.yaw.toFixed(2),
      } : null;
    },
    jump: (s: number) => { startRun(s); },
    /** Simulation ohne Rendern vorspulen (Tests im verdeckten Fenster). */
    run: (sec: number) => { for (let t = 0; t < sec && running && !paused; t += 1 / 60) { input.update(1 / 60); simulate(1 / 60); } },
    world: () => world,
    autopilot: false,
  };
}

// Tab im Hintergrund -> Pause
document.addEventListener('visibilitychange', () => { if (document.hidden && running) setPause(true); });
