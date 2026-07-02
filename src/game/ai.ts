import { Ball } from './ball';
import { COURT } from './court';
import { PlayerEntity, REACH_X, REACH_Z } from './player';
import { clamp } from '../types';
import type { Difficulty, ShotType } from '../types';

export interface AiParams {
  speed: number;
  missProb: number; // probabilidad de fallar del todo una devolución
  aimError: number; // metros de error medio al apuntar
  qualityBase: number;
}

export const AI_PARAMS: Record<Difficulty, AiParams> = {
  easy: { speed: 4.0, missProb: 0.3, aimError: 1.7, qualityBase: 0.6 },
  medium: { speed: 5.4, missProb: 0.16, aimError: 1.1, qualityBase: 0.72 },
  hard: { speed: 6.8, missProb: 0.06, aimError: 0.6, qualityBase: 0.85 },
};

export interface AiHooks {
  /** ¿Puede la CPU golpear ya? (reglas: no doble toque, dejar botar el saque…) */
  canHit(): boolean;
  /** Ejecuta el golpe de la CPU. */
  doHit(type: ShotType, aim: { x: number; z: number }, quality: number): void;
  /** Nº de botes desde el último golpe (para decidir volea). */
  bounceCount(): number;
}

export class CpuAi {
  entity: PlayerEntity;
  ball: Ball;
  params: AiParams;
  hooks: AiHooks;
  private missThisBall = false;
  private incoming = false;

  constructor(entity: PlayerEntity, ball: Ball, difficulty: Difficulty, hooks: AiHooks) {
    this.entity = entity;
    this.ball = ball;
    this.params = AI_PARAMS[difficulty];
    this.hooks = hooks;
    this.entity.speed = this.params.speed;
  }

  /** Llamar cuando empieza un punto nuevo. */
  resetPoint(): void {
    this.missThisBall = false;
    this.incoming = false;
  }

  update(dt: number): void {
    const b = this.ball;
    const e = this.entity;

    const headingToCpu = b.active && b.vel.z < -0.1 && b.pos.z < COURT.length;
    if (headingToCpu && !this.incoming) {
      this.incoming = true;
      this.missThisBall = Math.random() < this.params.missProb;
    }
    if (!headingToCpu && b.vel.z > 0.1) this.incoming = false;

    // Movimiento: ir hacia donde va a llegar la bola; si no, volver a la base.
    let targetX = 0;
    let targetZ = e.baseZ;
    if (b.active && headingToCpu) {
      const land = b.predictLanding();
      targetX = clamp(land.x, -COURT.halfWidth + 0.5, COURT.halfWidth - 0.5);
      targetZ = clamp(land.z + 0.6, 0.8, COURT.netZ - 1.3);
      if (this.missThisBall) targetX += 1.4; // llega "mal colocada" y falla
    }
    e.moveToward(targetX, targetZ, dt);

    // Decisión de golpe
    if (!b.active || this.missThisBall || !this.hooks.canHit()) return;
    if (b.pos.z > COURT.netZ - 0.2) return; // la bola aún no está en su lado
    const dx = Math.abs(b.pos.x - e.x);
    const dz = Math.abs(b.pos.z - e.z);
    if (dx < REACH_X * 0.9 && dz < REACH_Z * 0.9 && b.pos.y < 2.6) {
      const type = this.chooseShot();
      const aim = this.chooseAim();
      const quality = clamp(
        this.params.qualityBase + (Math.random() - 0.5) * 0.3 - dx * 0.08,
        0.2,
        0.98,
      );
      this.hooks.doHit(type, aim, quality);
    }
  }

  private chooseShot(): ShotType {
    const b = this.ball;
    if (b.pos.y > 1.7) {
      // Bola muy alta: remate. Media altura: bandeja (control) o víbora (agresiva).
      if (b.pos.y > 2.15) return 'smash';
      return Math.random() < 0.55 ? 'bandeja' : 'vibora';
    }
    // La CPU está de cara al jugador: su derecha queda en -x
    if (this.hooks.bounceCount() === 0) {
      return b.pos.x <= this.entity.x ? 'volleyFh' : 'volleyBh';
    }
    return b.pos.x <= this.entity.x ? 'forehand' : 'backhand';
  }

  private chooseAim(): { x: number; z: number } {
    const err = this.params.aimError;
    // Esquinas profundas del lado del jugador, con algo de variedad.
    const corner = Math.random();
    let x: number;
    if (corner < 0.4) x = -(1.8 + Math.random() * 2);
    else if (corner < 0.8) x = 1.8 + Math.random() * 2;
    else x = (Math.random() - 0.5) * 2;
    const z = 14 + Math.random() * 4.5;
    return {
      x: clamp(x + (Math.random() - 0.5) * err * 2, -4.6, 4.6),
      z: clamp(z + (Math.random() - 0.5) * err, COURT.netZ + 2, COURT.length - 0.6),
    };
  }
}
