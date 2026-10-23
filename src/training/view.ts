import { SKELETON, LM } from '../camera/pose';
import type { PoseTracker } from '../camera/pose';
import { sfx } from '../audio/sfx';
import {
  impactZone,
  prepGuideTargets,
  requiresGuideHand,
  requiresShoulderTurn,
  worstPostureCue,
} from './metrics';
import { TrainingSession } from './session';
import type { RepResult, TrainingSummary } from './session';
import { SHOT_NAMES } from '../types';
import type { ShotType } from '../types';

// CameraTrainingView: la cámara del jugador es la pantalla. Sobre ella se
// dibujan el esqueleto (PoseOverlay), las guías visuales de armado a 3 metros,
// la zona de impacto (TargetZoneOverlay), el anillo de timing (TimingIndicator)
// y el efecto Hit-Stop con onda expansiva de choque.

const COLOR = {
  good: '#34d399',
  neon: '#00f5d4',
  warn: '#fbbf24',
  bad: '#f87171',
  line: 'rgba(255,255,255,0.75)',
  joint: '#ffffff',
} as const;

/** Duración (ms) de la micro-pausa visual de impacto (Hit-Stop). */
const HIT_STOP_MS = 55;
/** Duración (ms) del anillo expansivo de choque tras un buen impacto. */
const SHOCKWAVE_MS = 420;

