import { Ball } from './ball';
import { COURT, inServiceBox, sideOfZ } from './court';
import { PlayerEntity, REACH_X, REACH_Z } from './player';
import { CpuAi } from './ai';
import { Score } from './scoring';
import { Renderer } from './render';
import { classifySwing, computeShotVelocity, SHOT_PARAMS } from './shots';
import { MatchLogger } from '../analysis/logger';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { clamp, opponent } from '../types';
import type { ControlAdapter, SwingEvent } from '../ui/input';
import type { ControlMode, Difficulty, Side, ShotType } from '../types';

type MatchState = 'preServe' | 'rally' | 'pointOver' | 'done';

export interface MatchOptions {
  renderer: Renderer;
  control: ControlAdapter;
  controlMode: ControlMode;
  difficulty: Difficulty;
  onFinish(logger: MatchLogger, score: Score): void;
  onQuit(): void;
}

export class MatchMode {
  private opts: MatchOptions;
  private ball = new Ball();
  private player = new PlayerEntity('player');
  private cpu = new PlayerEntity('cpu');
  private ai: CpuAi;
  private score = new Score();
  logger = new MatchLogger();

  private state: MatchState = 'preServe';
  private servingSide: Side = 'player';
  private pointsInGame = 0;
  private serveNumber = 1;
  private serveBoxX: -1 | 1 = -1;
  private servePos = { x: 0, z: 0 };

  // Estado del intercambio desde el último golpe
  private lastHitBy: Side = 'player';
  private bounceCount = 0;
  private isServe = false;
  private serveBounced = false;
  private wallSinceHit = false;

  private cpuServeTimer = 0;
  private pointOverTimer = 0;
  private whiffCooldown = 0;
  private raf = 0;
  private lastT = 0;
  private running = false;

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.ai = new CpuAi(this.cpu, this.ball, opts.difficulty, {
      canHit: () => this.cpuCanHit(),
      doHit: (type, aim, quality) => this.executeHit('cpu', type, quality, aim, 0),
      bounceCount: () => this.bounceCount,
    });
    if (opts.controlMode === 'camera') this.player.speed = 8;

