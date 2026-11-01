/** Prozeduraler Ton (WebAudio): Wind, Kante, Publikum, Piepser. */
export class Sound {
  private ctx: AudioContext | null = null;
  private wind!: GainNode;
  private windF!: BiquadFilterNode;
  private edge!: GainNode;
  private crowd!: GainNode;
  muted = false;

  init() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6 + (Math.random() * 2 - 1) * 0.15; }
    const src = (gain: GainNode) => {
      const s = ctx.createBufferSource();
      s.buffer = noise; s.loop = true; s.connect(gain); s.start(Math.random());
    };
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);

    this.windF = ctx.createBiquadFilter();
    this.windF.type = 'bandpass'; this.windF.frequency.value = 400; this.windF.Q.value = 0.6;
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    this.windF.connect(this.wind).connect(master);
    const wIn = ctx.createGain(); wIn.connect(this.windF); src(wIn);

    const ef = ctx.createBiquadFilter();
    ef.type = 'highpass'; ef.frequency.value = 2200;
    this.edge = ctx.createGain(); this.edge.gain.value = 0;
    ef.connect(this.edge).connect(master);
    const eIn = ctx.createGain(); eIn.connect(ef); src(eIn);

    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass'; cf.frequency.value = 900; cf.Q.value = 0.4;
    this.crowd = ctx.createGain(); this.crowd.gain.value = 0;
    cf.connect(this.crowd).connect(master);
    const cIn = ctx.createGain(); cIn.connect(cf); src(cIn);
  }

  update(speed: number, carve: number, skid: number, airborne: boolean, crowd: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const m = this.muted ? 0 : 1;
    const v = Math.min(speed / 40, 1.3);
    this.wind.gain.setTargetAtTime(m * v * v * 0.55, t, 0.1);
    this.windF.frequency.setTargetAtTime(250 + v * 900, t, 0.1);
    this.edge.gain.setTargetAtTime(m * (airborne ? 0 : Math.min(1, carve * 0.5 + skid) * Math.min(speed / 15, 1) * 0.28), t, 0.05);
    this.crowd.gain.setTargetAtTime(m * crowd * 0.35, t, 0.3);
  }

  beep(freq = 880, dur = 0.12, vol = 0.25) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  thump(vol = 0.5) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(120, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.25);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.3);
  }

  pause(p: boolean) { if (this.ctx) void (p ? this.ctx.suspend() : this.ctx.resume()); }
}
