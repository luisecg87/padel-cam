import { clamp } from '../types';

// Detección de swing a partir de la muñeca: ÚNICO sitio donde vive. El
// control del juego (gestures.ts) y el entrenamiento técnico (session.ts)
// la comparten, así el mismo gesto cuenta igual en todos los modos.
//
// Umbrales relativos al ancho de hombros ("anchos de cuerpo por segundo"):
// la sensibilidad es la misma estés cerca o lejos de la cámara.
export const SWING_SPEED_BW = 6.5; // velocidad mínima de la muñeca
export const SWING_MIN_DIST_BW = 0.55; // recorrido mínimo (evita disparos por ruido)
export const SWING_COOLDOWN = 0.5; // s entre golpes
export const HISTORY_MS = 170;

export interface WristPt {
  x: number; // en espejo (tu derecha queda a la derecha de la pantalla)
  y: number;
}

interface WristSample {
  t: number; // segundos
  pos: WristPt;
}

export interface DetectedSwing {
  t: number; // s
  pos: WristPt; // muñeca en el momento de la detección
  dir: -1 | 0 | 1; // hacia dónde barre el gesto (izq/centro/dcha)
  /** La muñeca estaba por encima de los hombros y baja con fuerza. */
  overhead: boolean;
  power: number; // 0..1: fuerza del gesto
}

export class SwingDetector {
  private history: Record<'L' | 'R', WristSample[]> = { L: [], R: [] };
  private lastSwingT = 0;

  reset(): void {
    this.history.L = [];
    this.history.R = [];
  }

  /**
   * Alimenta un frame nuevo de pose (una vez por frame, no por tick de
   * render). `wrists` va en espejo; `null` = muñeca no visible.
   */
  feed(
    t: number,
    wrists: Record<'L' | 'R', WristPt | null>,
    bw: number,
    shoulderY: number,
  ): DetectedSwing | null {
    for (const hand of ['L', 'R'] as const) {
      const pos = wrists[hand];
      if (!pos) {
        this.history[hand] = [];
        continue;
      }
      const hist = this.history[hand];
      hist.push({ t, pos });
      while (hist.length > 0 && t - hist[0].t > HISTORY_MS / 1000) hist.shift();
      if (hist.length < 3) continue;

      const first = hist[0];
      const dtw = t - first.t;
      if (dtw < 0.06) continue;
      const dx = pos.x - first.pos.x;
      const dy = pos.y - first.pos.y;
      // Velocidad y recorrido en "anchos de cuerpo": independiente de la distancia
      const speedBw = Math.hypot(dx, dy) / dtw / bw;
      const distBw = Math.hypot(dx, dy) / bw;

      if (
        speedBw > SWING_SPEED_BW &&
        distBw > SWING_MIN_DIST_BW &&
        t - this.lastSwingT > SWING_COOLDOWN
      ) {
        this.lastSwingT = t;
        this.reset();
        const vxBw = dx / dtw / bw;
        return {
          t,
          pos,
          dir: vxBw > 3 ? 1 : vxBw < -3 ? -1 : 0,
          overhead: first.pos.y < shoulderY && dy / dtw > 0.4,
          // Brazo lento arriba = bandeja, latigazo = remate
          power: clamp((speedBw - SWING_SPEED_BW) / 9, 0, 1),
        };
      }
    }
    return null;
  }
}
