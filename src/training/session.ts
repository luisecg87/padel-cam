import { HISTORY_MS, SWING_COOLDOWN, SWING_MIN_DIST_BW, SWING_SPEED_BW } from '../camera/gestures';
import { LM } from '../camera/pose';
import type { PoseFrame } from '../camera/pose';
import { impactZone, readBody, worstPostureCue } from './metrics';
import type { BodyState, Level, Pt } from './metrics';
import { clamp, SHOT_NAMES } from '../types';
import type { ShotType } from '../types';

// Sesión de entrenamiento técnico por repeticiones ("sombra" con ritmo):
// el sistema anuncia el golpe, marca la preparación y pita el momento exacto
// de impacto; se evalúa timing, punto de impacto, preparación y postura con
// los datos reales de la pose. No hay bola: todas las métricas son del gesto.

export type Phase = 'searching' | 'announce' | 'prep' | 'strike' | 'result' | 'done';

export const REPS_PER_SESSION = 10;
const T_ANNOUNCE = 0.9;
const T_PREP = 1.7;
const T_RING = 1.0; // el anillo converge; al llegar a 0 suena el beat
const T_AFTER = 0.45; // margen tras el beat para aceptar el golpe
const T_RESULT = 1.25;

export type FailCause = 'early' | 'late' | 'noswing' | 'zone' | 'form' | null;

export interface RepResult {
  swung: boolean;
  dtMs: number | null; // golpe respecto al beat (negativo = pronto)
  zoneDistBw: number | null; // distancia muñeca→zona de impacto (anchos de cuerpo)
  power: number; // 0..1
  prepOk: boolean;
  postureOk: boolean;
  score: number; // 0..100
  correct: boolean;
  cause: FailCause;
}

export interface Feedback {
  text: string;
  level: Level;
}

export interface TrainingSummary {
  shot: ShotType;
  reps: RepResult[];
  correct: number;
  consistency: number; // media de score 0..100
  avgAbsDtMs: number | null;
  meanDtMs: number | null;
  bestStreak: number;
  avgPower: number;
  mainIssue: { text: string; tipId: string } | null;
  recommendation: string;
}

interface WristSample {
  t: number; // s
  pos: Pt;
}

export interface DetectedSwing {
  t: number; // s
  pos: Pt;
  power: number; // 0..1
  overhead: boolean;
}

export class TrainingSession {
  shot: ShotType;
  phase: Phase = 'searching';
  repIndex = 0; // 0-based; repIndex+1 se muestra
  reps: RepResult[] = [];
  streak = 0;
  bestStreak = 0;
  feedback: Feedback | null = null;
  body: BodyState | null = null;
  /** 1 → 0 durante la fase de golpeo (radio del anillo de timing). */
  ringT = 0;
  beatFired = false;

  onBeat: (() => void) | null = null;
  onResult: ((rep: RepResult) => void) | null = null;
  onFinish: ((summary: TrainingSummary) => void) | null = null;

  private phaseStart = 0;
  private stableFrames = 0;
  private lastFrameT = 0;
  private history: Record<'L' | 'R', WristSample[]> = { L: [], R: [] };
  private lastSwingT = 0;
  private capturedSwing: DetectedSwing | null = null;
  private resolveTime: number | null = null; // resolución diferida: deja terminar la extensión
  private maxExt = 0; // máxima distancia muñeca-cadera vista desde la captura
  private prepSeen = false;
  private postureBadSeen = false;
  lastPower = 0;

  constructor(shot: ShotType) {
    this.shot = shot;
  }

  private get beatTime(): number {
    return this.phaseStart + T_RING;
  }

