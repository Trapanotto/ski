import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Heightfield, type CourseMeta } from './heightfield';

export type Quality = 'low' | 'mid' | 'high';
export const QSET = {
  low: { lod0: 650, treeNear: 220, treeFar: 1700, density: 0.35, shadows: false, pixel: 1, shadowMap: 1024 },
  mid: { lod0: 1100, treeNear: 380, treeFar: 2600, density: 0.65, shadows: true, pixel: 1.5, shadowMap: 2048 },
  high: { lod0: 1700, treeNear: 600, treeFar: 3800, density: 1, shadows: true, pixel: 2, shadowMap: 2048 },
};

export interface Gate { index: number; pos: THREE.Vector3; fwd: THREE.Vector3; right: THREE.Vector3; width: number; s: number }
export interface Line { pos: THREE.Vector3; fwd: THREE.Vector3; right: THREE.Vector3; width: number }
export interface Lift { name: string; bottom: THREE.Vector3; top: THREE.Vector3; dir: THREE.Vector3 }
export interface Box { x: number; z: number; hl: number; hw: number; c: number; s: number }

const BASE = import.meta.env.BASE_URL;

/**
 * Schnee: Lambert + prozedurale Details im Shader
 * - feine Unebenheiten und Windrillen (gestoerte Normale, nur in der Naehe)
 * - leichte Helligkeitsvariation
 * - Glitzern (Eiskristalle, blickwinkelabhaengig) und weicher Glanz gegen die Sonne
 */
export const snowUniforms = { uSunView: { value: new THREE.Vector3(0, 1, 0) } };
function snowMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSunView = snowUniforms.uSunView;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform vec3 uSunView;
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * sNoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
float sSurf(vec2 p) {
  float big = sFbm(p * 0.08);                                    // Mulden ~10 m
  float rip = sin(dot(p, vec2(0.83, 0.55)) * 2.2 + big * 9.0);    // Windrillen
  return big * 1.6 + sFbm(p * 0.7) * 0.5 + rip * 0.12;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float sDist = length(vViewPosition);
float sNear = clamp(1.0 - sDist / 900.0, 0.0, 1.0);
diffuseColor.rgb *= 0.9 + 0.12 * sFbm(vWPos.xz * 0.05) + 0.07 * sNear * (sNoise(vWPos.xz * 3.0) - 0.5);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (sNear > 0.0) {
  float e = 0.25;
  float h0 = sSurf(vWPos.xz);
  vec3 g = vec3(sSurf(vWPos.xz + vec2(e, 0.0)) - h0, 0.0, sSurf(vWPos.xz + vec2(0.0, e)) - h0) / e;
  vec3 pert = vec3(-g.x, 0.0, -g.z) * 0.45 * sNear;
  normal = normalize(normal + (viewMatrix * vec4(pert, 0.0)).xyz);
}`)
      .replace('#include <opaque_fragment>', `
{
  vec3 V = normalize(vViewPosition);
  vec3 R = reflect(-uSunView, normal);
  float spec = max(dot(R, V), 0.0);
  float lit = clamp(dot(normal, uSunView), 0.0, 1.0);
  // Glitzern: zufaellige Kristalle, die nur bei passendem Winkel aufblitzen
  vec3 cell = floor(vWPos * 9.0);
  float h = sHash(cell.xz + cell.y * 7.13);
  float facet = sHash(cell.zx + 3.7);
  float glint = step(0.985, h) * pow(max(dot(R, V) * (0.9 + 0.1 * facet), 0.0), 3.0);
  float near = clamp(1.0 - sDist / 70.0, 0.0, 1.0);
  outgoingLight += vec3(1.6, 1.6, 1.7) * glint * near * lit;
  outgoingLight += vec3(1.0, 0.97, 0.9) * pow(spec, 24.0) * 0.18 * lit;   // weicher Glanz
}
#include <opaque_fragment>`);
  };
  return m;
}

