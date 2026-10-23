import { clamp, SHOT_NAMES } from '../types';
import type { DrillType, ShotType } from '../types';
import type { Report, Tip } from './coach';

// Historial de sesiones e informes del entrenador, guardado en localStorage
// para que las correcciones sobrevivan al cierre del navegador.

export type BiomechanicKey = 'knees' | 'prep' | 'stance' | 'timing';

/** Desglose de fallos por tipo de biomecánica en una sesión o acumulado. */
export interface BiomechanicsBreakdown {
  knees: number; // flexión de rodillas
  prep: number; // armado temprano de la pala
  stance: number; // separación de pies (base)
  timing: number; // sincronización con el impacto
}

export const BIOMECHANIC_LABELS: Record<BiomechanicKey, string> = {
  knees: 'Rodillas',
  prep: 'Armado',
  stance: 'Separación de pies',
  timing: 'Timing',
};

export interface SavedSession {
  date: number; // epoch ms
  mode: 'match' | 'practice';
  title: string;
  stats: Report['stats'];
  tips: Tip[];
  /** Puntuación de consistencia técnica de la sesión (0..100). */
  consistency?: number;
  /** Desglose de fallos por tipo de biomecánica registrados en la sesión. */
  biomechanics?: BiomechanicsBreakdown;
  /** Golpe entrenado en la sesión (si aplica). */
  shot?: ShotType;
}

export interface Correction {
  key: string;
  text: string; // texto de la última vez que apareció
  count: number; // en cuántas sesiones ha salido
  lastDate: number;
  /** ¿Apareció en la última sesión guardada? (aún pendiente de corregir) */
  active: boolean;
}

const KEY = 'padelcam.progress.v1';
const MAX_SESSIONS = 40;

