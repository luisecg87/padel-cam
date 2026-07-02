export type Side = 'player' | 'cpu';
export type ShotType =
  | 'serve'
  | 'forehand'
  | 'backhand'
  | 'volleyFh'
  | 'volleyBh'
  | 'bandeja'
  | 'vibora'
  | 'smash';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type ControlMode = 'camera' | 'keyboard';
export type DrillType =
  | 'mixto'
  | 'forehand'
  | 'backhand'
  | 'volley'
  | 'bandeja'
  | 'vibora'
  | 'smash';

/** Golpes que se ejecutan por encima de la cabeza. */
export function isOverheadShot(t: ShotType): boolean {
  return t === 'smash' || t === 'bandeja' || t === 'vibora';
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const SHOT_NAMES: Record<ShotType, string> = {
  serve: 'saque',
  forehand: 'derecha',
  backhand: 'revés',
  volleyFh: 'volea de derecha',
  volleyBh: 'volea de revés',
  bandeja: 'bandeja',
  vibora: 'víbora',
  smash: 'remate',
};

export const SHOT_ARTICLES: Record<ShotType, 'el' | 'la'> = {
  serve: 'el',
  forehand: 'la',
  backhand: 'el',
  volleyFh: 'la',
  volleyBh: 'la',
  bandeja: 'la',
  vibora: 'la',
  smash: 'el',
};

export function opponent(s: Side): Side {
  return s === 'player' ? 'cpu' : 'player';
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
