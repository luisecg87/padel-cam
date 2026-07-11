import { GRAVITY, BALL_RADIUS } from './ball';
import { COURT } from './court';
import type { ShotType, Vec3 } from '../types';
import type { SwingEvent } from '../ui/input';

export interface ShotParams {
  speed: number; // velocidad horizontal m/s
  minNetClearance: number;
  spin: number; // curva lateral (m/s²) hacia el lado del golpe
}

export const SHOT_PARAMS: Record<ShotType, ShotParams> = {
  serve: { speed: 10.5, minNetClearance: 0.3, spin: 0 },
  forehand: { speed: 13.5, minNetClearance: 0.25, spin: 0 },
  backhand: { speed: 12.5, minNetClearance: 0.25, spin: 0 },
  volleyFh: { speed: 11.5, minNetClearance: 0.2, spin: 0 },
  volleyBh: { speed: 11, minNetClearance: 0.2, spin: 0 },
  bandeja: { speed: 9.5, minNetClearance: 0.35, spin: 0 },
  vibora: { speed: 15, minNetClearance: 0.1, spin: 3.5 },
  smash: { speed: 19, minNetClearance: 0.05, spin: 0 },
};

/**
 * Decide qué golpe sale según la situación de la bola y el gesto:
 * - Bola alta: víbora si el brazo cruza en diagonal, remate si es un gesto
 *   claramente por encima de la cabeza (o la bola está muy alta), bandeja si no.
 * - Sin bote y a media altura: volea (de derecha o revés según el lado).
 * - Con bote: derecha o revés según el lado.
 */
export function classifySwing(
  ballY: number,
  dx: number, // bola respecto al jugador (+ = a su derecha)
  bounceCount: number,
  swing: SwingEvent,
): ShotType {
  const high = ballY > 1.7 || (swing.overhead && ballY > 1.2);
  if (high) {
    if (swing.dir !== 0) return 'vibora';
    if (ballY > 2.1) return 'smash';
    if (swing.overhead && swing.power > 0.55) return 'smash';
    return 'bandeja';
  }
  if (bounceCount === 0) return dx >= 0 ? 'volleyFh' : 'volleyBh';
  return dx >= 0 ? 'forehand' : 'backhand';
}

/** Cota del multiplicador de velocidad por potencia del gesto (cámara). */
export const SPEED_MUL_MIN = 0.78;
export const SPEED_MUL_MAX = 1.18;

/**
 * Potencia del gesto real (0..1) → multiplicador de velocidad de bola,
 * acotado. ÚNICO sitio donde vive esta fórmula: partido, práctica y
 * desafíos deben usarla para que el mismo gesto pegue igual en todos.
 */
export function gestureSpeedMul(power: number): number {
  return Math.min(Math.max(0.85 + 0.35 * power, SPEED_MUL_MIN), SPEED_MUL_MAX);
}

/**
 * Calcula la velocidad inicial para que la bola aterrice en `target`,
 * elevando el arco lo necesario para pasar la red.
 * La calidad (0..1) desvía el objetivo: golpe a destiempo = bola imprecisa.
 */
export function computeShotVelocity(
  from: Vec3,
  target: { x: number; z: number },
  type: ShotType,
  quality: number,
): Vec3 {
  const params = SHOT_PARAMS[type];

  // Desviación por mala calidad de golpe + ruido base
  const dev = (1 - quality) * 2.8 + 0.35;
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * dev;
  const tx = target.x + Math.cos(ang) * r;
  const tz = target.z + Math.sin(ang) * r * 0.8;

  const dx = tx - from.x;
  const dz = tz - from.z;
  const dist = Math.hypot(dx, dz);
  let t = Math.max(dist / params.speed, 0.28);

  for (let i = 0; i < 5; i++) {
    const vx = dx / t;
    const vz = dz / t;
    const vy = (BALL_RADIUS - from.y) / t + 0.5 * GRAVITY * t;
    // ¿Pasa la red?
    if (Math.sign(from.z - COURT.netZ) !== Math.sign(tz - COURT.netZ) && vz !== 0) {
      const tNet = (COURT.netZ - from.z) / vz;
      if (tNet > 0 && tNet < t) {
        const yNet = from.y + vy * tNet - 0.5 * GRAVITY * tNet * tNet;
        if (yNet < COURT.netHeight + params.minNetClearance) {
          t *= 1.16; // arco más alto, mismo punto de aterrizaje
          continue;
        }
      }
    }
    return { x: vx, y: vy, z: vz };
  }
  const vx = dx / t;
  const vz = dz / t;
  const vy = (BALL_RADIUS - from.y) / t + 0.5 * GRAVITY * t;
  return { x: vx, y: vy, z: vz };
}
