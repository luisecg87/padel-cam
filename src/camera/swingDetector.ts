import { LM } from './pose';
import type { PoseFrame } from './pose';
import { clamp } from '../types';

// Umbrales relativos al ancho de hombros ("anchos de cuerpo por segundo"):
// así la sensibilidad es la misma estés cerca o lejos de la cámara.
export const SWING_SPEED_BW = 6.5; // velocidad mínima de la muñeca
export const SWING_MIN_DIST_BW = 0.55; // recorrido mínimo (evita disparos por ruido)
export const SWING_COOLDOWN = 0.5; // s entre golpes
export const HISTORY_MS = 170;

interface WristSample {
  t: number; // segundos
  x: number; // espejado (0 = izquierda del jugador en pantalla)
  y: number;
}

export interface DetectedSwing {
  t: number; // s
  pos: { x: number; y: number }; // posición de la muñeca en espejo en el instante de disparo
  dir: -1 | 0 | 1;
  power: number; // 0..1
  overhead: boolean;
}

/**
 * Detector compartido de golpes (swings) a partir del movimiento de las muñecas
 * medido en "anchos de hombros" (bw). Usado tanto en el control de partido/práctica
 * (`CameraControl`) como en las sesiones de entrenamiento técnico (`TrainingSession`).
 */
export class WristSwingDetector {
  private history: Record<'L' | 'R', WristSample[]> = { L: [], R: [] };
  private lastSwingT = 0;
  private lastFrameT = -1;

  reset(): void {
    this.history.L = [];
    this.history.R = [];
  }

  detect(frame: PoseFrame, bw: number, t = frame.t / 1000): DetectedSwing | null {
    if (frame.t === this.lastFrameT) return null;
    this.lastFrameT = frame.t;

    const lm = frame.lm;
    const vis = (i: number): boolean => (lm[i]?.visibility ?? 0) > 0.4;

    for (const hand of ['L', 'R'] as const) {
      const wi = hand === 'L' ? LM.L_WRIST : LM.R_WRIST;
      if (!vis(wi)) {
        this.history[hand] = [];
        continue;
      }
      const w = lm[wi];
      const sample: WristSample = { t, x: 1 - w.x, y: w.y };
      const hist = this.history[hand];
      hist.push(sample);
      while (hist.length > 0 && t - hist[0].t > HISTORY_MS / 1000) hist.shift();
      if (hist.length < 3) continue;

      const first = hist[0];
      const dtw = sample.t - first.t;
      if (dtw < 0.06) continue;
      const dx = sample.x - first.x;
      const dy = sample.y - first.y;
      // Velocidad y recorrido en "anchos de cuerpo": independiente de la distancia
      const speedBw = Math.hypot(dx, dy) / dtw / bw;
      const distBw = Math.hypot(dx, dy) / bw;

      if (
        speedBw > SWING_SPEED_BW &&
        distBw > SWING_MIN_DIST_BW &&
        t - this.lastSwingT > SWING_COOLDOWN
      ) {
        this.lastSwingT = t;
        const shoulderY = (lm[LM.L_SHOULDER].y + lm[LM.R_SHOULDER].y) / 2;
        // Golpe alto: la muñeca estaba por encima de los hombros y baja con fuerza
        const overhead = first.y < shoulderY && dy / dtw > 0.4;
        const vxBw = dx / dtw / bw;
        const dir: -1 | 0 | 1 = vxBw > 3 ? 1 : vxBw < -3 ? -1 : 0;
        // Fuerza del gesto: brazo lento arriba = bandeja, latigazo = remate
        const power = clamp((speedBw - SWING_SPEED_BW) / 9, 0, 1);
        this.reset();
        return {
          t,
          pos: { x: sample.x, y: sample.y },
          dir,
          power,
          overhead,
        };
      }
    }
    return null;
  }
}
