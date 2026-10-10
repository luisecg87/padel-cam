import { LM, PoseTracker, drawPreview } from './pose';
import type { PoseFrame } from './pose';
import { SwingDetector } from './swing';
import { readBody } from '../training/metrics';
import type { Level } from '../training/metrics';
import { clamp } from '../types';
import type { ArmPose, ControlAdapter, LivePose, MoveIntent, SwingEvent } from '../ui/input';

export interface CalibrationData {
  neutralHipX: number; // x de las caderas (espejado) en posición neutra
  shoulderWidth: number; // ancho de hombros normalizado, como escala corporal
}

const LATERAL_RANGE_BW = 3.0; // anchos de cuerpo que cubren media pista
const POSE_SMOOTH = 0.55; // suavizado de la pose en vivo (1 = sin suavizar)
const ARM_MAX_BW = 2.2; // tope de alcance: descarta saltos del detector

const visible = (frame: PoseFrame, i: number): boolean => (frame.lm[i]?.visibility ?? 0) > 0.4;

/**
 * Brazo real relativo a su hombro, en espejo y en anchos de hombro.
 * `aspect` (alto/ancho del vídeo) corrige que x e y vienen normalizadas
 * cada una por su dimensión: sin él, el brazo se deforma en móvil vertical.
 */
function readArm(
  frame: PoseFrame,
  shoulder: number,
  elbow: number,
  wrist: number,
  bw: number,
  aspect: number,
): ArmPose | null {
  if (!visible(frame, shoulder) || !visible(frame, elbow) || !visible(frame, wrist)) return null;
  const s = frame.lm[shoulder];
  const rel = (i: number): { x: number; y: number } => {
    const p = frame.lm[i];
    const x = -(p.x - s.x) / bw; // espejo
    const y = ((p.y - s.y) * aspect) / bw;
    const len = Math.hypot(x, y);
    const k = len > ARM_MAX_BW ? ARM_MAX_BW / len : 1;
    return { x: x * k, y: y * k };
  };
  const e = rel(elbow);
  const h = rel(wrist);
  return { ex: e.x, ey: e.y, hx: h.x, hy: h.y };
}

function smoothArm(prev: ArmPose | null, next: ArmPose | null): ArmPose | null {
  if (!prev || !next) return next;
  const k = POSE_SMOOTH;
  return {
    ex: prev.ex + (next.ex - prev.ex) * k,
    ey: prev.ey + (next.ey - prev.ey) * k,
    hx: prev.hx + (next.hx - prev.hx) * k,
    hy: prev.hy + (next.hy - prev.hy) * k,
  };
}

/**
 * Convierte los landmarks de MediaPipe en el control del juego:
 * caderas → posición lateral en pista, muñecas rápidas → golpes, y brazos
 * reales → pose en vivo del avatar.
 */
export class CameraControl implements ControlAdapter {
  tracker: PoseTracker;
  calib: CalibrationData;
  bodyVisible = false;

  private courtX = 0; // posición objetivo en pista, suavizada
  private swings: SwingEvent[] = [];
  private detector = new SwingDetector();
  private pose: LivePose | null = null;
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
    if (!frame) {
      this.pose = null; // sin cuerpo a la vista el avatar vuelve a su pose propia
      return;
    }
    if (frame.t === this.lastFrameT) return;
    this.lastFrameT = frame.t;
    const t = frame.t / 1000;
    const lm = frame.lm;

    const vis = (i: number): boolean => visible(frame, i);
    this.bodyVisible = vis(LM.L_HIP) && vis(LM.R_HIP) && (vis(LM.L_WRIST) || vis(LM.R_WRIST));
    if (!this.bodyVisible) {
      this.pose = null;
      return;
    }

    // Escala corporal del frame actual: se adapta si te acercas o alejas
    const shouldersVisible = vis(LM.L_SHOULDER) && vis(LM.R_SHOULDER);
    const bw = shouldersVisible
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

    // --- Pose en vivo: los brazos reales del jugador mueven al avatar ---
    this.updatePose(frame, bw, shouldersVisible);

    // --- Detección de swings con las muñecas ---
    const wrist = (i: number): { x: number; y: number } | null =>
      vis(i) ? { x: 1 - lm[i].x, y: lm[i].y } : null;
    const shoulderY = (lm[LM.L_SHOULDER].y + lm[LM.R_SHOULDER].y) / 2;
    const swing = this.detector.feed(t, { L: wrist(LM.L_WRIST), R: wrist(LM.R_WRIST) }, bw, shoulderY);
    if (swing) {
      // Forma técnica en el momento del golpe: alimenta el gameplay
      const body = readBody(frame, 'forehand');
      const lvl = (l: Level): number => (l === 'good' ? 1 : l === 'warn' ? 0.7 : 0.4);
      const form = body
        ? {
            posture: (lvl(body.stance.level) + lvl(body.knees.level) + lvl(body.balance.level)) / 3,
            extension: Math.hypot(swing.pos.x - body.hipCenter.x, swing.pos.y - body.hipCenter.y) / bw,
          }
        : { posture: 0.75, extension: null };
      this.swings.push({ dir: swing.dir, overhead: swing.overhead, power: swing.power, form });
    }
  }

  private updatePose(frame: PoseFrame, bw: number, shouldersVisible: boolean): void {
    if (!shouldersVisible) {
      this.pose = null;
      return;
    }
    const video = this.tracker.video;
    const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 0.75;
    const lm = frame.lm;
    const right = readArm(frame, LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, bw, aspect);
    const left = readArm(frame, LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, bw, aspect);
    // En espejo el hombro derecho queda a la derecha: dx > 0 siempre de frente
    const dx = -(lm[LM.R_SHOULDER].x - lm[LM.L_SHOULDER].x);
    const dy = (lm[LM.R_SHOULDER].y - lm[LM.L_SHOULDER].y) * aspect;
    const tilt = clamp(Math.atan2(dy, Math.max(dx, 0.01)), -0.35, 0.35);
    const prev = this.pose;
    this.pose = {
      right: smoothArm(prev?.right ?? null, right),
      left: smoothArm(prev?.left ?? null, left),
      tilt: prev ? prev.tilt + (tilt - prev.tilt) * POSE_SMOOTH : tilt,
    };
  }

  getMove(): MoveIntent {
    return { mode: 'absolute', x: this.courtX };
  }

  consumeSwings(): SwingEvent[] {
    const s = this.swings;
    this.swings = [];
    return s;
  }

  getPose(): LivePose | null {
    return this.pose;
  }

  destroy(): void {
    // El tracker lo gestiona main.ts (se reutiliza entre partidas)
  }
}