export function loadSessions(): SavedSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as SavedSession[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Guarda una sesión al final del historial. Devuelve false si no se pudo persistir. */
export function saveSession(session: SavedSession): boolean {
  try {
    const sessions = loadSessions();
    sessions.push(session);
    while (sessions.length > MAX_SESSIONS) sessions.shift();
    localStorage.setItem(KEY, JSON.stringify(sessions));
    return true;
  } catch {
    return false;
  }
}

export function clearSessions(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

/**
 * Extrae la puntuación de consistencia (0..100) de una sesión guardada.
 * Soporta tanto el campo directo `consistency` como estadísticas guardadas ("Consistencia" / "Calidad media").
 */
export function extractSessionConsistency(s: SavedSession): number | null {
  if (typeof s.consistency === 'number' && !Number.isNaN(s.consistency)) {
    return clamp(Math.round(s.consistency), 0, 100);
  }
  for (const st of s.stats) {
    if (st.lbl === 'Consistencia' || st.lbl === 'Calidad media') {
      const n = Number.parseFloat(st.val.replace('%', '').trim());
      if (!Number.isNaN(n)) return clamp(Math.round(n), 0, 100);
    }
  }
  return null;
}

/**
 * Calcula la puntuación de consistencia técnica general (0 a 100) acumulada en el historial.
 * Pondera ligeramente más las sesiones recientes para reflejar la evolución real del jugador.
 */
export function calculateOverallConsistency(sessions: SavedSession[]): number {
  const scores: number[] = [];
  for (const s of sessions) {
    const c = extractSessionConsistency(s);
    if (c !== null) scores.push(c);
  }
  if (scores.length === 0) return 0;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < scores.length; i++) {
    const weight = 1 + (i / scores.length) * 0.5;
    weightedSum += scores[i] * weight;
    weightTotal += weight;
  }
  return clamp(Math.round(weightedSum / weightTotal), 0, 100);
}

/**
 * Acumula el desglose de fallos biomecánicos (rodillas, armado, separación de pies, timing)
 * a lo largo del historial y devuelve también el fallo dominante.
 */
export function aggregateBiomechanics(sessions: SavedSession[]): {
  breakdown: BiomechanicsBreakdown;
  dominantFault: BiomechanicKey | null;
  totalFaults: number;
} {
  const breakdown: BiomechanicsBreakdown = { knees: 0, prep: 0, stance: 0, timing: 0 };
  for (const s of sessions) {
    if (!s.biomechanics) continue;
    breakdown.knees += s.biomechanics.knees || 0;
    breakdown.prep += s.biomechanics.prep || 0;
    breakdown.stance += s.biomechanics.stance || 0;
    breakdown.timing += s.biomechanics.timing || 0;
  }
  const keys: BiomechanicKey[] = ['timing', 'prep', 'knees', 'stance'];
  let dominantFault: BiomechanicKey | null = null;
  let maxCount = 0;
  for (const k of keys) {
    if (breakdown[k] > maxCount) {
      maxCount = breakdown[k];
      dominantFault = k;
    }
  }
  const totalFaults = breakdown.knees + breakdown.prep + breakdown.stance + breakdown.timing;
  return { breakdown, dominantFault, totalFaults };
}

/**
 * Agrupa las correcciones (consejos de aviso) de todas las sesiones guardadas.
 * Una corrección repetida en varias sesiones es un patrón a trabajar.
 */
export function pendingCorrections(sessions: SavedSession[]): Correction[] {
  const map = new Map<string, Correction>();
  const lastDate = sessions.length ? sessions[sessions.length - 1].date : 0;
  for (const s of sessions) {
    for (const tip of s.tips) {
      if (!tip.warn) continue;
      const key = tip.id ?? tip.text;
      const entry = map.get(key);
      if (entry) {
        entry.count++;
        if (s.date >= entry.lastDate) {
          entry.lastDate = s.date;
          entry.text = tip.text;
        }
      } else {
        map.set(key, { key, text: tip.text, count: 1, lastDate: s.date, active: false });
      }
    }
  }
  for (const c of map.values()) c.active = c.lastDate === lastDate && lastDate > 0;
  return [...map.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.count - a.count || b.lastDate - a.lastDate,
  );
}

// ---------- Palmarés del torneo ----------

const TROPHY_KEY = 'padelcam.trophies.v1';

export function loadTrophies(): number {
  try {
    return Number(localStorage.getItem(TROPHY_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function addTrophy(): number {
  const n = loadTrophies() + 1;
  try {
    localStorage.setItem(TROPHY_KEY, String(n));
  } catch {
    /* almacenamiento no disponible */
  }
  return n;
}

// ---------- Progresión del jugador: XP y nivel ----------

const XP_KEY = 'padelcam.xp.v1';
const LEVEL_TITLES = ['Novato', 'Bronce', 'Plata', 'Oro', 'Platino', 'Leyenda'];

export interface XpInfo {
  xp: number;
  level: number; // 1..
  title: string;
  levelXp: number; // xp dentro del nivel actual
  levelSize: number; // xp necesaria para pasar de nivel
}

function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 120)) + 1;
}

function xpAtLevel(level: number): number {
  return (level - 1) * (level - 1) * 120;
}

export function getXp(): XpInfo {
  let xp = 0;
  try {
    xp = Number(localStorage.getItem(XP_KEY)) || 0;
  } catch {
    /* sin almacenamiento */
  }
  const level = levelFromXp(xp);
  const base = xpAtLevel(level);
  return {
    xp,
    level,
    title: LEVEL_TITLES[Math.min(Math.floor((level - 1) / 3), LEVEL_TITLES.length - 1)],
    levelXp: xp - base,
    levelSize: xpAtLevel(level + 1) - base,
  };
}

/** Suma XP y devuelve el estado (con aviso de subida de nivel). */
export function addXp(amount: number): XpInfo & { leveledUp: boolean } {
  const before = getXp();
  const xp = before.xp + Math.max(0, Math.round(amount));
  try {
    localStorage.setItem(XP_KEY, String(xp));
  } catch {
    /* sin almacenamiento */
  }
  const after = getXp();
  return { ...after, leveledUp: after.level > before.level };
}

// ---------- Récords de desafíos ----------

const CHALLENGE_KEY = 'padelcam.challenges.v1';

export interface ChallengeRecord {
  best: number;
  stars: number; // 0..3
}

export function loadChallengeRecords(): Record<string, ChallengeRecord> {
  try {
    const raw = localStorage.getItem(CHALLENGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ChallengeRecord>) : {};
  } catch {
    return {};
  }
}

/** Guarda si mejora; devuelve el récord vigente y si fue récord nuevo. */
export function saveChallengeResult(
  id: string,
  score: number,
  stars: number,
): { record: ChallengeRecord; isNewBest: boolean } {
  const all = loadChallengeRecords();
  const prev = all[id];
  const isNewBest = !prev || score > prev.best;
  const record: ChallengeRecord = {
    best: isNewBest ? score : prev.best,
    stars: Math.max(stars, prev?.stars ?? 0),
  };
  all[id] = record;
  try {
    localStorage.setItem(CHALLENGE_KEY, JSON.stringify(all));
  } catch {
    /* sin almacenamiento */
  }
  return { record, isNewBest };
}

// ---------- Racha y plan del día (bucle de retención) ----------

export interface ProgressSummary {
  totalSessions: number;
  streakDays: number; // días consecutivos entrenados (sigue viva si entrenaste ayer)
  trainedToday: boolean;
  /** Puntuación de consistencia técnica general (0 a 100) acumulada en el historial. */
  overallConsistency: number;
  /** Desglose acumulado de fallos biomecánicos en el historial. */
  biomechanics: BiomechanicsBreakdown;
  /** Fallo biomecánico dominante en el historial del jugador. */
  dominantFault: BiomechanicKey | null;
}

export function summarize(sessions: SavedSession[]): ProgressSummary {
  const days = new Set(sessions.map((s) => new Date(s.date).toDateString()));
  const d = new Date();
  const trainedToday = days.has(d.toDateString());
  if (!trainedToday) d.setDate(d.getDate() - 1);
  let streakDays = 0;
  while (days.has(d.toDateString())) {
    streakDays++;
    d.setDate(d.getDate() - 1);
  }
  const overallConsistency = calculateOverallConsistency(sessions);
  const { breakdown: biomechanics, dominantFault } = aggregateBiomechanics(sessions);
  return {
    totalSessions: sessions.length,
    streakDays,
    trainedToday,
    overallConsistency,
    biomechanics,
    dominantFault,
  };
}

export interface DrillSuggestion {
  drill: DrillType;
  reason: string;
}

export const SHOT_DRILL: Partial<Record<ShotType, DrillType>> = {
  forehand: 'forehand',
  backhand: 'backhand',
  volleyFh: 'volley',
  volleyBh: 'volley',
  bandeja: 'bandeja',
  vibora: 'vibora',
  smash: 'smash',
};

const KEY_DRILL: Record<string, DrillSuggestion> = {
  'timing-tarde': { drill: 'mixto', reason: 'Llegas tarde a la bola: afina el timing con golpes variados.' },
  'timing-pronto': { drill: 'mixto', reason: 'Golpeas antes de tiempo: afina el timing con golpes variados.' },
  'biomec-knees': { drill: 'bandeja', reason: 'Te falta flexión de rodillas: entrena bandeja y defensa baja flexionando piernas.' },
  'biomec-prep': { drill: 'forehand', reason: 'Armas la pala tarde: entrena la preparación temprana en tu derecha.' },
  'biomec-stance': { drill: 'volley', reason: 'Base de pies estrecha: entrena voleas manteniendo una postura ancha y estable.' },
  'preparacion': { drill: 'forehand', reason: 'Falta preparación previa al golpe: trabaja el armado temprano.' },
  'impacto-zona': { drill: 'forehand', reason: 'El punto de impacto se desvía: entrena la extensión del brazo en derecha.' },
  'llegar-bola': { drill: 'mixto', reason: 'Se te escapan bolas: trabaja el desplazamiento con golpes variados.' },
  'golpes-al-aire': { drill: 'mixto', reason: 'Demasiados golpes al aire: entrena la lectura de bola.' },
  'eleccion-golpe': { drill: 'mixto', reason: 'Confundes qué golpe toca: el drill mixto te obliga a leer cada bola.' },
  'subir-red': { drill: 'volley', reason: 'Juegas demasiado atrás: domina la volea para atreverte a subir.' },
  'juego-pared': { drill: 'mixto', reason: 'La pared te está costando puntos: entrena la lectura del rebote.' },
};

/** Elige el drill del día a partir de la corrección pendiente más repetida. */
export function suggestDrill(corrections: Correction[]): DrillSuggestion | null {
  for (const c of corrections) {
    if (!c.active) continue;
    if (c.key.startsWith('golpe-debil-')) {
      const shot = c.key.slice('golpe-debil-'.length) as ShotType;
      const drill = SHOT_DRILL[shot];
      if (drill) {
        return { drill, reason: `Tu ${SHOT_NAMES[shot]} falló mucho la última sesión: dale un drill.` };
      }
      continue;
    }
    const s = KEY_DRILL[c.key];
    if (s) return s;
  }
  return null;
}
