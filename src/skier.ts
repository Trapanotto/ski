import * as THREE from 'three';
import type { World } from './world';
import type { Input } from './input';

const G = 9.81;
const UP = new THREE.Vector3(0, 1, 0);

type Part = THREE.Object3D;

function findPart(root: THREE.Object3D, base: string): Part {
  let hit: Part | undefined;
  const re = new RegExp(`^${base}(\\d{3})?$`);
  root.traverse((o) => { if (!hit && re.test(o.name)) hit = o; });
  if (!hit) throw new Error('Teil fehlt: ' + base);
  return hit;
}

export interface SkierEvents {
  onCrash?: (reason: string) => void;
  onLand?: (impact: number, air: number) => void;
  onJump?: () => void;
}

/** Fahrer: Arcade-Fahrphysik auf dem Hoehenraster + prozedurale Pose. */
export class Skier {
  readonly holder = new THREE.Object3D();      // Position + Ausrichtung zum Hang
  readonly body: THREE.Object3D;               // Modell (Rollen in der Kurve)
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;                                     // Blickrichtung: (cos, 0, sin)
  airborne = false;
  airTime = 0;
  crashed = 0;                                 // Restzeit Sturz (s)
  tuck = 0;                                    // 0..1 geglaettet
  lean = 0;
  compression = 0;
  carve = 0;                                   // 0..1 Kantengeraeusch / Schnee
  skid = 0;
  spin = 0;                                    // Drehung in der Luft (rad)
  topSpeed = 0;
  freeride = false;
  events: SkierEvents = {};
  private p: Record<string, Part> = {};
  private scale: number;
  private normal = new THREE.Vector3(0, 1, 0);
  private tumble = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector2();
  private omega = 0;
  private visUp = new THREE.Vector3(0, 1, 0);

  constructor(template: THREE.Object3D, female: boolean, ghost = false) {
    this.body = template.clone(true);
    this.scale = female ? 0.95 : 1;
    if (ghost) {
      const mat = new THREE.MeshBasicMaterial({ color: '#9fd0ff', transparent: true, opacity: 0.35, depthWrite: false });
      this.body.traverse((m) => { if ((m as THREE.Mesh).isMesh) { (m as THREE.Mesh).material = mat; m.castShadow = false; } });
    }
    this.holder.add(this.body);
    for (const n of ['pelvis', 'torso', 'head', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R', 'upperarm_L', 'upperarm_R',
      'forearm_L', 'forearm_R', 'pole_L', 'pole_R', 'ski_L', 'ski_R', 'boot_L', 'boot_R']) this.p[n] = findPart(this.body, n);
  }

