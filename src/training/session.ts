import { WristSwingDetector } from '../camera/swingDetector';
import type { DetectedSwing } from '../camera/swingDetector';
import type { PoseFrame } from '../camera/pose';
import { sfx } from '../audio/sfx';
import { BIOMECHANIC_LABELS, SHOT_DRILL } from '../analysis/progress';
import type {
  BiomechanicKey,
  BiomechanicPillars,
  BiomechanicsBreakdown,
} from '../analysis/progress';
import {
  impactZone,
  readBody,
  requiresGuideHand,
  requiresShoulderTurn,
  worstPostureCue,
} from './metrics';
import type { BodyState, Level } from './metrics';
import { clamp, SHOT_NAMES } from '../types';
import type { DrillType, ShotType } from '../types';

export type { DetectedSwing };

// Sesión de entrenamiento técnico por repeticiones ("sombra" con ritmo):
// el sistema anuncia el golpe, marca la preparación y pita el momento exacto
// de impacto; se evalúa timing, punto de impacto, preparación y postura con
// los datos reales de la pose. No hay bola: todas las métricas son del gesto.

export type Phase = 'searching' | 'announce' | 'prep' | 'strike' | 'result' | 'done';

export const REPS_PER_SESSION = 10;

/**
 * Secuencia combinada de "Calentamiento Express (3 min)" (12 repeticiones rápidas):
 * 3 derechas, 3 reveses, 3 voleas, 3 bandejas.
 */
export const EXPRESS_WARMUP_SEQUENCE: readonly ShotType[] = [
  'forehand',
  'forehand',
  'forehand',
  'backhand',
  'backhand',
  'backhand',
  'volleyFh',
  'volleyFh',
  'volleyFh',
  'bandeja',
  'bandeja',
  'bandeja',
] as const;

export const EXPRESS_REPS_PER_SESSION = EXPRESS_WARMUP_SEQUENCE.length;

/** Locuciones de transición del VoiceCoach cuando cambia el golpe en el Calentamiento Express. */
const EXPRESS_TRANSITION_VOICE: Readonly<Record<number, string>> = {
  0: '¡Calentamiento express! Empezamos con derecha.',
  3: '¡Cambio a revés!',
  6: '¡Subimos a la volea!',
  9: '¡Atento al globo, bandeja!',
};

const T_ANNOUNCE = 0.9;
const T_ANNOUNCE_TRANSITION = 1.45; // margen extra cuando el VoiceCoach anuncia cambio de golpe
const T_PREP = 1.7;
const T_PREP_EXPRESS = 1.45;
const T_RING = 1.0; // el anillo converge; al llegar a 0 suena el beat
const T_AFTER = 0.45; // margen tras el beat para aceptar el golpe
const T_RESULT = 1.25;
const T_RESULT_EXPRESS = 1.15;

/** Margen (ms) para que termine el efecto de sonido (good/bad ~240ms) antes de hablar. */
const SFX_VOICE_DELAY_MS = 260;

export type FailCause = 'early' | 'late' | 'noswing' | 'zone' | 'form' | null;
type PostureFault = 'knees' | 'stance' | 'balance' | null;

export interface RepResult {
  shot: ShotType;
  swung: boolean;
  dtMs: number | null; // golpe respecto al beat (negativo = pronto)
  zoneDistBw: number | null; // distancia muñeca→zona de impacto (anchos de cuerpo)
  power: number; // 0..1
  prepOk: boolean; // armado temprano de la pala (incluye perfilado y mano guía si aplican)
  shoulderTurnOk: boolean; // giro de hombros >= 22%
  guideHandOk: boolean; // mano libre activa en golpes aéreos
  kneesOk: boolean; // flexión de rodillas adecuada
  stanceOk: boolean; // separación de pies (base estable)
  timingOk: boolean; // sincronización dentro de la ventana de impacto
  postureOk: boolean;
  score: number; // 0..100
  correct: boolean;
  cause: FailCause;
}

export interface Feedback {
  text: string;
  level: Level;
  /** Frase única cantada por el entrenador por voz (Web Speech API). */
  voice: string;
}

