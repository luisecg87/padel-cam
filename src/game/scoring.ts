import type { Side } from '../types';

const POINT_LABELS = ['0', '15', '30', '40'];

/**
 * Puntuación de pádel: 15/30/40 con punto de oro en 40-40
 * (en 40-40 el siguiente punto gana el juego, como en el pádel moderno).
 * Partido a un set: gana quien llega a 6 juegos con 2 de diferencia (a 6-6, hasta 7).
 */
export class Score {
  points: Record<Side, number> = { player: 0, cpu: 0 };
  games: Record<Side, number> = { player: 0, cpu: 0 };
  finished = false;
  winner: Side | null = null;
  private targetGames: number;

  /** targetGames: juegos para ganar (6 = set completo; 3 = set corto de torneo). */
  constructor(targetGames = 6) {
    this.targetGames = targetGames;
  }

  /** Devuelve 'game' | 'match' | null según lo que se haya cerrado con este punto. */
  addPoint(side: Side): 'game' | 'match' | null {
    if (this.finished) return null;
    const other: Side = side === 'player' ? 'cpu' : 'player';
    this.points[side]++;

    // Con punto de oro el marcador de puntos nunca pasa de 4:
    // llegar a 4 puntos siempre cierra el juego.
    if (this.points[side] >= 4) {
      this.points = { player: 0, cpu: 0 };
      this.games[side]++;
      const g = this.games[side];
      const go = this.games[other];
      if ((g >= this.targetGames && g - go >= 2) || g === this.targetGames + 1) {
        this.finished = true;
        this.winner = side;
        return 'match';
      }
      return 'game';
    }
    return null;
  }

  pointsLabel(): string {
    const p = this.points.player;
    const c = this.points.cpu;
    if (p === 3 && c === 3) return '40 - 40 · Punto de oro';
    return `${POINT_LABELS[p]} - ${POINT_LABELS[c]}`;
  }

  gamesLabel(): string {
    return `Juegos ${this.games.player} - ${this.games.cpu}`;
  }
}
