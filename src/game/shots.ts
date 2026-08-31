import { GRAVITY, BALL_RADIUS } from './ball';
import { COURT } from './court';
import { clamp } from '../types';
import type { ShotType, Vec3 } from '../types';

// Rango de velocidad real según qué tan fuerte fue el swing (power 0..1):
// un golpe flojo no se queda a la misma velocidad que uno a fondo.
const MIN_POWER_FACTOR = 0.75;
const MAX_POWER_FACTOR = 1.2;

export interface ShotParams {
  speed: number; // velocidad horizontal m/s
  minNetClearance: number;
}

export const SHOT_PARAMS: Record<ShotType, ShotParams> = {
  serve: { speed: 10.5, minNetClearance: 0.3 },
  forehand: { speed: 13.5, minNetClearance: 0.25 },
  backhand: { speed: 12.5, minNetClearance: 0.25 },
  volley: { speed: 11.5, minNetClearance: 0.2 },
  smash: { speed: 19, minNetClearance: 0.05 },
};

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
  power = 1,
): Vec3 {
  const params = SHOT_PARAMS[type];
  const speed = params.speed * (MIN_POWER_FACTOR + (MAX_POWER_FACTOR - MIN_POWER_FACTOR) * clamp(power, 0, 1));

  // Desviación por mala calidad de golpe + ruido base
  const dev = (1 - quality) * 2.8 + 0.35;
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * dev;
  const tx = target.x + Math.cos(ang) * r;
  const tz = target.z + Math.sin(ang) * r * 0.8;

  const dx = tx - from.x;
  const dz = tz - from.z;
  const dist = Math.hypot(dx, dz);
  let t = Math.max(dist / speed, 0.28);

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
