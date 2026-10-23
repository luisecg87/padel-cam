import { WristSwingDetector } from '../camera/swingDetector';
import type { DetectedSwing } from '../camera/swingDetector';
import type { PoseFrame } from '../camera/pose';
import { sfx } from '../audio/sfx';
import { BIOMECHANIC_LABELS, SHOT_DRILL } from '../analysis/progress';
import type { BiomechanicKey, BiomechanicsBreakdown } from '../analysis/progress';
import { impactZone, readBody, worstPostureCue } from './metrics';
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
const T_ANNOUNCE = 0.9;
const T_PREP = 1.7;
const T_RING = 1.0; // el anillo converge; al llegar a 0 suena el beat
const T_AFTER = 0.45; // margen tras el beat para aceptar el golpe
const T_RESULT = 1.25;

/** Margen (ms) para que termine el efecto de sonido (good/bad ~240ms) antes de hablar. */
const SFX_VOICE_DELAY_MS = 260;

export type FailCause = 'early' | 'late' | 'noswing' | 'zone' | 'form' | null;
type PostureFault = 'knees' | 'stance' | 'balance' | null;

export interface RepResult {
  swung: boolean;
  dtMs: number | null; // golpe respecto al beat (negativo = pronto)
  zoneDistBw: number | null; // distancia muñeca→zona de impacto (anchos de cuerpo)
  power: number; // 0..1
  prepOk: boolean; // armado temprano de la pala
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
  /** Frase cantada por el entrenador por voz (Web Speech API). */
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
  reps: RepResult[];
  correct: number;
  consistency: number; // media de score 0..100
  avgAbsDtMs: number | null;
  meanDtMs: number | null;
  bestStreak: number;
  avgPower: number;
  /** Desglose de fallos por tipo de biomecánica (rodillas, armado, separación de pies, timing). */
  biomechanics: BiomechanicsBreakdown;
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
  private swingDetector = new WristSwingDetector();
  private voice = new VoiceCoach();
  private capturedSwing: DetectedSwing | null = null;
  private resolveTime: number | null = null; // resolución diferida: deja terminar la extensión
  private maxExt = 0; // máxima distancia muñeca-cadera vista desde la captura
  private prepSeen = false;
  private kneesBadSeen = false;
  private stanceBadSeen = false;
  private postureBadSeen = false;
  private postureFault: PostureFault = null;
  lastPower = 0;

  constructor(shot: ShotType) {
    this.shot = shot;
  }