  update(frame: PoseFrame | null, now: number): void {
    const t = now / 1000;
    this.body = readBody(frame, this.shot);

    if (this.phase === 'done') return;

    // Sin cuerpo visible: pausar la sesión hasta volver a verlo
    if (!this.body) {
      if (this.phase !== 'searching') this.setPhase('searching', t);
      this.stableFrames = 0;
      this.history.L = [];
      this.history.R = [];
      return;
    }

    this.detectSwing(frame!, t);

    // El punto de impacto real es la máxima extensión de la muñeca tras el
    // swing (la detección dispara al inicio del gesto, no en el impacto).
    if (this.capturedSwing) {
      for (const w of [this.body.wrists.L, this.body.wrists.R]) {
        if (!w) continue;
        const d = Math.hypot(w.x - this.body.hipCenter.x, w.y - this.body.hipCenter.y);
        if (d > this.maxExt) {
          this.maxExt = d;
          this.capturedSwing.pos = w;
        }
      }
    }

    switch (this.phase) {
      case 'searching':
        this.stableFrames++;
        if (this.stableFrames > 12) this.setPhase('announce', t);
        break;

      case 'announce':
        if (t - this.phaseStart > T_ANNOUNCE) {
          this.prepSeen = false;
          this.postureBadSeen = false;
          this.capturedSwing = null;
          this.resolveTime = null;
          this.maxExt = 0;
          this.setPhase('prep', t);
        }
        break;

      case 'prep':
        if (this.body.prepared) this.prepSeen = true;
        if (worstPostureCue(this.body).level === 'bad') this.postureBadSeen = true;
        if (t - this.phaseStart > T_PREP) this.setPhase('strike', t);
        break;

      case 'strike': {
        this.ringT = clamp(1 - (t - this.phaseStart) / T_RING, 0, 1);
        if (this.body.prepared) this.prepSeen = true;
        if (!this.beatFired && t >= this.beatTime) {
          this.beatFired = true;
          this.onBeat?.();
        }
        if (this.capturedSwing && this.resolveTime !== null) {
          if (t >= this.resolveTime) this.resolveRep(this.capturedSwing.t);
        } else if (t > this.beatTime + T_AFTER) {
          this.resolveRep(t);
        }
        break;
      }

      case 'result':
        if (t - this.phaseStart > T_RESULT) {
          this.repIndex++;
          if (this.repIndex >= REPS_PER_SESSION) {
            this.phase = 'done';
            this.onFinish?.(this.buildSummary());
          } else {
            this.setPhase('announce', t);
          }
        }
        break;
    }
  }

  private setPhase(p: Phase, t: number): void {
    this.phase = p;
    this.phaseStart = t;
    if (p === 'strike') {
      this.ringT = 1;
      this.beatFired = false;
    }
    if (p !== 'result') this.feedback = null;
  }

  /** Misma detección de swing que el juego: velocidad de muñeca en anchos de cuerpo. */
  private detectSwing(frame: PoseFrame, t: number): void {
    if (frame.t === this.lastFrameT || !this.body) return;
    this.lastFrameT = frame.t;
    const bw = this.body.bw;
    for (const hand of ['L', 'R'] as const) {
      const wi = hand === 'L' ? LM.L_WRIST : LM.R_WRIST;
      const p = frame.lm[wi];
      if (!p || (p.visibility ?? 0) < 0.4) {
        this.history[hand] = [];
        continue;
      }
      const sample: WristSample = { t, pos: { x: 1 - p.x, y: p.y } };
      const hist = this.history[hand];
      hist.push(sample);
      while (hist.length > 0 && t - hist[0].t > HISTORY_MS / 1000) hist.shift();
      if (hist.length < 3) continue;
      const first = hist[0];
      const dtw = sample.t - first.t;
      if (dtw < 0.06) continue;
      const dx = sample.pos.x - first.pos.x;
      const dy = sample.pos.y - first.pos.y;
      const speedBw = Math.hypot(dx, dy) / dtw / bw;
      const distBw = Math.hypot(dx, dy) / bw;
      if (speedBw > SWING_SPEED_BW && distBw > SWING_MIN_DIST_BW && t - this.lastSwingT > SWING_COOLDOWN) {
        this.lastSwingT = t;
        const overhead = first.pos.y < this.body.shoulderCenter.y && dy / dtw > 0.4;
        const power = clamp((speedBw - SWING_SPEED_BW) / 9, 0, 1);
        this.lastPower = power;
        this.onSwing({ t, pos: sample.pos, power, overhead });
        this.history.L = [];
        this.history.R = [];
        break;
      }
    }
  }

