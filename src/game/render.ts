import { Ball, BALL_RADIUS } from './ball';
import { COURT } from './court';
import { PlayerEntity } from './player';
import { clamp, isOverheadShot, lerp } from '../types';
import type { Vec3 } from '../types';
import type { GameRenderer } from './renderers/GameRenderer';

// ============================================================================
// Lenguaje visual: ARCADE DEPORTIVO 2.5D. Formas grandes, siluetas claras,
// contraste fuerte y lectura móvil. Jerarquía: jugador cercano > bola > red >
// líneas > rival > cristales > fondo. El fondo es una silueta de estadio,
// no un decorado.
// ============================================================================

// Cámara visual: cerca del jugador pero a altura de espectador, no a ras de
// suelo (evita el ángulo dramático que hacía parecer "avatar mal colocado").
// (Solo proyección: las coordenadas lógicas del juego no cambian.)
const CAM_Z = 25;
const CAM_H = 4.15;

const OUTLINE = '#0d1826';

export interface Palette {
  shirt: string;
  shirtDark: string;
  shorts: string;
  skin: string;
  hair: string;
}

export const PLAYER_PALETTE: Palette = {
  shirt: '#2fd6b3',
  shirtDark: '#118b72',
  shorts: '#14293e',
  skin: '#efc296',
  hair: '#3a2a1c',
};

export const CPU_PALETTE: Palette = {
  shirt: '#f2784e',
  shirtDark: '#b04424',
  shorts: '#2a1a22',
  skin: '#f3cda2',
  hair: '#20242c',
};

/** Hash determinista 0..1 (variación sin patrón visible). */
function seed01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Aclara/oscurece un color hex un factor -1..1. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}

/**
 * Estado de pose suavizado de un avatar (jugador cercano o rival lejano):
 * blend 0 = reposo (pala delante del cuerpo), 1 = preparado/en golpe;
 * side +1 = lado de derecha (forehand), -1 = lado de revés (backhand).
 */
interface AvatarPose {
  blend: number;
  side: number;
}

interface Particle {
  kind: 'dot' | 'ring';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export class Renderer implements GameRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  private f = 500;
  private horizonY = 0;
  // Compresión horizontal específica de retrato: evita que un jugador en
  // el lateral de la pista (p.ej. posición de saque) quede fuera del
  // encuadre estrecho de un móvil, sin tener que alejar la cámara ni
  // encoger la pista verticalmente.
  private hScale = 1;
  // Paneo horizontal de cámara: sigue al jugador cercano cuando se va a un
  // lateral (p.ej. posición de saque), para que nunca salga del encuadre
  // sin tener que exagerar la compresión general de la escena.
  private panFactor = 0;
  private camX = 0;
  private shakeMag = 0;
  private particles: Particle[] = [];
  private lastDrawT = 0;
  private crowdExcite = 0;
  /** Camiseta del rival: los rivales del torneo tienen su propio color. */
  cpuPalette: Palette = CPU_PALETTE;
  /** Zonas objetivo de los desafíos, dibujadas sobre la pista. */
  targetZones: Array<{ x0: number; x1: number; z0: number; z1: number }> = [];

