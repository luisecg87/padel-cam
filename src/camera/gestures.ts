import { LM, PoseTracker, drawPreview } from './pose';
import {
  HISTORY_MS,
  SWING_COOLDOWN,
  SWING_MIN_DIST_BW,
  SWING_SPEED_BW,
  WristSwingDetector,
} from './swingDetector';
import { readBody } from '../training/metrics';
import type { Level } from '../training/metrics';
import { clamp } from '../types';
import type { ControlAdapter, MoveIntent, SwingEvent } from '../ui/input';

export { HISTORY_MS, SWING_COOLDOWN, SWING_MIN_DIST_BW, SWING_SPEED_BW };

export interface CalibrationData {
  neutralHipX: number; // x de las caderas (espejado) en posición neutra
  shoulderWidth: number; // ancho de hombros normalizado, como escala corporal
}

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
  private swingDetector = new WristSwingDetector();
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
    const detected = this.swingDetector.detect(frame, bw);
    if (detected) {
      // Forma técnica en el momento del golpe: alimenta el gameplay
      const body = readBody(frame, 'forehand');
      const lvl = (l: Level): number => (l === 'good' ? 1 : l === 'warn' ? 0.7 : 0.4);
      const form = body
        ? {
            posture: (lvl(body.stance.level) + lvl(body.knees.level) + lvl(body.balance.level)) / 3,
            extension: Math.hypot(detected.pos.x - body.hipCenter.x, detected.pos.y - body.hipCenter.y) / bw,
          }
        : { posture: 0.75, extension: null };
      this.swings.push({
        dir: detected.dir,
        overhead: detected.overhead,
        power: detected.power,
        form,
      });
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
