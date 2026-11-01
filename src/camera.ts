import * as THREE from 'three';
import type { Skier } from './skier';
import type { World } from './world';

export const CAM_MODES = ['Verfolger', 'Nah', 'Helm', 'TV'] as const;

/** Kamera: Verfolger, nah, Helm, TV (feste Punkte am Streckenrand). */
export class CameraRig {
  cam: THREE.PerspectiveCamera;
  mode = 0;
  intro = false;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, -1);
  private shake = 0;
  private tvPos = new THREE.Vector3();
  private tvTimer = 0;

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(62, aspect, 0.3, 60000);
  }

  next() { this.mode = (this.mode + 1) % CAM_MODES.length; this.tvTimer = 0; }

  bump(v: number) { this.shake = Math.min(1, this.shake + v); }

  snap(sk: Skier, world: World) {
    this.fwd.set(Math.cos(sk.yaw), 0, Math.sin(sk.yaw));
    this.update(10, sk, world, true);
  }

  update(dt: number, sk: Skier, world: World, instant = false) {
    const sp = sk.speed;
    // Blickrichtung folgt der Fahrtrichtung (bei Tempo) oder den Ski
    const target = new THREE.Vector3();
    if (sp > 3 && sk.crashed <= 0) target.set(sk.vel.x, 0, sk.vel.z).normalize();
    else target.set(Math.cos(sk.yaw), 0, Math.sin(sk.yaw));
    this.fwd.lerp(target, instant ? 1 : Math.min(1, dt * 3.2)).normalize();
    const hf = world.hf;
    const focus = sk.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
    let desired: THREE.Vector3;
    let lookAt: THREE.Vector3;
    let fov = 62 + Math.min(sp, 45) * 0.32;

    if (this.intro) {                // Startschuss: von vorne-seitlich auf den Fahrer
      const side = new THREE.Vector3(-this.fwd.z, 0, this.fwd.x);
      desired = focus.clone().addScaledVector(this.fwd, 5.5).addScaledVector(side, 2.5).add(new THREE.Vector3(0, 0.6, 0));
      lookAt = focus.clone().add(new THREE.Vector3(0, -0.2, 0));
      fov = 50;
    } else if (this.mode === 2) {           // Helm
      const head = sk.pos.clone().add(new THREE.Vector3(0, 1.0 + (1 - sk.tuck) * 0.55, 0)).addScaledVector(this.fwd, 0.25);
      desired = head;
      lookAt = head.clone().addScaledVector(this.fwd, 20).add(new THREE.Vector3(0, -3, 0));
      fov += 8;
    } else if (this.mode === 3) {    // TV
      this.tvTimer -= dt;
      if (this.tvTimer <= 0 || this.tvPos.distanceTo(sk.pos) > 160) {
        const ahead = sk.pos.clone().addScaledVector(this.fwd, 70 + sp * 1.2);
        const side = new THREE.Vector3(-this.fwd.z, 0, this.fwd.x).multiplyScalar(Math.random() > 0.5 ? 35 : -35);
        this.tvPos.copy(ahead).add(side);
        this.tvPos.y = hf.height(this.tvPos.x, this.tvPos.z) + 6;
        this.tvTimer = 7;
        instant = true;
      }
      desired = this.tvPos;
      lookAt = focus;
      const d = this.tvPos.distanceTo(sk.pos);
      fov = THREE.MathUtils.clamp(2400 / d, 18, 60);
    } else {
      const far = this.mode === 0;
      const dist = (far ? 6.2 : 3.6) + Math.min(sp, 40) * (far ? 0.06 : 0.03);
      const height = far ? 2.4 : 1.5;
      desired = focus.clone().addScaledVector(this.fwd, -dist).add(new THREE.Vector3(0, height, 0));
      lookAt = focus.clone().addScaledVector(this.fwd, 6);
    }
    const g = hf.height(desired.x, desired.z) + 1.2;
    if (desired.y < g) desired.y = g;
    const k = instant ? 1 : Math.min(1, dt * (this.mode === 2 ? 30 : 9));
    this.pos.lerp(desired, k);
    this.look.lerp(lookAt, instant ? 1 : Math.min(1, dt * 12));
    this.cam.position.copy(this.pos);
    if (this.shake > 0.01 && this.mode !== 3) {
      const a = this.shake * 0.12;
      this.cam.position.add(new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
    }
    this.shake *= Math.exp(-dt * 6);
    this.cam.lookAt(this.look);
    this.cam.fov += (fov - this.cam.fov) * Math.min(1, dt * 3);
    this.cam.updateProjectionMatrix();
  }
}