export interface TrainingOptions {
  canvas: HTMLCanvasElement;
  tracker: PoseTracker;
  shot: ShotType;
  /** Si es true, lanza la secuencia de Calentamiento Express (12 reps: 3 derechas, 3 reveses, 3 voleas, 3 bandejas). */
  express?: boolean;
  onFinish(summary: TrainingSummary): void;
  onQuit(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/** Formatea en una línea el estado biomecánico de una repetición (rodillas, armado/perfilado, pies, timing). */
export function formatRepBiomechanics(rep: RepResult): string {
  return [
    `${rep.kneesOk ? '✓' : '✗'} Rodillas`,
    `${rep.prepOk ? '✓' : '✗'} Armado`,
    `${rep.stanceOk ? '✓' : '✗'} Pies`,
    `${rep.timingOk ? '✓' : '✗'} Timing`,
  ].join(' · ');
}

export class CameraTrainingView {
  private opts: TrainingOptions;
  private session: TrainingSession;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private feedbackShownAt = 0;
  private powerShown = 0;
  private hitStopUntil = 0;
  private shockwaveAt = -1000;

  constructor(opts: TrainingOptions) {
    this.opts = opts;
    this.ctx = opts.canvas.getContext('2d')!;
    this.session = new TrainingSession(opts.shot, !!opts.express);
    this.session.onBeat = () => sfx.click();
    this.session.onResult = (rep) => {
      const now = performance.now();
      this.feedbackShownAt = now;
      this.powerShown = rep.power;
      if (rep.correct) {
        sfx.good();
        // Hit-Stop (~55 ms) + anillo expansivo + feedback háptico en golpes buenos
        if (rep.score >= 70) {
          this.hitStopUntil = now + HIT_STOP_MS;
          this.shockwaveAt = now;
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
              navigator.vibrate?.(35);
            } catch {
              /* vibración bloqueada o no disponible */
            }
          }
        }
      } else if (rep.swung) {
        sfx.bad();
      }
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
    $('#trainShot').textContent = this.session.express
      ? `⚡ ${SHOT_NAMES[this.session.shot].toUpperCase()}`
      : SHOT_NAMES[this.session.shot].toUpperCase();
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
    this.session.stopSpeech();
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
    const inHitStop = now < this.hitStopUntil;
    const s = this.session;
    if (!inHitStop) {
      s.update(this.opts.tracker.latest, now);
    }
    this.drawCamera(inHitStop);
    this.drawPoseOverlay();
    this.drawPrepGuides(now);
    this.drawTargetZone(now, inHitStop);
    this.updateHud(now);
  }

  /** La cámara en espejo ocupa toda la pantalla (cover). */
  private drawCamera(inHitStop: boolean): void {
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
      // Oscurecido sutil para que el overlay respire (destello breve durante hit-stop)
      ctx.fillStyle = inHitStop ? 'rgba(0, 245, 212, 0.12)' : 'rgba(6, 10, 16, 0.18)';
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

  // ---------- Guía visual a 3 metros durante `prep` ----------

  private drawPrepGuides(now: number): void {
    const s = this.session;
    const body = s.body;
    const ctx = this.ctx;
    if (!body || s.phase !== 'prep') return;

    const currentShot = s.shot;
    const guides = prepGuideTargets(currentShot, body);
    const sh = this.px(guides.racketShoulder);
    const el = this.px(guides.racketElbow);
    const rt = this.px(guides.racketTarget);
    const unitPx = Math.max(body.bw * this.videoRect.w, 60);
    const ringR = Math.max(unitPx * 0.34, 28);
    const pulse = 1 + Math.sin(now / 150) * 0.06;

    const armReady = body.prepared && body.shoulderTurned;
    const armCol = armReady ? COLOR.neon : COLOR.warn;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Silueta guía del brazo armado (hombro -> codo -> mano con pala)
    ctx.strokeStyle = armReady ? 'rgba(0, 245, 212, 0.85)' : 'rgba(251, 191, 36, 0.65)';
    ctx.lineWidth = armReady ? 8 : 6;
    ctx.setLineDash(armReady ? [] : [10, 8]);
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.quadraticCurveTo(el.x, el.y, rt.x, rt.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Anillo grande de armado a 3 metros (se ilumina en cian/verde neón al armar y perfilar)
    if (armReady) {
      const glow = ctx.createRadialGradient(rt.x, rt.y, ringR * 0.2, rt.x, rt.y, ringR * 1.9);
      glow.addColorStop(0, 'rgba(0, 245, 212, 0.45)');
      glow.addColorStop(1, 'rgba(0, 245, 212, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(rt.x, rt.y, ringR * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = armReady ? 'rgba(0, 245, 212, 0.22)' : 'rgba(251, 191, 36, 0.14)';
    ctx.strokeStyle = armCol;
    ctx.lineWidth = armReady ? 4.5 : 3;
    ctx.beginPath();
    ctx.arc(rt.x, rt.y, ringR * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Etiqueta legible a 3 metros
    ctx.font = '800 13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = armCol;
    const armLabel = armReady
      ? '✓ ARMADO LISTO'
      : !body.prepared
        ? '🎾 ARMA AQUÍ'
        : '↻ GIRA HOMBROS';
    ctx.fillText(armLabel, rt.x, rt.y + ringR + 18);

    // 3. Golpes aéreos (bandeja/remate): anillo objetivo superior para levantar la mano guía
    if (requiresGuideHand(currentShot) && guides.guideTarget && guides.guideShoulder) {
      const gs = this.px(guides.guideShoulder);
      const gt = this.px(guides.guideTarget);
      const guideOk = body.guideHandUp;
      const gCol = guideOk ? COLOR.neon : COLOR.warn;
      const gR = Math.max(ringR * 0.85, 24);

      ctx.strokeStyle = guideOk ? 'rgba(0, 245, 212, 0.75)' : 'rgba(251, 191, 36, 0.55)';
      ctx.lineWidth = 5;
      ctx.setLineDash(guideOk ? [] : [8, 7]);
      ctx.beginPath();
      ctx.moveTo(gs.x, gs.y);
      ctx.lineTo(gt.x, gt.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (guideOk) {
        const gGlow = ctx.createRadialGradient(gt.x, gt.y, gR * 0.2, gt.x, gt.y, gR * 1.8);
        gGlow.addColorStop(0, 'rgba(0, 245, 212, 0.4)');
        gGlow.addColorStop(1, 'rgba(0, 245, 212, 0)');
        ctx.fillStyle = gGlow;
        ctx.beginPath();
        ctx.arc(gt.x, gt.y, gR * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = guideOk ? 'rgba(0, 245, 212, 0.2)' : 'rgba(251, 191, 36, 0.14)';
      ctx.strokeStyle = gCol;
      ctx.lineWidth = guideOk ? 4 : 2.8;
      ctx.beginPath();
      ctx.arc(gt.x, gt.y, gR * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = gCol;
      ctx.fillText(guideOk ? '✓ MANO GUÍA' : '☝️ SUBE MANO LIBRE', gt.x, gt.y - gR - 10);
    }

    ctx.restore();
  }

  // ---------- TargetZoneOverlay + TimingIndicator + Hit-Stop ----------

  private drawTargetZone(now: number, inHitStop: boolean): void {
    const s = this.session;
    const body = s.body;
    const ctx = this.ctx;
    if (!body || s.phase === 'searching' || s.phase === 'done') return;

    const currentShot = s.shot;
    const zone = impactZone(currentShot, body);
    const c = this.px(zone.c);
    const r = Math.max(zone.r * this.videoRect.w, 26);

    if (s.phase === 'result') {
      // Durante el Hit-Stop (~55 ms), congelar la bola en el punto exacto de contacto
      if (inHitStop) {
        this.drawIncomingBall(c, r, 1);
      }

      // Anillo expansivo de choque (Shockwave) tras un buen impacto
      const shockAge = now - this.shockwaveAt;
      if (shockAge >= 0 && shockAge <= SHOCKWAVE_MS) {
        this.drawShockwave(c, r, shockAge / SHOCKWAVE_MS);
      }

      // Flash del resultado sobre la zona
      const level = s.feedback?.level ?? 'warn';
      const age = (now - this.feedbackShownAt) / 1000;
      const pulse = 1 + Math.max(0, 0.25 - age) * 1.4;
      ctx.strokeStyle = level === 'good' ? COLOR.neon : COLOR[level];
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
    const prepReady =
      body.prepared && body.shoulderTurned && (!requiresGuideHand(currentShot) || body.guideHandUp);
    ctx.setLineDash(active ? [] : [7, 7]);
    ctx.strokeStyle = active
      ? COLOR.good
      : prepReady
        ? COLOR.neon
        : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = active ? 3.5 : prepReady ? 3 : 2;
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
    ctx.fillStyle = active ? COLOR.good : prepReady ? COLOR.neon : 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Anillo expansivo de choque + destello radial que subraya físicamente el
   * instante de contacto en un golpe bueno.
   */
  private drawShockwave(c: { x: number; y: number }, r: number, k: number): void {
    const ctx = this.ctx;
    const ease = 1 - Math.pow(1 - k, 3);
    const ringRadius = r * (0.9 + ease * 2.3);
    const alpha = Math.max(0, 1 - k);

    ctx.save();
    ctx.strokeStyle = `rgba(0, 245, 212, ${alpha * 0.9})`;
    ctx.lineWidth = Math.max(2, (1 - k) * 9);
    ctx.beginPath();
    ctx.arc(c.x, c.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Segundo anillo interior dorado/blanco
    ctx.strokeStyle = `rgba(253, 253, 166, ${alpha * 0.75})`;
    ctx.lineWidth = Math.max(1.5, (1 - k) * 5);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * (0.6 + ease * 1.4), 0, Math.PI * 2);
    ctx.stroke();

    // Rayos cortos de impacto
    const rays = 8;
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * Math.PI * 2;
      const r0 = r * (0.7 + ease * 0.9);
      const r1 = r * (1.1 + ease * 1.6);
      ctx.beginPath();
      ctx.moveTo(c.x + Math.cos(ang) * r0, c.y + Math.sin(ang) * r0);
      ctx.lineTo(c.x + Math.cos(ang) * r1, c.y + Math.sin(ang) * r1);
      ctx.stroke();
    }
    ctx.restore();
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
    const body = s.body;
    const currentShot = s.shot;

    const shotLabel = s.express
      ? `⚡ ${SHOT_NAMES[currentShot].toUpperCase()}`
      : SHOT_NAMES[currentShot].toUpperCase();
    if ($('#trainShot').textContent !== shotLabel) {
      $('#trainShot').textContent = shotLabel;
    }

    $('#trainRep').textContent = `${Math.min(s.repIndex + 1, s.totalReps)} / ${s.totalReps}`;
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
      if (s.express && s.repIndex % 3 === 0) {
        if (s.repIndex === 0) phaseTxt = '⚡ Calentamiento Express: 3 Derechas';
        else if (s.repIndex === 3) phaseTxt = '⚡ ¡Cambio a Revés! (3 reps)';
        else if (s.repIndex === 6) phaseTxt = '⚡ ¡Subimos a la Volea! (3 reps)';
        else if (s.repIndex === 9) phaseTxt = '⚡ ¡Atento al globo: Bandeja! (3 reps)';
        phaseCls = 'warn';
      } else {
        phaseTxt = `Siguiente: ${SHOT_NAMES[currentShot]}`;
      }
    } else if (s.phase === 'prep') {
      const fullPrep =
        !!body &&
        body.prepared &&
        body.shoulderTurned &&
        (!requiresGuideHand(currentShot) || body.guideHandUp);
      if (fullPrep) {
        phaseTxt = '✓ ARMADO LISTO · ESPERA LA BOLA';
        phaseCls = 'good';
      } else if (body && !body.prepared) {
        phaseTxt = 'PREPARA LA PALA';
      } else if (body && requiresShoulderTurn(currentShot) && !body.shoulderTurned) {
        phaseTxt = 'PERFILA LOS HOMBROS (PONTE DE LADO)';
      } else {
        phaseTxt = 'LEVANTA LA MANO LIBRE';
      }
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

    // Corrección de postura en vivo o desglose biomecánico tras la repetición
    const cueEl = $('#trainCue');
    const lastRep = s.reps[s.reps.length - 1];
    if (s.phase === 'result' && lastRep) {
      cueEl.textContent = formatRepBiomechanics(lastRep);
      const allOk = lastRep.kneesOk && lastRep.prepOk && lastRep.stanceOk && lastRep.timingOk;
      cueEl.className = `train-cue show ${allOk ? 'good' : lastRep.correct ? 'warn' : 'bad'}`;
    } else if (body && (s.phase === 'prep' || s.phase === 'strike' || s.phase === 'announce')) {
      const cue = worstPostureCue(body);
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
