import * as THREE from 'three';
import type { World, Gate, Line } from './world';

export type Mode = 'race' | 'training' | 'freeride';
export const GATE_PENALTY = 3;

/** Fortschritt entlang der Mittellinie (s in Metern). */
export class Track {
  private x: Float32Array;
  private z: Float32Array;
  private idx = 0;
  readonly step: number;
  constructor(world: World) {
    const p = world.points;
    this.x = new Float32Array(p.map((v) => v.x));
    this.z = new Float32Array(p.map((v) => v.z));
    this.step = world.meta.course.points_step;
  }
  reset(s = 0) { this.idx = Math.round(s / this.step); }
  /** s und seitlicher Abstand. */
  locate(px: number, pz: number): { s: number; dist: number } {
    let best = this.idx, bd = Infinity;
    const lo = Math.max(0, this.idx - 40), hi = Math.min(this.x.length - 1, this.idx + 60);
    for (let i = lo; i <= hi; i++) {
      const d = (this.x[i] - px) ** 2 + (this.z[i] - pz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 120 * 120) {               // weit weg: global suchen
      for (let i = 0; i < this.x.length; i++) {
        const d = (this.x[i] - px) ** 2 + (this.z[i] - pz) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this.idx = best;
    return { s: best * this.step, dist: Math.sqrt(bd) };
  }
  point(s: number) {
    const i = Math.max(0, Math.min(this.x.length - 1, Math.round(s / this.step)));
    return new THREE.Vector3(this.x[i], 0, this.z[i]);
  }
  dirAt(s: number) {
    const i = Math.max(0, Math.min(this.x.length - 2, Math.round(s / this.step)));
    return new THREE.Vector3(this.x[i + 1] - this.x[i], 0, this.z[i + 1] - this.z[i]).normalize();
  }
}

function crossed(line: Line | Gate, a: THREE.Vector3, b: THREE.Vector3): number | null {
  const da = (a.x - line.pos.x) * line.fwd.x + (a.z - line.pos.z) * line.fwd.z;
  const db = (b.x - line.pos.x) * line.fwd.x + (b.z - line.pos.z) * line.fwd.z;
  if (!(da < 0 && db >= 0)) return null;
  const t = da / (da - db);
  const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
  return (x - line.pos.x) * line.right.x + (z - line.pos.z) * line.right.z;
}

export interface RaceEvents {
  onGate?: (g: Gate, ok: boolean) => void;
  onSplit?: (i: number, t: number, diff: number | null) => void;
  onSection?: (name: string) => void;
  onFinish?: (t: number) => void;
  onStart?: () => void;
}

export class Race {
  state: 'ready' | 'running' | 'finished' = 'ready';
  time = 0;
  penalty = 0;
  missed = 0;
  passed = 0;
  nextGate = 0;
  splitTimes: number[] = [];
  lastGatePos: { pos: THREE.Vector3; fwd: THREE.Vector3 } | null = null;
  s = 0;
  dist = 0;
  private sectionIdx = 0;
  private splitIdx = 0;
  events: RaceEvents = {};
  readonly track: Track;

  constructor(private world: World, readonly mode: Mode, private bestSplits: number[] | null) {
    this.track = new Track(world);
  }

  get total() { return this.time + this.penalty; }

  reset(fromS = 0) {
    this.state = 'ready';
    this.time = 0; this.penalty = 0; this.missed = 0; this.passed = 0;
    this.splitTimes = [];
    this.track.reset(fromS);
    this.nextGate = this.world.gates.findIndex((g) => g.s > fromS + 5);
    if (this.nextGate < 0) this.nextGate = this.world.gates.length;
    this.sectionIdx = this.world.meta.course.sections.findIndex((x) => x.s > fromS);
    if (this.sectionIdx < 0) this.sectionIdx = this.world.meta.course.sections.length;
    this.splitIdx = this.world.meta.course.splits.findIndex((x) => x > fromS);
    if (this.splitIdx < 0) this.splitIdx = 99;
    this.lastGatePos = null;
  }

  update(dt: number, prev: THREE.Vector3, cur: THREE.Vector3) {
    const loc = this.track.locate(cur.x, cur.z);
    this.s = loc.s; this.dist = loc.dist;
    if (this.mode === 'freeride') return;
    const w = this.world;
    if (this.state === 'ready') {
      if (crossed(w.start, prev, cur) !== null) {
        this.state = 'running';
        this.events.onStart?.();
      }
      return;
    }
    if (this.state !== 'running') return;
    this.time += dt;
    // Tore
    while (this.nextGate < w.gates.length) {
      const g = w.gates[this.nextGate];
      const lat = crossed(g, prev, cur);
      if (lat !== null && Math.abs(g.pos.x - cur.x) + Math.abs(g.pos.z - cur.z) < 60) {
        const ok = Math.abs(lat) <= g.width / 2;
        this.gateResult(g, ok);
        continue;
      }
      if (this.s > g.s + 25) { this.gateResult(g, false); continue; }
      break;
    }
    // Abschnitte + Zwischenzeiten
    const secs = w.meta.course.sections;
    while (this.sectionIdx < secs.length && this.s >= secs[this.sectionIdx].s) {
      this.events.onSection?.(secs[this.sectionIdx].name);
      this.sectionIdx++;
    }
    const sp = w.meta.course.splits;
    while (this.splitIdx < sp.length && this.s >= sp[this.splitIdx]) {
      const t = this.total;
      this.splitTimes[this.splitIdx] = t;
      const best = this.bestSplits?.[this.splitIdx];
      this.events.onSplit?.(this.splitIdx, t, best != null ? t - best : null);
      this.splitIdx++;
    }
    // Ziel
    const lat = crossed(w.finish, prev, cur);
    if (lat !== null && Math.abs(lat) < w.finish.width / 2 + 10) {
      this.state = 'finished';
      // Rest-Tore als verpasst
      while (this.nextGate < w.gates.length) this.gateResult(w.gates[this.nextGate], false);
      this.events.onFinish?.(this.total);
    }
  }

  private gateResult(g: Gate, ok: boolean) {
    this.nextGate++;
    if (ok) { this.passed++; this.lastGatePos = { pos: g.pos.clone(), fwd: g.fwd.clone() }; }
    else {
      this.missed++;
      if (this.mode === 'race') this.penalty += GATE_PENALTY;
      this.lastGatePos = { pos: g.pos.clone(), fwd: g.fwd.clone() };
    }
    this.events.onGate?.(g, ok);
  }
}

export function fmt(t: number, sign = false): string {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const str = m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : s.toFixed(2);
  return (sign ? (neg ? '−' : '+') : neg ? '−' : '') + str;
}