  /** Cancela locuciones pendientes o en curso (llamar al cerrar la vista de entrenamiento). */
  stopSpeech(): void {
    this.voice.cancel();
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
    this.body = readBody(frame, this.shot);

    if (this.phase === 'done') return;

    // Sin cuerpo visible: pausar la sesión hasta volver a verlo
    if (!this.body) {
      if (this.phase !== 'searching') this.setPhase('searching', t);
      this.stableFrames = 0;
      this.swingDetector.reset();
      return;
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
        if (t - this.phaseStart > T_ANNOUNCE) {
          this.prepSeen = false;
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
        this.recordPosture(this.body);
        if (t - this.phaseStart > T_PREP) this.setPhase('strike', t);
        break;

      case 'strike': {
        this.ringT = clamp(1 - (t - this.phaseStart) / T_RING, 0, 1);
        if (this.body.prepared) this.prepSeen = true;
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
        swung: false,
        dtMs: null,
        zoneDistBw: null,
        power: 0,
        prepOk: this.prepSeen,
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
      const fScore = (this.prepSeen ? 10 : 0) + (this.postureBadSeen ? 0 : 10);
      const score = tScore + zScore + fScore;

      let cause: FailCause = null;
      if (tScore === 10) cause = dt < 0 ? 'early' : 'late';
      else if (zScore === 10) cause = 'zone';
      else if (fScore < 20) cause = 'form';

      // Correcta = sin fallo grave y puntuación alta
      const correct = score >= 70 && (cause === null || cause === 'form');

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
        swung: true,
        dtMs,
        zoneDistBw,
        power: s.power,
        prepOk: this.prepSeen,
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
    // Cuando hubo swing, suena sfx.good() o sfx.bad() (~240 ms); retrasamos la
    // locución para que no se solape con el efecto de sonido. Si no hubo swing,
    // no suena efecto de golpe y la voz puede entrar casi de inmediato.
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

    // 1. Desglose de fallos por tipo de biomecánica (rodillas, armado, separación de pies, timing)
    const biomechanics: BiomechanicsBreakdown = {
      knees: reps.filter((r) => !r.kneesOk).length,
      prep: reps.filter((r) => !r.prepOk).length,
      stance: reps.filter((r) => !r.stanceOk).length,
      timing: reps.filter((r) => !r.timingOk).length,
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

    const name = SHOT_NAMES[this.shot];
    const currentDrill: DrillType = SHOT_DRILL[this.shot] ?? 'forehand';
    const consistency = this.consistency;

    const coachCard = this.buildCoachDiagnosisCard(
      dominantFault,
      biomechanics,
      totalReps,
      meanDtMs,
      consistency,
      name,
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
      shot: this.shot,
      reps,
      correct,
      consistency,
      avgAbsDtMs,
      meanDtMs,
      bestStreak: this.bestStreak,
      avgPower,
      biomechanics,
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
    shotName: string,
    currentDrill: DrillType,
  ): CoachDiagnosisCard {
    if (!dominantFault || biomechanics[dominantFault] === 0) {
      const nextShot: ShotType = this.shot === 'forehand' ? 'backhand' : this.shot === 'backhand' ? 'bandeja' : 'vibora';
      const nextDrill: DrillType = SHOT_DRILL[nextShot] ?? 'mixto';
      return {
        dominantFault: null,
        badgeText: 'BIOMECÁNICA IMPECABLE',
        diagnosis: `Has mantenido una postura sólida, buen armado y sincronización en tus repeticiones de ${shotName} (${consistency}% de consistencia).`,
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
          exerciseName: `Repetir ${shotName} con centro de gravedad bajo`,
          exerciseReason: `Vuelve a lanzar la serie de ${shotName} flexionando las rodillas desde el aviso de preparación antes de cada impacto.`,
          targetShot: this.shot,
          targetDrill: currentDrill,
        };

      case 'prep':
        return {
          dominantFault: 'prep',
          badgeText: `FALLO DOMINANTE · ARMADO (${n}/${totalReps})`,
          diagnosis: `No armaste la pala a tiempo en ${n} de ${totalReps} repeticiones. Preparar tarde te obliga a dar un latigazo precipitado.`,
          exerciseName: `Serie de armado temprano en ${shotName}`,
          exerciseReason: `Repite ${shotName} llevando la mano hacia atrás en cuanto aparezca «PREPARA LA PALA», antes de que empiece a cerrarse el anillo.`,
          targetShot: this.shot,
          targetDrill: currentDrill,
        };

      case 'stance':
        return {
          dominantFault: 'stance',
          badgeText: `FALLO DOMINANTE · SEPARACIÓN DE PIES (${n}/${totalReps})`,
          diagnosis: `Jugaste con los pies demasiado juntos en ${n} de ${totalReps} repeticiones, restando equilibrio en el momento del impacto.`,
          exerciseName: `Serie de estabilidad y base en ${shotName}`,
          exerciseReason: `Repite el ejercicio separando los pies un poco más que el ancho de tus hombros durante toda la serie.`,
          targetShot: this.shot,
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
          exerciseName: `Sincronización de impacto en ${shotName}`,
          exerciseReason: isLate
            ? `Repite la sesión de ${shotName} iniciando el avance del brazo justo antes de que la bola virtual entre en el círculo.`
            : `Repite la sesión de ${shotName} aguantando la pala armada hasta que la bola virtual toque el centro de la zona.`,
          targetShot: this.shot,
          targetDrill: currentDrill,
        };
      }
    }
  }
}