interface Chunk { cx: number; cz: number; center: THREE.Vector3; lod0?: THREE.Object3D; lod1?: THREE.Object3D;
  near: THREE.InstancedMesh[]; far: THREE.InstancedMesh[] }

/** Laedt eine Strecke (Gelaende, Panorama, Strecke, Baeume, Gebaeude, Lifte). */
export class World {
  scene = new THREE.Scene();
  meta!: CourseMeta;
  hf!: Heightfield;
  sun!: THREE.DirectionalLight;
  gates: Gate[] = [];
  start!: Line;
  finish!: Line;
  points: THREE.Vector3[] = [];
  nets: { a: THREE.Vector2; b: THREE.Vector2 }[] = [];
  lifts: Lift[] = [];
  boxes: Box[] = [];
  skierTemplates: Record<'M' | 'F', THREE.Object3D> = {} as never;
  propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private terrainMat = snowMaterial();
  private sunDir = new THREE.Vector3(-0.62, 0.42, 0.66).normalize();
  private chunks: Chunk[] = [];
  private treeX!: Float32Array;
  private treeZ!: Float32Array;
  private treeR!: Float32Array;
  private gridStart!: Int32Array;
  private gridItems!: Int32Array;
  private gridW = 0;
  private gridH = 0;
  private q = QSET.mid;
  private sky!: THREE.Mesh;

  async load(id: string, quality: Quality, progress: (f: number, t: string) => void) {
    this.q = QSET[quality];
    const dir = `${BASE}courses/${id}/`;
    const draco = new DRACOLoader().setDecoderPath(`${BASE}draco/`);
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const glb = (url: string, w: number, base: number) =>
      loader.loadAsync(url, (e) => e.total && progress(base + (w * e.loaded) / e.total, ''));

    progress(0.02, 'Lade Streckendaten …');
    this.meta = await (await fetch(dir + 'meta.json')).json();
    this.hf = new Heightfield(await (await fetch(dir + 'height.bin')).arrayBuffer(), this.meta);
    const treesBuf = await (await fetch(dir + 'trees.bin')).arrayBuffer();

    progress(0.08, 'Lade Modelle …');
    const [skier, props] = await Promise.all([glb(`${BASE}models/skier.glb`, 0.04, 0.08), glb(`${BASE}models/props.glb`, 0.04, 0.12)]);
    progress(0.16, 'Lade Panorama …');
    const pano = await glb(dir + 'panorama.glb', 0.08, 0.16);
    progress(0.24, 'Lade Gelände …');
    const lod1 = await glb(dir + 'terrain_lod1.glb', 0.08, 0.24);
    const course = await glb(dir + 'course.glb', 0.06, 0.32);
    progress(0.38, 'Lade Gelände (Detail) …');
    const lod0 = await glb(dir + 'terrain_lod0.glb', 0.45, 0.38);
    progress(0.85, 'Pflanze Bäume …');

    this.setupEnvironment();
    this.setupTerrain(lod0.scene, lod1.scene, pano.scene);
    this.setupCourse(course.scene);
    this.setupProps(props.scene, treesBuf);
    this.setupSkiers(skier.scene);
    this.scene.updateMatrixWorld(true);
    progress(1, 'Bereit');
  }

