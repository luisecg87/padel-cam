import type { ShotType } from '../types';

export interface TechniqueResult {
  shoulderOk: boolean;
  stepOk: boolean;
  tip: string | null;
}

// Golpes de fondo (derecha/revés/remate/saque): la técnica real pide girar
// los hombros para preparar el golpe. La volea es lo contrario: es un bloqueo
// corto y compacto, sin balanceo hacia atrás — girar de más ahí es un error.
const WANTS_ROTATION: Record<ShotType, boolean> = {
  serve: true,
  forehand: true,
  backhand: true,
  smash: true,
  volley: false,
};

const ROTATION_MIN = 0.35; // por debajo de esto, se considera que no preparó el golpe
const ROTATION_MAX_FOR_VOLLEY = 0.3; // por encima de esto, ya no es una volea compacta

export function evaluateTechnique(
  type: ShotType,
  shoulderTurn: number,
  stepped: boolean,
): TechniqueResult {
  const wantsRotation = WANTS_ROTATION[type];
  const shoulderOk = wantsRotation ? shoulderTurn >= ROTATION_MIN : shoulderTurn <= ROTATION_MAX_FOR_VOLLEY;
  const stepOk = stepped;

  let tip: string | null = null;
  if (!shoulderOk && !stepOk) {
    tip = wantsRotation
      ? '🔄🦵 Gira los hombros al preparar y da un paso hacia la bola'
      : '✋🦵 En la volea no eches el brazo atrás: bloquea corto y da un paso';
  } else if (!shoulderOk) {
    tip = wantsRotation
      ? '🔄 Prepara el golpe girando más los hombros'
      : '✋ Volea más compacta: no eches tanto el brazo hacia atrás';
  } else if (!stepOk) {
    tip = '🦵 Da un paso hacia la bola al golpear';
  }

  return { shoulderOk, stepOk, tip };
}