  private onSwing(s: DetectedSwing): void {
    // Solo cuenta el primer golpe cercano al beat (desde media fase de prep)
    if (this.capturedSwing) return;
    if (this.phase === 'strike' || (this.phase === 'prep' && this.beatEstimate() - s.t < 1.6)) {
      this.capturedSwing = s;
      this.maxExt = this.body
        ? Math.hypot(s.pos.x - this.body.hipCenter.x, s.pos.y - this.body.hipCenter.y)
        : 0;
      if (this.phase === 'strike' && s.t >= this.beatTime - 0.36) {
        // Dentro de la ventana: resolver en ~200 ms, cuando termine la extensión
        this.resolveTime = s.t + 0.2;
      }
    }
  }

  /** Momento estimado del beat aunque aún estemos en prep. */
  private beatEstimate(): number {
    return this.phase === 'strike' ? this.beatTime : this.phaseStart + T_PREP + T_RING;
  }

  private resolveRep(t: number): void {
    if (this.phase !== 'strike' && this.phase !== 'prep') return;
    const s = this.capturedSwing;
    const beat = this.beatEstimate();
    const body = this.body;

    let rep: RepResult;
    if (!s) {
      rep = {
        swung: false, dtMs: null, zoneDistBw: null, power: 0,
        prepOk: this.prepSeen, postureOk: !this.postureBadSeen,
        score: 0, correct: false, cause: 'noswing',
      };
      this.feedback = { text: 'SIN GOLPE', level: 'bad' };
    } else {
      const dt = s.t - beat;
      const dtMs = Math.round(dt * 1000);
      let zoneDistBw: number | null = null;
      if (body) {
        const z = impactZone(this.shot, body);
        zoneDistBw = Math.hypot(s.pos.x - z.c.x, s.pos.y - z.c.y) / body.bw;
      }
      const tScore = Math.abs(dt) <= 0.15 ? 40 : Math.abs(dt) <= 0.35 ? 28 : 10;
      const zScore = zoneDistBw === null ? 20 : zoneDistBw <= 0.55 ? 40 : zoneDistBw <= 1.0 ? 26 : 10;
      const fScore = (this.prepSeen ? 10 : 0) + (this.postureBadSeen ? 0 : 10);
      const score = tScore + zScore + fScore;

      let cause: FailCause = null;
      if (tScore === 10) cause = dt < 0 ? 'early' : 'late';
      else if (zScore === 10) cause = 'zone';
      else if (fScore < 10) cause = 'form';

      // Correcta = sin fallo grave y puntuación alta
      const correct = score >= 70 && (cause === null || cause === 'form');

      if (cause === 'early') this.feedback = { text: 'MUY PRONTO', level: 'bad' };
      else if (cause === 'late') this.feedback = { text: 'TARDE', level: 'bad' };
      else if (cause === 'zone') {
        const tooClose = body && s.pos && Math.abs(s.pos.x - body.hipCenter.x) < Math.abs(impactZone(this.shot, body).c.x - body.hipCenter.x);
        this.feedback = { text: tooClose ? 'EXTIENDE EL BRAZO' : 'IMPACTA MÁS CERCA', level: 'warn' };
      } else if (cause === 'form') this.feedback = { text: 'PREPARA ANTES LA PALA', level: 'warn' };
      else if (score >= 90) this.feedback = { text: 'PERFECTO', level: 'good' };
      else this.feedback = { text: 'BUEN GOLPE', level: 'good' };

      rep = {
        swung: true, dtMs, zoneDistBw, power: s.power,
        prepOk: this.prepSeen, postureOk: !this.postureBadSeen,
        score, correct, cause,
      };
    }

    this.reps.push(rep);
    if (rep.correct) {
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.streak = 0;
    }
    this.onResult?.(rep);
    this.setPhase('result', t);
  }

