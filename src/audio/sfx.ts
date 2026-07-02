import { isOverheadShot } from '../types';
import type { ShotType } from '../types';

const MUTE_KEY = 'padelcam.muted';

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  slide?: number; // frecuencia final (glissando)
  attack?: number;
  delay?: number; // segundos antes de sonar
}

/**
 * Efectos de sonido 100% sintetizados con WebAudio: no hay assets que cargar.
 * Todo pasa por un gain maestro con mute persistente.
 */
class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  /** Crear/reanudar el AudioContext. Llamar desde un gesto del usuario. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* almacenamiento no disponible */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  private tone(freq: number, dur: number, opts: ToneOpts = {}): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(opts.slide, 1), t0 + dur);
    const peak = opts.gain ?? 0.2;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, filterFreq: number, gain: number, opts: { q?: number; slide?: number; delay?: number } = {}): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(filterFreq, t0);
    if (opts.slide) f.frequency.exponentialRampToValueAtTime(opts.slide, t0 + dur);
    f.Q.value = opts.q ?? 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  // ---------- Eventos del juego ----------

  /** "Pock" del golpe: más grave y fuerte cuanto más potente es el golpe. */
  hit(type: ShotType): void {
    const power = type === 'smash' ? 1 : type === 'vibora' ? 0.9 : isOverheadShot(type) ? 0.7 : type === 'serve' ? 0.6 : 0.65;
    this.tone(190 - power * 60, 0.09, { type: 'triangle', gain: 0.28 + power * 0.2, slide: 80 });
    this.noise(0.05, 2200, 0.12 + power * 0.1);
  }

  bounce(): void {
    this.tone(150, 0.08, { type: 'sine', gain: 0.14, slide: 70 });
  }

  wall(): void {
    // Toque en el cristal: "tin" agudo y corto
    this.tone(950, 0.1, { type: 'triangle', gain: 0.1, slide: 700 });
    this.noise(0.06, 3500, 0.06, { q: 3 });
  }

  net(): void {
    this.tone(120, 0.16, { type: 'sawtooth', gain: 0.12, slide: 60 });
    this.noise(0.12, 500, 0.1 );
  }

  whiff(): void {
    this.noise(0.16, 900, 0.12, { q: 0.8, slide: 300 });
  }

  fault(): void {
    this.tone(220, 0.22, { type: 'square', gain: 0.08, slide: 140 });
  }

  pointWin(): void {
    this.tone(520, 0.12, { type: 'triangle', gain: 0.14 });
    this.tone(660, 0.14, { type: 'triangle', gain: 0.14, delay: 0.09 });
    this.tone(880, 0.2, { type: 'triangle', gain: 0.14, delay: 0.18 });
  }

  pointLose(): void {
    this.tone(330, 0.14, { type: 'triangle', gain: 0.1 });
    this.tone(233, 0.24, { type: 'triangle', gain: 0.1, delay: 0.12 });
  }

  /** Murmullo/aplauso del público: ráfagas de ruido filtrado. */
  cheer(big = false): void {
    const n = big ? 20 : 9;
    for (let i = 0; i < n; i++) {
      this.noise(0.14 + Math.random() * 0.1, 1400 + Math.random() * 1600, big ? 0.075 : 0.05, {
        q: 1.6,
        delay: Math.random() * (big ? 1.1 : 0.5),
      });
    }
  }

  gameWin(): void {
    this.pointWin();
    this.cheer();
  }

  matchWin(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.tone(f, 0.3, { type: 'triangle', gain: 0.16, delay: i * 0.15 }));
    this.cheer(true);
  }

  matchLose(): void {
    const notes = [392, 330, 262];
    notes.forEach((f, i) => this.tone(f, 0.32, { type: 'triangle', gain: 0.12, delay: i * 0.18 }));
  }

  click(): void {
    this.tone(700, 0.05, { type: 'triangle', gain: 0.07 });
  }

  /** Acierto en el modo práctica. */
  good(): void {
    this.tone(660, 0.1, { type: 'triangle', gain: 0.12 });
    this.tone(990, 0.16, { type: 'triangle', gain: 0.12, delay: 0.08 });
  }

  /** Fallo en el modo práctica. */
  bad(): void {
    this.tone(196, 0.2, { type: 'square', gain: 0.06, slide: 150 });
  }
}

export const sfx = new Sfx();
