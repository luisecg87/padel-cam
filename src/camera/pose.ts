import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
} as const;

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export interface PoseFrame {
  t: number; // performance.now() en ms
  lm: NormalizedLandmark[]; // coordenadas normalizadas 0..1 (sin espejar)
}

/**
 * Envuelve la webcam + MediaPipe Pose. Corre su propio bucle de detección
 * y deja el último resultado en `latest`.
 */
export class PoseTracker {
  video: HTMLVideoElement;
  latest: PoseFrame | null = null;
  running = false;
  error: string | null = null;

  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private lastVideoTime = -1;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.error = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (e) {
      this.error = 'No se pudo acceder a la cámara. Revisa los permisos del navegador.';
      throw new Error(this.error);
    }
    this.video.srcObject = this.stream;
    await this.video.play();

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    } catch (e) {
      this.error = 'No se pudo cargar el modelo de detección de pose (¿hay internet?).';
      this.stopStream();
      throw new Error(this.error);
    }

    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.detect();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private detect(): void {
    const lmk = this.landmarker;
    if (!lmk || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const t = performance.now();
    const res = lmk.detectForVideo(this.video, t);
    if (res.landmarks && res.landmarks.length > 0) {
      this.latest = { t, lm: res.landmarks[0] };
    } else {
      this.latest = null;
    }
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.landmarker?.close();
    this.landmarker = null;
    this.stopStream();
    this.latest = null;
  }
}

/** Dibuja el preview espejo con el esqueleto sobre el canvas pequeño. */
export function drawPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  frame: PoseFrame | null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (!frame) return;
  ctx.fillStyle = '#2ecc71';
  const dots = [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_WRIST, LM.R_WRIST, LM.L_HIP, LM.R_HIP];
  for (const i of dots) {
    const p = frame.lm[i];
    if (!p || (p.visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, i === LM.L_WRIST || i === LM.R_WRIST ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