export interface CoachDiagnosisCard {
  dominantFault: BiomechanicKey | null;
  badgeText: string;
  diagnosis: string;
  exerciseName: string;
  exerciseReason: string;
  targetShot: ShotType;
  targetDrill: DrillType;
}

export interface TrainingSummary {
  shot: ShotType;
  /** True si la sesión fue un Calentamiento Express combinado de 12 repeticiones. */
  express: boolean;
  reps: RepResult[];
  correct: number;
  consistency: number; // media de score 0..100
  avgAbsDtMs: number | null;
  meanDtMs: number | null;
  bestStreak: number;
  avgPower: number;
  /** Desglose de fallos por tipo de biomecánica (rodillas, armado, separación de pies, timing). */
  biomechanics: BiomechanicsBreakdown;
  /** Porcentajes de éxito (0..100) en los 4 pilares biomecánicos para la Ficha Técnica. */
  pillars: BiomechanicPillars;
  dominantFault: BiomechanicKey | null;
  coachCard: CoachDiagnosisCard;
  mainIssue: { text: string; tipId: string } | null;
  recommendation: string;
}

/**
 * Sintetizador de voz del entrenador usando la Web Speech API nativa.
 * Evita solaparse con los efectos de sonido esperando a que terminen y
 * cancelando cualquier locución activa antes del siguiente beat o al salir.
 */
class VoiceCoach {
  private timer: number | null = null;
  private cachedVoice: SpeechSynthesisVoice | null = null;

  private getSpanishVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (this.cachedVoice) return this.cachedVoice;
    const voices = window.speechSynthesis.getVoices();
    this.cachedVoice =
      voices.find((v) => v.lang.toLowerCase().startsWith('es-es')) ??
      voices.find((v) => v.lang.toLowerCase().startsWith('es')) ??
      null;
    return this.cachedVoice;
  }

  /** Programa una locución tras el margen indicado para no pisar los efectos de sonido. */
  speak(text: string, delayMs = SFX_VOICE_DELAY_MS): void {
    this.cancel();
    if (sfx.muted || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (sfx.muted || !('speechSynthesis' in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'es-ES';
        const voice = this.getSpanishVoice();
        if (voice) utter.voice = voice;
        utter.rate = 1.12;
        utter.pitch = 1.0;
        utter.volume = 0.95;
        window.speechSynthesis.speak(utter);
      } catch {
        /* Web Speech API bloqueada o no soportada en este entorno */
      }
    }, Math.max(0, delayMs));
  }

  /** Detiene cualquier locución en curso o programada. */
  cancel(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignorar */
      }
    }
  }
}

export class TrainingSession {
  shot: ShotType;
  readonly express: boolean;
  readonly totalReps: number;
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
  private neutralBw = 0; // ancho de hombros neutro de frente a la cámara
  private swingDetector = new WristSwingDetector();
  private voice = new VoiceCoach();
  private capturedSwing: DetectedSwing | null = null;
  private resolveTime: number | null = null; // resolución diferida: deja terminar la extensión
  private maxExt = 0; // máxima distancia muñeca-cadera vista desde la captura
  private prepSeen = false;
  private shoulderTurnSeen = false;
  private guideHandSeen = false;
  private kneesBadSeen = false;
  private stanceBadSeen = false;
  private postureBadSeen = false;
  private postureFault: PostureFault = null;
  private announcedRepIndex = -1;
  lastPower = 0;

  constructor(shot: ShotType, express = false) {
    this.express = express;
    this.totalReps = express ? EXPRESS_REPS_PER_SESSION : REPS_PER_SESSION;
    this.shot = express ? EXPRESS_WARMUP_SEQUENCE[0] : shot;
  }

  /** Cancela locuciones pendientes o en curso (llamar al cerrar la vista de entrenamiento). */
  stopSpeech(): void {
    this.voice.cancel();
  }

  private get prepDuration(): number {
    return this.express ? T_PREP_EXPRESS : T_PREP;
  }

