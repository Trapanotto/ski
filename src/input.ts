/** Tastatur, Gamepad und Touch zusammengefasst. */
export class Input {
  steer = 0;          // -1 links ... +1 rechts
  tuck = false;
  brake = false;
  private keys = new Set<string>();
  private events = new Set<string>();
  private touchSteer = 0;
  private touchY = 0;
  private touchTuck = false;
  private gpPrev: boolean[] = [];
  readonly isTouch: boolean;

  constructor() {
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const map: Record<string, string> = {
        Space: 'jump', KeyR: 'restart', KeyC: 'camera', Escape: 'pause', KeyP: 'pause', KeyT: 'lift', KeyG: 'ghost',
      };
      if (map[e.code]) { this.events.add(map[e.code]); e.preventDefault(); }
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.setupTouch();
  }

  private setupTouch() {
    const zone = document.getElementById('stickzone')!;
    const base = document.getElementById('stickbase')!;
    const knob = document.getElementById('stickknob')!;
    let id: number | null = null;
    let cx = 0, cy = 0;
    const R = 55;
    const move = (x: number, y: number) => {
      let dx = x - cx, dy = y - cy;
      const l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.touchSteer = dx / R;
      this.touchY = dy / R;
    };
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      zone.setPointerCapture(id);
      const r = zone.getBoundingClientRect();
      cx = e.clientX; cy = e.clientY;
      base.style.left = `${cx - r.left - 65}px`;
      base.style.top = `${cy - r.top - 65}px`;
      base.style.bottom = 'auto';
      move(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e.clientX, e.clientY); });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      this.touchSteer = 0; this.touchY = 0;
      knob.style.transform = '';
    };
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);

    const hold = (elId: string, on: (v: boolean) => void) => {
      const el = document.getElementById(elId)!;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); on(true); });
      const off = () => { el.classList.remove('on'); on(false); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('pointerleave', off);
    };
    hold('tTuck', (v) => (this.touchTuck = v));
    hold('tJump', (v) => { if (v) this.events.add('jump'); });
    const tap = (elId: string, ev: string) =>
      document.getElementById(elId)!.addEventListener('pointerdown', (e) => { e.preventDefault(); this.events.add(ev); });
    tap('tPause', 'pause');
    tap('tCam', 'camera');
    tap('tLift', 'lift');
  }

  /** Einmal pro Frame aufrufen. */
  update(dt: number) {
    const k = this.keys;
    let target = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) target -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) target += 1;
    let tuck = k.has('ArrowUp') || k.has('KeyW');
    let brake = k.has('ArrowDown') || k.has('KeyS') || k.has('ShiftLeft');

    // Gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) target = ax;
      const b = (i: number) => !!gp.buttons[i]?.pressed;
      const val = (i: number) => gp.buttons[i]?.value ?? 0;
      if (val(7) > 0.3 || b(5) || (gp.axes[1] ?? 0) < -0.5) tuck = true;
      if (val(6) > 0.3 || b(4) || (gp.axes[1] ?? 0) > 0.6) brake = true;
      const edge = (i: number, ev: string) => { if (b(i) && !this.gpPrev[i]) this.events.add(ev); };
      edge(0, 'jump'); edge(3, 'camera'); edge(9, 'pause'); edge(8, 'restart'); edge(2, 'lift');
      this.gpPrev = gp.buttons.map((x) => x.pressed);
      break;
    }

    // Touch
    if (Math.abs(this.touchSteer) > 0.05) target = Math.sign(this.touchSteer) * Math.min(1, Math.abs(this.touchSteer) * 1.25);
    if (this.touchTuck || this.touchY < -0.45) tuck = true;
    if (this.touchY > 0.55) brake = true;

    // Tastatur: weich einlenken, Analog: direkt
    const rate = Math.abs(target) === 1 || target === 0 ? 7 : 30;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));
    this.tuck = tuck && !brake;
    this.brake = brake;
  }

  take(ev: string): boolean {
    const had = this.events.has(ev);
    this.events.delete(ev);
    return had;
  }

  clearEvents() { this.events.clear(); }
}