  private stars = Array.from({ length: 40 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.16,
    r: 0.4 + Math.random() * 0.9,
    a: 0.15 + Math.random() * 0.35,
  }));
  private vignette: CanvasGradient | null = null;

  // Sistema de poses del avatar: reposo <-> preparación <-> golpe <-> vuelta,
  // suavizado con interpolación exponencial (sin estado de gameplay, solo
  // visual). Un estado independiente por avatar (cercano/lejano).
  private poseNear: AvatarPose = { blend: 0, side: 1 };
  private poseFar: AvatarPose = { blend: 0, side: 1 };

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
    // Encuadre arcade: el campo cercano llena la parte baja de la pantalla,
    // pero sin que el jugador quede cortado en los laterales.
    const portrait = this.H > this.W * 1.2;
    if (portrait) {
      this.f = Math.min(this.H * 0.6, this.W * 1.3);
      this.horizonY = this.H * 0.34;
      this.hScale = 0.74;
      this.panFactor = 0.6;
    } else {
      this.f = Math.min(this.H * 0.84, this.W * 0.62);
      this.horizonY = this.H * 0.3;
      this.hScale = 1;
      this.panFactor = 0.2;
    }
    const g = this.ctx.createRadialGradient(
      this.W / 2, this.H * 0.58, Math.min(this.W, this.H) * 0.42,
      this.W / 2, this.H * 0.58, Math.max(this.W, this.H) * 0.82,
    );
    g.addColorStop(0, 'rgba(2, 8, 18, 0)');
    g.addColorStop(1, 'rgba(2, 8, 18, 0.6)');
    this.vignette = g;
  }

  /** Proyección perspectiva simple de coordenadas de mundo a pantalla. */
  project(x: number, y: number, z: number): { x: number; y: number; s: number } {
    const d = Math.max(CAM_Z - z, 0.5);
    const s = this.f / d;
    return {
      x: this.W / 2 + (x - this.camX) * s * this.hScale,
      y: this.horizonY + (CAM_H - y) * s,
      s,
    };
  }

  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  exciteCrowd(amount: number): void {
    this.crowdExcite = Math.min(1, this.crowdExcite + amount);
  }

  /** Chispas en un punto del mundo; a ras de suelo añade onda de impacto. */
  burst(pos: Vec3, color: string, count = 8, speed = 2.2): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        kind: 'dot',
        x: pos.x, y: Math.max(pos.y, 0.03), z: pos.z,
        vx: Math.cos(a) * v,
        vy: Math.random() * v * 0.9,
        vz: Math.sin(a) * v * 0.6,
        life: 0.3 + Math.random() * 0.25,
        maxLife: 0.55,
        color,
        size: 0.024 + Math.random() * 0.028,
      });
    }
    if (pos.y < 0.28) {
      this.particles.push({
        kind: 'ring',
        x: pos.x, y: 0.02, z: pos.z,
        vx: 0, vy: 0, vz: 0,
        life: 0.4, maxLife: 0.4,
        color,
        size: 0.12,
      });
    }
    if (this.particles.length > 200) this.particles.splice(0, this.particles.length - 200);
  }

  draw(ball: Ball, player: PlayerEntity, cpu: PlayerEntity, showBall: boolean): void {
    const now = performance.now();
    const dt = this.lastDrawT ? Math.min((now - this.lastDrawT) / 1000, 0.05) : 0.016;
    this.lastDrawT = now;

    // La cámara sigue suavemente al jugador cercano en horizontal para que
    // nunca quede fuera de encuadre en los laterales (p.ej. al sacar).
    const camTarget = player.x * this.panFactor;
    this.camX += (camTarget - this.camX) * Math.min(dt * 3.5, 1);

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

    this.drawBackground(dt, now);
    this.drawCourt(now);
    if (showBall) this.drawLandingMarker(ball, now);
    this.drawAvatar(cpu, this.cpuPalette, true, ball, dt);
    if (showBall && ball.pos.z <= COURT.netZ) this.drawBall(ball);
    this.drawNet();
    if (showBall && ball.pos.z > COURT.netZ) this.drawBall(ball);
    this.drawParticles(dt);
    this.drawAvatar(player, PLAYER_PALETTE, false, ball, dt);
    ctx.restore();

    if (this.vignette) {
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  // ==========================================================================
  // Fondo: silueta de estadio, no decorado
  // ==========================================================================

  private drawBackground(dt: number, now: number): void {
    const ctx = this.ctx;
    this.crowdExcite *= Math.exp(-dt * 0.8);
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#03060d');
    g.addColorStop(0.3, '#081527');
    g.addColorStop(1, '#050c18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    for (const s of this.stars) {
      ctx.fillStyle = `rgba(200, 222, 250, ${s.a})`;
      ctx.beginPath();
      ctx.arc(s.x * this.W, s.y * this.H, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grada: masas de silueta con cabezas onduladas (3 filas)
    const t = now / 1000;
    const bandTop = this.project(0, 8.4, -6).y;
    const bandBot = this.project(0, 3.2, -1).y;
    const gB = ctx.createLinearGradient(0, bandTop, 0, bandBot);
    gB.addColorStop(0, '#050b15');
    gB.addColorStop(1, '#0b1a2e');
    ctx.fillStyle = gB;
    ctx.fillRect(0, bandTop, this.W, bandBot - bandTop);

    const ROW_COLORS = ['#182a41', '#13233a', '#0e1c31'];
    for (let row = 2; row >= 0; row--) {
      const z = -2 - row * 1.9;
      const y = 4.5 + row * 1.05;
      const bob = this.crowdExcite * Math.max(0, Math.sin(t * 8 + row * 2)) * 0.18;
      const bottom = this.project(0, y - 1.1, z).y;
      ctx.fillStyle = ROW_COLORS[row];
      ctx.beginPath();
      ctx.moveTo(-10, bottom);
      for (let i = 0; i < 46; i++) {
        const sd = seed01(i * 13 + row * 71);
        const hx = -11 + i * 0.52 + (sd - 0.5) * 0.2;
        const hp = this.project(hx, y + bob + (sd - 0.5) * 0.16, z);
        const r = (0.15 + sd * 0.06) * hp.s;
        if (sd > 0.1) ctx.arc(hp.x, hp.y, r, Math.PI, 0);
        else ctx.lineTo(hp.x, hp.y + r);
      }
      ctx.lineTo(this.W + 10, bottom);
      ctx.closePath();
      ctx.fill();
    }
    // Barandilla
    const ra = this.project(-10, 4.05, -1.3);
    const rb = this.project(10, 4.05, -1.3);
    ctx.strokeStyle = 'rgba(140, 175, 215, 0.3)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(ra.x, ra.y);
    ctx.lineTo(rb.x, rb.y);
    ctx.stroke();

    // Focos: grandes, cuatro luminarias con halo amplio
    for (const lx of [-6.8, -2.3, 2.3, 6.8]) {
      const p = this.project(lx, 8.6, -5.5);
      const r = 0.62 * p.s;
      ctx.strokeStyle = 'rgba(55, 75, 100, 0.7)';
      ctx.lineWidth = Math.max(r * 0.14, 2);
      const base = this.project(lx, 4.4, -5.5);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + r * 0.4);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
      ctx.fillStyle = '#131f30';
      ctx.beginPath();
      ctx.roundRect(p.x - r * 1.4, p.y - r * 0.45, r * 2.8, r * 0.9, r * 0.2);
      ctx.fill();
      ctx.fillStyle = '#fff6d8';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(p.x + i * r * 0.85, p.y, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
      const glow = ctx.createRadialGradient(p.x, p.y, r * 0.3, p.x, p.y, r * 4);
      glow.addColorStop(0, 'rgba(255, 248, 215, 0.45)');
      glow.addColorStop(1, 'rgba(255, 248, 215, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tribunas laterales: masas oscuras que cierran la escena
    for (const side of [-1, 1] as const) {
      const quad = [
        this.project(side * 9.6, 0, 21),
        this.project(side * 9.6, 5, 21),
        this.project(side * 9.6, 5, -1),
        this.project(side * 9.6, 0, -1),
      ];
      ctx.fillStyle = '#070f1c';
      ctx.beginPath();
      quad.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(110, 145, 185, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(quad[1].x, quad[1].y);
      ctx.lineTo(quad[2].x, quad[2].y);
      ctx.stroke();
    }
  }

  // ==========================================================================
  // Pista: dos masas + luz grande + líneas con grosor en perspectiva
  // ==========================================================================

  private groundPoly(points: Array<[number, number]>): void {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach(([x, z], i) => {
      const p = this.project(x, 0, z);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }

  /** Línea de pista como banda con grosor real en metros (pesa en perspectiva). */
  private lineBandH(x0: number, x1: number, z: number, t: number, style: string): void {
    this.groundPoly([
      [x0, z - t / 2],
      [x1, z - t / 2],
      [x1, z + t / 2],
      [x0, z + t / 2],
    ]);
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }

  private lineBandV(x: number, z0: number, z1: number, t: number, style: string): void {
    this.groundPoly([
      [x - t / 2, z0],
      [x + t / 2, z0],
      [x + t / 2, z1],
      [x - t / 2, z1],
    ]);
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }

  private drawCourt(now: number): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const L = COURT.length;

    // Base exterior oscura: la pista resalta sobre ella
    this.groundPoly([
      [-10, -1.5],
      [10, -1.5],
      [10, L + 3],
      [-10, L + 3],
    ]);
    const gDeck = ctx.createLinearGradient(0, this.horizonY, 0, this.H);
    gDeck.addColorStop(0, '#0a1424');
    gDeck.addColorStop(1, '#122341');
    ctx.fillStyle = gDeck;
    ctx.fill();

    // Suelo: masa lejana fría → masa cercana iluminada
    this.groundPoly([
      [-hw, 0],
      [hw, 0],
      [hw, L],
      [-hw, L],
    ]);
    const gFloor = ctx.createLinearGradient(0, this.horizonY, 0, this.H);
    gFloor.addColorStop(0, '#173e63');
    gFloor.addColorStop(0.42, '#2364a4');
    gFloor.addColorStop(1, '#3d8fdd');
    ctx.fillStyle = gFloor;
    ctx.fill();

    // Luz por masas: gran mancha en el campo cercano, menor en el rival
    ctx.save();
    this.groundPoly([
      [-hw, 0],
      [hw, 0],
      [hw, L],
      [-hw, L],
    ]);
    ctx.clip();
    for (const [pz, pr, al] of [[15.5, 9, 0.16], [5, 6.5, 0.09]] as const) {
      const c = this.project(0, 0, pz);
      const rr = pr * c.s;
      const pool = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rr);
      pool.addColorStop(0, `rgba(200, 230, 255, ${al})`);
      pool.addColorStop(1, 'rgba(200, 230, 255, 0)');
      ctx.fillStyle = pool;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rr, rr * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Sombra perimetral fuerte: la pista tiene borde, no se funde
    const edge = (poly: Array<[number, number]>, x0: number, y0: number, x1: number, y1: number): void => {
      this.groundPoly(poly);
      const gE = ctx.createLinearGradient(x0, y0, x1, y1);
      gE.addColorStop(0, 'rgba(3, 11, 24, 0.5)');
      gE.addColorStop(1, 'rgba(3, 11, 24, 0)');
      ctx.fillStyle = gE;
      ctx.fill();
    };
    for (const side of [-1, 1] as const) {
      const px0 = this.project(side * hw, 0, L / 2).x;
      const px1 = this.project(side * (hw - 1.5), 0, L / 2).x;
      edge([[side * hw, 0], [side * (hw - 1.5), 0], [side * (hw - 1.5), L], [side * hw, L]], px0, 0, px1, 0);
    }
    const yF0 = this.project(0, 0, 0).y;
    const yF1 = this.project(0, 0, 1.8).y;
    edge([[-hw, 0], [hw, 0], [hw, 1.8], [-hw, 1.8]], 0, yF0, 0, yF1);
    // oscurecido tras la red: separa los dos campos
    this.groundPoly([
      [-hw, COURT.netZ - 1.6],
      [hw, COURT.netZ - 1.6],
      [hw, COURT.netZ],
      [-hw, COURT.netZ],
    ]);
    ctx.fillStyle = 'rgba(4, 14, 30, 0.14)';
    ctx.fill();
    // sombra de la red
    this.groundPoly([
      [-hw, COURT.netZ + 0.1],
      [hw, COURT.netZ + 0.1],
      [hw, COURT.netZ + 0.9],
      [-hw, COURT.netZ + 0.9],
    ]);
    ctx.fillStyle = 'rgba(3, 12, 26, 0.22)';
    ctx.fill();
    ctx.restore();

    // Líneas: halo suave + banda blanca con grosor en perspectiva
    const t = 0.1;
    for (const z of [0.08, L - 0.08, COURT.serviceLineCpu, COURT.serviceLinePlayer]) {
      this.lineBandH(-hw, hw, z, t * 2.6, 'rgba(255,255,255,0.16)');
    }
    this.lineBandV(0, COURT.serviceLineCpu, COURT.serviceLinePlayer, t * 2.6, 'rgba(255,255,255,0.16)');
    for (const z of [0.08, L - 0.08, COURT.serviceLineCpu, COURT.serviceLinePlayer]) {
      this.lineBandH(-hw, hw, z, t, 'rgba(255,255,255,0.96)');
    }
    this.lineBandV(0, COURT.serviceLineCpu, COURT.serviceLinePlayer, t, 'rgba(255,255,255,0.96)');

    // Zonas objetivo de los desafíos
    if (this.targetZones.length > 0) {
      const pulse = 0.15 + Math.sin(now / 300) * 0.06;
      for (const z of this.targetZones) {
        this.groundPoly([
          [z.x0, z.z0],
          [z.x1, z.z0],
          [z.x1, z.z1],
          [z.x0, z.z1],
        ]);
        ctx.fillStyle = `rgba(52, 211, 153, ${pulse.toFixed(3)})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.9)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    this.drawGlass();
    this.drawLedBoard(now);
  }

  /** Cristales gráficos: pocos paneles grandes con masa visual. */
  private drawGlass(): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const L = COURT.length;
    const wh = COURT.wallHeight;

    const quad3d = (pts: Array<[number, number, number]>): void => {
      ctx.beginPath();
      pts.forEach(([x, y, z], i) => {
        const p = this.project(x, y, z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
    };

    const wall = (a: [number, number], b: [number, number], cuts: number, back: boolean): void => {
      // base oscura donde el cristal toca el suelo
      quad3d([[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], 0.32, b[1]], [a[0], 0.32, a[1]]]);
      ctx.fillStyle = 'rgba(5, 13, 25, 0.8)';
      ctx.fill();
      // plano translúcido completo
      quad3d([[a[0], 0.32, a[1]], [b[0], 0.32, b[1]], [b[0], wh, b[1]], [a[0], wh, a[1]]]);
      ctx.fillStyle = back ? 'rgba(140, 195, 245, 0.12)' : 'rgba(140, 195, 245, 0.07)';
      ctx.fill();
      // brillo grande y suave en diagonal
      const mid = this.project((a[0] + b[0]) / 2, wh * 0.7, (a[1] + b[1]) / 2);
      const gS = ctx.createLinearGradient(mid.x - mid.s, mid.y - mid.s, mid.x + mid.s, mid.y + mid.s);
      gS.addColorStop(0, 'rgba(255,255,255,0.09)');
      gS.addColorStop(0.5, 'rgba(255,255,255,0.015)');
      gS.addColorStop(1, 'rgba(255,255,255,0)');
      quad3d([[a[0], 0.32, a[1]], [b[0], 0.32, b[1]], [b[0], wh, b[1]], [a[0], wh, a[1]]]);
      ctx.fillStyle = gS;
      ctx.fill();
      // cortes verticales (pocos) y marco
      ctx.strokeStyle = 'rgba(175, 210, 245, 0.4)';
      ctx.lineWidth = 2.5;
      for (let i = 0; i <= cuts; i++) {
        const k = i / cuts;
        const x = a[0] + (b[0] - a[0]) * k;
        const z = a[1] + (b[1] - a[1]) * k;
        const p0 = this.project(x, 0, z);
        const p1 = this.project(x, wh, z);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      // remate superior claro con grosor
      quad3d([[a[0], wh, a[1]], [b[0], wh, b[1]], [b[0], wh + 0.18, b[1]], [a[0], wh + 0.18, a[1]]]);
      ctx.fillStyle = 'rgba(190, 218, 245, 0.65)';
      ctx.fill();
    };

    wall([-hw, 0], [hw, 0], 3, true);
    wall([-hw, 0], [-hw, L], 4, false);
    wall([hw, 0], [hw, L], 4, false);
  }

  /** Valla LED con marquesina en lo alto del cristal de fondo. */
  private drawLedBoard(now: number): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const tl = this.project(-hw, 3.95, 0);
    const br = this.project(hw, 3.45, 0);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    if (w < 40) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tl.x, tl.y, w, h);
    ctx.clip();
    ctx.fillStyle = '#04090f';
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.font = `bold ${Math.max(h * 0.55, 8).toFixed(1)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    const msg = 'PÁDEL CAM  ●  JUEGA CON TU CUERPO  ●  ';
    const mw = Math.max(ctx.measureText(msg).width, 40);
    const off = -((now / 1000) * w * 0.06) % mw;
    for (let x = tl.x + off - mw; x < br.x; x += mw) {
      ctx.fillText(msg, x, tl.y + h * 0.55);
    }
    ctx.restore();
  }

  // ==========================================================================
  // Red: fuerte, divide la pista
  // ==========================================================================

  private drawNet(): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const nz = COURT.netZ;
    const nh = COURT.netHeight;
    const a = this.project(-hw, 0, nz);
    const b = this.project(hw, 0, nz);
    const at = this.project(-hw, nh, nz);
    const bt = this.project(hw, nh, nz);

    // cuerpo de la red
    ctx.fillStyle = 'rgba(9, 20, 34, 0.6)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(bt.x, bt.y);
    ctx.lineTo(at.x, at.y);
    ctx.closePath();
    ctx.fill();

    // malla sugerida (pocas líneas)
    ctx.strokeStyle = 'rgba(215, 232, 248, 0.14)';
    ctx.lineWidth = 1.5;
    for (let x = -hw + 0.8; x < hw; x += 0.8) {
      const v0 = this.project(x, 0, nz);
      const v1 = this.project(x, nh, nz);
      ctx.beginPath();
      ctx.moveTo(v0.x, v0.y);
      ctx.lineTo(v1.x, v1.y);
      ctx.stroke();
    }
    const h0 = this.project(-hw, nh * 0.5, nz);
    const h1 = this.project(hw, nh * 0.5, nz);
    ctx.beginPath();
    ctx.moveTo(h0.x, h0.y);
    ctx.lineTo(h1.x, h1.y);
    ctx.stroke();

    // banda superior gruesa con volumen
    const bT = this.project(0, nh + 0.06, nz);
    const bB = this.project(0, nh - 0.12, nz);
    const gBand = ctx.createLinearGradient(0, bT.y, 0, bB.y);
    gBand.addColorStop(0, '#ffffff');
    gBand.addColorStop(0.7, '#dbe4ee');
    gBand.addColorStop(1, '#93a5ba');
    ctx.fillStyle = gBand;
    ctx.beginPath();
    ctx.moveTo(this.project(-hw, nh + 0.06, nz).x, this.project(-hw, nh + 0.06, nz).y);
    ctx.lineTo(this.project(hw, nh + 0.06, nz).x, this.project(hw, nh + 0.06, nz).y);
    ctx.lineTo(this.project(hw, nh - 0.12, nz).x, this.project(hw, nh - 0.12, nz).y);
    ctx.lineTo(this.project(-hw, nh - 0.12, nz).x, this.project(-hw, nh - 0.12, nz).y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // postes contundentes
    for (const px of [-hw, hw]) {
      const base = this.project(px, 0, nz);
      const top = this.project(px, nh + 0.16, nz);
      ctx.fillStyle = 'rgba(2, 8, 18, 0.4)';
      ctx.beginPath();
      ctx.ellipse(base.x + base.s * 0.05, base.y, base.s * 0.16, base.s * 0.055, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(base.s * 0.13, 6);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      const gP = ctx.createLinearGradient(base.x - 5, 0, base.x + 5, 0);
      gP.addColorStop(0, '#c3cfdc');
      gP.addColorStop(0.45, '#f2f6fa');
      gP.addColorStop(1, '#93a2b3');
      ctx.strokeStyle = gP;
      ctx.lineWidth = Math.max(base.s * 0.095, 4.5);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }
  }

  // ==========================================================================
  // Pelota: siempre lo más brillante
  // ==========================================================================

  private drawLandingMarker(ball: Ball, now: number): void {
    if (!ball.active) return;
    const speed2 = ball.vel.x ** 2 + ball.vel.z ** 2;
    if (speed2 < 4 || ball.pos.y < 0.35) return;
    const land = ball.predictLanding();
    if (Math.abs(land.x) > COURT.halfWidth || land.z < 0 || land.z > COURT.length) return;
    const ctx = this.ctx;
    const p = this.project(land.x, 0, land.z);
    const r = Math.max(0.32 * p.s, 7);
    const pulse = 0.75 + Math.sin(now / 130) * 0.25;
    ctx.strokeStyle = `rgba(220, 228, 40, ${(0.4 * pulse).toFixed(3)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawBall(ball: Ball): void {
    const ctx = this.ctx;
    const pos = ball.pos;

    // Estela corta y deportiva
    const tr = ball.trail;
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
    const speedK = Math.max(0.6, Math.min(speed / 13, 1.6)); // bola rápida = estela potente
    if (tr.length >= 2) {
      for (let i = Math.max(1, tr.length - 6); i < tr.length; i++) {
        const a = this.project(tr[i - 1].x, tr[i - 1].y, tr[i - 1].z);
        const b = this.project(tr[i].x, tr[i].y, tr[i].z);
        const k = (i - (tr.length - 6)) / 6;
        ctx.strokeStyle = `rgba(222, 230, 40, ${(k * 0.28 * speedK).toFixed(3)})`;
        ctx.lineWidth = Math.max(BALL_RADIUS * b.s * 1.7 * k * speedK, 1.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Sombra dinámica
    const sh = this.project(pos.x, 0, pos.z);
    const shR = Math.max(BALL_RADIUS * sh.s * 1.2, 3);
    const hFade = Math.max(0.18, 0.5 - pos.y * 0.1);
    ctx.fillStyle = `rgba(0, 4, 12, ${hFade.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, shR * 1.3, shR * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    const p = this.project(pos.x, pos.y, pos.z);
    const r = Math.max(BALL_RADIUS * p.s * 1.85, 4.5);

    const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 2.6);
    glow.addColorStop(0, 'rgba(232, 238, 60, 0.35)');
    glow.addColorStop(1, 'rgba(232, 238, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(r * 0.16, 1.5);
    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r);
    g.addColorStop(0, '#fdfda6');
    g.addColorStop(0.65, '#e6ec2a');
    g.addColorStop(1, '#c2c916');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = Math.max(r * 0.13, 1);
    ctx.beginPath();
    ctx.arc(p.x - r * 0.25, p.y, r * 0.8, -0.8, 0.8);
    ctx.stroke();
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
      const alpha = Math.min(p.life / p.maxLife, 1);
      if (p.kind === 'ring') {
        const k = 1 - p.life / p.maxLife;
        const pr = this.project(p.x, 0, p.z);
        const rr = (p.size + k * 0.6) * pr.s;
        ctx.strokeStyle = `rgba(${p.color}, ${(alpha * 0.5).toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, rr, rr * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      p.vy -= 6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.02) {
        p.y = 0.02;
        p.vy = Math.abs(p.vy) * 0.3;
      }
      const pr = this.project(p.x, p.y, p.z);
      ctx.fillStyle = `rgba(${p.color}, ${(alpha * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, Math.max(p.size * pr.s, 1.2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ==========================================================================
  // Avatares: personajes arcade — masas rellenas con contorno, no palitos
  // ==========================================================================

  /** Cápsula con contorno y highlight: el ladrillo de los personajes. */
  private capsule(
    x1: number, y1: number, x2: number, y2: number,
    w: number, fill: string, highlight = true,
  ): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = w + Math.max(w * 0.32, 2.5);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = fill;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (highlight && w > 5) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = w * 0.32;
      const off = w * 0.2;
      ctx.beginPath();
      ctx.moveTo(x1 - off, y1 - off * 0.6);
      ctx.lineTo(x2 - off, y2 - off * 0.6);
      ctx.stroke();
    }
  }

  /**
   * Deriva hacia qué lado y con cuánta antelación debería prepararse el
   * jugador a partir de la posición/velocidad real de la bola (solo
   * lectura visual, no toca ningún estado de gameplay).
   */
  private anticipate(p: PlayerEntity, ball: Ball, facingCamera: boolean): { blend: number; side: number } {
    if (!ball.active) return { blend: 0, side: 0 };
    // ¿La bola viaja hacia el lado de este jugador?
    const incoming = facingCamera ? ball.vel.z < -0.4 : ball.vel.z > 0.4;
    if (!incoming) return { blend: 0, side: 0 };
    const dz = Math.abs(ball.pos.z - p.z);
    const blend = clamp(1 - dz / 10, 0, 0.85);
    // Misma convención derecha/revés que usa classifySwing en match.ts
    const dx = ball.pos.x - p.x;
    const side = (facingCamera ? -dx : dx) >= 0 ? 1 : -1;
    return { blend, side };
  }

  private drawAvatar(p: PlayerEntity, pal: Palette, facingCamera: boolean, ball: Ball, dt: number): void {
    const ctx = this.ctx;
    const base = this.project(p.x, 0, p.z);
    // Escala arcade: el personaje manda en pantalla
    const s = base.s * (facingCamera ? 1.4 : 1.3);
    const cx = base.x;
    const swinging = p.swingType !== null;
    const isBackhandSwing =
      swinging && (p.swingType === 'backhand' || p.swingType === 'volleyBh');
    const swingK = swinging ? Math.sin(Math.min(p.swingT, 1) * Math.PI) : 0;
    const swingDir = isBackhandSwing ? -1 : 1;
    const dirScreen = swingDir * (facingCamera ? -1 : 1);

    // ---- Sistema de poses: ready -> prepareForehand/Backhand -> swing -> recover ----
    // `blend` (0..1) es continuo y suavizado: da la transición fluida entre
    // reposo y preparación/golpe, y la caída de blend tras el golpe ES la
    // recuperación. `side` (-1 revés / +1 derecha) es SIEMPRE discreto: solo
    // se reevalúa cuando el avatar está cerca de reposo (blend bajo), nunca
    // a media preparación, para no producir una pala "a medio cruzar" que
    // no se lee ni como derecha ni como revés.
    const pose = facingCamera ? this.poseFar : this.poseNear;
    const ease = Math.min(dt * 7, 1);
    if (swinging) {
      pose.blend += (1 - pose.blend) * ease;
      pose.side = swingDir; // el golpe real ya se conoce con certeza
    } else {
      const ant = this.anticipate(p, ball, facingCamera);
      pose.blend += (ant.blend - pose.blend) * ease;
      if (pose.blend < 0.2 && ant.blend > 0.05) pose.side = ant.side;
    }
    const prepBlend = clamp(pose.blend, 0, 1); // 0 reposo -> 1 preparado/golpeando
    const prepSide = pose.side >= 0 ? 1 : -1; // revés (-1) o derecha (+1), sin ambigüedad

    // Sombra grande y clara bajo los pies
    const gSh = ctx.createRadialGradient(cx, base.y, 0, cx, base.y, 0.55 * s);
    gSh.addColorStop(0, 'rgba(0, 4, 12, 0.45)');
    gSh.addColorStop(1, 'rgba(0, 4, 12, 0)');
    ctx.fillStyle = gSh;
    ctx.beginPath();
    ctx.ellipse(cx, base.y, 0.55 * s, 0.17 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Anillo de identidad bajo el jugador (lenguaje de retransmisión de
    // pádel profesional): elipse del color de su equipo, sutil.
    ctx.strokeStyle = pal.shirt;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(0.035 * s, 2);
    ctx.beginPath();
    ctx.ellipse(cx, base.y, 0.42 * s, 0.13 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Proporciones arcade: cabeza grande, torso ancho, piernas con masa
    const legLen = 0.72 * s;
    const crouch = 0.07 * s;
    const hipY = base.y - legLen + crouch;
    const torsoH = 0.5 * s;
    const headR = 0.155 * s;
    // Sin sesgo fijo: si la cámara está detrás, el jugador queda cuadrado a
    // cámara en reposo (hombros simétricos, de espalda real). La lectura
    // de hacia dónde juega viene del giro real de hombros al preparar/
    // golpear (más abajo), nunca de un giro artificial constante.
    let lean = p.lean * (facingCamera ? -1 : 1);
    if (swinging) lean += swingK * 0.22 * dirScreen;
    // Torso gira hacia el lado anticipado al prepararse (hombro acompaña)
    else lean += prepBlend * 0.13 * prepSide * (facingCamera ? -1 : 1);

    const stride = Math.sin(p.runPhase) * 0.18 * s * p.moveAmount;
    const lungeF = swingK * 0.14 * s; // zancada del golpe
    const prepLungeF = !swinging ? prepBlend * 0.06 * s : 0; // pierna de apoyo en preparación
    // Lado de la pantalla que carga el peso: el del golpe real, o el anticipado
    const activeDirScreen = swinging ? dirScreen : prepSide * (facingCamera ? -1 : 1);

    // ---- Piernas: muslo + gemelo con masa, rodilla flexionada ----
    const drawLeg = (side: -1 | 1, off: number): void => {
      const isLunge = side === activeDirScreen && (swinging || prepBlend > 0.15);
      const lungeAmt = swinging ? lungeF : prepLungeF;
      const hx = cx + side * 0.12 * s;
      const fx = cx + side * (0.2 * s + (isLunge ? lungeAmt : 0)) + off;
      const fy = base.y - Math.abs(off) * 0.2;
      const kx = (hx + fx) / 2 + side * 0.05 * s;
      const ky = (hipY + fy) / 2 - 0.045 * s;
      this.capsule(hx, hipY + 0.06 * s, kx, ky, 0.155 * s, pal.skin);
      this.capsule(kx, ky, fx, fy - 0.09 * s, 0.115 * s, pal.skin);
      // Zapatilla grande con suela
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.fillStyle = '#f4f7fa';
      ctx.beginPath();
      ctx.ellipse(fx + side * 0.04 * s, fy - 0.035 * s, 0.14 * s, 0.062 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#232c39';
      ctx.beginPath();
      ctx.ellipse(fx + side * 0.04 * s, fy - 0.004 * s, 0.14 * s, 0.026 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    drawLeg(-1, stride);
    drawLeg(1, -stride);

    // ---- Pantalón con masa ----
    ctx.fillStyle = pal.shorts;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 0.21 * s, hipY - 0.12 * s);
    ctx.lineTo(cx + 0.21 * s, hipY - 0.12 * s);
    ctx.lineTo(cx + 0.19 * s, hipY + 0.16 * s);
    ctx.lineTo(cx + 0.045 * s, hipY + 0.16 * s);
    ctx.lineTo(cx, hipY + 0.06 * s);
    ctx.lineTo(cx - 0.045 * s, hipY + 0.16 * s);
    ctx.lineTo(cx - 0.19 * s, hipY + 0.16 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, hipY);
    ctx.rotate(lean);

    // ---- Torso atlético: hombros anchos, cintura clara ----
    const shW = 0.27 * s;
    const waistW = 0.17 * s;
    const torso = (): void => {
      ctx.beginPath();
      ctx.moveTo(-waistW, 0.02 * s);
      ctx.quadraticCurveTo(-shW * 1.06, -torsoH * 0.55, -shW, -torsoH);
      ctx.quadraticCurveTo(0, -torsoH - 0.07 * s, shW, -torsoH);
      ctx.quadraticCurveTo(shW * 1.06, -torsoH * 0.55, waistW, 0.02 * s);
      ctx.closePath();
    };
    const gT = ctx.createLinearGradient(-shW, 0, shW, 0);
    if (facingCamera) {
      gT.addColorStop(0, pal.shirtDark);
      gT.addColorStop(0.4, pal.shirt);
      gT.addColorStop(1, shade(pal.shirt, 0.12));
    } else {
      gT.addColorStop(0, shade(pal.shirt, 0.12));
      gT.addColorStop(0.6, pal.shirt);
      gT.addColorStop(1, pal.shirtDark);
    }
    torso();
    ctx.fillStyle = gT;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
    torso();
    ctx.stroke();
    // highlight del lado de la luz
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = Math.max(0.035 * s, 1.5);
    ctx.beginPath();
    ctx.moveTo(-waistW * 0.9, 0);
    ctx.quadraticCurveTo(-shW, -torsoH * 0.55, -shW * 0.92, -torsoH * 0.92);
    ctx.stroke();
    if (!facingCamera) {
      // Espalda atlética: canal de la columna + omóplatos sutiles. Da
      // volumen y orientación (hacia dónde mira el jugador) sin recurrir a
      // ninguna cara: es lectura de espalda pura.
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.lineWidth = Math.max(0.022 * s, 1.2);
      ctx.beginPath();
      ctx.moveTo(0, -torsoH * 0.85);
      ctx.quadraticCurveTo(waistW * 0.06, -torsoH * 0.4, 0, 0);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = Math.max(0.03 * s, 1.4);
      for (const sgn of [-1, 1] as const) {
        ctx.beginPath();
        ctx.moveTo(sgn * waistW * 0.35, -torsoH * 0.15);
        ctx.quadraticCurveTo(sgn * shW * 0.7, -torsoH * 0.5, sgn * shW * 0.55, -torsoH * 0.82);
        ctx.stroke();
      }
    }
    // dorsal / franja
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `900 ${(0.16 * s).toFixed(1)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!facingCamera) ctx.fillText('1', 0, -torsoH * 0.55);
    else ctx.fillText('2', 0, -torsoH * 0.55);

    // Brazo de la pala: hombro/alcance, usados también por el brazo libre
    // para el agarre a dos manos del revés.
    const armSide = facingCamera ? -1 : 1;
    const shoulder = { x: armSide * shW * 0.95, y: -torsoH + 0.05 * s };
    const armLen = (0.5 + swingK * 0.1) * s; // brazo extendido en el golpe

    // ---- Brazo libre (dos segmentos) ----
    // En reposo, la mano secundaria se acerca al cuello de la pala (grip a
    // dos manos); al preparar/golpear se abre para dar equilibrio. En el
    // revés, en cambio, se mantiene junto a la mano de la pala (agarre a
    // dos manos real).
    const offSide = facingCamera ? 1 : -1;
    const armSway = -stride * 0.5;
    const fShoulder = { x: offSide * shW * 0.92, y: -torsoH + 0.06 * s };
    const fElbow = {
      x: offSide * (shW + 0.06 * s),
      y: -torsoH * 0.5 + swingK * 0.06 * s,
    };
    const fBlend = swinging ? 1 : prepBlend;
    // En reposo, la mano libre se acerca a la garganta de la pala (agarre a
    // dos manos de espera), casi centrada, no abierta hacia el lado, y a
    // la altura del pecho (no de la cintura) para que se lea claramente
    // delante del cuerpo en vez de quedar tapada junto al pantalón.
    const readyFHand = { x: offSide * shW * 0.2, y: -torsoH * 0.58 };
    let activeFHand: { x: number; y: number };
    if (isBackhandSwing) {
      // Agarre a dos manos: la mano libre viaja junto al mango de la pala
      const bT = p.swingT;
      const bAngle = swingDir * (1.2 - bT * 3.4);
      activeFHand = {
        x: shoulder.x + Math.sin(bAngle) * armLen * armSide * 0.82,
        y: shoulder.y + Math.cos(bAngle) * armLen * 0.75 * 0.82 + 0.05 * s,
      };
    } else {
      activeFHand = {
        x: offSide * (shW - 0.02 * s) + armSway - swingK * 0.08 * s * dirScreen,
        y: -0.12 * s,
      };
    }
    const fHand = {
      x: lerp(readyFHand.x, activeFHand.x, fBlend),
      y: lerp(readyFHand.y, activeFHand.y, fBlend),
    };
    this.capsule(fShoulder.x, fShoulder.y, fElbow.x, fElbow.y, 0.105 * s, pal.shirt);
    this.capsule(fElbow.x, fElbow.y, fHand.x, fHand.y, 0.085 * s, pal.skin);

    // ---- Cuello y cabeza grande ----
    this.capsule(0, -torsoH + 0.02 * s, 0, -torsoH - 0.07 * s, 0.085 * s, pal.skin, false);
    const headY = -torsoH - headR * 1.15;
    ctx.fillStyle = pal.skin;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.hair;
    ctx.beginPath();
    if (facingCamera) {
      // Vista frontal (rival lejano): el pelo es un flequillo, se ve cara.
      ctx.arc(0, headY, headR * 1.03, Math.PI * 1.02, Math.PI * 1.98);
    } else {
      // Vista trasera real (jugador cercano, cámara detrás): se ve la
      // nuca. Sin hueco, sin mejilla, sin oreja — pura silueta de espalda.
      ctx.arc(0, headY, headR * 1.05, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fill();
    // cinta (visible desde cualquier ángulo, rodea la cabeza)
    ctx.strokeStyle = facingCamera ? '#f4f7fb' : '#ffd166';
    ctx.lineWidth = Math.max(headR * 0.24, 2);
    ctx.beginPath();
    if (facingCamera) {
      ctx.arc(0, headY, headR * 0.96, Math.PI * 1.12, Math.PI * 1.88);
    } else {
      ctx.arc(0, headY, headR * 0.98, Math.PI * 0.08, Math.PI * 0.92);
    }
    ctx.stroke();
    if (facingCamera && s > 34) {
      ctx.fillStyle = '#1c222b';
      ctx.beginPath();
      ctx.arc(-headR * 0.34, headY + headR * 0.12, headR * 0.1, 0, Math.PI * 2);
      ctx.arc(headR * 0.34, headY + headR * 0.12, headR * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Brazo de la pala: reposo (delante) <-> preparación <-> golpe ----
    let armAngle: number;
    let hand: { x: number; y: number };
    if (swinging) {
      const t = p.swingT;
      if (p.swingType !== null && isOverheadShot(p.swingType)) {
        // Golpes altos: fórmula existente sin tocar
        const range = p.swingType === 'bandeja' ? 0.85 : 1.15;
        armAngle = -Math.PI * 0.8 + t * Math.PI * range;
      } else if (isBackhandSwing) {
        // Revés: preparación CRUZADA delante del cuerpo -> impacto/salida
        // extendida hacia el lado contrario (barrido invertido respecto a
        // la derecha, como un revés real; antes salía al revés).
        armAngle = swingDir * (1.2 - t * 3.4);
      } else {
        // Derecha: preparación atrás del lado dominante -> impacto/salida extendida
        armAngle = swingDir * (-2.2 + t * 3.4);
      }
      hand = {
        x: shoulder.x + Math.sin(armAngle) * armLen * armSide,
        y: shoulder.y + Math.cos(armAngle) * armLen * 0.75 + 0.05 * s,
      };
    } else {
      // Reposo: la pala cuelga casi centrada, delante del pecho (READY_ANGLE).
      // Preparación: se lleva hacia atrás en el lado anticipado (derecha) o
      // cruza delante del cuerpo hacia el lado contrario (revés), según el
      // lado continuo `prepSide` (+1 derecha .. -1 revés).
      const READY_ANGLE = 0.22;
      const PREP_ANGLE = 1.1;
      armAngle = lerp(READY_ANGLE, PREP_ANGLE, prepBlend) * (prepBlend > 0 ? prepSide : 1);
      const readyHand = {
        x: armSide * shW * 0.34, // casi centrada delante del cuerpo, no pegada a un lado
        y: -torsoH * 0.52, // altura de pecho: se lee delante del cuerpo, no tapada junto al pantalón
      };
      // Derecha: el ángulo ya lleva la pala hacia atrás del lado dominante.
      // Revés: el propio ángulo (signo prepSide) cruza la pala delante del
      // cuerpo hacia el lado contrario — sin tirón extra que la saque fuera
      // de la silueta ni la esconda detrás del cuerpo.
      const prepHand = {
        x: shoulder.x + Math.sin(armAngle) * armLen * armSide,
        y: shoulder.y + Math.cos(armAngle) * armLen * 0.75 + 0.05 * s,
      };
      hand = {
        x: lerp(readyHand.x, prepHand.x, prepBlend),
        y: lerp(readyHand.y, prepHand.y, prepBlend),
      };
    }
    const mid = { x: (shoulder.x + hand.x) / 2, y: (shoulder.y + hand.y) / 2 };
    const elbow = {
      x: mid.x + Math.cos(armAngle) * 0.08 * s * armSide * (1 - swingK * 0.7),
      y: mid.y + Math.sin(armAngle) * 0.05 * s,
    };

    // motion trail de pala: corto y grueso
    if (swinging && p.swingT > 0.1 && p.swingT < 0.6) {
      const prevSign = swingDir < 0 ? 1 : -1;
      for (const [dA, alpha] of [[0.5, 0.22], [0.95, 0.1]] as const) {
        const gA = armAngle + prevSign * dA;
        const gh = {
          x: shoulder.x + Math.sin(gA) * armLen * armSide,
          y: shoulder.y + Math.cos(gA) * armLen * 0.75 + 0.05 * s,
        };
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.ellipse(
          gh.x + Math.sin(gA * armSide) * 0.2 * s,
          gh.y + Math.cos(gA * armSide) * 0.16 * s,
          0.15 * s, 0.19 * s, gA * armSide, 0, Math.PI * 2,
        );
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // brazo (hombro→codo) y antebrazo (codo→mano)
    this.capsule(shoulder.x, shoulder.y, elbow.x, elbow.y, 0.115 * s, pal.shirt);
    this.capsule(elbow.x, elbow.y, hand.x, hand.y, 0.09 * s, pal.skin);
    // muñequera + puño
    ctx.fillStyle = '#f4f7fb';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, 0.055 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // ---- Pala grande, claramente separada de la mano ----
    const rackAngle = armAngle * armSide;
    const handleLen = 0.14 * s;
    const rackCx = hand.x + Math.sin(rackAngle) * (handleLen + 0.17 * s);
    const rackCy = hand.y + Math.cos(rackAngle) * (handleLen + 0.17 * s) * 0.85;
    // mango visible
    this.capsule(
      hand.x, hand.y,
      hand.x + Math.sin(rackAngle) * handleLen,
      hand.y + Math.cos(rackAngle) * handleLen * 0.85,
      0.05 * s, '#1c242f', false,
    );
    // marco + cara
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(0.045 * s, 2.5);
    const gR = ctx.createLinearGradient(rackCx - 0.12 * s, rackCy - 0.12 * s, rackCx + 0.12 * s, rackCy + 0.12 * s);
    if (swinging) {
      gR.addColorStop(0, '#ffe9b0');
      gR.addColorStop(1, '#ffbe3d');
    } else {
      gR.addColorStop(0, '#e8823f');
      gR.addColorStop(1, '#b04e1a');
    }
    ctx.fillStyle = gR;
    ctx.beginPath();
    ctx.ellipse(rackCx, rackCy, 0.145 * s, 0.185 * s, rackAngle, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (s > 36) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      for (const [ox, oy] of [[0, 0], [-0.05, -0.06], [0.05, -0.06], [-0.05, 0.06], [0.05, 0.06]]) {
        ctx.beginPath();
        ctx.arc(rackCx + ox * s, rackCy + oy * s, 0.015 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // flash de contacto
    if (swinging && p.swingT < 0.2) {
      const fa = (0.2 - p.swingT) * 3.6;
      const fl = ctx.createRadialGradient(rackCx, rackCy, 0, rackCx, rackCy, 0.5 * s);
      fl.addColorStop(0, `rgba(255, 255, 255, ${Math.min(fa, 0.8).toFixed(3)})`);
      fl.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = fl;
      ctx.beginPath();
      ctx.arc(rackCx, rackCy, 0.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.textAlign = 'start';
  }
}