  // ---------------------------------------------------------------- Himmel, Licht, Nebel
  private setupEnvironment() {
    const s = this.scene;
    const horizon = new THREE.Color('#cfe1f2');
    s.background = horizon;
    s.fog = new THREE.Fog(horizon, 2500, 34000);
    if (this.meta.sun) this.sunDir.fromArray(this.meta.sun).normalize();
    s.add(new THREE.HemisphereLight('#a9c8f5', '#dfe6ef', 0.8));
    const sun = new THREE.DirectionalLight('#fff1dc', 2.3);
    sun.position.copy(this.sunDir).multiplyScalar(100);
    sun.castShadow = this.q.shadows;
    sun.shadow.mapSize.set(this.q.shadowMap, this.q.shadowMap);
    const sc = sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    s.add(sun, sun.target);
    this.sun = sun;

    const skyGeo = new THREE.SphereGeometry(1, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#2f6fc4') }, hor: { value: horizon }, sunDir: { value: sun.position.clone().normalize() } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(hor, top, pow(h, 0.55));
          float sd = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(1.0,0.95,0.85) * (pow(sd, 900.0) * 1.5 + pow(sd, 12.0) * 0.12);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.sky.scale.setScalar(1000);
    s.add(this.sky);
  }

  // ---------------------------------------------------------------- Gelaende
  private setupTerrain(l0: THREE.Object3D, l1: THREE.Object3D, pano: THREE.Object3D) {
    const [CX, CZ] = this.meta.chunks;
    const C = this.meta.chunk;
    for (let cz = 0; cz < CZ; cz++)
      for (let cx = 0; cx < CX; cx++) {
        const h = this.hf.height(cx * C + C / 2, cz * C + C / 2);
        this.chunks.push({ cx, cz, center: new THREE.Vector3(cx * C + C / 2, h, cz * C + C / 2), near: [], far: [] });
      }
    const take = (root: THREE.Object3D, prefix: string, key: 'lod0' | 'lod1') => {
      const list: THREE.Object3D[] = [];
      root.traverse((o) => { if (o.name.startsWith(prefix)) list.push(o); });
      for (const o of list) {
        const [, cx, cz] = o.name.split('_').map(Number);
        const ch = this.chunks[cz * CX + cx];
        o.traverse((m) => {
          if ((m as THREE.Mesh).isMesh) {
            const mesh = m as THREE.Mesh;
            mesh.material = this.terrainMat;
            mesh.receiveShadow = key === 'lod0' && this.q.shadows;
            mesh.frustumCulled = true;
          }
        });
        ch[key] = o;
        this.scene.add(o);
      }
    };
    take(l0, 'T0_', 'lod0');
    take(l1, 'T1_', 'lod1');
    pano.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).material = this.terrainMat; });
    this.scene.add(pano);
  }

  // ---------------------------------------------------------------- Strecke aus course.glb
  private setupCourse(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const pts = this.meta.course.points;
    this.points = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const nearestS = (p: THREE.Vector3) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i][0] - p.x) ** 2 + (pts[i][2] - p.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best * this.meta.course.points_step;
    };
    const frame = (o: THREE.Object3D) => {
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      o.matrixWorld.decompose(pos, q, sc);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      return { pos, fwd, right };
    };
    root.traverse((o) => {
      const ud = o.userData;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        if (o.name === 'Nets') {
          m.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
        } else {
          m.material = this.propMat;
          m.castShadow = this.q.shadows;
        }
      }
      if (ud.kind === 'gate') {
        const f = frame(o);
        this.gates.push({ index: ud.index, ...f, width: ud.width ?? 12, s: nearestS(f.pos) });
      } else if (ud.kind === 'start') {
        this.start = { ...frame(o), width: 8 };
      } else if (ud.kind === 'finish') {
        this.finish = { ...frame(o), width: ud.width ?? 40 };
      } else if (ud.kind === 'nets' && ud.runs) {
        for (const run of JSON.parse(ud.runs) as [number, number][][])
          for (let i = 0; i < run.length - 1; i++)
            this.nets.push({ a: new THREE.Vector2(...run[i]), b: new THREE.Vector2(...run[i + 1]) });
      } else if (ud.kind === 'lift' && ud.cable) {
        const cab = (JSON.parse(ud.cable) as number[][]).map((c) => new THREE.Vector3(c[0], c[1], c[2]));
        this.addCable(cab, ud.name ?? '');
      }
    });
    this.gates.sort((a, b) => a.index - b.index);
    this.scene.add(root);
  }

  private addCable(pts: THREE.Vector3[], name: string) {
    if (pts.length < 2) return;
    const verts: number[] = [];
    for (const side of [-2.3, 2.3]) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
        const n = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(side);
        const segs = 8;
        for (let k = 0; k < segs; k++) {
          const t0 = k / segs, t1 = (k + 1) / segs;
          const sag = (t: number) => -Math.sin(Math.PI * t) * a.distanceTo(b) * 0.02;
          const p0 = a.clone().lerp(b, t0).add(n); p0.y += sag(t0);
          const p1 = a.clone().lerp(b, t1).add(n); p1.y += sag(t1);
          verts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#30363d' })));
    const first = pts[0], last = pts[pts.length - 1];
    const [bottom, top] = first.y < last.y ? [first, last] : [last, first];
    const dir = new THREE.Vector3().subVectors(top, bottom).setY(0).normalize();
    this.lifts.push({ name, bottom: bottom.clone(), top: top.clone(), dir });
  }

  // ---------------------------------------------------------------- Baeume + Gebaeude
  private setupProps(props: THREE.Object3D, treesBuf: ArrayBuffer) {
    const geo = (name: string) => {
      const o = props.getObjectByName(name) as THREE.Mesh;
      return o.geometry;
    };
    const gA = geo('Tree_A'), gB = geo('Tree_B'), gF = geo('Tree_Far');
    const raw = new Uint16Array(treesBuf);
    const nAll = raw.length / 3;
    const n = Math.floor(nAll * this.q.density);
    const [CX] = this.meta.chunks;
    const C = this.meta.chunk;
    const buckets: number[][] = this.chunks.map(() => []);
    this.treeX = new Float32Array(n); this.treeZ = new Float32Array(n); this.treeR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = raw[i * 3] / 10, z = raw[i * 3 + 1] / 10, h = raw[i * 3 + 2] / 10;
      this.treeX[i] = x; this.treeZ[i] = z; this.treeR[i] = 0.35 + h * 0.012;
      const ci = Math.min(Math.floor(z / C), this.meta.chunks[1] - 1) * CX + Math.min(Math.floor(x / C), CX - 1);
      buckets[ci].push(i);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let c = 0; c < this.chunks.length; c++) {
      const ids = buckets[c];
      if (!ids.length) continue;
      const a = ids.filter((_, k) => k % 3 !== 0), b = ids.filter((_, k) => k % 3 === 0);
      const make = (g: THREE.BufferGeometry, list: number[], shadow: boolean) => {
        const im = new THREE.InstancedMesh(g, this.propMat, list.length);
        list.forEach((i, k) => {
          const h = raw[i * 3 + 2] / 10;
          p.set(this.treeX[i], this.hf.height(this.treeX[i], this.treeZ[i]) - 0.3, this.treeZ[i]);
          q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
          sc.set(h * 0.75, h, h * 0.75);
          im.setMatrixAt(k, m4.compose(p, q, sc));
        });
        im.computeBoundingSphere();
        im.castShadow = shadow;
        im.visible = false;
        this.scene.add(im);
        return im;
      };
      this.chunks[c].near.push(make(gA, a, this.q.shadows), make(gB, b, this.q.shadows));
      this.chunks[c].far.push(make(gF, ids, false));
    }
    // Kollisionsraster (8 m)
    const cell = 8;
    this.gridW = Math.ceil(this.hf.sizeX / cell) + 1;
    this.gridH = Math.ceil(this.hf.sizeZ / cell) + 1;
    const counts = new Int32Array(this.gridW * this.gridH + 1);
    const cellOf = (i: number) => Math.floor(this.treeZ[i] / cell) * this.gridW + Math.floor(this.treeX[i] / cell);
    for (let i = 0; i < n; i++) counts[cellOf(i) + 1]++;
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.gridStart = counts;
    this.gridItems = new Int32Array(n);
    const fill = counts.slice();
    for (let i = 0; i < n; i++) this.gridItems[fill[cellOf(i)]++] = i;

    // Gebaeude
    const bl = this.meta.buildings;
    const chalet = new THREE.InstancedMesh(geo('Chalet'), this.propMat, bl.length);
    bl.forEach(([x, z, len, wid, ang, hgt], k) => {
      const y = Math.min(
        this.hf.height(x, z), this.hf.height(x + len / 2, z), this.hf.height(x - len / 2, z),
        this.hf.height(x, z + wid / 2), this.hf.height(x, z - wid / 2));
      p.set(x, y - 0.3, z);
      q.setFromAxisAngle(up, -ang);
      sc.set(len, Math.max(hgt, 4) / 0.95, wid);
      chalet.setMatrixAt(k, m4.compose(p, q, sc));
      this.boxes.push({ x, z, hl: len / 2, hw: wid / 2, c: Math.cos(ang), s: Math.sin(ang) });
    });
    chalet.computeBoundingSphere();
    chalet.castShadow = this.q.shadows;
    this.scene.add(chalet);
  }

  private setupSkiers(root: THREE.Object3D) {
    for (const k of ['M', 'F'] as const) {
      const o = root.getObjectByName(`Skier_${k}`)!;
      o.removeFromParent();
      o.position.set(0, 0, 0);
      o.traverse((m) => {
        if ((m as THREE.Mesh).isMesh) {
          (m as THREE.Mesh).material = this.propMat;
          m.castShadow = true;
        }
      });
      this.skierTemplates[k] = o;
    }
  }

  // ---------------------------------------------------------------- Laufzeit
  update(cam: THREE.Camera, focus: THREE.Vector3) {
    const cp = cam.position;
    this.sky.position.copy(cp);
    snowUniforms.uSunView.value.copy(this.sunDir).transformDirection(cam.matrixWorldInverse);
    for (const ch of this.chunks) {
      const d = Math.hypot(ch.center.x - cp.x, ch.center.z - cp.z) - this.meta.chunk * 0.6;
      const near = d < this.q.lod0;
      if (ch.lod0) ch.lod0.visible = near;
      if (ch.lod1) ch.lod1.visible = !near || !ch.lod0;
      const tn = d < this.q.treeNear;
      const tf = !tn && d < this.q.treeFar;
      for (const m of ch.near) m.visible = tn;
      for (const m of ch.far) m.visible = tf;
    }
    // Schatten folgt dem Fahrer
    const s = this.sun;
    s.target.position.copy(focus);
    s.position.copy(focus).addScaledVector(this.sunDir, 150);
    s.target.updateMatrixWorld();
  }

  /** Naechster Baum im Radius r: liefert Abstand-Ueberlappung (>0 = Kollision) und Richtung. */
  treeHit(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    const cell = 8;
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    for (let j = cj - 1; j <= cj + 1; j++) {
      if (j < 0 || j >= this.gridH) continue;
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || i >= this.gridW) continue;
        const c = j * this.gridW + i;
        for (let k = this.gridStart[c]; k < this.gridStart[c + 1]; k++) {
          const t = this.gridItems[k];
          const dx = x - this.treeX[t], dz = z - this.treeZ[t];
          const rr = r + this.treeR[t];
          if (dx * dx + dz * dz < rr * rr) { out.set(dx, dz).normalize(); return true; }
        }
      }
    }
    return false;
  }

  buildingHit(x: number, z: number): boolean {
    for (const b of this.boxes) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40) continue;
      const u = dx * b.c + dz * b.s, v = -dx * b.s + dz * b.c;
      if (Math.abs(u) < b.hl + 0.4 && Math.abs(v) < b.hw + 0.4) return true;
    }
    return false;
  }

  /** Netz-Kollision: liefert Normale (vom Netz weg) oder null. */
  netHit(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    const p = new THREE.Vector2(x, z);
    for (const n of this.nets) {
      const ab = n.b.clone().sub(n.a);
      if (Math.abs(n.a.x - x) > 30 || Math.abs(n.a.y - z) > 30) continue;
      const t = Math.max(0, Math.min(1, p.clone().sub(n.a).dot(ab) / ab.lengthSq()));
      const c = n.a.clone().addScaledVector(ab, t);
      const d = p.distanceTo(c);
      if (d < r) { out.copy(p).sub(c).normalize(); if (!isFinite(out.x)) out.set(1, 0); return true; }
    }
    return false;
  }
}