    this.ball.callbacks = {
      onGround: (pos) => {
        sfx.bounce();
        this.opts.renderer.burst(pos, '150, 200, 240', 5, 1.4);
        this.onGround(pos.x, pos.z);
      },
      onWall: (pos) => {
        sfx.wall();
        this.opts.renderer.burst(pos, '210, 235, 255', 6, 1.8);
        this.onWall();
      },
      onNet: () => {
        sfx.net();
        this.onNet();
      },
      onOut: () => this.onOut(),
    };
  }

  start(): void {
    this.running = true;
    ui.setHudVisible(true);
    this.updateScoreHud();
    this.setupServe();
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min((t - this.lastT) / 1000, 0.04);
      this.lastT = t;
      this.update(dt);
      this.opts.renderer.draw(this.ball, this.player, this.cpu, true);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    ui.setHudVisible(false);
  }

  // ---------- Saque ----------

  private setupServe(): void {
    this.state = 'preServe';
    const court = this.pointsInGame % 2 === 0 ? 'R' : 'L';
    const server = this.servingSide;
    let sx: number;
    if (server === 'player') {
      sx = court === 'R' ? 2.2 : -2.2; // derecha del jugador = +x
    } else {
      sx = court === 'R' ? -2.2 : 2.2; // derecha de la CPU = -x
    }
    const sz = server === 'player' ? 19 : 1;
    this.servePos = { x: sx, z: sz };
    this.serveBoxX = sx > 0 ? -1 : 1; // caja diagonal

    const serverEntity = server === 'player' ? this.player : this.cpu;
    const receiverEntity = server === 'player' ? this.cpu : this.player;
    serverEntity.x = sx;
    serverEntity.z = sz + (server === 'player' ? -0.4 : 0.4);
    serverEntity.clampToCourt();
    receiverEntity.x = this.serveBoxX * 2.4;
    receiverEntity.z = receiverEntity.baseZ + (server === 'player' ? 0 : 0.5);
    receiverEntity.clampToCourt();

    this.ball.reset({ x: sx, y: 1.0, z: serverEntity.z });
    this.logger.beginPoint(server);
    this.ai.resetPoint();
    this.cpuServeTimer = 1.3;

    ui.setServeInfo(
      server === 'player'
        ? `Tu saque (${this.serveNumber}º) · golpea para sacar`
        : `Saque de la CPU (${this.serveNumber}º)`,
    );
  }

  private doServe(dirBias: number): void {
    const server = this.servingSide;
    const receiver = opponent(server);
    const boxCenterZ = receiver === 'cpu' ? 5.8 : 14.2;
    const target = {
      x: clamp(this.serveBoxX * 2.4 + dirBias * 1.1 + (Math.random() - 0.5), -4.5, 4.5),
      z: boxCenterZ + (Math.random() - 0.5) * 1.5,
    };
    const quality = server === 'player' ? 0.85 : 0.8;
    const from = { x: this.servePos.x, y: 1.0, z: this.servePos.z };
    this.ball.launch(from, computeShotVelocity(from, target, 'serve', quality));

    const entity = server === 'player' ? this.player : this.cpu;
    entity.startSwing('serve');
    sfx.hit('serve');
    this.logger.logShot({
      by: server, type: 'serve', quality, timing: 0,
      x: entity.x, z: entity.z, afterWall: false,
    });

    this.lastHitBy = server;
    this.bounceCount = 0;
    this.isServe = true;
    this.serveBounced = false;
    this.wallSinceHit = false;
    this.state = 'rally';
  }

  private serveFault(): void {
    this.ball.active = false;
    this.logger.logServeFault();
    sfx.fault();
    if (this.serveNumber === 1) {
      this.serveNumber = 2;
      ui.toast('¡Falta de saque!', 1100);
      this.state = 'pointOver';
      this.pointOverTimer = 1.1;
    } else {
      this.resolvePoint(opponent(this.servingSide), 'doble falta');
    }
  }

  // ---------- Árbitro ----------

  private onGround(x: number, z: number): void {
    if (this.state !== 'rally') return;
    const side = sideOfZ(z);
    this.bounceCount++;

    if (this.bounceCount === 1) {
      if (side === this.lastHitBy) {
        // No cruzó la red
        if (this.isServe) this.serveFault();
        else this.resolvePoint(opponent(this.lastHitBy), 'no cruzó la red');
        return;
      }
      if (this.isServe) {
        if (!inServiceBox(x, z, opponent(this.servingSide), this.serveBoxX)) {
          this.serveFault();
          return;
        }
        this.serveBounced = true;
      }
    } else if (this.bounceCount >= 2) {
      this.resolvePoint(this.lastHitBy, 'doble bote');
    }
  }

  private onWall(): void {
    if (this.state !== 'rally') return;
    if (this.bounceCount === 0) {
      // Directa a la pared sin botar: fuera
      if (this.isServe) this.serveFault();
      else this.resolvePoint(opponent(this.lastHitBy), 'directa a la pared');
    } else {
      this.wallSinceHit = true; // rebote legal en el cristal
    }
  }

  private onNet(): void {
    if (this.state !== 'rally') return;
    if (this.isServe) this.serveFault();
    else this.resolvePoint(opponent(this.lastHitBy), 'red');
  }

  private onOut(): void {
    if (this.state !== 'rally') return;
    if (this.isServe) this.serveFault();
    else this.resolvePoint(opponent(this.lastHitBy), 'fuera');
  }

  private resolvePoint(winner: Side, reason: string): void {
    this.state = 'pointOver';
    this.ball.active = false;
    this.logger.endPoint(winner, reason);

    const res = this.score.addPoint(winner);
    this.updateScoreHud();

    let msg = winner === 'player' ? '¡Punto para ti!' : 'Punto para la CPU';
    msg += `\n(${reason})`;
    if (res === 'game') {
      msg += '\n🎾 ¡Juego!';
      this.pointsInGame = 0;
      this.servingSide = opponent(this.servingSide);
      if (winner === 'player') sfx.gameWin();
      else sfx.pointLose();
    } else if (res === 'match') {
      msg = this.score.winner === 'player' ? '🏆 ¡PARTIDO GANADO!' : '🤖 La CPU gana el partido';
      if (this.score.winner === 'player') sfx.matchWin();
      else sfx.matchLose();
    } else {
      this.pointsInGame++;
      if (winner === 'player') sfx.pointWin();
      else sfx.pointLose();
    }
    ui.toast(msg, res === 'match' ? 2400 : 1600);

    this.serveNumber = 1;
    this.pointOverTimer = res === 'match' ? 2.4 : 1.7;
    if (res === 'match') this.state = 'done';
  }

  private updateScoreHud(): void {
    ui.updateScore(this.score.gamesLabel(), this.score.pointsLabel());
  }

  // ---------- Golpes ----------

  private cpuCanHit(): boolean {
    if (this.state !== 'rally') return false;
    if (this.lastHitBy === 'cpu') return false;
    if (this.isServe && !this.serveBounced) return false; // dejar botar el saque
    return true;
  }

  private tryPlayerSwing(swing: SwingEvent): void {
    if (this.state === 'preServe' && this.servingSide === 'player') {
      this.doServe(swing.dir);
      return;
    }
    if (this.state !== 'rally' || this.lastHitBy === 'player') return;

    if (this.isServe && !this.serveBounced) {
      ui.toast('Deja botar el saque', 900);
      return;
    }

    const b = this.ball;
    const p = this.player;
    const dx = b.pos.x - p.x;
    const dz = b.pos.z - p.z;
    const reachable =
      b.pos.z > COURT.netZ - 0.3 &&
      Math.abs(dx) < REACH_X &&
      Math.abs(dz) < REACH_Z &&
      b.pos.y < 3;

    if (!reachable) {
      if (this.whiffCooldown <= 0) {
        this.logger.logWhiff();
        sfx.whiff();
        this.whiffCooldown = 0.5;
        this.player.startSwing('forehand');
      }
      return;
    }

    const type = classifySwing(b.pos.y, dx, this.bounceCount, swing);

    const quality = clamp(
      1 - (Math.abs(dx) / REACH_X) * 0.45 - (Math.abs(dz) / REACH_Z) * 0.45,
      0.15,
      1,
    );
    // <0 = golpeó antes de tiempo (bola lejos), >0 = tarde (bola encima)
    const timing = b.pos.z - (p.z - 0.5);

    this.executeHit('player', type, quality, this.aimFor(type, swing.dir), timing);
  }

  /** Objetivo del golpe según su tipo (z bajo = profundo en campo CPU). */
  private aimFor(type: ShotType, dir: number): { x: number; z: number } {
    switch (type) {
      case 'vibora':
        // Cruzada y tensa hacia el cristal lateral
        return {
          x: clamp(dir * 3.9 + (Math.random() - 0.5) * 0.8, -4.6, 4.6),
          z: 3.5 + Math.random() * 2.5,
        };
      case 'bandeja':
        // Profunda y controlada, a los pies del fondo rival
        return {
          x: clamp(dir * 2.2 + (Math.random() - 0.5), -4, 4),
          z: 1.8 + Math.random() * 2.2,
        };
      case 'smash':
        return {
          x: clamp(dir * 2.8 + (Math.random() - 0.5), -4.5, 4.5),
          z: 4 + Math.random() * 4,
        };
      default:
        return {
          x: clamp(dir * 2.8 + (Math.random() - 0.5), -4.5, 4.5),
          z: 3 + Math.random() * 4.5,
        };
    }
  }

  private executeHit(
    side: Side,
    type: ShotType,
    quality: number,
    aim: { x: number; z: number },
    timing: number,
  ): void {
    const entity = side === 'player' ? this.player : this.cpu;
    this.ball.vel = computeShotVelocity(this.ball.pos, aim, type, quality);
    // La víbora sale con efecto: curva en el aire y escupe en el bote
    this.ball.spin =
      type === 'vibora' ? Math.sign(this.ball.vel.x || 1) * SHOT_PARAMS.vibora.spin : 0;
    this.ball.active = true;
    entity.startSwing(type);

    sfx.hit(type);
    this.opts.renderer.burst(this.ball.pos, '255, 235, 130', 6, 2.4);
    if (type === 'smash') this.opts.renderer.shake(7);
    else if (type === 'vibora') this.opts.renderer.shake(5);

    this.logger.logShot({
      by: side, type, quality, timing,
      x: entity.x, z: entity.z,
      afterWall: this.wallSinceHit,
    });

    this.lastHitBy = side;
    this.bounceCount = 0;
    this.isServe = false;
    this.wallSinceHit = false;
  }

  // ---------- Bucle ----------

  private update(dt: number): void {
    this.whiffCooldown -= dt;
    this.opts.control.update(dt);

    for (const swing of this.opts.control.consumeSwings()) {
      this.tryPlayerSwing(swing);
    }

    // Movimiento del jugador
    const move = this.opts.control.getMove();
    if (move.mode === 'velocity') {
      this.player.applyMoveInput(move.x, move.z, dt);
    } else {
      // Cámara: x absoluta, z automática (el juego te coloca en profundidad)
      let targetZ = 17.5;
      if (this.ball.active && this.ball.vel.z > 0.1) {
        const land = this.ball.predictLanding();
        targetZ = clamp(land.z + 0.5, COURT.netZ + 2, COURT.length - 0.6);
      }
      this.player.moveToward(move.x, targetZ, dt);
    }

    // Saque de la CPU
    if (this.state === 'preServe' && this.servingSide === 'cpu') {
      this.cpuServeTimer -= dt;
      if (this.cpuServeTimer <= 0) this.doServe(Math.random() < 0.5 ? -0.5 : 0.5);
    }

    if (this.state === 'rally') this.ai.update(dt);
    else if (this.ball.active === false && this.state !== 'preServe') {
      // entre puntos la CPU vuelve a su base
      this.cpu.moveToward(0, this.cpu.baseZ, dt);
    }

    this.player.update(dt);
    this.cpu.update(dt);
    this.ball.update(dt);

    // Transición tras el punto / falta
    if ((this.state === 'pointOver' || this.state === 'done') && this.pointOverTimer > 0) {
      this.pointOverTimer -= dt;
      if (this.pointOverTimer <= 0) {
        if (this.state === 'done') {
          this.stop();
          this.opts.onFinish(this.logger, this.score);
        } else {
          this.setupServe();
        }
      }
    }
  }
}
