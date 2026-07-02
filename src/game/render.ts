import { Ball, BALL_RADIUS } from './ball';
import { COURT } from './court';
import { PlayerEntity } from './player';
import type { Vec3 } from '../types';

// Cámara detrás del jugador (z alto), mirando hacia la pista de la CPU (z bajo).
const CAM_Z = 26;
const CAM_H = 4.8;

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  private f = 500;
  private horizonY = 0;

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

  draw(ball: Ball, player: PlayerEntity, cpu: PlayerEntity, showBall: boolean): void {
    const ctx = this.ctx;
    this.drawBackground();
    this.drawCourt();
    this.drawAvatar(cpu, '#e76f51', '#ffd7c2', true);
    if (showBall && ball.pos.z <= COURT.netZ) this.drawBall(ball.pos);
    this.drawNet();
    if (showBall && ball.pos.z > COURT.netZ) this.drawBall(ball.pos);
    this.drawAvatar(player, '#2a9d8f', '#bfeee8', false);
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#0a1c30');
    g.addColorStop(0.35, '#14385e');
    g.addColorStop(1, '#0d2740');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
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

    // Líneas de la pista
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
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

  private drawBall(pos: Vec3): void {
    const ctx = this.ctx;
    // Sombra en el suelo (clave para leer la profundidad)
    const sh = this.project(pos.x, 0, pos.z);
    const shR = Math.max(BALL_RADIUS * sh.s, 2.5);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, shR * 1.15, shR * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const p = this.project(pos.x, pos.y, pos.z);
    const r = Math.max(BALL_RADIUS * p.s * 1.6, 3);
    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r);
    g.addColorStop(0, '#fdfb8f');
    g.addColorStop(1, '#d9e021');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawAvatar(p: PlayerEntity, color: string, skin: string, facingCamera: boolean): void {
    const ctx = this.ctx;
    const base = this.project(p.x, 0, p.z);
    const s = base.s; // píxeles por metro

    // Sombra
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(base.x, base.y, 0.45 * s, 0.14 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const legH = 0.85 * s;
    const bodyH = 0.65 * s;
    const headR = 0.16 * s;
    const hipY = base.y - legH;
    const shoulderY = hipY - bodyH;

    // Piernas
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.09 * s, 2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base.x - 0.14 * s, base.y);
    ctx.lineTo(base.x - 0.06 * s, hipY);
    ctx.moveTo(base.x + 0.14 * s, base.y);
    ctx.lineTo(base.x + 0.06 * s, hipY);
    ctx.stroke();

    // Torso
    ctx.lineWidth = Math.max(0.3 * s, 4);
    ctx.beginPath();
    ctx.moveTo(base.x, hipY);
    ctx.lineTo(base.x, shoulderY + 0.05 * s);
    ctx.stroke();

    // Cabeza
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(base.x, shoulderY - headR * 1.2, headR, 0, Math.PI * 2);
    ctx.fill();

    // Brazo con pala (animado durante el swing)
    const swinging = p.swingType !== null;
    let armAngle: number;
    if (swinging) {
      // Barrido de -140° a 40° (o remate de arriba abajo)
      const t = p.swingT;
      if (p.swingType === 'smash') {
        armAngle = -Math.PI / 2 + t * Math.PI * 0.9;
      } else {
        const dir = p.swingType === 'backhand' ? -1 : 1;
        armAngle = dir * (-2.2 + t * 3.2);
      }
    } else {
      armAngle = 0.9; // pala preparada abajo
    }
    const armLen = 0.55 * s;
    const ax = base.x + Math.sin(armAngle) * armLen * (facingCamera ? -1 : 1);
    const ay = shoulderY + Math.cos(armAngle) * armLen * 0.6 + 0.1 * s;

    ctx.strokeStyle = skin;
    ctx.lineWidth = Math.max(0.08 * s, 2);
    ctx.beginPath();
    ctx.moveTo(base.x + (facingCamera ? -0.12 : 0.12) * s, shoulderY + 0.08 * s);
    ctx.lineTo(ax, ay);
    ctx.stroke();

    // Pala
    ctx.fillStyle = swinging ? '#ffd166' : '#c8551b';
    ctx.beginPath();
    ctx.ellipse(ax, ay, 0.13 * s, 0.17 * s, armAngle, 0, Math.PI * 2);
    ctx.fill();
  }
}
