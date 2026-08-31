import { LM } from '../camera/pose';
import type { PoseFrame } from '../camera/pose';
import { clamp } from '../types';
import type { ShotType } from '../types';

// Métricas de técnica calculadas SOLO con datos reales de la pose (2D).
// Todo se mide en "anchos de hombros" (bw) para ser independiente de la
// distancia a la cámara. Las coordenadas se trabajan en espejo (como un
// espejo de gimnasio: tu derecha queda a la derecha de la pantalla).

export interface Pt {
  x: number;
  y: number;
}

export type Level = 'good' | 'warn' | 'bad';

export interface PostureCheck {
  level: Level;
  /** Corrección corta y accionable (vacía si todo está bien). */
  cue: string;
}

export interface BodyState {
  visible: boolean;
  bw: number; // ancho de hombros en unidades normalizadas
  hipCenter: Pt;
  shoulderCenter: Pt;
  nose: Pt;
  wrists: { L: Pt | null; R: Pt | null }; // en espejo
  stance: PostureCheck; // separación de pies
  knees: PostureCheck; // flexión de rodillas
  ready: PostureCheck; // manos delante, a media altura
  balance: PostureCheck; // hombros nivelados
  /** Preparación del golpe: pala (muñeca) armada hacia el lado del golpe. */
  prepared: boolean;
}

const vis = (f: PoseFrame, i: number): boolean => (f.lm[i]?.visibility ?? 0) > 0.4;
const mir = (f: PoseFrame, i: number): Pt => ({ x: 1 - f.lm[i].x, y: f.lm[i].y });

function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (m === 0) return 180;
  return (Math.acos(clamp(dot / m, -1, 1)) * 180) / Math.PI;
}

/** Lado del cuerpo donde se golpea cada tipo (en espejo, +1 = derecha del jugador). */
export function shotSide(shot: ShotType): 1 | -1 {
  return shot === 'backhand' || shot === 'volleyBh' ? -1 : 1;
}

/**
 * Zona de impacto objetivo relativa al cuerpo (en espejo). El jugador debe
 * hacer pasar la muñeca por esta zona en el momento del golpe.
 *
 * `spread` (opcional, en anchos de hombros) es la variación por repetición
 * que sortea la sesión: `x` aleja la zona del cuerpo hacia el lado del golpe
 * (nunca la acerca) e `y` la sube o baja un poco. Así el punto de impacto no
 * queda pegado al cuerpo ni cae siempre en el mismo sitio, como en la pista.
 */
export function impactZone(
  shot: ShotType,
  body: BodyState,
  spread?: Pt,
): { c: Pt; r: number } {
  const bw = body.bw;
  const hc = body.hipCenter;
  const chestY = (body.shoulderCenter.y + hc.y) / 2;
  const headY = body.nose.y;
  const side = shotSide(shot);
  const sx = Math.max(spread?.x ?? 0, 0) * bw; // solo hacia fuera
  const sy = (spread?.y ?? 0) * bw;
  let c: Pt;
  switch (shot) {
    case 'volleyFh':
    case 'volleyBh':
      c = { x: hc.x + side * (1.15 * bw + sx), y: chestY + sy };
      break;
    case 'bandeja':
      c = { x: hc.x + 0.65 * bw + sx, y: headY - 0.35 * bw + sy };
      break;
    case 'vibora':
      c = { x: hc.x + 0.95 * bw + sx, y: headY - 0.25 * bw + sy };
      break;
    case 'smash':
      c = { x: hc.x + 0.3 * bw + sx * 0.6, y: headY - 0.85 * bw + sy };
      break;
    default: // derecha / revés
      c = { x: hc.x + side * (1.35 * bw + sx), y: hc.y - 0.15 * bw + sy };
  }
  return { c, r: 0.45 * bw };
}