  get consistency(): number {
    if (this.reps.length === 0) return 0;
    return Math.round(this.reps.reduce((a, r) => a + r.score, 0) / this.reps.length);
  }

  private buildSummary(): TrainingSummary {
    const reps = this.reps;
    const swung = reps.filter((r) => r.dtMs !== null);
    const correct = reps.filter((r) => r.correct).length;
    const avgAbsDtMs = swung.length
      ? Math.round(swung.reduce((a, r) => a + Math.abs(r.dtMs!), 0) / swung.length)
      : null;
    const meanDtMs = swung.length
      ? Math.round(swung.reduce((a, r) => a + r.dtMs!, 0) / swung.length)
      : null;
    const avgPower = swung.length ? swung.reduce((a, r) => a + r.power, 0) / swung.length : 0;

    // Error principal: causa de fallo más repetida
    const counts = new Map<Exclude<FailCause, null>, number>();
    for (const r of reps) if (r.cause) counts.set(r.cause, (counts.get(r.cause) ?? 0) + 1);
    let main: Exclude<FailCause, null> | null = null;
    for (const [k, v] of counts) if (v >= 2 && (!main || v > (counts.get(main) ?? 0))) main = k;

    const name = SHOT_NAMES[this.shot];
    const ISSUES: Record<Exclude<FailCause, null>, { text: string; tipId: string; rec: string }> = {
      late: {
        text: 'Llegas tarde al impacto',
        tipId: 'timing-tarde',
        rec: `Arma la pala en cuanto se anuncia el golpe y empieza el gesto antes del pitido. Repite la sesión de ${name} buscando golpear justo en el beat.`,
      },
      early: {
        text: 'Golpeas antes de tiempo',
        tipId: 'timing-pronto',
        rec: `Acompaña el anillo con la preparación y suelta el gesto solo cuando se cierre. Repite ${name} a este ritmo antes de subirlo.`,
      },
      zone: {
        text: 'El punto de impacto se desvía de la zona ideal',
        tipId: 'impacto-zona',
        rec: `Haz pasar la mano por el círculo objetivo: es la distancia natural de impacto de ${SHOT_NAMES[this.shot]}. Hazlo lento y exagerado 5 veces y vuelve a la sesión.`,
      },
      form: {
        text: 'Falta preparación previa al golpe',
        tipId: 'preparacion',
        rec: 'Lleva la pala atrás/arriba ANTES de que se cierre el anillo: la preparación temprana es la mitad del golpe.',
      },
      noswing: {
        text: 'Te quedas sin golpear en varias repeticiones',
        tipId: 'ritmo',
        rec: 'No busques el golpe perfecto: sigue el ritmo aunque falles. La constancia del gesto llega antes que la precisión.',
      },
    };

    const consistency = this.consistency;
    const mainIssue = main ? { text: ISSUES[main].text, tipId: ISSUES[main].tipId } : null;
    const recommendation = main
      ? ISSUES[main].rec
      : consistency >= 85
        ? `Gesto muy consistente. Siguiente sesión: prueba ${name} con menos margen o cambia a un golpe que domines menos.`
        : `Buen trabajo. Repite la sesión de ${name} buscando superar el ${consistency}% de consistencia.`;

    return {
      shot: this.shot,
      reps,
      correct,
      consistency,
      avgAbsDtMs,
      meanDtMs,
      bestStreak: this.bestStreak,
      avgPower,
      mainIssue,
      recommendation,
    };
  }
}
