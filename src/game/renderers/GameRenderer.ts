import type { Ball } from '../ball';
import type { PlayerEntity } from '../player';
import type { Palette } from '../render';
import type { Vec3 } from '../../types';

/**
 * Contrato mínimo que necesita cualquier renderer (canvas 2D, Three.js, o
 * futuros) para conectarse al juego real. El gameplay (match.ts,
 * practice.ts, challenges.ts, guest.ts) solo conoce esta interfaz, nunca la
 * clase concreta — así se puede cambiar de renderer sin tocar ninguna
 * lógica de juego.
 */
export interface GameRenderer {
  /** Camiseta del rival: los rivales del torneo tienen su propio color. */
  cpuPalette: Palette;
  /** Aspecto del jugador humano: lo fija su perfil local. */
  playerPalette: Palette;
  /** Zonas objetivo de los desafíos, dibujadas sobre la pista. */
  targetZones: Array<{ x0: number; x1: number; z0: number; z1: number }>;
  draw(ball: Ball, player: PlayerEntity, cpu: PlayerEntity, showBall: boolean): void;
  shake(mag: number): void;
  exciteCrowd(amount: number): void;
  burst(pos: Vec3, color: string, count?: number, speed?: number): void;
}
