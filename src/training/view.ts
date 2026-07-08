import { SKELETON, LM } from '../camera/pose';
import type { PoseTracker } from '../camera/pose';
import { sfx } from '../audio/sfx';
import { impactZone } from './metrics';
import { worstPostureCue } from './metrics';
import { REPS_PER_SESSION, TrainingSession } from './session';
import type { TrainingSummary } from './session';
import { SHOT_NAMES } from '../types';
import type { ShotType } from '../types';

// CameraTrainingView: la cámara del jugador es la pantalla. Sobre ella se
// dibujan el esqueleto (PoseOverlay), la zona de impacto (TargetZoneOverlay)
// y el anillo de timing (TimingIndicator). Las métricas y correcciones van
// en un HUD DOM aparte, grande y de alto contraste.

const COLOR = {
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  line: 'rgba(255,255,255,0.75)',
  joint: '#ffffff',
} as const;

export interface TrainingOptions {
  canvas: HTMLCanvasElement;
  tracker: PoseTracker;
  shot: ShotType;
  onFinish(summary: TrainingSummary): void;
  onQuit(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export class CameraTrainingView {
  private opts: TrainingOptions;
  private session: TrainingSession;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private feedbackShownAt = 0;
  private powerShown = 0;

  constructor(opts: TrainingOptions) {
    this.opts = opts;
    this.ctx = opts.canvas.getContext('2d')!;
    this.session = new TrainingSession(opts.shot);
    this.session.onBeat = () => sfx.click();
    this.session.onResult = (rep) => {
      this.feedbackShownAt = performance.now();
      if (rep.correct) sfx.good();
      else if (rep.swung) sfx.bad();
      this.powerShown = rep.power;
    };
    this.session.onFinish = (summary) => {
      this.stop();
      opts.onFinish(summary);
    };
  }

  start(): void {
    this.running = true;
    this.resize();
    window.addEventListener('resize', this.resize);
    $('#trainHud').classList.add('active');
    this.opts.canvas.style.display = 'block';
    $('#trainShot').textContent = SHOT_NAMES[this.opts.shot].toUpperCase();
    $('#btnTrainQuit').onclick = () => {
      this.stop();
      this.opts.onQuit();
    };
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    $('#trainHud').classList.remove('active');
    this.opts.canvas.style.display = 'none';
  }

  private resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.opts.canvas.width = window.innerWidth * dpr;
    this.opts.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // ---------- Bucle ----------

  private tick(): void {
    const now = performance.now();
    const s = this.session;
    s.update(this.opts.tracker.latest, now);
    this.drawCamera();
    this.drawPoseOverlay();
    this.drawTargetZone(now);
    this.updateHud(now);
  }

  /** La cámara en espejo ocupa toda la pantalla (cover). */
  private drawCamera(): void {
    const ctx = this.ctx;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const video = this.opts.tracker.video;
    ctx.fillStyle = '#0a0f16';
    ctx.fillRect(0, 0, W, H);
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const scale = Math.max(W / video.videoWidth, H / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(-1, 1); // espejo
      ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      // Oscurecido sutil para que el overlay respire
      ctx.fillStyle = 'rgba(6, 10, 16, 0.18)';
      ctx.fillRect(0, 0, W, H);
    }
    this.videoRect = this.computeVideoRect(W, H);
  }

  // Rect de pantalla que ocupa el vídeo (para mapear coords normalizadas)
  private videoRect = { x: 0, y: 0, w: 1, h: 1 };
  private computeVideoRect(W: number, H: number): { x: number; y: number; w: number; h: number } {
    const video = this.opts.tracker.video;
    if (video.videoWidth === 0) return { x: 0, y: 0, w: W, h: H };
    const scale = Math.max(W / video.videoWidth, H / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
  }

  /** Coordenada normalizada en espejo → píxeles de pantalla. */
  private px(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: this.videoRect.x + p.x * this.videoRect.w,
      y: this.videoRect.y + p.y * this.videoRect.h,
    };
  }

  // ---------- PoseOverlay ----------

  private drawPoseOverlay(): void {
    const frame = this.opts.tracker.latest;
    const ctx = this.ctx;
    if (!frame) return;
    const pt = (i: number): { x: number; y: number } | null => {
      const p = frame.lm[i];
      if (!p || (p.visibility ?? 0) < 0.4) return null;
      return this.px({ x: 1 - p.x, y: p.y });
    };
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 3;
    for (const [a, b] of SKELETON) {
      const pa = pt(a);
      const pb = pt(b);
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.fillStyle = COLOR.joint;
    for (const i of [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_ELBOW, LM.R_ELBOW, LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE]) {
      const p = pt(i);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Muñecas destacadas (son el "sensor" del golpe)
    for (const i of [LM.L_WRIST, LM.R_WRIST]) {
      const p = pt(i);
      if (!p) continue;
      ctx.fillStyle = '#7dd3fc';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---------- TargetZoneOverlay + TimingIndicator ----------

  private drawTargetZone(now: number): void {
    const s = this.session;
    const body = s.body;
    const ctx = this.ctx;
    if (!body || s.phase === 'searching' || s.phase === 'done') return;

    const zone = impactZone(this.opts.shot, body);
    const c = this.px(zone.c);
    const r = Math.max(zone.r * this.videoRect.w, 26);

    if (s.phase === 'result') {
      // Flash del resultado sobre la zona
      const level = s.feedback?.level ?? 'warn';
      const age = (now - this.feedbackShownAt) / 1000;
      const pulse = 1 + Math.max(0, 0.25 - age) * 1.4;
      ctx.strokeStyle = COLOR[level];
      ctx.lineWidth = 4;
      ctx.globalAlpha = Math.max(0.15, 1 - age * 0.8);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    // Zona objetivo: discreta en prep, activa en strike
    const active = s.phase === 'strike';
    ctx.setLineDash(active ? [] : [7, 7]);
    ctx.strokeStyle = active ? COLOR.good : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = active ? 3.5 : 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (active) {
      ctx.fillStyle = 'rgba(52, 211, 153, 0.14)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Anillo de timing sutil de refuerzo (la señal principal es la bola)
      const ringR = r + s.ringT * r * 2.6;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      this.drawIncomingBall(c, r, 1 - s.ringT);
    }
    // Punto central
    ctx.fillStyle = active ? COLOR.good : 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Bola virtual que se ve venir: nace pequeña al fondo de la escena y
   * llega a la zona de impacto EXACTAMENTE en el beat (p=1). Golpear
   * cuando la bola llega es mucho más natural que leer un anillo
   * abstracto — es el mismo gesto mental que en la pista real.
   */
  private drawIncomingBall(c: { x: number; y: number }, r: number, p: number): void {
    const ctx = this.ctx;
    const vr = this.videoRect;
    // Origen: centro-arriba de la escena ("desde la red"), llegada: la zona
    const start = { x: vr.x + vr.w * 0.5, y: vr.y + vr.h * 0.12 };
    const k = Math.min(p, 1);
    const x = start.x + (c.x - start.x) * k;
    // Arco: sube un poco y cae hacia la zona, como una bola real
    const y = start.y + (c.y - start.y) * k - Math.sin(k * Math.PI) * r * 1.3;
    const ballR = Math.max(r * (0.16 + 0.42 * k), 7); // crece al acercarse

    // Estela corta (dos fantasmas hacia atrás en la trayectoria)
    for (const [lag, alpha] of [[0.12, 0.28], [0.24, 0.14]] as const) {
      const kg = Math.max(k - lag, 0);
      const gx = start.x + (c.x - start.x) * kg;
      const gy = start.y + (c.y - start.y) * kg - Math.sin(kg * Math.PI) * r * 1.3;
      ctx.fillStyle = `rgba(230, 236, 42, ${alpha})`;
      ctx.beginPath();
      ctx.arc(gx, gy, ballR * (0.75 - lag), 0, Math.PI * 2);
      ctx.fill();
    }

    // Halo + bola (mismo lenguaje visual que la bola del juego)
    const glow = ctx.createRadialGradient(x, y, ballR * 0.4, x, y, ballR * 2.4);
    glow.addColorStop(0, 'rgba(232, 238, 60, 0.4)');
    glow.addColorStop(1, 'rgba(232, 238, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, ballR * 2.4, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(x - ballR * 0.3, y - ballR * 0.3, ballR * 0.2, x, y, ballR);
    g.addColorStop(0, '#fdfda6');
    g.addColorStop(0.65, '#e6ec2a');
    g.addColorStop(1, '#c2c916');
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(13, 24, 38, 0.85)';
    ctx.lineWidth = Math.max(ballR * 0.14, 1.5);
    ctx.beginPath();
    ctx.arc(x, y, ballR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // ---------- HUD DOM ----------

  private updateHud(now: number): void {
    const s = this.session;

    $('#trainRep').textContent = `${Math.min(s.repIndex + 1, REPS_PER_SESSION)} / ${REPS_PER_SESSION}`;
    $('#trainScore').textContent = s.reps.length ? `${s.consistency}%` : '—';
    $('#trainStreak').textContent = `${s.streak}`;

    // Fase → mensaje central superior
    const phaseEl = $('#trainPhase');
    let phaseTxt = '';
    let phaseCls = '';
    if (s.phase === 'searching') {
      phaseTxt = 'Colócate frente a la cámara, de la cintura hacia arriba';
      phaseCls = 'warn';
    } else if (s.phase === 'announce') {
      phaseTxt = `Siguiente: ${SHOT_NAMES[this.opts.shot]}`;
    } else if (s.phase === 'prep') {
      phaseTxt = s.body?.prepared ? 'Preparado · espera el anillo' : 'PREPARA LA PALA';
      phaseCls = s.body?.prepared ? 'good' : '';
    } else if (s.phase === 'strike') {
      phaseTxt = '¡AHORA!';
      phaseCls = 'good';
    }
    if (phaseEl.textContent !== phaseTxt) phaseEl.textContent = phaseTxt;
    phaseEl.className = `train-phase ${phaseCls}`;

    // Feedback grande del resultado
    const fbEl = $('#trainFeedback');
    if (s.phase === 'result' && s.feedback) {
      fbEl.textContent = s.feedback.text;
      fbEl.className = `train-feedback show ${s.feedback.level}`;
    } else {
      fbEl.className = 'train-feedback';
    }

    // Corrección de postura (TechniqueFeedbackPanel compacto)
    const cueEl = $('#trainCue');
    if (s.body && (s.phase === 'prep' || s.phase === 'strike' || s.phase === 'announce')) {
      const cue = worstPostureCue(s.body);
      cueEl.textContent = cue.level === 'good' ? '✓ Postura lista' : cue.cue;
      cueEl.className = `train-cue show ${cue.level}`;
    } else {
      cueEl.className = 'train-cue';
    }

    // PowerMeter: decae suavemente tras cada golpe
    const target = s.phase === 'result' ? this.powerShown : this.powerShown * Math.max(0, 1 - (now - this.feedbackShownAt) / 2500);
    $('#trainPowerFill').style.height = `${Math.round(target * 100)}%`;
  }
}
