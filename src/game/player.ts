import { clamp } from '../types';
import type { Side, ShotType } from '../types';
import { COURT } from './court';

export const REACH_X = 1.7; // alcance lateral para golpear (m)
export const REACH_Z = 2.0; // alcance en profundidad (m)

export class PlayerEntity {
  side: Side;
  x = 0;
  z: number;
  speed = 6.5; // m/s
  // Mano dominante: puramente identidad/render (qué mano sostiene la pala).
  // No afecta física, IA ni clasificación de golpe (forehand/backhand se
  // sigue decidiendo por el lado geométrico de la bola). Fallback a diestro
  // hasta que exista un perfil de usuario que lo fije explícitamente.
  dominantHand: 'left' | 'right' = 'right';
  // Animación de golpe
  swingType: ShotType | null = null;
  swingT = 0; // 0..1
  // Animación de carrera (derivada del movimiento real)
  runPhase = 0;
  moveAmount = 0; // 0..1, cuánto se está moviendo
  lean = 0; // inclinación lateral al correr
  private prevX: number;
  private prevZ: number;

  constructor(side: Side) {
    this.side = side;
    this.z = side === 'player' ? 17.5 : 2.5;
    this.prevX = this.x;
    this.prevZ = this.z;
  }

  get baseZ(): number {
    return this.side === 'player' ? 17.5 : 2.5;
  }

  private velX = 0;
  private velZ = 0;

  /** Movimiento por teclado/táctil con aceleración suave (más precisión que el paso directo). */
  applyMoveInput(mx: number, mz: number, dt: number): void {
    const accel = 32; // m/s²
    const tvx = mx * this.speed;
    const tvz = mz * this.speed;
    this.velX += clamp(tvx - this.velX, -accel * dt, accel * dt);
    this.velZ += clamp(tvz - this.velZ, -accel * dt, accel * dt);
    this.x += this.velX * dt;
    this.z += this.velZ * dt;
    this.clampToCourt();
  }

  moveToward(targetX: number, targetZ: number, dt: number): void {
    const dx = targetX - this.x;
    const dz = targetZ - this.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.02) {
      const step = Math.min(this.speed * dt, d);
      this.x += (dx / d) * step;
      this.z += (dz / d) * step;
    }
    this.clampToCourt();
  }

  clampToCourt(): void {
    this.x = clamp(this.x, -COURT.halfWidth + 0.4, COURT.halfWidth - 0.4);
    if (this.side === 'player') {
      this.z = clamp(this.z, COURT.netZ + 1.2, COURT.length - 0.5);
    } else {
      this.z = clamp(this.z, 0.5, COURT.netZ - 1.2);
    }
  }

  startSwing(type: ShotType): void {
    this.swingType = type;
    this.swingT = 0;
  }

  update(dt: number): void {
    if (this.swingType !== null) {
      this.swingT += dt * 3.2;
      if (this.swingT >= 1) {
        this.swingType = null;
        this.swingT = 0;
      }
    }

    // Animación de carrera según el desplazamiento real de este frame
    if (dt > 0) {
      const dx = this.x - this.prevX;
      const dist = Math.hypot(dx, this.z - this.prevZ);
      const speed = dist / dt;
      const target = clamp(speed / 5, 0, 1);
      this.moveAmount += (target - this.moveAmount) * 0.18;
      if (this.moveAmount > 0.04) this.runPhase += dt * (5 + 11 * this.moveAmount);
      const leanTarget = clamp((dx / dt) * 0.06, -0.25, 0.25);
      this.lean += (leanTarget - this.lean) * 0.15;
    }
    this.prevX = this.x;
    this.prevZ = this.z;
  }
}
