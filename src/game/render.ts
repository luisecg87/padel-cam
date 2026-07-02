import { Ball, BALL_RADIUS } from './ball';
import { COURT } from './court';
import { PlayerEntity } from './player';
import { isOverheadShot } from '../types';
import type { Vec3 } from '../types';

// ============================================================================
// Dirección visual: "noche de Premier Pádel" — retransmisión deportiva
// nocturna. Luz fría cenital, pista con material, público a contraluz,
// un solo acento de color (la bola lima). Cámara más baja para dar presencia
// al jugador y profundidad a la pista.
// ============================================================================

const CAM_Z = 26;
const CAM_H = 4.4; // cámara más baja que antes: perspectiva más deportiva

export interface Palette {
  shirt: string;
  shirtDark: string;
  shorts: string;
  skin: string;
  hair: string;
}

const PLAYER_PALETTE: Palette = {
  shirt: '#25c9b0',
  shirtDark: '#0f7d6d',
  shorts: '#12293d',
  skin: '#e9b98d',
  hair: '#3a2a1c',
};

export const CPU_PALETTE: Palette = {
  shirt: '#f0764f',
  shirtDark: '#a63d22',
  shorts: '#26161f',
  skin: '#f0c9a0',
  hair: '#20242c',
};

// Público a contraluz: siluetas frías y apagadas, no confeti
const CROWD_COLORS = ['#233349', '#2b3c53', '#1e2d42', '#32425a', '#27374e', '#202f45'];

/** Hash determinista 0..1 para variar el público sin patrón visible. */
function seed01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

interface Particle {
  kind: 'dot' | 'ring';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  color: string; // "r,g,b"
  size: number; // radio en metros (para ring: radio inicial)
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
  /** Zonas objetivo de los desafíos, dibujadas sobre la pista. */
  targetZones: Array<{ x0: number; x1: number; z0: number; z1: number }> = [];

