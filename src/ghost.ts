/** Aufzeichnung und Wiedergabe der besten Fahrt (lokal im Browser). */
const FIELDS = 6; // x, y, z, yaw, lean, tuck
const DT = 0.05;

export interface Best { time: number; splits: number[]; frames: number[]; rider: string; date: string }

export class GhostRecorder {
  frames: number[] = [];
  private acc = 0;
  record(dt: number, x: number, y: number, z: number, yaw: number, lean: number, tuck: number) {
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.frames.push(+x.toFixed(2), +y.toFixed(2), +z.toFixed(2), +yaw.toFixed(3), +lean.toFixed(2), +tuck.toFixed(2));
    }
  }
}

export function sampleGhost(frames: number[], t: number) {
  const n = frames.length / FIELDS;
  if (n < 2) return null;
  const f = Math.min(t / DT, n - 1.001);
  const i = Math.floor(f), u = f - i;
  const a = i * FIELDS, b = (i + 1) * FIELDS;
  const L = (k: number) => frames[a + k] + (frames[b + k] - frames[a + k]) * u;
  let dy = frames[b + 3] - frames[a + 3];
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return { x: L(0), y: L(1), z: L(2), yaw: frames[a + 3] + dy * u, lean: L(4), tuck: L(5), done: t / DT >= n - 1 };
}

const key = (course: string, rider: string) => `trapanotto-ski:best:${course}:${rider}`;

export function loadBest(course: string, rider: string): Best | null {
  try {
    const s = localStorage.getItem(key(course, rider));
    return s ? (JSON.parse(s) as Best) : null;
  } catch { return null; }
}

export function saveBest(course: string, rider: string, b: Best) {
  try { localStorage.setItem(key(course, rider), JSON.stringify(b)); } catch { /* Speicher nicht verfuegbar */ }
}