  get speed() { return this.vel.length(); }
  get dir() { return this.tmp.set(Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

  place(pos: THREE.Vector3, fwd: THREE.Vector3, world: World, speed = 0) {
    this.pos.set(pos.x, world.hf.height(pos.x, pos.z), pos.z);
    this.yaw = Math.atan2(fwd.z, fwd.x);
    this.vel.set(fwd.x, 0, fwd.z).normalize().multiplyScalar(speed);
    this.airborne = false; this.crashed = 0; this.airTime = 0; this.spin = 0;
    this.body.rotation.set(0, 0, 0);
    this.holder.quaternion.identity();
    this.omega = 0; this.lean = 0;
  }

  /** Physikschritt (feste Zeitschrittweite). */
  step(dt: number, inp: Input | null, world: World, frozen = false) {
    const hf = world.hf;
    if (frozen) {
      this.pos.y = hf.height(this.pos.x, this.pos.z);
      this.vel.set(0, 0, 0);
      hf.normal(this.pos.x, this.pos.z, this.normal);
      return;
    }
    const steer = inp ? inp.steer : 0;
    const wantTuck = inp ? inp.tuck : false;
    const brake = inp ? inp.brake : false;
    const jump = inp ? inp.take('jump') : false;

    if (this.crashed > 0) {
      this.crashed -= dt;
      // Rutschen bis zum Stillstand
      hf.normal(this.pos.x, this.pos.z, this.normal);
      const a = this.tmp.set(0, -G, 0);
      a.addScaledVector(this.normal, -a.dot(this.normal));
      this.vel.addScaledVector(a, dt * 0.6);
      this.vel.addScaledVector(this.normal, -this.vel.dot(this.normal));
      this.vel.multiplyScalar(Math.exp(-dt * 1.8));
      this.pos.addScaledVector(this.vel, dt);
      this.pos.y = hf.height(this.pos.x, this.pos.z);
      this.clampBounds(world);
      return;
    }

    const speed = this.vel.length();
    this.tuck += ((wantTuck ? 1 : 0) - this.tuck) * Math.min(1, dt * 5);

    // Lenken: Drehrate faellt mit dem Tempo (Arcade)
    const maxRate = this.airborne ? (this.freeride ? 5.5 : 1.2) : Math.min(2.4, 30 / Math.max(speed, 1)) * (1 - this.tuck * 0.35);
    const targetOmega = steer * maxRate * (brake && !this.airborne ? 1.3 : 1);
    this.omega += (targetOmega - this.omega) * Math.min(1, dt * 10);
    this.yaw += this.omega * dt;
    if (this.airborne) this.spin += this.omega * dt;

    if (!this.airborne) {
      const n = hf.normal(this.pos.x, this.pos.z, this.normal);
      // Hangabtrieb
      const a = new THREE.Vector3(0, -G, 0);
      a.addScaledVector(n, -a.dot(n));
      this.vel.addScaledVector(a, dt);
      this.vel.addScaledVector(n, -this.vel.dot(n));
      // Skirichtung im Hang
      const D = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
      D.addScaledVector(n, -D.dot(n)).normalize();
      const S = new THREE.Vector3().crossVectors(n, D).normalize();
      let vl = this.vel.dot(D);
      let vs = this.vel.dot(S);
      // Kantengriff: Querbewegung wird zu Fahrt (Carven) oder bremst (Rutschen)
      const grip = brake ? 3.5 : 7.5;
      const vs2 = vs * Math.exp(-grip * dt);
      const lost = Math.abs(vs) - Math.abs(vs2);
      const back = vl < -0.5 && !brake;                // rueckwaerts fahren: Ski drehen langsam mit
      vl += (brake ? 0 : 0.75) * lost * Math.sign(vl || 1);
      vs = vs2;
      this.skid = Math.min(1, Math.abs(vs) / 6 + (brake ? 0.6 : 0));
      this.carve = Math.min(1, Math.abs(this.omega) * speed / 25);
      // Reibung + Luftwiderstand
      const mu = 0.04 + (brake ? 0.55 : 0);
      const cd = 0.0056 - this.tuck * 0.0026 + (brake ? 0.004 : 0);
      const v = Math.hypot(vl, vs);
      // Arcade-Begrenzer: ab ~145 km/h stark zunehmender Widerstand (Spitze ~160 km/h)
      const over = Math.max(0, v - 40);
      const decel = mu * G * Math.max(n.y, 0.3) + cd * v * v + 0.3 * over * over;
      if (v > 1e-3) {
        const f = Math.max(0, v - decel * dt) / v;
        vl *= f; vs *= f;
      }
      // Anschieben (Skating) bei kleinem Tempo
      if (wantTuck && vl < 9) vl += 2.6 * dt;
      if (back) this.yaw += Math.sign(steer || 1) * dt * 1.5;
      this.vel.copy(D).multiplyScalar(vl).addScaledVector(S, vs);

      if (jump) {
        this.vel.addScaledVector(n, 4.6);
        this.vel.y += 0.6;
        this.airborne = true;
        this.airTime = 0; this.spin = 0;
        this.events.onJump?.();
      }
      // Kompression: Gelaende steigt an
      const prevY = this.pos.y;
      this.pos.addScaledVector(this.vel, dt);
      const h = hf.height(this.pos.x, this.pos.z);
      if (!this.airborne) {
        if (this.pos.y > h + 0.09) {
          this.airborne = true;          // Gelaende faellt weg -> Flug
          this.airTime = 0; this.spin = 0;
        } else {
          const rise = (h - this.pos.y) / dt;
          this.compression = Math.max(this.compression, Math.min(1, Math.max(0, rise) / 8));
          this.pos.y = h;
          if (rise > 0) this.vel.y += 0; // Tempo bleibt tangential (naechster Schritt projiziert)
        }
      }
      void prevY;
    } else {
      this.airTime += dt;
      this.vel.y -= G * dt;
      const v = this.vel.length();
      const cd = 0.0045 - this.tuck * 0.0018;
      this.vel.multiplyScalar(Math.max(0, 1 - cd * v * dt));
      this.pos.addScaledVector(this.vel, dt);
      const h = hf.height(this.pos.x, this.pos.z);
      if (this.pos.y <= h) {
        const n = hf.normal(this.pos.x, this.pos.z, this.normal);
        const vn = this.vel.dot(n);
        const impact = Math.max(0, -vn);
        this.pos.y = h;
        this.airborne = false;
        // Landewinkel: Ski gegen Fahrtrichtung
        const hv = this.tmp.set(this.vel.x, 0, this.vel.z);
        const hs = hv.length();
        let off = 0;
        if (hs > 3) {
          const vy = Math.atan2(hv.z, hv.x);
          off = Math.abs(Math.atan2(Math.sin(vy - this.yaw), Math.cos(vy - this.yaw)));
        }
        const bad = impact > 15 || (off > 1.1 && off < 2.4 && hs > 10);
        this.vel.addScaledVector(n, -vn);
        this.vel.multiplyScalar(1 - Math.min(0.35, impact * 0.012));
        if (off >= 2.4 && hs > 3) this.yaw += Math.PI;        // rueckwaerts gelandet -> Ski drehen (Arcade)
        else if (off > 0.5 && !bad) this.yaw = Math.atan2(this.vel.z, this.vel.x);
        this.compression = Math.min(1, impact / 10);
        this.events.onLand?.(impact, this.airTime);
        if (bad) this.crash(impact > 15 ? 'Harte Landung' : 'Verkantet');
      }
    }

    // Hindernisse
    const sp = this.vel.length();
    if (world.treeHit(this.pos.x, this.pos.z, 0.35, this.tmp2) && !this.airborne) {
      if (sp > 6) this.crash('Baum'); else this.bounce(this.tmp2, 0.2);
    } else if (!this.freeride && world.netHit(this.pos.x, this.pos.z, 0.6, this.tmp2)) {
      const into = -(this.vel.x * this.tmp2.x + this.vel.z * this.tmp2.y);
      if (into > 14) this.crash('Fangnetz');
      else if (into > 0) this.bounce(this.tmp2, 0.25);
    } else if (world.buildingHit(this.pos.x, this.pos.z) && this.pos.y < world.hf.height(this.pos.x, this.pos.z) + 6) {
      if (sp > 5) this.crash('Hauswand'); else this.bounce(this.tmp2.set(-this.vel.x, -this.vel.z).normalize(), 0.1);
    }
    this.clampBounds(world);
    this.topSpeed = Math.max(this.topSpeed, this.vel.length());
    this.compression *= Math.exp(-dt * 6);
  }

  private bounce(n: THREE.Vector2, keep: number) {
    const vn = this.vel.x * n.x + this.vel.z * n.y;
    if (vn < 0) {
      this.vel.x -= (1 + keep) * vn * n.x;
      this.vel.z -= (1 + keep) * vn * n.y;
      this.vel.multiplyScalar(0.7);
      this.pos.x += n.x * 0.3; this.pos.z += n.y * 0.3;
      this.yaw = Math.atan2(this.vel.z, this.vel.x);
    }
  }

  private clampBounds(world: World) {
    const m = 20;
    const hf = world.hf;
    if (!hf.inside(this.pos.x, this.pos.z, m)) {
      this.pos.x = Math.min(Math.max(this.pos.x, m), hf.sizeX - m);
      this.pos.z = Math.min(Math.max(this.pos.z, m), hf.sizeZ - m);
      this.vel.multiplyScalar(0.2);
      this.pos.y = Math.max(this.pos.y, hf.height(this.pos.x, this.pos.z));
    }
  }

  crash(reason: string) {
    if (this.crashed > 0) return;
    this.crashed = 2.4;
    this.airborne = false;
    this.tumble.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(6 + this.speed * 0.3);
    this.vel.multiplyScalar(0.55);
    this.events.onCrash?.(reason);
  }

  /** Darstellung (jeden Frame). */
  updateVisual(dt: number, world: World) {
    const p = this.p;
    const s = this.scale;
    this.holder.position.copy(this.pos);
    if (this.crashed > 0) {
      const k = Math.min(1, this.crashed / 2.4);
      this.body.rotation.x += this.tumble.x * dt * k;
      this.body.rotation.z += this.tumble.z * dt * k;
      this.body.position.y = 0.3;
      this.poseLimbs(0.4, -0.6, 1.2, 1.5, 0.4);
      return;
    }
    this.body.position.y = 0;
    this.body.rotation.x = 0;
    // Ausrichtung: Hoch = Hangnormale (in der Luft langsam zur Senkrechten)
    const target = this.airborne ? UP : world.hf.normal(this.pos.x, this.pos.z, this.tmp, 1.5);
    this.visUp.lerp(target, Math.min(1, dt * (this.airborne ? 3 : 14))).normalize();
    const fwd = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    fwd.addScaledVector(this.visUp, -fwd.dot(this.visUp)).normalize();
    const zAxis = fwd.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(this.visUp, zAxis).normalize();
    const m = new THREE.Matrix4().makeBasis(xAxis, this.visUp, zAxis);
    this.holder.quaternion.setFromRotationMatrix(m);
    // Kurvenlage
    const sp = this.speed;
    const targetLean = this.airborne ? 0 : -Math.atan((sp * this.omega) / G) * 0.85;
    this.lean += (Math.max(-0.95, Math.min(0.95, targetLean)) - this.lean) * Math.min(1, dt * 8);
    this.body.rotation.z = this.lean;
    // Ski aufkanten
    p.ski_L.rotation.z = p.ski_R.rotation.z = -this.lean * 0.15;
    const t = this.tuck;
    const c = this.compression;
    const hip = (0.98 - 0.36 * t - c * 0.18) * s;
    const back = (0.04 + 0.12 * t) * s;
    p.pelvis.position.set(0, hip, back);
    // Beine (2-Gelenk-IK): Knoechel bei y=0.12
    const l1 = 0.42 * s, l2 = 0.42 * s;
    const zt = -back, yt = 0.12 * s - (hip - 0.02);
    const D = Math.min(Math.hypot(zt, yt), l1 + l2 - 1e-4);
    const knee = -Math.acos(Math.max(-1, Math.min(1, (D * D - l1 * l1 - l2 * l2) / (2 * l1 * l2))));
    const thetaT = Math.atan2(-zt, -yt);
    const thigh = thetaT + Math.asin(Math.max(-1, Math.min(1, (l2 * Math.sin(-knee)) / D)));
    p.thigh_L.rotation.x = p.thigh_R.rotation.x = thigh;
    p.shin_L.rotation.x = p.shin_R.rotation.x = knee;
    this.poseLimbs(-0.2 - 1.15 * t, 0.15 + 0.9 * t, 0.35 + 1.25 * t, 0.5 + 0.5 * t, t);
  }

  private poseLimbs(torso: number, head: number, arm: number, fore: number, t: number) {
    const p = this.p;
    p.torso.rotation.x = torso;
    p.head.rotation.x = head;
    p.upperarm_L.rotation.set(arm, 0, -0.25 + 0.1 * t);
    p.upperarm_R.rotation.set(arm, 0, 0.25 - 0.1 * t);
    p.forearm_L.rotation.x = p.forearm_R.rotation.x = fore;
    // Stoecke: stehend nach unten, in der Hocke nach hinten unter die Arme
    p.pole_L.rotation.set(-0.35 - 2.0 * t, 0, 0.1);
    p.pole_R.rotation.set(-0.35 - 2.0 * t, 0, -0.1);
  }
}