/** Extrae el estado corporal y las comprobaciones de postura de un frame. */
export function readBody(frame: PoseFrame | null, shot: ShotType): BodyState | null {
  if (!frame) return null;
  const f = frame;
  if (!vis(f, LM.L_SHOULDER) || !vis(f, LM.R_SHOULDER) || !vis(f, LM.L_HIP) || !vis(f, LM.R_HIP)) {
    return null;
  }
  const ls = mir(f, LM.L_SHOULDER);
  const rs = mir(f, LM.R_SHOULDER);
  const lh = mir(f, LM.L_HIP);
  const rh = mir(f, LM.R_HIP);
  const bw = Math.max(Math.abs(ls.x - rs.x), 0.05);
  const hipCenter = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const shoulderCenter = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const nose = vis(f, LM.NOSE) ? mir(f, LM.NOSE) : { x: shoulderCenter.x, y: shoulderCenter.y - bw };

  const wL = vis(f, LM.L_WRIST) ? mir(f, LM.L_WRIST) : null;
  const wR = vis(f, LM.R_WRIST) ? mir(f, LM.R_WRIST) : null;

  // --- Separación de pies (si se ven los tobillos) ---
  let stance: PostureCheck = { level: 'good', cue: '' };
  if (vis(f, LM.L_ANKLE) && vis(f, LM.R_ANKLE)) {
    const spread = Math.abs(mir(f, LM.L_ANKLE).x - mir(f, LM.R_ANKLE).x) / bw;
    if (spread < 0.55) stance = { level: 'bad', cue: 'Separa los pies' };
    else if (spread < 0.75) stance = { level: 'warn', cue: 'Un poco más de base' };
  }

  // --- Flexión de rodillas (ángulo cadera-rodilla-tobillo) ---
  let knees: PostureCheck = { level: 'good', cue: '' };
  if (vis(f, LM.L_KNEE) && vis(f, LM.L_ANKLE) && vis(f, LM.R_KNEE) && vis(f, LM.R_ANKLE)) {
    const aL = angleDeg(lh, mir(f, LM.L_KNEE), mir(f, LM.L_ANKLE));
    const aR = angleDeg(rh, mir(f, LM.R_KNEE), mir(f, LM.R_ANKLE));
    const a = (aL + aR) / 2;
    if (a > 174) knees = { level: 'bad', cue: 'Flexiona las rodillas' };
    else if (a > 167) knees = { level: 'warn', cue: 'Flexiona un poco más' };
  }

  // --- Posición de espera: manos delante entre pecho y cadera ---
  let ready: PostureCheck = { level: 'warn', cue: 'Pala delante del cuerpo' };
  const anyWrist = wL ?? wR;
  if (anyWrist) {
    const inBand = anyWrist.y > shoulderCenter.y - 0.2 * bw && anyWrist.y < hipCenter.y + 0.6 * bw;
    ready = inBand
      ? { level: 'good', cue: '' }
      : anyWrist.y <= shoulderCenter.y - 0.2 * bw
        ? { level: 'warn', cue: 'Baja las manos a la cintura' }
        : { level: 'warn', cue: 'Sube las manos: pala delante' };
  }

  // --- Equilibrio: hombros nivelados ---
  const tilt = Math.abs(ls.y - rs.y) / bw;
  const balance: PostureCheck =
    tilt > 0.35
      ? { level: 'bad', cue: 'Nivela los hombros' }
      : tilt > 0.22
        ? { level: 'warn', cue: 'Cuida el equilibrio' }
        : { level: 'good', cue: '' };

  // --- Preparación: muñeca armada hacia el lado del golpe (o arriba en golpes altos) ---
  const side = shotSide(shot);
  const overheadShot = shot === 'smash' || shot === 'bandeja' || shot === 'vibora';
  let prepared = false;
  for (const w of [wL, wR]) {
    if (!w) continue;
    if (overheadShot) {
      if (w.y < shoulderCenter.y + 0.1 * bw) prepared = true;
    } else if ((w.x - hipCenter.x) * side > 0.55 * bw) {
      prepared = true;
    }
  }

  return {
    visible: true,
    bw,
    hipCenter,
    shoulderCenter,
    nose,
    wrists: { L: wL, R: wR },
    stance,
    knees,
    ready,
    balance,
    prepared,
  };
}

/** Peor comprobación de postura → una única corrección accionable. */
export function worstPostureCue(b: BodyState): PostureCheck {
  const checks = [b.knees, b.stance, b.ready, b.balance];
  const bad = checks.find((c) => c.level === 'bad');
  if (bad) return bad;
  const warn = checks.find((c) => c.level === 'warn');
  if (warn) return warn;
  return { level: 'good', cue: 'Postura lista' };
}
