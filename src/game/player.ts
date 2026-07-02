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
  // Animación de golpe
  swingType: ShotType | null = null;
  swingT = 0; // 0..1

  constructor(side: Side) {
    this.side = side;
    this.z = side === 'player' ? 17.5 : 2.5;
  }

  get baseZ(): number {
    return this.side === 'player' ? 17.5 : 2.5;
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
  }
}
