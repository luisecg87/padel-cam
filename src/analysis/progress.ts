import type { Report, Tip } from './coach';

// Historial de sesiones e informes del entrenador, guardado en localStorage
// para que las correcciones sobrevivan al cierre del navegador.

export interface SavedSession {
  date: number; // epoch ms
  mode: 'match' | 'practice';
  title: string;
  stats: Report['stats'];
  tips: Tip[];
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
