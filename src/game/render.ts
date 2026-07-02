import { Ball, BALL_RADIUS } from './ball';
import { COURT } from './court';
import { PlayerEntity } from './player';
import { isOverheadShot } from '../types';
import type { Vec3 } from '../types';

// Cámara detrás del jugador (z alto), mirando hacia la pista de la CPU (z bajo).
const CAM_Z = 26;
const CAM_H = 4.8;

export interface Palette {
  shirt: string;
  shirtDark: string;
  shorts: string;
  skin: string;
  hair: string;
}

const PLAYER_PALETTE: Palette = {
  shirt: '#22c4ae',
  shirtDark: '#128a79',
  shorts: '#0d3b55',
  skin: '#e9b98d',
  hair: '#3a2a1c',
};

export const CPU_PALETTE: Palette = {
  shirt: '#f0764f',
  shirtDark: '#bd4a2c',
  shorts: '#3a2734',
  skin: '#f0c9a0',
  hair: '#20242c',
};

// Colores apagados para el público de las gradas
const CROWD_COLORS = [
  '#c9a284', '#7fa3c4', '#c48a8a', '#93b887',
  '#c4b47f', '#a08ac4', '#d8d3ca', '#7fc4ba',
];

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; // segundos restantes
  maxLife: number;
  color: string; // "r,g,b"
  size: number; // radio en metros
}

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  private f = 500;
  private horizonY = 0;
  private shakeMag = 0;
  private particles: Particle[] = [];
  private lastDrawT = 0;
  private crowdExcite = 0;
  /** Camiseta del rival: los rivales del torneo tienen su propio color. */
  cpuPalette: Palette = CPU_PALETTE;
  // Cielo estrellado fijo (posiciones relativas a la pantalla)
  private stars = Array.from({ length: 70 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.22,
    r: 0.4 + Math.random() * 1.1,
    a: 0.25 + Math.random() * 0.55,
  }));
  private vignette: CanvasGradient | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.f = Math.min(this.H * 0.95, this.W * 0.57);
    this.horizonY = this.H * 0.3;
    // Viñeta cacheada (oscurece esquinas: foco en la pista)
    const g = this.ctx.createRadialGradient(
      this.W / 2, this.H * 0.55, Math.min(this.W, this.H) * 0.45,
      this.W / 2, this.H * 0.55, Math.max(this.W, this.H) * 0.78,
    );
    g.addColorStop(0, 'rgba(2, 8, 18, 0)');
    g.addColorStop(1, 'rgba(2, 8, 18, 0.5)');
    this.vignette = g;
  }

  /** Proyección perspectiva simple de coordenadas de mundo a pantalla. */
  project(x: number, y: number, z: number): { x: number; y: number; s: number } {
    const d = Math.max(CAM_Z - z, 0.5);
    const s = this.f / d; // píxeles por metro a esa profundidad
    return {
      x: this.W / 2 + x * s,
      y: this.horizonY + (CAM_H - y) * s,
      s,
    };
  }

  /** Sacudida de cámara (remates, víboras…). mag en píxeles iniciales. */
  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  /** Chispas/polvo en un punto del mundo. color en formato "r,g,b". */
  burst(pos: Vec3, color: string, count = 8, speed = 2.2): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x: pos.x, y: Math.max(pos.y, 0.03), z: pos.z,
        vx: Math.cos(a) * v,
        vy: Math.random() * v * 0.9,
        vz: Math.sin(a) * v * 0.6,
        life: 0.35 + Math.random() * 0.3,
        maxLife: 0.65,
        color,
        size: 0.025 + Math.random() * 0.03,
      });
    }
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
  }

  draw(ball: Ball, player: PlayerEntity, cpu: PlayerEntity, showBall: boolean): void {
    const now = performance.now();
    const dt = this.lastDrawT ? Math.min((now - this.lastDrawT) / 1000, 0.05) : 0.016;
    this.lastDrawT = now;

    const ctx = this.ctx;
    ctx.save();
    if (this.shakeMag > 0.3) {
      ctx.translate(
        (Math.random() - 0.5) * this.shakeMag * 2,
        (Math.random() - 0.5) * this.shakeMag * 2,
      );
      this.shakeMag *= Math.exp(-dt * 9);
    } else {
      this.shakeMag = 0;
    }

    this.drawBackground();
    this.drawCrowd(dt);
    this.drawFloodlights();
    this.drawCourt();
    this.drawLedBoard();
    this.drawAvatar(cpu, this.cpuPalette, true);
    if (showBall && ball.pos.z <= COURT.netZ) this.drawBall(ball);
    this.drawNet();
    if (showBall && ball.pos.z > COURT.netZ) this.drawBall(ball);
    this.drawParticles(dt);
    this.drawAvatar(player, PLAYER_PALETTE, false);
    ctx.restore();

    // Viñeta en espacio de pantalla (fuera del shake)
    if (this.vignette) {
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  /** El público se pone en pie: 1 = ovación completa. Decae solo. */
  exciteCrowd(amount: number): void {
    this.crowdExcite = Math.min(1, this.crowdExcite + amount);
  }

  /** Gradas con público detrás de la pared de fondo; salta con los puntos. */
  private drawCrowd(dt: number): void {
    this.crowdExcite *= Math.exp(-dt * 0.8);
    const ctx = this.ctx;
    const t = performance.now() / 1000;

    // Banda oscura de la grada
    const bandTop = this.project(0, 8.6, -6.2).y;
    const bandBottom = this.project(0, 3.4, -1.2).y;
    const g = ctx.createLinearGradient(0, bandTop, 0, bandBottom);
    g.addColorStop(0, '#07111f');
    g.addColorStop(1, '#0d2035');
    ctx.fillStyle = g;
    ctx.fillRect(0, bandTop, this.W, bandBottom - bandTop);

    for (let row = 0; row < 3; row++) {
      const z = -1.6 - row * 1.8;
      const y = 4.4 + row * 1.15;
      for (let i = 0; i < 26; i++) {
        const x = -8.6 + i * 0.69 + (row % 2) * 0.35;
        const phase = i * 1.7 + row * 2.3;
        const idle = Math.sin(t * 1.6 + phase) * 0.035;
        const jump = Math.max(0, Math.sin(t * 8 + phase)) * 0.32 * this.crowdExcite;
        const p = this.project(x, y + idle + jump, z);
        const r = 0.155 * p.s;
        ctx.fillStyle = CROWD_COLORS[(i * 7 + row * 13) % CROWD_COLORS.length];
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(p.x - r * 0.95, p.y + r * 0.55, r * 1.9, r * 1.7);
      }
    }
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= 6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy = Math.abs(p.vy) * 0.3; }
      const pr = this.project(p.x, p.y, p.z);
      const alpha = Math.min(p.life / p.maxLife, 1) * 0.85;
      ctx.fillStyle = `rgba(${p.color}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, Math.max(p.size * pr.s, 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#060f1e');
    g.addColorStop(0.35, '#14385e');
    g.addColorStop(1, '#0d2740');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    // Noche estrellada sobre el estadio
    for (const s of this.stars) {
      ctx.fillStyle = `rgba(220, 235, 255, ${s.a})`;
      ctx.beginPath();
      ctx.arc(s.x * this.W, s.y * this.H, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Focos del estadio sobre las gradas, con halo. */
  private drawFloodlights(): void {
    const ctx = this.ctx;
    for (const lx of [-7.2, -2.4, 2.4, 7.2]) {
      const p = this.project(lx, 8.9, -5.8);
      const r = 0.55 * p.s;
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.15, p.x, p.y, r * 3);
      g.addColorStop(0, 'rgba(255, 250, 220, 0.95)');
      g.addColorStop(0.25, 'rgba(255, 245, 200, 0.28)');
      g.addColorStop(1, 'rgba(255, 245, 200, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Valla LED publicitaria en lo alto del cristal de fondo, con texto en marquesina. */
  private drawLedBoard(): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const tl = this.project(-hw, 3.95, 0);
    const br = this.project(hw, 3.5, 0);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    if (w < 40) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, w, h);
    ctx.clip();
    ctx.fillStyle = '#050d17';
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.fillStyle = '#ffd166';
    ctx.font = `bold ${Math.max(h * 0.55, 7).toFixed(1)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    const msg = 'PÁDEL CAM  ●  JUEGA CON TU CUERPO  ●  ';
    const mw = Math.max(ctx.measureText(msg).width, 40);
    const off = -((performance.now() / 1000) * w * 0.06) % mw;
    for (let x = tl.x + off - mw; x < br.x; x += mw) {
      ctx.fillText(msg, x, tl.y + h * 0.55);
    }
    ctx.restore();
  }

  private groundPoly(points: Array<[number, number]>): void {
    // points: pares [x, z] sobre el suelo
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach(([x, z], i) => {
      const p = this.project(x, 0, z);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }

  private groundLine(x1: number, z1: number, x2: number, z2: number, w = 2): void {
    const ctx = this.ctx;
    const a = this.project(x1, 0, z1);
    const b = this.project(x2, 0, z2);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  private drawCourt(): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const L = COURT.length;

    // Suelo de la pista
    this.groundPoly([
      [-hw, 0],
      [hw, 0],
      [hw, L],
      [-hw, L],
    ]);
    const gFloor = ctx.createLinearGradient(0, this.horizonY, 0, this.H);
    gFloor.addColorStop(0, '#1e5f9e');
    gFloor.addColorStop(1, '#2d7cc9');
    ctx.fillStyle = gFloor;
    ctx.fill();

    // Bandas de "cepillado" del césped artificial
    for (let z = 0; z < L; z += 2.5) {
      if ((z / 2.5) % 2 === 0) continue;
      this.groundPoly([
        [-hw, z],
        [hw, z],
        [hw, Math.min(z + 2.5, L)],
        [-hw, Math.min(z + 2.5, L)],
      ]);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fill();
    }

    // Paredes de cristal (fondo y laterales), muy sutiles
    ctx.fillStyle = 'rgba(180, 220, 255, 0.10)';
    ctx.strokeStyle = 'rgba(200, 230, 255, 0.35)';
    ctx.lineWidth = 1.5;

    const wallQuad = (pts: Array<[number, number, number]>) => {
      ctx.beginPath();
      pts.forEach(([x, y, z], i) => {
        const p = this.project(x, y, z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };

    const wh = COURT.wallHeight;
    // Pared de fondo (lado CPU)
    wallQuad([
      [-hw, 0, 0],
      [hw, 0, 0],
      [hw, wh, 0],
      [-hw, wh, 0],
    ]);
    // Paredes laterales
    wallQuad([
      [-hw, 0, 0],
      [-hw, 0, L],
      [-hw, wh, L],
      [-hw, wh, 0],
    ]);
    wallQuad([
      [hw, 0, 0],
      [hw, 0, L],
      [hw, wh, L],
      [hw, wh, 0],
    ]);

    // Perfiles metálicos del cristal (estructura de la jaula)
    ctx.strokeStyle = 'rgba(210, 230, 250, 0.28)';
    ctx.lineWidth = 2;
    const post = (x: number, z: number): void => {
      const a = this.project(x, 0, z);
      const b = this.project(x, wh, z);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    for (const x of [-hw, -hw / 2, 0, hw / 2, hw]) post(x, 0); // fondo
    for (const z of [0, 4, 8, 12, 16, L]) {
      post(-hw, z);
      post(hw, z);
    }

    // Reflejo diagonal en el cristal de fondo
    const rTop = this.project(-hw * 0.55, wh, 0);
    const rBot = this.project(-hw * 0.15, 0.3, 0);
    const gGlass = ctx.createLinearGradient(rTop.x, rTop.y, rBot.x, rBot.y);
    gGlass.addColorStop(0, 'rgba(255,255,255,0.10)');
    gGlass.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = gGlass;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(rTop.x, rTop.y);
    ctx.lineTo(rBot.x, rBot.y);
    ctx.stroke();

    // Líneas de la pista con halo (doble trazo)
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    this.groundLine(-hw, 0.05, hw, 0.05, 6);
    this.groundLine(-hw, L - 0.05, hw, L - 0.05, 6);
    this.groundLine(-hw, COURT.serviceLineCpu, hw, COURT.serviceLineCpu, 5);
    this.groundLine(-hw, COURT.serviceLinePlayer, hw, COURT.serviceLinePlayer, 5);
    this.groundLine(0, COURT.serviceLineCpu, 0, COURT.serviceLinePlayer, 5);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    this.groundLine(-hw, 0.05, hw, 0.05, 3); // fondo CPU
    this.groundLine(-hw, L - 0.05, hw, L - 0.05, 3); // fondo jugador
    this.groundLine(-hw, COURT.serviceLineCpu, hw, COURT.serviceLineCpu, 2);
    this.groundLine(-hw, COURT.serviceLinePlayer, hw, COURT.serviceLinePlayer, 2);
    this.groundLine(0, COURT.serviceLineCpu, 0, COURT.serviceLinePlayer, 2); // línea central
  }

  private drawNet(): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const nz = COURT.netZ;
    const nh = COURT.netHeight;
    const a = this.project(-hw, 0, nz);
    const b = this.project(hw, 0, nz);
    const at = this.project(-hw, nh, nz);
    const bt = this.project(hw, nh, nz);

    // Malla
    ctx.fillStyle = 'rgba(10, 25, 40, 0.55)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(bt.x, bt.y);
    ctx.lineTo(at.x, at.y);
    ctx.closePath();
    ctx.fill();

    // Retícula de la red
    ctx.strokeStyle = 'rgba(220, 235, 250, 0.18)';
    ctx.lineWidth = 1;
    for (let x = -hw + 0.4; x < hw; x += 0.45) {
      const v0 = this.project(x, 0, nz);
      const v1 = this.project(x, nh, nz);
      ctx.beginPath();
      ctx.moveTo(v0.x, v0.y);
      ctx.lineTo(v1.x, v1.y);
      ctx.stroke();
    }
    for (const y of [0.3, 0.6]) {
      const h0 = this.project(-hw, y, nz);
      const h1 = this.project(hw, y, nz);
      ctx.beginPath();
      ctx.moveTo(h0.x, h0.y);
      ctx.lineTo(h1.x, h1.y);
      ctx.stroke();
    }

    // Banda superior blanca
    ctx.strokeStyle = '#f4f7fb';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(bt.x, bt.y);
    ctx.stroke();

    // Postes
    ctx.strokeStyle = '#dfe8f2';
    ctx.lineWidth = 4;
    for (const px of [-hw, hw]) {
      const base = this.project(px, 0, nz);
      const top = this.project(px, nh + 0.1, nz);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }
  }

  private drawBall(ball: Ball): void {
    const ctx = this.ctx;
    const pos = ball.pos;

    // Estela de movimiento
    for (let i = 0; i < ball.trail.length; i++) {
      const t = ball.trail[i];
      const tp = this.project(t.x, t.y, t.z);
      const tr = Math.max(BALL_RADIUS * tp.s * 1.6, 3) * (0.35 + (i / ball.trail.length) * 0.5);
      ctx.fillStyle = `rgba(217, 224, 33, ${(0.04 + (i / ball.trail.length) * 0.16).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, tr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sombra en el suelo (clave para leer la profundidad)
    const sh = this.project(pos.x, 0, pos.z);
    const shR = Math.max(BALL_RADIUS * sh.s, 2.5);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, shR * 1.15, shR * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const p = this.project(pos.x, pos.y, pos.z);
    const r = Math.max(BALL_RADIUS * p.s * 1.6, 3);

    // Halo luminoso (la bola destaca bajo los focos)
    const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 2.6);
    glow.addColorStop(0, 'rgba(230, 236, 60, 0.30)');
    glow.addColorStop(1, 'rgba(230, 236, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();

    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r);
    g.addColorStop(0, '#fdfb8f');
    g.addColorStop(1, '#d9e021');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Costura de la pelota
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(r * 0.12, 0.7);
    ctx.beginPath();
    ctx.arc(p.x - r * 0.25, p.y, r * 0.82, -0.8, 0.8);
    ctx.stroke();
  }

  private drawAvatar(p: PlayerEntity, pal: Palette, facingCamera: boolean): void {
    const ctx = this.ctx;
    const base = this.project(p.x, 0, p.z);
    const s = base.s; // píxeles por metro
    const cx = base.x;

    // Sombra
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(cx, base.y, 0.42 * s, 0.13 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const legLen = 0.82 * s;
    const bodyH = 0.62 * s;
    const headR = 0.15 * s;
    const hipY = base.y - legLen;
    const shY = hipY - bodyH;
    const lean = p.lean * (facingCamera ? -1 : 1);

    // Zancada: las piernas se balancean con el movimiento real
    const stride = Math.sin(p.runPhase) * 0.2 * s * p.moveAmount;
    const kneeLift = Math.abs(Math.sin(p.runPhase)) * 0.08 * s * p.moveAmount;

    ctx.lineCap = 'round';

    // ---- Piernas (piel) con zapatillas ----
    const legW = Math.max(0.1 * s, 2.5);
    const drawLeg = (side: -1 | 1, offset: number): void => {
      const hx = cx + side * 0.1 * s;
      const fx = cx + side * 0.15 * s + offset;
      const fy = base.y - Math.abs(offset) * 0.25;
      const kx = (hx + fx) / 2 + side * 0.02 * s;
      const ky = (hipY + fy) / 2 + kneeLift;
      ctx.strokeStyle = pal.skin;
      ctx.lineWidth = legW;
      ctx.beginPath();
      ctx.moveTo(hx, hipY + 0.1 * s);
      ctx.quadraticCurveTo(kx, ky, fx, fy - 0.04 * s);
      ctx.stroke();
      // Zapatilla
      ctx.fillStyle = '#f2f5f7';
      ctx.beginPath();
      ctx.ellipse(fx, fy - 0.02 * s, 0.11 * s, 0.055 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    drawLeg(-1, stride);
    drawLeg(1, -stride);

    // ---- Pantalón corto ----
    ctx.fillStyle = pal.shorts;
    this.roundRect(cx - 0.17 * s, hipY - 0.08 * s, 0.34 * s, 0.26 * s, 0.07 * s);

    // ---- Torso con sombreado ----
    const g = ctx.createLinearGradient(cx - 0.2 * s, 0, cx + 0.2 * s, 0);
    if (facingCamera) {
      g.addColorStop(0, pal.shirtDark);
      g.addColorStop(0.45, pal.shirt);
      g.addColorStop(1, pal.shirt);
    } else {
      g.addColorStop(0, pal.shirt);
      g.addColorStop(0.55, pal.shirt);
      g.addColorStop(1, pal.shirtDark);
    }
    ctx.save();
    ctx.translate(cx, hipY);
    ctx.rotate(lean);
    ctx.fillStyle = g;
    this.roundRect(-0.19 * s, -bodyH, 0.38 * s, bodyH + 0.02 * s, 0.12 * s);

    // ---- Brazo libre (se balancea al correr, al contrario que las piernas) ----
    const offSide = facingCamera ? 1 : -1;
    const armSway = -stride * 0.6;
    ctx.strokeStyle = pal.skin;
    ctx.lineWidth = Math.max(0.075 * s, 2);
    ctx.beginPath();
    ctx.moveTo(offSide * 0.17 * s, -bodyH + 0.08 * s);
    ctx.quadraticCurveTo(
      offSide * 0.26 * s,
      -bodyH * 0.5,
      offSide * 0.22 * s + armSway,
      -0.12 * s,
    );
    ctx.stroke();

    // ---- Cabeza ----
    const headY = -bodyH - headR * 1.15;
    ctx.fillStyle = pal.skin;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    // Pelo: de frente se ve el flequillo, de espaldas cubre casi toda la cabeza
    ctx.fillStyle = pal.hair;
    ctx.beginPath();
    if (facingCamera) {
      ctx.arc(0, headY, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95);
      ctx.closePath();
    } else {
      ctx.arc(0, headY - headR * 0.05, headR * 1.02, Math.PI * 0.9, Math.PI * 2.1);
      ctx.closePath();
    }
    ctx.fill();
    // Cinta deportiva
    ctx.strokeStyle = facingCamera ? '#f4f7fb' : '#ffd166';
    ctx.lineWidth = Math.max(headR * 0.22, 1.2);
    ctx.beginPath();
    ctx.arc(0, headY, headR * 0.98, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    // Ojos si está de frente y lo bastante cerca
    if (facingCamera && s > 26) {
      ctx.fillStyle = '#1c222b';
      ctx.beginPath();
      ctx.arc(-headR * 0.32, headY + headR * 0.1, headR * 0.09, 0, Math.PI * 2);
      ctx.arc(headR * 0.32, headY + headR * 0.1, headR * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Brazo de la pala, articulado (hombro → codo → mano) ----
    const swinging = p.swingType !== null;
    let armAngle: number;
    if (swinging) {
      const t = p.swingT;
      if (p.swingType !== null && isOverheadShot(p.swingType)) {
        // Remate/bandeja/víbora: brazo desde arriba; la bandeja es más contenida
        const range = p.swingType === 'bandeja' ? 0.85 : 1.1;
        armAngle = -Math.PI * 0.75 + t * Math.PI * range;
      } else {
        const dir = p.swingType === 'backhand' || p.swingType === 'volleyBh' ? -1 : 1;
        armAngle = dir * (-2.1 + t * 3.1);
      }
    } else {
      armAngle = 1.0 + armSway / Math.max(s, 1); // pala abajo, con leve balanceo
    }
    const armSide = facingCamera ? -1 : 1;
    const shoulder = { x: armSide * 0.17 * s, y: -bodyH + 0.08 * s };
    const armLen = 0.52 * s;
    const hand = {
      x: shoulder.x + Math.sin(armAngle) * armLen * armSide,
      y: shoulder.y + Math.cos(armAngle) * armLen * 0.75 + 0.06 * s,
    };
    // Codo desplazado perpendicularmente para que el brazo se doble natural
    const mid = { x: (shoulder.x + hand.x) / 2, y: (shoulder.y + hand.y) / 2 };
    const elbow = {
      x: mid.x + Math.cos(armAngle) * 0.09 * s * armSide,
      y: mid.y + Math.sin(armAngle) * 0.06 * s,
    };
    ctx.strokeStyle = pal.skin;
    ctx.lineWidth = Math.max(0.08 * s, 2);
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.quadraticCurveTo(elbow.x, elbow.y, hand.x, hand.y);
    ctx.stroke();

    // ---- Pala de pádel ----
    const rackAngle = armAngle * armSide;
    const rackLen = 0.16 * s;
    const rackCx = hand.x + Math.sin(rackAngle) * rackLen;
    const rackCy = hand.y + Math.cos(rackAngle) * rackLen * 0.8;
    // Mango
    ctx.strokeStyle = '#2b2f38';
    ctx.lineWidth = Math.max(0.045 * s, 1.5);
    ctx.beginPath();
    ctx.moveTo(hand.x, hand.y);
    ctx.lineTo(rackCx, rackCy);
    ctx.stroke();
    // Marco y cara
    ctx.fillStyle = swinging ? '#ffd166' : '#c8551b';
    ctx.beginPath();
    ctx.ellipse(rackCx, rackCy, 0.13 * s, 0.16 * s, rackAngle, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = swinging ? '#ffe3a1' : '#e07a3f';
    ctx.beginPath();
    ctx.ellipse(rackCx, rackCy, 0.095 * s, 0.125 * s, rackAngle, 0, Math.PI * 2);
    ctx.fill();
    // Agujeros de la pala
    if (s > 30) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (const [ox, oy] of [[0, 0], [-0.04, -0.05], [0.04, -0.05], [-0.04, 0.05], [0.04, 0.05]]) {
        ctx.beginPath();
        ctx.arc(rackCx + ox * s, rackCy + oy * s, 0.012 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
}
