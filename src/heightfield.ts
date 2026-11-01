import { Vector3 } from 'three';

export interface CourseMeta {
  id: string; name: string; place: string;
  step: number; W: number; H: number; hmin: number; hscale: number;
  chunk: number; chunks: [number, number]; size: [number, number];
  trees: number;
  buildings: [number, number, number, number, number, number][];
  lifts: { name: string; type: string; pts: [number, number][] }[];
  pistes: { d: string; pts: [number, number][] }[];
  course: {
    length: number; finish_s: number; points_step: number;
    points: [number, number, number][];
    sections: { name: string; s: number }[];
    splits: number[];
  };
  attribution: string;
  sun?: [number, number, number];
}

/** Hoehenraster aus height.bin. Gleiche Dreiecksteilung wie das Blender-Mesh. */
export class Heightfield {
  readonly W: number;
  readonly H: number;
  readonly step: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly data: Float32Array;

  constructor(buf: ArrayBuffer, meta: CourseMeta) {
    const u = new Uint16Array(buf);
    this.W = meta.W;
    this.H = meta.H;
    this.step = meta.step;
    this.sizeX = (meta.W - 1) * meta.step;
    this.sizeZ = (meta.H - 1) * meta.step;
    this.data = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) this.data[i] = meta.hmin + u[i] * meta.hscale;
  }

  height(x: number, z: number): number {
    const W = this.W;
    let fx = x / this.step;
    let fz = z / this.step;
    if (fx < 0) fx = 0; else if (fx > W - 1.001) fx = W - 1.001;
    if (fz < 0) fz = 0; else if (fz > this.H - 1.001) fz = this.H - 1.001;
    const i = fx | 0, j = fz | 0;
    const u = fx - i, v = fz - j;
    const d = this.data;
    const a = d[j * W + i], b = d[j * W + i + 1], c = d[(j + 1) * W + i + 1], e = d[(j + 1) * W + i];
    return u >= v ? a + (b - a) * u + (c - b) * v : a + (e - a) * v + (c - e) * u;
  }

  /** Geglaettete Normale (zentrale Differenzen). */
  normal(x: number, z: number, out: Vector3, e = 2): Vector3 {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  inside(x: number, z: number, margin = 0): boolean {
    return x > margin && z > margin && x < this.sizeX - margin && z < this.sizeZ - margin;
  }
}
