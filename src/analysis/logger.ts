import type { Side, ShotType } from '../types';

export type ShotResult = 'in' | 'error' | 'winner' | 'unknown';

export interface ShotLog {
  by: Side;
  type: ShotType;
  quality: number; // 0..1
  timing: number; // <0 = temprano, >0 = tarde (metros respecto al punto ideal)
  x: number;
  z: number;
  afterWall: boolean;
  result: ShotResult;
}

export interface PointLog {
  winner: Side;
  reason: string;
  shots: ShotLog[];
  serveFaults: number;
  server: Side;
}

export class MatchLogger {
  points: PointLog[] = [];
  whiffs = 0; // golpes al aire del jugador
  private currentShots: ShotLog[] = [];
  private currentFaults = 0;
  private currentServer: Side = 'player';

  beginPoint(server: Side): void {
    this.currentShots = [];
    this.currentFaults = 0;
    this.currentServer = server;
  }

  logShot(shot: Omit<ShotLog, 'result'>): void {
    this.currentShots.push({ ...shot, result: 'in' });
  }

  logServeFault(): void {
    this.currentFaults++;
  }

  logWhiff(): void {
    this.whiffs++;
  }

  endPoint(winner: Side, reason: string): void {
    const shots = this.currentShots;
    const last = shots[shots.length - 1];
    if (last) {
      // Si el último en golpear perdió el punto, su golpe fue error;
      // si lo ganó, fue winner (el rival no llegó).
      last.result = last.by === winner ? 'winner' : 'error';
    }
    this.points.push({
      winner,
      reason,
      shots: [...shots],
      serveFaults: this.currentFaults,
      server: this.currentServer,
    });
  }
}
