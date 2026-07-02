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

const SWING_SPEED = 1.5; // unidades normalizadas por segundo
const SWING_COOLDOWN = 0.55; // s entre golpes
const HISTORY_MS = 200;

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

    // --- Desplazamiento lateral: caderas → x de pista (espejado) ---
    const hipX = 1 - (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2; // espejo selfie
    // Rango útil: media pantalla de cámara a cada lado, escalado al cuerpo
    const range = Math.max(this.calib.shoulderWidth * 1.6, 0.18);
    const rel = (hipX - (1 - this.calib.neutralHipX)) / range;
    const targetX = clamp(rel * 4.5, -4.6, 4.6);
    this.courtX += (targetX - this.courtX) * 0.25; // suavizado

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
      const vx = (sample.x - first.x) / dtw;
      const vy = (sample.y - first.y) / dtw;
      const speed = Math.hypot(vx, vy);

      if (speed > SWING_SPEED && t - this.lastSwingT > SWING_COOLDOWN) {
        this.lastSwingT = t;
        const shoulderY = (lm[LM.L_SHOULDER].y + lm[LM.R_SHOULDER].y) / 2;
        // Remate: la muñeca estaba por encima de los hombros y baja con fuerza
        const overhead = first.y < shoulderY && vy > 0.4;
        const dir: -1 | 0 | 1 = vx > 0.7 ? 1 : vx < -0.7 ? -1 : 0;
        this.swings.push({ dir, overhead });
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