  // Cielo estrellado fijo (posiciones relativas a la pantalla)
  private stars = Array.from({ length: 80 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.2,
    r: 0.4 + Math.random() * 1.1,
    a: 0.2 + Math.random() * 0.5,
  }));
  // Motas de polvo en el aire bajo los focos (atmósfera)
  private motes = Array.from({ length: 26 }, () => ({
    x: Math.random(),
    y: 0.15 + Math.random() * 0.5,
    r: 0.6 + Math.random() * 1.2,
    sp: 0.004 + Math.random() * 0.01,
    ph: Math.random() * Math.PI * 2,
  }));
  private vignette: CanvasGradient | null = null;
  private grain: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.makeGrain();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Textura sutil de moqueta para el suelo (patrón pre-renderizado). */
  private makeGrain(): void {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 220; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,10,30,0.03)';
      g.fillRect(Math.random() * 96, Math.random() * 96, 1.4, 1.4);
    }
    this.grain = this.ctx.createPattern(c, 'repeat');
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.f = Math.min(this.H * 0.98, this.W * 0.6);
    this.horizonY = this.H * 0.33;
    const g = this.ctx.createRadialGradient(
      this.W / 2, this.H * 0.55, Math.min(this.W, this.H) * 0.45,
      this.W / 2, this.H * 0.55, Math.max(this.W, this.H) * 0.8,
    );
    g.addColorStop(0, 'rgba(2, 8, 18, 0)');
    g.addColorStop(1, 'rgba(2, 8, 18, 0.55)');
    this.vignette = g;
  }

  /** Proyección perspectiva simple de coordenadas de mundo a pantalla. */
  project(x: number, y: number, z: number): { x: number; y: number; s: number } {
    const d = Math.max(CAM_Z - z, 0.5);
    const s = this.f / d;
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

  /** El público reacciona: 1 = ovación completa. Decae solo. */
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
        size: 0.022 + Math.random() * 0.026,
      });
    }
    // Onda expansiva en el suelo cuando el impacto es a ras de pista
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

    this.drawBackground(now);
    this.drawCrowd(dt, now);
    this.drawFloodlights();
    this.drawCourt(now);
    this.drawLedBoard(now);
    if (showBall) this.drawLandingMarker(ball, now);
    this.drawAvatar(cpu, this.cpuPalette, true);
    if (showBall && ball.pos.z <= COURT.netZ) this.drawBall(ball);
    this.drawNet();
    if (showBall && ball.pos.z > COURT.netZ) this.drawBall(ball);
    this.drawParticles(dt);
    this.drawAvatar(player, PLAYER_PALETTE, false);
    this.drawMotes(now);
    ctx.restore();

    if (this.vignette) {
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  // ==========================================================================
  // Entorno
  // ==========================================================================

  private drawBackground(now: number): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#040a15');
    g.addColorStop(0.32, '#0d2440');
    g.addColorStop(0.6, '#123152');
    g.addColorStop(1, '#0a1e35');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    for (const s of this.stars) {
      const tw = 0.75 + Math.sin(now / 1400 + s.x * 20) * 0.25;
      ctx.fillStyle = `rgba(215, 232, 255, ${(s.a * tw).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x * this.W, s.y * this.H, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Motas de polvo iluminadas: atmósfera sutil delante de todo. */
  private drawMotes(now: number): void {
    const ctx = this.ctx;
    for (const m of this.motes) {
      const x = ((m.x + now * m.sp * 0.00001) % 1) * this.W;
      const y = (m.y + Math.sin(now / 2400 + m.ph) * 0.012) * this.H;
      ctx.fillStyle = 'rgba(200, 225, 255, 0.05)';
      ctx.beginPath();
      ctx.arc(x, y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Gradas a contraluz: siluetas frías con balanceo leve; saltan en los puntos. */
  private drawCrowd(dt: number, now: number): void {
    this.crowdExcite *= Math.exp(-dt * 0.8);
    const ctx = this.ctx;
    const t = now / 1000;

    // Banda de la grada con degradado
    const bandTop = this.project(0, 8.6, -6.2).y;
    const bandBottom = this.project(0, 3.4, -1.2).y;
    const g = ctx.createLinearGradient(0, bandTop, 0, bandBottom);
    g.addColorStop(0, '#050b16');
    g.addColorStop(1, '#0e2138');
    ctx.fillStyle = g;
    ctx.fillRect(0, bandTop, this.W, bandBottom - bandTop);

    for (let row = 0; row < 3; row++) {
      const z = -1.6 - row * 1.8;
      const y = 4.4 + row * 1.15;
      // Banda de escalón entre filas: da estructura de grada real
      const s0 = this.project(0, y - 0.62, z + 0.4);
      ctx.fillStyle = `rgba(10, 22, 40, ${(0.55 - row * 0.12).toFixed(2)})`;
      ctx.fillRect(0, s0.y, this.W, Math.max(2.5, 0.1 * s0.s));

      const rowAlpha = 0.62 - row * 0.13;
      for (let i = 0; i < 30; i++) {
        const sd = seed01(i * 31 + row * 7);
        const x = -9.6 + i * 0.66 + (row % 2) * 0.33 + (sd - 0.5) * 0.18;
        const phase = i * 1.7 + row * 2.3;
        const idle = Math.sin(t * 1.5 + phase) * 0.03;
        const jump = Math.max(0, Math.sin(t * 8 + phase)) * 0.24 * this.crowdExcite;
        const p = this.project(x, y + idle + jump, z);
        const r = (0.125 + sd * 0.05) * p.s;
        ctx.globalAlpha = rowAlpha * (0.7 + sd * 0.5);
        ctx.fillStyle = CROWD_COLORS[Math.floor(sd * CROWD_COLORS.length)];
        // cabeza + hombros como una sola silueta
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + r * 1.6, r * 1.45, r * 1.1, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(p.x - r * 1.45, p.y + r * 1.6, r * 2.9, r * 1.3);
        // brillo de contraluz en algunas cabezas
        if (sd > 0.72) {
          ctx.globalAlpha = rowAlpha * 0.5;
          ctx.strokeStyle = 'rgba(150, 190, 235, 0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, -Math.PI * 0.85, -Math.PI * 0.15);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Barandilla frontal de la grada
    const ra = this.project(-9, 4.15, -1.4);
    const rb = this.project(9, 4.15, -1.4);
    ctx.strokeStyle = 'rgba(150, 180, 215, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ra.x, ra.y);
    ctx.lineTo(rb.x, rb.y);
    ctx.stroke();
  }

  /** Torres de luz con glow y conos sutiles hacia la pista. */
  private drawFloodlights(): void {
    const ctx = this.ctx;
    for (const lx of [-7.2, -2.4, 2.4, 7.2]) {
      const p = this.project(lx, 8.9, -5.8);
      const r = 0.5 * p.s;
      // mástil
      const base = this.project(lx, 4.6, -5.8);
      ctx.strokeStyle = 'rgba(60, 80, 105, 0.8)';
      ctx.lineWidth = Math.max(r * 0.16, 1.5);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + r * 0.6);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
      // luminaria (barra con 3 lámparas)
      ctx.fillStyle = '#1a2637';
      ctx.fillRect(p.x - r * 1.5, p.y - r * 0.5, r * 3, r);
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = '#fff7de';
        ctx.beginPath();
        ctx.arc(p.x + i * r, p.y, r * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }
      // glow
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.2, p.x, p.y, r * 3.4);
      g.addColorStop(0, 'rgba(255, 250, 224, 0.5)');
      g.addColorStop(0.3, 'rgba(255, 245, 205, 0.16)');
      g.addColorStop(1, 'rgba(255, 245, 205, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
      // cono de luz hacia la pista
      const t1 = this.project(lx * 0.55, 0, 6);
      const t2 = this.project(lx * 0.2, 0, 12);
      const cone = ctx.createLinearGradient(p.x, p.y, (t1.x + t2.x) / 2, (t1.y + t2.y) / 2);
      cone.addColorStop(0, 'rgba(230, 240, 255, 0.055)');
      cone.addColorStop(1, 'rgba(230, 240, 255, 0)');
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.8, p.y);
      ctx.lineTo(p.x + r * 0.8, p.y);
      ctx.lineTo(t2.x, t2.y);
      ctx.lineTo(t1.x, t1.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ==========================================================================
  // Pista
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

  private drawCourt(now: number): void {
    const ctx = this.ctx;
    const hw = COURT.halfWidth;
    const L = COURT.length;

    // Plataforma exterior (que la pista no flote en el vacío)
    this.groundPoly([
      [-9.5, -1.2],
      [9.5, -1.2],
      [9.5, L + 1],
      [-9.5, L + 1],
    ]);
    ctx.fillStyle = '#0b1c30';
    ctx.fill();

    // Suelo de la pista: gradiente con caída lateral (luz cenital)
    this.groundPoly([
      [-hw, 0],
      [hw, 0],
      [hw, L],
      [-hw, L],
    ]);
    // Perspectiva de luz: fondo frío y oscuro, zona cercana iluminada
    const gFloor = ctx.createLinearGradient(0, this.horizonY, 0, this.H);
    gFloor.addColorStop(0, '#123f66');
    gFloor.addColorStop(0.45, '#2065a8');
    gFloor.addColorStop(1, '#3585d0');
    ctx.fillStyle = gFloor;
    ctx.fill();

    // Charcos de luz de los focos sobre la pista (recortados al suelo)
    ctx.save();
    this.groundPoly([
      [-hw, 0],
      [hw, 0],
      [hw, L],
      [-hw, L],
    ]);
    ctx.clip();
    for (const [px, pz, pr] of [[-2.6, 7.5, 5.2], [2.6, 7.5, 5.2], [-2.6, 14, 5.6], [2.6, 14, 5.6]] as const) {
      const c = this.project(px, 0, pz);
      const rr = pr * c.s;
      const pool = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rr);
      pool.addColorStop(0, 'rgba(190, 225, 255, 0.10)');
      pool.addColorStop(1, 'rgba(190, 225, 255, 0)');
      ctx.fillStyle = pool;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rr, rr * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // material: textura sutil de moqueta
    if (this.grain) {
      ctx.fillStyle = this.grain;
      ctx.fillRect(0, this.horizonY, this.W, this.H - this.horizonY);
    }
    // sombra interior en todo el perímetro (la pista deja de ser un plano)
    const edge = (poly: Array<[number, number]>, x0: number, y0: number, x1: number, y1: number): void => {
      this.groundPoly(poly);
      const gE = ctx.createLinearGradient(x0, y0, x1, y1);
      gE.addColorStop(0, 'rgba(3, 13, 28, 0.4)');
      gE.addColorStop(1, 'rgba(3, 13, 28, 0)');
      ctx.fillStyle = gE;
      ctx.fill();
    };
    for (const side of [-1, 1] as const) {
      const px0 = this.project(side * hw, 0, L / 2).x;
      const px1 = this.project(side * (hw - 1.7), 0, L / 2).x;
      edge([[side * hw, 0], [side * (hw - 1.7), 0], [side * (hw - 1.7), L], [side * hw, L]], px0, 0, px1, 0);
    }
    const yFar0 = this.project(0, 0, 0).y;
    const yFar1 = this.project(0, 0, 1.6).y;
    edge([[-hw, 0], [hw, 0], [hw, 1.6], [-hw, 1.6]], 0, yFar0, 0, yFar1);
    const yNear0 = this.project(0, 0, L).y;
    const yNear1 = this.project(0, 0, L - 1.8).y;
    edge([[-hw, L], [hw, L], [hw, L - 1.8], [-hw, L - 1.8]], 0, yNear0, 0, yNear1);
    ctx.restore();
    // bandas de cepillado alternas
    for (let z = 0; z < L; z += 2.5) {
      if ((z / 2.5) % 2 === 0) continue;
      this.groundPoly([
        [-hw, z],
        [hw, z],
        [hw, Math.min(z + 2.5, L)],
        [-hw, Math.min(z + 2.5, L)],
      ]);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fill();
    }
    // sombra de la red sobre el suelo
    this.groundPoly([
      [-hw, COURT.netZ + 0.15],
      [hw, COURT.netZ + 0.15],
      [hw, COURT.netZ + 0.75],
      [-hw, COURT.netZ + 0.75],
    ]);
    ctx.fillStyle = 'rgba(3, 12, 26, 0.16)';
    ctx.fill();

    // Paredes de cristal: más transparentes arriba, con marco
    const wh = COURT.wallHeight;
    const wallQuad = (pts: Array<[number, number, number]>, sideWall: boolean): void => {
      ctx.beginPath();
      pts.forEach(([x, y, z], i) => {
        const p = this.project(x, y, z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      const top = this.project(pts[2][0], wh, pts[2][2]).y;
      const bot = this.project(pts[0][0], 0, pts[0][2]).y;
      const gg = ctx.createLinearGradient(0, top, 0, bot);
      gg.addColorStop(0, 'rgba(160, 205, 245, 0.035)');
      gg.addColorStop(1, sideWall ? 'rgba(160, 205, 245, 0.10)' : 'rgba(160, 205, 245, 0.13)');
      ctx.fillStyle = gg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(190, 222, 250, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    wallQuad([[-hw, 0, 0], [hw, 0, 0], [hw, wh, 0], [-hw, wh, 0]], false);
    wallQuad([[-hw, 0, 0], [-hw, 0, L], [-hw, wh, L], [-hw, wh, 0]], true);
    wallQuad([[hw, 0, 0], [hw, 0, L], [hw, wh, L], [hw, wh, 0]], true);

    // Perfiles metálicos con remate superior brillante
    ctx.strokeStyle = 'rgba(205, 228, 250, 0.34)';
    ctx.lineWidth = 2;
    const post = (x: number, z: number): void => {
      const a = this.project(x, 0, z);
      const b = this.project(x, wh, z);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(230, 244, 255, 0.7)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const x of [-hw, -hw / 2, 0, hw / 2, hw]) post(x, 0);
    for (const z of [0, 4, 8, 12, 16, L]) {
      post(-hw, z);
      post(hw, z);
    }

    // Reflejo diagonal en el cristal de fondo
    const rTop = this.project(-hw * 0.55, wh, 0);
    const rBot = this.project(-hw * 0.15, 0.3, 0);
    const gGlass = ctx.createLinearGradient(rTop.x, rTop.y, rBot.x, rBot.y);
    gGlass.addColorStop(0, 'rgba(255,255,255,0.11)');
    gGlass.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = gGlass;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(rTop.x, rTop.y);
    ctx.lineTo(rBot.x, rBot.y);
    ctx.stroke();

    // Líneas con halo (doble trazo)
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    this.groundLine(-hw, 0.05, hw, 0.05, 6);
    this.groundLine(-hw, L - 0.05, hw, L - 0.05, 6);
    this.groundLine(-hw, COURT.serviceLineCpu, hw, COURT.serviceLineCpu, 5);
    this.groundLine(-hw, COURT.serviceLinePlayer, hw, COURT.serviceLinePlayer, 5);
    this.groundLine(0, COURT.serviceLineCpu, 0, COURT.serviceLinePlayer, 5);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    this.groundLine(-hw, 0.05, hw, 0.05, 3);
    this.groundLine(-hw, L - 0.05, hw, L - 0.05, 3);
    this.groundLine(-hw, COURT.serviceLineCpu, hw, COURT.serviceLineCpu, 2);
    this.groundLine(-hw, COURT.serviceLinePlayer, hw, COURT.serviceLinePlayer, 2);
    this.groundLine(0, COURT.serviceLineCpu, 0, COURT.serviceLinePlayer, 2);

    // Perspectiva aérea: una capa de bruma fría difumina el fondo
    const fogBottom = this.project(0, 0, COURT.netZ - 1).y;
    const gFog = ctx.createLinearGradient(0, this.horizonY - this.H * 0.04, 0, fogBottom);
    gFog.addColorStop(0, 'rgba(125, 170, 220, 0.14)');
    gFog.addColorStop(1, 'rgba(125, 170, 220, 0)');
    ctx.fillStyle = gFog;
    ctx.fillRect(0, this.horizonY - this.H * 0.04, this.W, fogBottom - this.horizonY + this.H * 0.04);

    // Zonas objetivo de los desafíos, con pulso sutil
    if (this.targetZones.length > 0) {
      const pulse = 0.13 + Math.sin(now / 300) * 0.05;
      for (const z of this.targetZones) {
        this.groundPoly([
          [z.x0, z.z0],
          [z.x1, z.z0],
          [z.x1, z.z1],
          [z.x0, z.z1],
        ]);
        ctx.fillStyle = `rgba(52, 211, 153, ${pulse.toFixed(3)})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }

  /** Valla LED en lo alto del cristal de fondo, con marquesina. */
  private drawLedBoard(now: number): void {
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
    ctx.fillStyle = '#04090f';
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
    ctx.font = `bold ${Math.max(h * 0.55, 7).toFixed(1)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    const msg = 'PÁDEL CAM  ●  JUEGA CON TU CUERPO  ●  ';
    const mw = Math.max(ctx.measureText(msg).width, 40);
    const off = -((now / 1000) * w * 0.06) % mw;
    for (let x = tl.x + off - mw; x < br.x; x += mw) {
      ctx.fillText(msg, x, tl.y + h * 0.55);
    }
    ctx.restore();
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

    ctx.fillStyle = 'rgba(8, 20, 34, 0.5)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(bt.x, bt.y);
    ctx.lineTo(at.x, at.y);
    ctx.closePath();
    ctx.fill();

    // Retícula
    ctx.strokeStyle = 'rgba(220, 235, 250, 0.16)';
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

    // Banda superior con brillo y cinta central
    const gBand = ctx.createLinearGradient(at.x, at.y - 3, at.x, at.y + 3);
    gBand.addColorStop(0, '#ffffff');
    gBand.addColorStop(1, '#c7d4e2');
    ctx.strokeStyle = gBand;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(bt.x, bt.y);
    ctx.stroke();
    const cTop = this.project(0, nh, nz);
    const cBot = this.project(0, 0, nz);
    ctx.strokeStyle = 'rgba(244, 247, 251, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cTop.x, cTop.y);
    ctx.lineTo(cBot.x, cBot.y);
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

  // ==========================================================================
  // Pelota
  // ==========================================================================

  /** Marca de bote prevista: anticipa dónde caerá la bola (lectura moderna). */
  private drawLandingMarker(ball: Ball, now: number): void {
    if (!ball.active) return;
    const speed2 = ball.vel.x ** 2 + ball.vel.z ** 2;
    if (speed2 < 4 || ball.pos.y < 0.35) return;
    const land = ball.predictLanding();
    if (Math.abs(land.x) > COURT.halfWidth || land.z < 0 || land.z > COURT.length) return;
    const ctx = this.ctx;
    const p = this.project(land.x, 0, land.z);
    const r = Math.max(0.3 * p.s, 6);
    const pulse = 0.75 + Math.sin(now / 130) * 0.25;
    ctx.strokeStyle = `rgba(217, 224, 33, ${(0.35 * pulse).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(217, 224, 33, ${(0.10 * pulse).toFixed(3)})`;
    ctx.fill();
  }

  private drawBall(ball: Ball): void {
    const ctx = this.ctx;
    const pos = ball.pos;

    // Estela: cinta afilada que sigue la trayectoria
    const tr = ball.trail;
    if (tr.length >= 2) {
      for (let i = 1; i < tr.length; i++) {
        const a = this.project(tr[i - 1].x, tr[i - 1].y, tr[i - 1].z);
        const b = this.project(tr[i].x, tr[i].y, tr[i].z);
        const k = i / tr.length;
        ctx.strokeStyle = `rgba(217, 224, 33, ${(k * 0.30).toFixed(3)})`;
        ctx.lineWidth = Math.max(BALL_RADIUS * b.s * 1.5 * k, 1);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Sombra dinámica (más nítida cuanto más baja va la bola)
    const sh = this.project(pos.x, 0, pos.z);
    const shR = Math.max(BALL_RADIUS * sh.s, 2.5);
    const hFade = Math.max(0.16, 0.45 - pos.y * 0.09);
    const gSh = ctx.createRadialGradient(sh.x, sh.y, 0, sh.x, sh.y, shR * 1.6);
    gSh.addColorStop(0, `rgba(0, 4, 12, ${hFade.toFixed(3)})`);
    gSh.addColorStop(1, 'rgba(0, 4, 12, 0)');
    ctx.fillStyle = gSh;
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, shR * 1.6, shR * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();

    const p = this.project(pos.x, pos.y, pos.z);
    const r = Math.max(BALL_RADIUS * p.s * 1.6, 3.5);

    // Halo luminoso: la bola es lo más fácil de seguir
    const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 2.8);
    glow.addColorStop(0, 'rgba(230, 236, 60, 0.32)');
    glow.addColorStop(1, 'rgba(230, 236, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.8, 0, Math.PI * 2);
    ctx.fill();

    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r);
    g.addColorStop(0, '#fdfda0');
    g.addColorStop(0.7, '#e3ea25');
    g.addColorStop(1, '#c3ca16');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(r * 0.12, 0.7);
    ctx.beginPath();
    ctx.arc(p.x - r * 0.25, p.y, r * 0.82, -0.8, 0.8);
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
        const rr = (p.size + k * 0.55) * pr.s;
        ctx.strokeStyle = `rgba(${p.color}, ${(alpha * 0.5).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, rr, rr * 0.38, 0, 0, Math.PI * 2);
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
      ctx.arc(pr.x, pr.y, Math.max(p.size * pr.s, 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ==========================================================================
  // Avatares: silueta deportiva con postura atlética
  // ==========================================================================

  private drawAvatar(p: PlayerEntity, pal: Palette, facingCamera: boolean): void {
    const ctx = this.ctx;
    const base = this.project(p.x, 0, p.z);
    const s = base.s * 1.18; // presencia: más grandes que el mundo
    const cx = base.x;

    // Sombra suave
    const gSh = ctx.createRadialGradient(cx, base.y, 0, cx, base.y, 0.5 * s);
    gSh.addColorStop(0, 'rgba(0, 4, 12, 0.4)');
    gSh.addColorStop(1, 'rgba(0, 4, 12, 0)');
    ctx.fillStyle = gSh;
    ctx.beginPath();
    ctx.ellipse(cx, base.y, 0.5 * s, 0.16 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const legLen = 0.84 * s;
    const bodyH = 0.6 * s;
    const headR = 0.125 * s;
    // Postura atlética: rodillas siempre algo flexionadas
    const crouch = 0.05 * s;
    const hipY = base.y - legLen + crouch;
    const shY = hipY - bodyH;
    let lean = p.lean * (facingCamera ? -1 : 1);
    // Inclinación corporal dinámica durante el golpe: el cuerpo acompaña
    if (p.swingType !== null) {
      const swingDir =
        (p.swingType === 'backhand' || p.swingType === 'volleyBh' ? -1 : 1) *
        (facingCamera ? -1 : 1);
      lean += Math.sin(Math.min(p.swingT, 1) * Math.PI) * 0.15 * swingDir;
    }

    const stride = Math.sin(p.runPhase) * 0.2 * s * p.moveAmount;
    const kneeLift = Math.abs(Math.sin(p.runPhase)) * 0.08 * s * p.moveAmount;

    ctx.lineCap = 'round';

    // ---- Piernas: muslo + gemelo con calcetín y zapatilla ----
    const drawLeg = (side: -1 | 1, offset: number): void => {
      const hx = cx + side * 0.1 * s;
      const fx = cx + side * 0.17 * s + offset;
      const fy = base.y - Math.abs(offset) * 0.25;
      const kx = (hx + fx) / 2 + side * 0.045 * s;
      const ky = (hipY + fy) / 2 + kneeLift - 0.02 * s;
      // muslo (más grueso)
      ctx.strokeStyle = pal.skin;
      ctx.lineWidth = Math.max(0.125 * s, 3);
      ctx.beginPath();
      ctx.moveTo(hx, hipY + 0.08 * s);
      ctx.lineTo(kx, ky);
      ctx.stroke();
      // gemelo
      ctx.lineWidth = Math.max(0.09 * s, 2.4);
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(fx, fy - 0.1 * s);
      ctx.stroke();
      // calcetín
      ctx.strokeStyle = '#eef2f6';
      ctx.lineWidth = Math.max(0.085 * s, 2.2);
      ctx.beginPath();
      ctx.moveTo(fx, fy - 0.11 * s);
      ctx.lineTo(fx, fy - 0.045 * s);
      ctx.stroke();
      // zapatilla con suela
      ctx.fillStyle = '#f4f7fa';
      ctx.beginPath();
      ctx.ellipse(fx + side * 0.02 * s, fy - 0.03 * s, 0.115 * s, 0.05 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#28303c';
      ctx.beginPath();
      ctx.ellipse(fx + side * 0.02 * s, fy - 0.008 * s, 0.115 * s, 0.022 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    drawLeg(-1, stride);
    drawLeg(1, -stride);

    // ---- Pantalón corto deportivo ----
    ctx.fillStyle = pal.shorts;
    ctx.beginPath();
    ctx.moveTo(cx - 0.19 * s, hipY - 0.1 * s);
    ctx.lineTo(cx + 0.19 * s, hipY - 0.1 * s);
    ctx.lineTo(cx + 0.165 * s, hipY + 0.18 * s);
    ctx.lineTo(cx + 0.05 * s, hipY + 0.18 * s);
    ctx.lineTo(cx, hipY + 0.08 * s);
    ctx.lineTo(cx - 0.05 * s, hipY + 0.18 * s);
    ctx.lineTo(cx - 0.165 * s, hipY + 0.18 * s);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.translate(cx, hipY);
    ctx.rotate(lean);

    // ---- Torso atlético: hombros anchos, cintura estrecha ----
    const g = ctx.createLinearGradient(-0.22 * s, 0, 0.22 * s, 0);
    if (facingCamera) {
      g.addColorStop(0, pal.shirtDark);
      g.addColorStop(0.45, pal.shirt);
      g.addColorStop(1, pal.shirt);
    } else {
      g.addColorStop(0, pal.shirt);
      g.addColorStop(0.55, pal.shirt);
      g.addColorStop(1, pal.shirtDark);
    }
    ctx.fillStyle = g;
    // Volumen: sombra suave alrededor del torso para despegarlo de la pista
    ctx.shadowColor = 'rgba(2, 10, 24, 0.55)';
    ctx.shadowBlur = Math.max(0.07 * s, 3);
    ctx.beginPath();
    ctx.moveTo(-0.22 * s, -bodyH + 0.05 * s);
    ctx.quadraticCurveTo(-0.24 * s, -bodyH * 0.5, -0.15 * s, 0.02 * s);
    ctx.lineTo(0.15 * s, 0.02 * s);
    ctx.quadraticCurveTo(0.24 * s, -bodyH * 0.5, 0.22 * s, -bodyH + 0.05 * s);
    ctx.quadraticCurveTo(0, -bodyH - 0.05 * s, -0.22 * s, -bodyH + 0.05 * s);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // franja lateral de la equipación
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(0.028 * s, 1);
    ctx.beginPath();
    ctx.moveTo((facingCamera ? -1 : 1) * 0.19 * s, -bodyH + 0.1 * s);
    ctx.quadraticCurveTo((facingCamera ? -1 : 1) * 0.21 * s, -bodyH * 0.5, (facingCamera ? -1 : 1) * 0.13 * s, 0);
    ctx.stroke();

    // ---- Brazo libre ----
    const offSide = facingCamera ? 1 : -1;
    const armSway = -stride * 0.6;
    ctx.strokeStyle = pal.skin;
    ctx.lineWidth = Math.max(0.075 * s, 2);
    ctx.beginPath();
    ctx.moveTo(offSide * 0.19 * s, -bodyH + 0.1 * s);
    ctx.quadraticCurveTo(
      offSide * 0.28 * s,
      -bodyH * 0.5,
      offSide * 0.2 * s + armSway,
      -0.16 * s,
    );
    ctx.stroke();

    // ---- Cuello y cabeza ----
    ctx.strokeStyle = pal.skin;
    ctx.lineWidth = Math.max(0.07 * s, 2);
    ctx.beginPath();
    ctx.moveTo(0, -bodyH + 0.02 * s);
    ctx.lineTo(0, -bodyH - 0.05 * s);
    ctx.stroke();
    const headY = -bodyH - headR * 1.35;
    ctx.fillStyle = pal.skin;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
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
    ctx.strokeStyle = facingCamera ? '#f4f7fb' : '#ffd166';
    ctx.lineWidth = Math.max(headR * 0.22, 1.2);
    ctx.beginPath();
    ctx.arc(0, headY, headR * 0.98, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    if (facingCamera && s > 26) {
      ctx.fillStyle = '#1c222b';
      ctx.beginPath();
      ctx.arc(-headR * 0.32, headY + headR * 0.1, headR * 0.09, 0, Math.PI * 2);
      ctx.arc(headR * 0.32, headY + headR * 0.1, headR * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Brazo de la pala (hombro → codo → mano) ----
    const swinging = p.swingType !== null;
    let armAngle: number;
    if (swinging) {
      const t = p.swingT;
      if (p.swingType !== null && isOverheadShot(p.swingType)) {
        const range = p.swingType === 'bandeja' ? 0.85 : 1.1;
        armAngle = -Math.PI * 0.75 + t * Math.PI * range;
      } else {
        const dir = p.swingType === 'backhand' || p.swingType === 'volleyBh' ? -1 : 1;
        armAngle = dir * (-2.1 + t * 3.1);
      }
    } else {
      armAngle = 1.0 + armSway / Math.max(s, 1);
    }
    const armSide = facingCamera ? -1 : 1;
    const shoulder = { x: armSide * 0.19 * s, y: -bodyH + 0.1 * s };
    const armLen = 0.52 * s;
    const hand = {
      x: shoulder.x + Math.sin(armAngle) * armLen * armSide,
      y: shoulder.y + Math.cos(armAngle) * armLen * 0.75 + 0.06 * s,
    };
    const mid = { x: (shoulder.x + hand.x) / 2, y: (shoulder.y + hand.y) / 2 };
    const elbow = {
      x: mid.x + Math.cos(armAngle) * 0.09 * s * armSide,
      y: mid.y + Math.sin(armAngle) * 0.06 * s,
    };

    // Swoosh: arco de velocidad durante el golpe
    if (swinging && p.swingT > 0.12 && p.swingT < 0.62) {
      const k = (p.swingT - 0.12) / 0.5;
      const rArc = armLen * 1.15;
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.35 * (1 - k)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.05 * s, 2);
      ctx.beginPath();
      const a0 = armAngle - 0.9;
      ctx.arc(shoulder.x, shoulder.y + 0.06 * s, rArc, (armSide > 0 ? a0 : Math.PI - armAngle) - 0.3, (armSide > 0 ? armAngle : Math.PI - a0) + 0.1);
      ctx.stroke();
    }

    // Estela de la pala: posiciones fantasma del gesto (motion trail)
    if (swinging && p.swingT > 0.12 && p.swingT < 0.58) {
      const prevSign = p.swingType === 'backhand' || p.swingType === 'volleyBh' ? 1 : -1;
      for (const [dA, alpha] of [[0.42, 0.18], [0.82, 0.08]] as const) {
        const gA = armAngle + prevSign * dA;
        const gh = {
          x: shoulder.x + Math.sin(gA) * armLen * armSide,
          y: shoulder.y + Math.cos(gA) * armLen * 0.75 + 0.06 * s,
        };
        const gRA = gA * armSide;
        const gx = gh.x + Math.sin(gRA) * 0.18 * s;
        const gy = gh.y + Math.cos(gRA) * 0.18 * s * 0.8;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.ellipse(gx, gy, 0.13 * s, 0.165 * s, gRA, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    ctx.strokeStyle = pal.skin;
    ctx.lineWidth = Math.max(0.085 * s, 2.2);
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.quadraticCurveTo(elbow.x, elbow.y, hand.x, hand.y);
    ctx.stroke();
    // muñequera
    ctx.strokeStyle = '#f4f7fb';
    ctx.lineWidth = Math.max(0.055 * s, 1.6);
    ctx.beginPath();
    ctx.moveTo(hand.x - 0.03 * s, hand.y - 0.02 * s);
    ctx.lineTo(hand.x + 0.03 * s, hand.y + 0.02 * s);
    ctx.stroke();

    // ---- Pala: más grande, con marco y corazón ----
    const rackAngle = armAngle * armSide;
    const rackLen = 0.18 * s;
    const rackCx = hand.x + Math.sin(rackAngle) * rackLen;
    const rackCy = hand.y + Math.cos(rackAngle) * rackLen * 0.8;
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = Math.max(0.05 * s, 1.6);
    ctx.beginPath();
    ctx.moveTo(hand.x, hand.y);
    ctx.lineTo(rackCx, rackCy);
    ctx.stroke();
    // marco
    ctx.fillStyle = swinging ? '#ffd166' : '#1d2530';
    ctx.beginPath();
    ctx.ellipse(rackCx, rackCy, 0.15 * s, 0.185 * s, rackAngle, 0, Math.PI * 2);
    ctx.fill();
    // cara
    const gR = ctx.createLinearGradient(rackCx - 0.1 * s, rackCy - 0.1 * s, rackCx + 0.1 * s, rackCy + 0.1 * s);
    if (swinging) {
      gR.addColorStop(0, '#ffe9b0');
      gR.addColorStop(1, '#ffc94d');
    } else {
      gR.addColorStop(0, '#e07a3f');
      gR.addColorStop(1, '#b8541e');
    }
    ctx.fillStyle = gR;
    ctx.beginPath();
    ctx.ellipse(rackCx, rackCy, 0.113 * s, 0.148 * s, rackAngle, 0, Math.PI * 2);
    ctx.fill();
    if (s > 30) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      for (const [ox, oy] of [[0, 0], [-0.045, -0.055], [0.045, -0.055], [-0.045, 0.055], [0.045, 0.055], [0, -0.09], [0, 0.09]]) {
        ctx.beginPath();
        ctx.arc(rackCx + ox * s, rackCy + oy * s, 0.013 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // brillo del golpe en la pala
    if (swinging && p.swingT < 0.5) {
      const gl = ctx.createRadialGradient(rackCx, rackCy, 0.05 * s, rackCx, rackCy, 0.32 * s);
      gl.addColorStop(0, 'rgba(255, 230, 150, 0.4)');
      gl.addColorStop(1, 'rgba(255, 230, 150, 0)');
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.arc(rackCx, rackCy, 0.32 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
