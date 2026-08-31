import { COURT } from './court';
import type { Vec3 } from '../types';

export const GRAVITY = 9.8;
export const BALL_RADIUS = 0.12;

export interface BallCallbacks {
  onGround?(pos: Vec3): void;
  onWall?(pos: Vec3): void;
  onNet?(): void;
  onOut?(pos: Vec3): void;
}

export class Ball {
  pos: Vec3 = { x: 0, y: 1, z: 15 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  spin = 0; // aceleración lateral (víbora): curva la bola en el aire
  active = false; // si la física está corriendo (false = bola en mano / punto terminado)
  trail: Vec3[] = []; // últimas posiciones, para la estela
  callbacks: BallCallbacks = {};

  reset(pos: Vec3): void {
    this.pos = { ...pos };
    this.vel = { x: 0, y: 0, z: 0 };
    this.spin = 0;
    this.active = false;
    this.trail.length = 0;
  }

  launch(pos: Vec3, vel: Vec3): void {
    this.pos = { ...pos };
    this.vel = { ...vel };
    this.spin = 0;
    this.active = true;
    this.trail.length = 0;
  }

  /** Predice el punto de aterrizaje (ignora paredes). */
  predictLanding(): Vec3 {
    const { pos, vel } = this;
    const h = Math.max(pos.y - BALL_RADIUS, 0);
    const disc = vel.y * vel.y + 2 * GRAVITY * h;
    const t = (vel.y + Math.sqrt(Math.max(disc, 0))) / GRAVITY;
    return { x: pos.x + vel.x * t, y: BALL_RADIUS, z: pos.z + vel.z * t };
  }

  update(dt: number): void {
    if (!this.active) return;
    this.trail.push({ ...this.pos });
    if (this.trail.length > 9) this.trail.shift();
    const prev = { ...this.pos };

    this.vel.y -= GRAVITY * dt;
    this.vel.x += this.spin * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // Red: ¿cruzó el plano z = netZ por debajo de la altura de la red?
    const dPrev = prev.z - COURT.netZ;
    const dNow = this.pos.z - COURT.netZ;
    if (dPrev !== 0 && Math.sign(dPrev) !== Math.sign(dNow)) {
      const t = Math.abs(dPrev) / (Math.abs(dPrev) + Math.abs(dNow));
      const yAtNet = prev.y + (this.pos.y - prev.y) * t;
      if (yAtNet < COURT.netHeight + BALL_RADIUS) {
        // Golpea la red: la bola cae muerta del lado del que golpeó.
        this.pos.z = COURT.netZ + Math.sign(dPrev) * 0.25;
        this.pos.y = Math.min(yAtNet, COURT.netHeight);
        this.vel = { x: 0, y: -1, z: Math.sign(dPrev) * 0.5 };
        this.callbacks.onNet?.();
        return;
      }
    }

    // Suelo
    if (this.pos.y <= BALL_RADIUS && this.vel.y < 0) {
      this.pos.y = BALL_RADIUS;
      this.vel.y = -this.vel.y * 0.72;
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
      // La víbora "escupe" hacia el lado en el bote y pierde parte del efecto
      this.vel.x += this.spin * 0.25;
      this.spin *= 0.45;
      if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0;
      this.callbacks.onGround?.({ ...this.pos });
    }

    // Paredes laterales (cristal hasta wallHeight)
    const maxX = COURT.halfWidth - BALL_RADIUS;
    if (Math.abs(this.pos.x) > maxX) {
      if (this.pos.y < COURT.wallHeight) {
        this.pos.x = Math.sign(this.pos.x) * maxX;
        this.vel.x = -this.vel.x * 0.7;
        this.spin = -this.spin * 0.5;
        this.callbacks.onWall?.({ ...this.pos });
      } else {
        this.active = false;
        this.callbacks.onOut?.({ ...this.pos });
        return;
      }
    }

    // Paredes de fondo
    if (this.pos.z < BALL_RADIUS || this.pos.z > COURT.length - BALL_RADIUS) {
      if (this.pos.y < COURT.wallHeight) {
        this.pos.z = this.pos.z < BALL_RADIUS ? BALL_RADIUS : COURT.length - BALL_RADIUS;
        this.vel.z = -this.vel.z * 0.7;
        this.callbacks.onWall?.({ ...this.pos });
      } else {
        this.active = false;
        this.callbacks.onOut?.({ ...this.pos });
        return;
      }
    }

    // Bola muerta (casi parada en el suelo)
    const speed2 = this.vel.x ** 2 + this.vel.y ** 2 + this.vel.z ** 2;
    if (this.pos.y <= BALL_RADIUS + 0.01 && speed2 < 0.15) {
      this.active = false;
      this.callbacks.onGround?.({ ...this.pos });
    }
  }
}
