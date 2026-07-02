import { LM, PoseTracker, drawPreview } from './pose';
import { clamp } from '../types';
import type { ControlAdapter, MoveIntent, SwingEvent } from '../ui/input';

export interface CalibrationData {
  neutralHipX: number; // x de las caderas (espejado) en posición neutra
  shoulderWidth: number; // ancho de hombros normalizado, como escala corporal
}

interface WristSample {
  t: number; // segundos
  x: number; // espejado (0 = izquierda del jugador en pantalla)
  y: number;
}

// Umbrales relativos al ancho de hombros ("anchos de cuerpo por segundo"):
// así la sensibilidad es la misma estés cerca o lejos de la cámara.
const SWING_SPEED_BW = 6.5; // velocidad mínima de la muñeca
const SWING_MIN_DIST_BW = 0.55; // recorrido mínimo (evita disparos por ruido)
const SWING_COOLDOWN = 0.5; // s entre golpes
const HISTORY_MS = 170;
const LATERAL_RANGE_BW = 3.0; // anchos de cuerpo que cubren media pista

/**
 * Convierte los landmarks de MediaPipe en el control del juego:
 * caderas → posición lateral en pista, muñecas rápidas → golpes.
 */
export class CameraControl implements ControlAdapter {
  tracker: PoseTracker;
  calib: CalibrationData;
  bodyVisible = false;

  private courtX = 0; // posición objetivo en pista, suavizada
  private swings: SwingEvent[] = [];
  private lastSwingT = 0;
  private history: Record<'L' | 'R', WristSample[]> = { L: [], R: [] };
  private lastFrameT = 0;
  private preview: HTMLCanvasElement;

  constructor(tracker: PoseTracker, calib: CalibrationData, preview: HTMLCanvasElement) {
    this.tracker = tracker;
    this.calib = calib;
    this.preview = preview;
  }

  update(_dt: number): void {
    const frame = this.tracker.latest;
    drawPreview(this.preview, this.tracker.video, frame);
    if (!frame || frame.t === this.lastFrameT) return;
    this.lastFrameT = frame.t;
    const t = frame.t / 1000;
    const lm = frame.lm;

    const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.4;
    this.bodyVisible = vis(LM.L_HIP) && vis(LM.R_HIP) && (vis(LM.L_WRIST) || vis(LM.R_WRIST));
    if (!this.bodyVisible) return;

    // Escala corporal del frame actual: se adapta si te acercas o alejas
    const bw =
      vis(LM.L_SHOULDER) && vis(LM.R_SHOULDER)
        ? Math.max(Math.abs(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x), 0.06)
        : Math.max(this.calib.shoulderWidth, 0.06);

    // --- Desplazamiento lateral: caderas → x de pista (espejado) ---
    const hipX = 1 - (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2; // espejo selfie
    const rel = (hipX - (1 - this.calib.neutralHipX)) / (bw * LATERAL_RANGE_BW);
    const targetX = clamp(rel, -1, 1) * 4.6;
    // Suavizado adaptativo: firme quieto (sin temblor), rápido al moverse
    const diff = targetX - this.courtX;
    const alpha = clamp(0.1 + Math.abs(diff) * 0.22, 0.1, 0.55);
    this.courtX += diff * alpha;

    // --- Detección de swings con las muñecas ---
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
        this.swings.push({ dir, overhead, power });
        this.history.L = [];
        this.history.R = [];
        break;
      }
    }
  }

  getMove(): MoveIntent {
    return { mode: 'absolute', x: this.courtX };
  }

  consumeSwings(): SwingEvent[] {
    const s = this.swings;
    this.swings = [];
    return s;
  }

  destroy(): void {
    // El tracker lo gestiona main.ts (se reutiliza entre partidas)
  }
}
