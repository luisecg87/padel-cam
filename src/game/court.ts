import type { Side } from '../types';

// Pista de pádel en coordenadas de mundo (metros):
// x: -5..5 (ancho 10 m), z: 0 (fondo CPU) .. 20 (fondo jugador), y: altura.
export const COURT = {
  halfWidth: 5,
  length: 20,
  netZ: 10,
  netHeight: 0.92,
  wallHeight: 4,
  // La línea de saque está a 6.95 m de la red en cada lado.
  serviceLineCpu: 10 - 6.95, // z = 3.05
  serviceLinePlayer: 10 + 6.95, // z = 16.95
};

export function sideOfZ(z: number): Side {
  return z > COURT.netZ ? 'player' : 'cpu';
}

// Caja de saque válida para quien recibe: entre la red y su línea de saque,
// en la mitad diagonal (boxX: -1 => x en [-5,0], +1 => x en [0,5]).
export function inServiceBox(x: number, z: number, receiver: Side, boxX: -1 | 1): boolean {
  const zOk =
    receiver === 'cpu'
      ? z > COURT.serviceLineCpu && z < COURT.netZ
      : z > COURT.netZ && z < COURT.serviceLinePlayer;
  const xOk = boxX === 1 ? x >= 0 && x <= COURT.halfWidth : x <= 0 && x >= -COURT.halfWidth;
  return zOk && xOk;
}
