import { MatchLogger } from './logger';
import { SHOT_ARTICLES, SHOT_NAMES } from '../types';
import type { ShotType } from '../types';

export interface StatCard {
  lbl: string;
  val: string;
}

export interface Tip {
  text: string;
  warn: boolean;
}

export interface Report {
  stats: StatCard[];
  tips: Tip[];
}

const NET_ZONE_Z = 14.5; // jugador por delante de esta z = "en la red"

/** Analiza el registro del partido y genera estadísticas + consejos para el jugador. */
export function analyzeMatch(log: MatchLogger): Report {
  const points = log.points;
  const total = points.length;
  const won = points.filter((p) => p.winner === 'player').length;

  const playerShots = points.flatMap((p) => p.shots.filter((s) => s.by === 'player'));
  const winners = playerShots.filter((s) => s.result === 'winner').length;
  const errors = playerShots.filter((s) => s.result === 'error').length;

  // Errores y uso por tipo de golpe
  const byType = new Map<ShotType, { n: number; errors: number; quality: number; late: number }>();
  for (const s of playerShots) {
    const e = byType.get(s.type) ?? { n: 0, errors: 0, quality: 0, late: 0 };
    e.n++;
    e.quality += s.quality;
    if (s.result === 'error') e.errors++;
    if (s.timing > 0.45) e.late++;
    byType.set(s.type, e);
  }

  const lateShots = playerShots.filter((s) => s.timing > 0.45).length;
  const lateFrac = playerShots.length ? lateShots / playerShots.length : 0;

  // Técnica corporal: solo hay datos si se jugó con cámara (con teclado quedan undefined).
  const withTechnique = playerShots.filter((s) => s.shoulderOk !== undefined);
  const shoulderBad = withTechnique.filter((s) => !s.shoulderOk).length;
  const stepBad = withTechnique.filter((s) => !s.stepOk).length;

  // Puntos en la red: el jugador golpeó al menos una vez adelantado
  const netPoints = points.filter((p) =>
    p.shots.some((s) => s.by === 'player' && s.z < NET_ZONE_Z),
  );
  const netWon = netPoints.filter((p) => p.winner === 'player').length;

  const doubleFaults = points.filter(
    (p) => p.server === 'player' && p.reason === 'doble falta',
  ).length;

  const wallErrors = playerShots.filter((s) => s.afterWall && s.result === 'error').length;

  const avgRally = total
    ? points.reduce((acc, p) => acc + p.shots.length, 0) / total
    : 0;

  const stats: StatCard[] = [
    { lbl: 'Puntos ganados', val: `${won} / ${total}` },
    { lbl: 'Winners', val: `${winners}` },
    { lbl: 'Errores no forzados', val: `${errors}` },
    { lbl: 'Golpes al aire', val: `${log.whiffs}` },
    { lbl: 'Puntos en la red', val: netPoints.length ? `${netWon} / ${netPoints.length}` : '0' },
    { lbl: 'Dobles faltas', val: `${doubleFaults}` },
    { lbl: 'Golpes por punto', val: avgRally.toFixed(1) },
  ];
  if (withTechnique.length > 0) {
    const techOk = withTechnique.filter((s) => s.shoulderOk && s.stepOk).length;
    stats.push({ lbl: 'Técnica correcta', val: `${Math.round((techOk / withTechnique.length) * 100)}%` });
  }

  const tips: Tip[] = [];

  if (lateFrac > 0.4 && lateShots >= 3) {
    tips.push({
      warn: true,
      text: `Llegaste tarde al ${Math.round(lateFrac * 100)}% de tus golpes. Prepara la pala en cuanto la bola cruce la red y da un paso hacia ella, no la esperes.`,
    });
  }

  // Golpe más débil
  let worst: { type: ShotType; errRate: number; n: number } | null = null;
  for (const [type, e] of byType) {
    if (e.n >= 3) {
      const errRate = e.errors / e.n;
      if (errRate > 0.4 && (!worst || errRate > worst.errRate)) {
        worst = { type, errRate, n: e.n };
      }
    }
  }
  if (worst) {
    tips.push({
      warn: true,
      text: `Tu ${SHOT_NAMES[worst.type]} falló el ${Math.round(worst.errRate * 100)}% de las veces. Entrénalo en el Modo Práctica eligiendo ese golpe.`,
    });
  }

  if (netPoints.length >= 3 && netWon / netPoints.length >= 0.6) {
    tips.push({
      warn: false,
      text: `Ganaste el ${Math.round((netWon / netPoints.length) * 100)}% de los puntos cuando subiste a la red. ¡Sube más! En pádel los puntos se ganan en la volea.`,
    });
  } else if (total >= 8 && netPoints.length <= Math.max(1, total * 0.15)) {
    tips.push({
      warn: true,
      text: 'Casi no subiste a la red: jugaste casi todo desde el fondo. Tras un golpe profundo, avanza hacia la red para cerrar el punto.',
    });
  }

  if (withTechnique.length >= 4 && shoulderBad / withTechnique.length >= 0.4) {
    tips.push({
      warn: true,
      text: `En ${shoulderBad} de tus golpes no preparaste bien el giro de hombros (o, en la volea, echaste demasiado el brazo atrás). Entra al Modo Práctica para trabajar la postura.`,
    });
  }
  if (withTechnique.length >= 4 && stepBad / withTechnique.length >= 0.4) {
    tips.push({
      warn: true,
      text: `En ${stepBad} de tus golpes no diste un paso real hacia la bola: estás golpeando solo con el brazo, sin cargar el peso del cuerpo.`,
    });
  }

  if (doubleFaults >= 2) {
    tips.push({
      warn: true,
      text: `Cometiste ${doubleFaults} dobles faltas. En el segundo saque no busques la esquina: apunta al centro de la caja y asegura.`,
    });
  }

  if (log.whiffs >= 3) {
    tips.push({
      warn: true,
      text: `Diste ${log.whiffs} golpes al aire. Mira la bola hasta el final y golpea cuando esté a la altura de tu cadera, ni antes ni después.`,
    });
  }

  if (wallErrors >= 2) {
    tips.push({
      warn: true,
      text: 'La pared te costó puntos: no golpees la bola pegada al cristal. Deja que salga de la pared y golpéala cuando se separe.',
    });
  }

  // Refuerzo positivo: su mejor golpe
  let best: { type: ShotType; q: number } | null = null;
  for (const [type, e] of byType) {
    if (type !== 'serve' && e.n >= 3) {
      const q = e.quality / e.n - (e.errors / e.n) * 0.5;
      if (!best || q > best.q) best = { type, q };
    }
  }
  if (best && tips.length < 5) {
    tips.push({
      warn: false,
      text: `Tu mejor golpe fue ${SHOT_ARTICLES[best.type]} ${SHOT_NAMES[best.type]}: úsalo como arma para construir los puntos.`,
    });
  }

  if (tips.length === 0) {
    tips.push({
      warn: false,
      text: won > total / 2
        ? '¡Partido muy sólido! Sigue así y prueba una dificultad mayor.'
        : 'Buen partido. Juega unos drills en el Modo Práctica para afinar el timing de tus golpes.',
    });
  }

  return { stats, tips: tips.slice(0, 5) };
}