  private get announceDuration(): number {
    if (this.express && EXPRESS_TRANSITION_VOICE[this.repIndex] !== undefined) {
      return T_ANNOUNCE_TRANSITION;
    }
    return T_ANNOUNCE;
  }

  private get resultDuration(): number {
    return this.express ? T_RESULT_EXPRESS : T_RESULT;
  }

  private get beatTime(): number {
    return this.phaseStart + T_RING;
  }

  private recordPosture(body: BodyState): void {
    if (body.knees.level === 'bad') this.kneesBadSeen = true;
    if (body.stance.level === 'bad') this.stanceBadSeen = true;
    if (worstPostureCue(body).level === 'bad') {
      this.postureBadSeen = true;
      if (body.knees.level === 'bad') this.postureFault = 'knees';
      else if (body.stance.level === 'bad' && !this.postureFault) this.postureFault = 'stance';
      else if (body.balance.level === 'bad' && !this.postureFault) this.postureFault = 'balance';
    }
  }

  update(frame: PoseFrame | null, now: number): void {
    const t = now / 1000;
    if (this.express && this.repIndex < EXPRESS_WARMUP_SEQUENCE.length) {
      this.shot = EXPRESS_WARMUP_SEQUENCE[this.repIndex];
    }
    this.body = readBody(frame, this.shot, this.neutralBw > 0.05 ? this.neutralBw : undefined);

    if (this.phase === 'done') return;

    // Sin cuerpo visible: pausar la sesión hasta volver a verlo
    if (!this.body) {
      if (this.phase !== 'searching') this.setPhase('searching', t);
      this.stableFrames = 0;
      this.swingDetector.reset();
      return;
    }

    // Calibrar el ancho de hombros neutro cuando el jugador está de frente en espera/anuncio
    if (this.phase === 'searching' || this.phase === 'announce') {
      if (this.body.rawShoulderSpan > 0.06) {
        this.neutralBw =
          this.neutralBw > 0.05
            ? Math.max(this.neutralBw * 0.92 + this.body.rawShoulderSpan * 0.08, this.body.rawShoulderSpan)
            : this.body.rawShoulderSpan;
      }
    }

    const detected = this.swingDetector.detect(frame!, this.body.bw, t);
    if (detected) {
      this.lastPower = detected.power;
      this.onSwing(detected);
    }

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
        if (t - this.phaseStart > this.announceDuration) {
          this.prepSeen = false;
          this.shoulderTurnSeen = !requiresShoulderTurn(this.shot);
          this.guideHandSeen = !requiresGuideHand(this.shot);
          this.kneesBadSeen = false;
          this.stanceBadSeen = false;
          this.postureBadSeen = false;
          this.postureFault = null;
          this.capturedSwing = null;
          this.resolveTime = null;
          this.maxExt = 0;
          this.setPhase('prep', t);
        }
        break;

      case 'prep':
        if (this.body.prepared) this.prepSeen = true;
        if (this.body.shoulderTurned) this.shoulderTurnSeen = true;
        if (this.body.guideHandUp) this.guideHandSeen = true;
        this.recordPosture(this.body);
        if (t - this.phaseStart > this.prepDuration) this.setPhase('strike', t);
        break;

      case 'strike': {
        this.ringT = clamp(1 - (t - this.phaseStart) / T_RING, 0, 1);
        if (this.body.prepared) this.prepSeen = true;
        if (this.body.shoulderTurned) this.shoulderTurnSeen = true;
        if (this.body.guideHandUp) this.guideHandSeen = true;
        this.recordPosture(this.body);
        if (!this.beatFired && t >= this.beatTime) {
          this.beatFired = true;
          // Garantiza que ninguna voz previa suene encima del click del beat
          this.voice.cancel();
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
        if (t - this.phaseStart > this.resultDuration) {
          this.repIndex++;
          if (this.repIndex >= this.totalReps) {
            this.phase = 'done';
            this.onFinish?.(this.buildSummary());
          } else {
            if (this.express) {
              this.shot = EXPRESS_WARMUP_SEQUENCE[this.repIndex];
            }
            this.setPhase('announce', t);
          }
        }
        break;
    }
  }

  private setPhase(p: Phase, t: number): void {
    this.phase = p;
    this.phaseStart = t;
    if (p === 'announce' && this.express && this.announcedRepIndex !== this.repIndex) {
      const cue = EXPRESS_TRANSITION_VOICE[this.repIndex];
      if (cue) {
        this.announcedRepIndex = this.repIndex;
        this.voice.speak(cue, 50);
      }
    }
    if (p === 'strike') {
      this.ringT = 1;
      this.beatFired = false;
    }
    if (p !== 'result') this.feedback = null;
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
    return this.phase === 'strike'
      ? this.beatTime
      : this.phaseStart + this.prepDuration + T_RING;
  }

  private resolveRep(t: number): void {
    if (this.phase !== 'strike' && this.phase !== 'prep') return;
    const s = this.capturedSwing;
    const beat = this.beatEstimate();
    const body = this.body;
    const fullPrepOk = this.prepSeen && this.shoulderTurnSeen && this.guideHandSeen;

    let rep: RepResult;
    if (!s) {
      rep = {
        shot: this.shot,
        swung: false,
        dtMs: null,
        zoneDistBw: null,
        power: 0,
        prepOk: fullPrepOk,
        shoulderTurnOk: this.shoulderTurnSeen,
        guideHandOk: this.guideHandSeen,
        kneesOk: !this.kneesBadSeen,
        stanceOk: !this.stanceBadSeen,
        timingOk: false,
        postureOk: !this.postureBadSeen,
        score: 0,
        correct: false,
        cause: 'noswing',
      };
      this.feedback = {
        text: 'SIN GOLPE',
        level: 'bad',
        voice: '¡Suelta el brazo al pitido!',
      };
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
      const fScore = (fullPrepOk ? 10 : 0) + (this.postureBadSeen ? 0 : 10);
      const score = tScore + zScore + fScore;

      let cause: FailCause = null;
      if (tScore === 10) cause = dt < 0 ? 'early' : 'late';
      else if (zScore === 10) cause = 'zone';
      else if (fScore < 20) cause = 'form';

      // Correcta = sin fallo grave y puntuación alta
      const correct = score >= 70 && (cause === null || cause === 'form');

      // Regla estricta: priorizar SOLO 1 corrección principal por repetición
      if (cause === 'early') {
        this.feedback = {
          text: 'MUY PRONTO',
          level: 'bad',
          voice: '¡Te adelantaste, espera la bola!',
        };
      } else if (cause === 'late') {
        this.feedback = {
          text: 'TARDE',
          level: 'bad',
          voice: '¡Punto de contacto muy retrasado!',
        };
      } else if (cause === 'zone') {
        const tooClose =
          body &&
          s.pos &&
          Math.abs(s.pos.x - body.hipCenter.x) <
            Math.abs(impactZone(this.shot, body).c.x - body.hipCenter.x);
        this.feedback = {
          text: tooClose ? 'EXTIENDE EL BRAZO' : 'IMPACTA MÁS CERCA',
          level: 'warn',
          voice: tooClose ? '¡Extiende más el brazo!' : '¡Impacta más cerca del cuerpo!',
        };
      } else if (cause === 'form') {
        if (!this.prepSeen) {
          this.feedback = {
            text: 'PREPARA ANTES LA PALA',
            level: 'warn',
            voice: '¡Arma la pala antes!',
          };
        } else if (!this.shoulderTurnSeen) {
          this.feedback = {
            text: 'PERFILA LOS HOMBROS',
            level: 'warn',
            voice: '¡Gira los hombros y ponte de lado!',
          };
        } else if (!this.guideHandSeen) {
          const shotLbl = this.shot === 'bandeja' ? 'la bandeja' : 'el remate';
          this.feedback = {
            text: 'LEVANTA LA MANO LIBRE',
            level: 'warn',
            voice: `¡Levanta la mano libre para apuntar ${shotLbl}!`,
          };
        } else if (this.postureFault === 'stance') {
          this.feedback = {
            text: 'SEPARA LOS PIES',
            level: 'warn',
            voice: '¡Separa más los pies!',
          };
        } else if (this.postureFault === 'balance') {
          this.feedback = {
            text: 'CUIDA EL EQUILIBRIO',
            level: 'warn',
            voice: '¡Cuida el equilibrio de los hombros!',
          };
        } else {
          this.feedback = {
            text: 'FLEXIONA LAS RODILLAS',
            level: 'warn',
            voice: '¡Flexiona más las rodillas!',
          };
        }
      } else if (score >= 90) {
        this.feedback = {
          text: 'PERFECTO',
          level: 'good',
          voice: '¡Impacto perfecto!',
        };
      } else {
        this.feedback = {
          text: 'BUEN GOLPE',
          level: 'good',
          voice: '¡Buen impacto!',
        };
      }

      rep = {
        shot: this.shot,
        swung: true,
        dtMs,
        zoneDistBw,
        power: s.power,
        prepOk: fullPrepOk,
        shoulderTurnOk: this.shoulderTurnSeen,
        guideHandOk: this.guideHandSeen,
        kneesOk: !this.kneesBadSeen,
        stanceOk: !this.stanceBadSeen,
        timingOk: tScore > 10,
        postureOk: !this.postureBadSeen,
        score,
        correct,
        cause,
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
    // En Calentamiento Express, si la siguiente repetición tiene anuncio de cambio de golpe
    // (reps 3, 6, 9), igual damos el feedback inmediato de esta rep durante `result` y al
    // entrar en `announce` se cantará la transición de golpe.
    if (this.feedback) {
      this.voice.speak(this.feedback.voice, rep.swung ? SFX_VOICE_DELAY_MS : 40);
    }
    this.setPhase('result', t);
  }

  get consistency(): number {
    if (this.reps.length === 0) return 0;
    return Math.round(this.reps.reduce((a, r) => a + r.score, 0) / this.reps.length);
  }

  private buildSummary(): TrainingSummary {
    const reps = this.reps;
    const totalReps = reps.length || 1;
    const swung = reps.filter((r) => r.dtMs !== null);
    const correct = reps.filter((r) => r.correct).length;
    const avgAbsDtMs = swung.length
      ? Math.round(swung.reduce((a, r) => a + Math.abs(r.dtMs!), 0) / swung.length)
      : null;
    const meanDtMs = swung.length
      ? Math.round(swung.reduce((a, r) => a + r.dtMs!, 0) / swung.length)
      : null;
    const avgPower = swung.length ? swung.reduce((a, r) => a + r.power, 0) / swung.length : 0;

    const shoulderTurnFaults = reps.filter((r) => !r.shoulderTurnOk).length;

    // 1. Desglose de fallos por tipo de biomecánica (rodillas, armado, separación de pies, timing)
    const biomechanics: BiomechanicsBreakdown = {
      knees: reps.filter((r) => !r.kneesOk).length,
      prep: reps.filter((r) => !r.prepOk).length,
      stance: reps.filter((r) => !r.stanceOk).length,
      timing: reps.filter((r) => !r.timingOk).length,
      shoulderTurn: shoulderTurnFaults,
      totalReps,
    };

    const pct = (faults: number) => clamp(Math.round((1 - faults / totalReps) * 100), 0, 100);
    const pillars: BiomechanicPillars = {
      knees: pct(biomechanics.knees),
      shoulderTurn: pct(shoulderTurnFaults),
      prep: pct(biomechanics.prep),
      timing: pct(biomechanics.timing),
    };

    const bioKeys: BiomechanicKey[] = ['timing', 'prep', 'knees', 'stance'];
    let dominantFault: BiomechanicKey | null = null;
    let maxBioCount = 0;
    for (const k of bioKeys) {
      if (biomechanics[k] > maxBioCount) {
        maxBioCount = biomechanics[k];
        dominantFault = k;
      }
    }

    // Si hubo fallo dominante, identificar en qué golpe se concentró más (especialmente útil en express)
    let focusShot: ShotType = this.express ? 'forehand' : this.shot;
    if (this.express && dominantFault) {
      const faultCounts = new Map<ShotType, number>();
      for (const r of reps) {
        const failed =
          (dominantFault === 'knees' && !r.kneesOk) ||
          (dominantFault === 'prep' && !r.prepOk) ||
          (dominantFault === 'stance' && !r.stanceOk) ||
          (dominantFault === 'timing' && !r.timingOk);
        if (failed) faultCounts.set(r.shot, (faultCounts.get(r.shot) ?? 0) + 1);
      }
      let bestCount = 0;
      for (const [sh, cnt] of faultCounts) {
        if (cnt > bestCount) {
          bestCount = cnt;
          focusShot = sh;
        }
      }
    }

    const name = this.express ? 'Calentamiento Express' : SHOT_NAMES[this.shot];
    const currentDrill: DrillType = SHOT_DRILL[focusShot] ?? 'forehand';
    const consistency = this.consistency;

    const coachCard = this.buildCoachDiagnosisCard(
      dominantFault,
      biomechanics,
      totalReps,
      meanDtMs,
      consistency,
      name,
      focusShot,
      currentDrill,
    );

    // Identificador estable para correcciones recurrentes en progress.ts
    let mainIssue: { text: string; tipId: string } | null = null;
    if (dominantFault && biomechanics[dominantFault] >= 2) {
      const tipId =
        dominantFault === 'timing'
          ? (meanDtMs ?? 0) >= 0
            ? 'timing-tarde'
            : 'timing-pronto'
          : `biomec-${dominantFault}`;
      mainIssue = {
        text: `${BIOMECHANIC_LABELS[dominantFault]}: ${coachCard.diagnosis}`,
        tipId,
      };
    }

    const recommendation = `${coachCard.exerciseName} — ${coachCard.exerciseReason}`;

    return {
      shot: focusShot,
      express: this.express,
      reps,
      correct,
      consistency,
      avgAbsDtMs,
      meanDtMs,
      bestStreak: this.bestStreak,
      avgPower,
      biomechanics,
      pillars,
      dominantFault,
      coachCard,
      mainIssue,
      recommendation,
    };
  }

  private buildCoachDiagnosisCard(
    dominantFault: BiomechanicKey | null,
    biomechanics: BiomechanicsBreakdown,
    totalReps: number,
    meanDtMs: number | null,
    consistency: number,
    sessionLabel: string,
    targetShot: ShotType,
    currentDrill: DrillType,
  ): CoachDiagnosisCard {
    const targetShotName = SHOT_NAMES[targetShot];
    if (!dominantFault || biomechanics[dominantFault] === 0) {
      const nextShot: ShotType =
        targetShot === 'forehand' ? 'backhand' : targetShot === 'backhand' ? 'bandeja' : 'vibora';
      const nextDrill: DrillType = SHOT_DRILL[nextShot] ?? 'mixto';
      return {
        dominantFault: null,
        badgeText: 'BIOMECÁNICA IMPECABLE',
        diagnosis: `Has mantenido una postura sólida, buen perfilado de hombros y sincronización en ${sessionLabel} (${consistency}% de consistencia).`,
        exerciseName: `Siguiente reto: Técnica de ${SHOT_NAMES[nextShot]}`,
        exerciseReason: `Transfiere esta calidad de apoyos y lectura de bola a tu ${SHOT_NAMES[nextShot]}.`,
        targetShot: nextShot,
        targetDrill: nextDrill,
      };
    }

    const n = biomechanics[dominantFault];
    switch (dominantFault) {
      case 'knees':
        return {
          dominantFault: 'knees',
          badgeText: `FALLO DOMINANTE · RODILLAS (${n}/${totalReps})`,
          diagnosis: `Mantuviste las piernas demasiado rígidas en ${n} de ${totalReps} repeticiones. Sin flexión de rodillas pierdes transferencia de peso y control de altura.`,
          exerciseName: `Repetir ${targetShotName} con centro de gravedad bajo`,
          exerciseReason: `Lanza una serie específica de ${targetShotName} flexionando las rodillas desde el aviso de preparación antes de cada impacto.`,
          targetShot,
          targetDrill: currentDrill,
        };

      case 'prep': {
        const turnFaults = this.reps.filter((r) => !r.shoulderTurnOk).length;
        const guideFaults = this.reps.filter((r) => !r.guideHandOk).length;
        if (guideFaults >= turnFaults && guideFaults > 0 && requiresGuideHand(targetShot)) {
          return {
            dominantFault: 'prep',
            badgeText: `FALLO DOMINANTE · MANO GUÍA (${guideFaults}/${totalReps})`,
            diagnosis: `Dejaste caer la mano no dominante en ${guideFaults} de ${totalReps} repeticiones aéreas. Levantar la mano libre equilibra los hombros y apunta la bola.`,
            exerciseName: `Serie de ${targetShotName} apuntando con mano guía`,
            exerciseReason: `Repite ${targetShotName} elevando la mano libre al anillo superior antes de armar el golpe.`,
            targetShot,
            targetDrill: currentDrill,
          };
        }
        if (turnFaults > 0 && requiresShoulderTurn(targetShot)) {
          return {
            dominantFault: 'prep',
            badgeText: `FALLO DOMINANTE · PERFILADO (${turnFaults}/${totalReps})`,
            diagnosis: `Golpeaste con el pecho de frente en ${turnFaults} de ${totalReps} repeticiones. En pádel es clave girar los hombros y ponerse de lado en la preparación.`,
            exerciseName: `Serie de perfilado lateral en ${targetShotName}`,
            exerciseReason: `Repite ${targetShotName} girando el tronco de lado hasta que la silueta de armado se ilumine en verde/cian.`,
            targetShot,
            targetDrill: currentDrill,
          };
        }
        return {
          dominantFault: 'prep',
          badgeText: `FALLO DOMINANTE · ARMADO (${n}/${totalReps})`,
          diagnosis: `No armaste la pala a tiempo en ${n} de ${totalReps} repeticiones. Preparar tarde te obliga a dar un latigazo precipitado.`,
          exerciseName: `Serie de armado temprano en ${targetShotName}`,
          exerciseReason: `Repite ${targetShotName} llevando la mano hacia atrás en cuanto aparezca «PREPARA LA PALA», antes de que empiece a cerrarse el anillo.`,
          targetShot,
          targetDrill: currentDrill,
        };
      }

      case 'stance':
        return {
          dominantFault: 'stance',
          badgeText: `FALLO DOMINANTE · SEPARACIÓN DE PIES (${n}/${totalReps})`,
          diagnosis: `Jugaste con los pies demasiado juntos en ${n} de ${totalReps} repeticiones, restando equilibrio en el momento del impacto.`,
          exerciseName: `Serie de estabilidad y base en ${targetShotName}`,
          exerciseReason: `Repite el ejercicio separando los pies un poco más que el ancho de tus hombros durante toda la serie.`,
          targetShot,
          targetDrill: currentDrill,
        };

      case 'timing': {
        const isLate = (meanDtMs ?? 0) >= 0;
        return {
          dominantFault: 'timing',
          badgeText: `FALLO DOMINANTE · TIMING (${n}/${totalReps})`,
          diagnosis: isLate
            ? `Tu impacto fue tardío en ${n} de ${totalReps} repeticiones (media ${meanDtMs !== null ? `+${meanDtMs} ms` : 'tarde'}). Dejas que la bola se te eche encima.`
            : `Te precipitaste antes del impacto ideal en ${n} de ${totalReps} repeticiones (media ${meanDtMs !== null ? `${meanDtMs} ms` : 'pronto'}).`,
          exerciseName: `Sincronización de impacto en ${targetShotName}`,
          exerciseReason: isLate
            ? `Trabaja ${targetShotName} iniciando el avance del brazo justo antes de que la bola virtual entre en el círculo.`
            : `Trabaja ${targetShotName} aguantando la pala armada hasta que la bola virtual toque el centro de la zona.`,
          targetShot,
          targetDrill: currentDrill,
        };
      }
    }
  }
}
