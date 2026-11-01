import * as THREE from 'three';
import type { Skier } from './skier';
import type { World } from './world';

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Schneestaub und Skispuren. */
export class Effects {
  private N = 700;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private points: THREE.Points;
  private next = 0;
  private trail: THREE.Mesh;
  private trailPos: Float32Array;
  private trailN = 600;
  private trailHead = 0;
  private trailCount = 0;
  private lastTrail = new THREE.Vector3(1e9, 0, 0);

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    this.life = new Float32Array(this.N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.28, map: dotTexture(), transparent: true, depthWrite: false, color: '#ffffff', opacity: 0.7,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Spur: zwei Linien je 600 Punkte als Dreiecksstreifen
    this.trailPos = new Float32Array(this.trailN * 2 * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    const idx: number[] = [];
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < this.trailN - 1; i++) {
        const a = (s * this.trailN + i) * 2, b = (s * this.trailN + i + 1) * 2;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    tg.setIndex(idx);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      color: '#b9cbe0', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
  }

  burst(at: THREE.Vector3, n: number, spread: number, up: number) {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.N;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.6;
      this.pos[i * 3 + 1] = at.y + 0.1;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.6;
      this.vel[i * 3] = (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 1] = Math.random() * up;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * spread;
      this.life[i] = 0.6 + Math.random() * 0.6;
    }
  }

  clearTrail() { this.trailCount = 0; this.trailHead = 0; this.trailPos.fill(0); this.lastTrail.set(1e9, 0, 0); }

  update(dt: number, sk: Skier, world: World) {
    // Staub beim Carven/Bremsen
    if (!sk.airborne && sk.crashed <= 0) {
      const amount = sk.skid * 1.2 + sk.carve * 0.8;
      const n = Math.floor(amount * sk.speed * dt * 8 + Math.random());
      if (n > 0) {
        const side = new THREE.Vector3(-Math.sin(sk.yaw), 0, Math.cos(sk.yaw));
        const at = sk.pos.clone().addScaledVector(side, Math.sign(sk.lean) * 0.3);
        for (let k = 0; k < n; k++) {
          this.burst(at, 1, 2.5, 1.8);
          const i = (this.next + this.N - 1) % this.N;
          this.vel[i * 3] += sk.vel.x * 0.35 + side.x * Math.sign(-sk.lean) * 3;
          this.vel[i * 3 + 2] += sk.vel.z * 0.35 + side.z * Math.sign(-sk.lean) * 3;
        }
      }
    }
    if (sk.crashed > 0 && sk.speed > 2) this.burst(sk.pos, 2, 3, 2);
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1e5; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 4 * dt;
      for (let c = 0; c < 3; c++) { this.vel[i * 3 + c] *= 1 - 1.5 * dt; this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    // Spuren
    if (!sk.airborne && sk.crashed <= 0 && sk.pos.distanceToSquared(this.lastTrail) > 1.2) {
      this.lastTrail.copy(sk.pos);
      const right = new THREE.Vector3(-Math.sin(sk.yaw), 0, Math.cos(sk.yaw));
      const fwd = new THREE.Vector3(Math.cos(sk.yaw), 0, Math.sin(sk.yaw));
      const i = this.trailHead;
      const fresh = this.trailCount === 0;
      this.trailHead = (this.trailHead + 1) % this.trailN;
      this.trailCount = Math.min(this.trailCount + 1, this.trailN);
      const nxt = this.trailHead;
      for (let s = 0; s < 2; s++) {
        const off = s === 0 ? -0.11 : 0.11;
        for (let e = 0; e < 2; e++) {
          const w = e === 0 ? -0.045 : 0.045;
          const x = sk.pos.x + right.x * (off + w), z = sk.pos.z + right.z * (off + w);
          const y = world.hf.height(x, z) + 0.03;
          const o = ((s * this.trailN + i) * 2 + e) * 3;
          this.trailPos[o] = x; this.trailPos[o + 1] = y; this.trailPos[o + 2] = z;
          if (fresh) {
            // ganzer Puffer auf den ersten Punkt -> keine Linien aus dem Nichts
            for (let k = 0; k < this.trailN; k++) {
              const q = ((s * this.trailN + k) * 2 + e) * 3;
              this.trailPos[q] = x; this.trailPos[q + 1] = y; this.trailPos[q + 2] = z;
            }
          } else {
            // aeltesten Punkt auf den neuesten legen -> Naht im Ringpuffer verschwindet
            const q = ((s * this.trailN + nxt) * 2 + e) * 3;
            this.trailPos[q] = x; this.trailPos[q + 1] = y; this.trailPos[q + 2] = z;
          }
        }
      }
      this.trail.geometry.attributes.position.needsUpdate = true;
    }
  }
}
