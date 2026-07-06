import { Ball } from './ball';
import { COURT, inServiceBox, sideOfZ } from './court';
import { PlayerEntity, REACH_X, REACH_Z } from './player';
import { CpuAi } from './ai';
import { Score } from './scoring';
import { classifySwing, computeShotVelocity, SHOT_PARAMS } from './shots';
import { MatchLogger } from '../analysis/logger';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { clamp, isOverheadShot, opponent } from '../types';
import type { SwingForm } from '../ui/input';
import { CPU_PALETTE } from './render';
import type { GameRenderer } from './renderers/GameRenderer';
import type { Rival } from '../modes/tournament';
import type { ControlAdapter, SwingEvent } from '../ui/input';
import type { ControlMode, Difficulty, Side, ShotType } from '../types';

type MatchState = 'preServe' | 'rally' | 'pointOver' | 'replay' | 'done';

export interface MatchOptions {
  renderer: GameRenderer;
  control: ControlAdapter;
  controlMode: ControlMode;
  difficulty: Difficulty;
  /** Juegos para ganar el set (por defecto 6; el torneo usa sets cortos). */
  targetGames?: number;
  /** Rival del torneo: nombre, camiseta y ajustes de IA propios. */
  rival?: Rival | null;
  /** Partida entre personas: el lado 'cpu' lo controla otra persona (p. ej. un rival online). */
  controlP2?: ControlAdapter;
  /** Nombre del lado cercano cuando hay dos personas (por defecto "Jugador 1"). */
  p1Name?: string;
  onFinish(logger: MatchLogger, score: Score): void;
  onQuit(): void;
}

/** Instantánea de un frame para la repetición a cámara lenta. */
interface ReplayFrame {
  bx: number; by: number; bz: number;
  px: number; pz: number; psw: ShotType | null; pst: number;
  cx: number; cz: number; csw: ShotType | null; cst: number;
}

const REPLAY_SPEED = 0.45; // cámara lenta
const MAX_FRAMES = 400; // ~6,6 s a 60 fps

export class MatchMode {
  private opts: MatchOptions;
  private ball = new Ball();
  private player = new PlayerEntity('player');
  private cpu = new PlayerEntity('cpu');
  private ai: CpuAi | null;
  private score: Score;
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
  private preServeIdle = 0;
  private pointOverTimer = 0;
  private whiffCooldowns: Record<Side, number> = { player: 0, cpu: 0 };
  private raf = 0;
  private lastT = 0;
  private running = false;

  // Confianza del jugador: la racha de buenos gestos da bonus; los errores
  // repetidos la hunden y despiertan al coach.
  private confidence = 0.5;
  private goodRun = 0; // golpes buenos consecutivos
  private errorRun = 0; // errores no forzados consecutivos
  private lastPlayerForm: SwingForm | null = null;
  private lastPlayerTiming = 0;
  private coachCooldown = 0;

  // Repetición a cámara lenta de puntos espectaculares
  private frames: ReplayFrame[] = [];
  private postFrames = 0; // frames grabados tras el fin del punto (deja ver el bote final)
  private pendingReplay = false;
  private finishAfterReplay = false;
  private replayT = 0;

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.score = new Score(opts.targetGames ?? 6);
    this.ai = opts.controlP2
      ? null
      : new CpuAi(this.cpu, this.ball, opts.difficulty, {
          canHit: () => this.cpuCanHit(),
          doHit: (type, aim, quality) => this.executeHit('cpu', type, quality, aim, 0),
          bounceCount: () => this.bounceCount,
        }, opts.rival?.ai);
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

  private get isDuel(): boolean {
    return !!this.opts.controlP2;
  }

  private get rivalName(): string {
    return this.opts.rival?.name ?? (this.isDuel ? 'Jugador 2' : 'la CPU');
  }

  private get p1Name(): string {
    return this.opts.p1Name ?? 'Jugador 1';
  }

  /** Estado mínimo para retransmitir la partida a un rival online. */
  netState(): {
    b: [number, number, number, number];
    p: [number, number, ShotType | null, number];
    c: [number, number, ShotType | null, number];
    replay: boolean;
  } {
    return {
      b: [this.ball.pos.x, this.ball.pos.y, this.ball.pos.z, this.ball.active ? 1 : 0],
      p: [this.player.x, this.player.z, this.player.swingType, this.player.swingT],
      c: [this.cpu.x, this.cpu.z, this.cpu.swingType, this.cpu.swingT],
      replay: this.state === 'replay',
    };
  }

  start(): void {
    this.running = true;
    this.opts.renderer.cpuPalette = this.opts.rival?.palette ?? CPU_PALETTE;
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
    ui.setReplay(false);
    ui.setFire(0);
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
    this.ai?.resetPoint();
    this.cpuServeTimer = 1.3;
    this.preServeIdle = 0;
    this.frames.length = 0;
    this.postFrames = 0;
    this.pendingReplay = false;

    ui.setServeInfo(
      server === 'player'
        ? `${this.isDuel ? `Saque de ${this.p1Name}` : 'Tu saque'} (${this.serveNumber}º) · golpea para sacar`
        : `Saque de ${this.rivalName} (${this.serveNumber}º)${this.isDuel ? ' · golpea para sacar' : ''}`,
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
    // El saque también golpea de verdad: mismo lenguaje visual que un golpe en juego
    this.opts.renderer.burst(from, '255, 235, 130', 6, 2.2);
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
    this.opts.renderer.exciteCrowd(winner === 'player' ? 1 : 0.45);
    this.updateConfidence(winner);

    // ¿Merece repetición? Winner propio tras un intercambio, o remate/víbora ganadora
    const pt = this.logger.points[this.logger.points.length - 1];
    const lastShot = pt.shots[pt.shots.length - 1];
    this.pendingReplay =
      !!lastShot &&
      lastShot.by === winner &&
      (pt.shots.length >= 3 || lastShot.type === 'smash' || lastShot.type === 'vibora');

    const res = this.score.addPoint(winner);
    this.updateScoreHud();

    let msg =
      winner === 'player'
        ? this.isDuel
          ? `¡Punto para ${this.p1Name}!`
          : '¡Punto para ti!'
        : `Punto para ${this.rivalName}`;
    msg += `\n(${reason})`;
    if (res === 'game') {
      msg += '\n🎾 ¡Juego!';
      this.pointsInGame = 0;
      this.servingSide = opponent(this.servingSide);
      if (winner === 'player') sfx.gameWin();
      else sfx.pointLose();
    } else if (res === 'match') {
      msg =
        this.score.winner === 'player'
          ? this.isDuel
            ? `🏆 ¡${this.p1Name} gana el partido!`
            : '🏆 ¡PARTIDO GANADO!'
          : this.opts.rival || this.isDuel
            ? `🏆 ¡${this.rivalName} gana el partido!`
            : '🤖 La CPU gana el partido';
      if (this.score.winner === 'player' || this.isDuel) sfx.matchWin();
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

  /** Confianza y coach reactivo: los errores repetidos traen consejo concreto. */
  private updateConfidence(winner: Side): void {
    const pt = this.logger.points[this.logger.points.length - 1];
    const last = pt?.shots[pt.shots.length - 1];
    const playerError = !!last && last.by === 'player' && last.result === 'error';
    const playerWinner = !!last && last.by === 'player' && last.result === 'winner';

    if (playerWinner) this.confidence = clamp(this.confidence + 0.14, 0, 1);
    else if (winner === 'player') this.confidence = clamp(this.confidence + 0.07, 0, 1);
    if (playerError) this.confidence = clamp(this.confidence - 0.15, 0, 1);
    // deriva suave hacia el punto neutro
    this.confidence += (0.5 - this.confidence) * 0.06;

    if (playerError) {
      this.errorRun++;
      this.goodRun = 0;
      ui.setFire(0);
    } else if (winner === 'player') {
      this.errorRun = 0;
    }

    this.coachCooldown = Math.max(0, this.coachCooldown - 1);
    if (this.errorRun >= 3 && this.coachCooldown === 0 && !this.isDuel) {
      this.errorRun = 0;
      this.coachCooldown = 4; // puntos hasta poder volver a hablar
      let advice: string;
      const f = this.lastPlayerForm;
      if (f && f.posture < 0.6) advice = 'flexiona las piernas y busca equilibrio antes de golpear';
      else if (f && f.extension !== null && (f.extension < 0.85 || f.extension > 1.8))
        advice = 'golpea al costado del cuerpo, ni encima ni estirado del todo';
      else if (this.lastPlayerTiming > 0.5) advice = 'prepara la pala antes: estás llegando tarde';
      else if (this.lastPlayerTiming < -0.5) advice = 'espera la bola, estás golpeando antes de tiempo';
      else advice = 'apunta al centro un par de bolas y recupera sensaciones';
      window.setTimeout(() => ui.toast(`🧑‍🏫 Coach: ${advice}`, 2200), 1200);
    }
  }

  // ---------- Golpes ----------

  private cpuCanHit(): boolean {
    if (this.state !== 'rally') return false;
    if (this.lastHitBy === 'cpu') return false;
    if (this.isServe && !this.serveBounced) return false; // dejar botar el saque
    return true;
  }

  private tryHumanSwing(side: Side, swing: SwingEvent): void {
    if (this.state === 'preServe' && this.servingSide === side) {
      this.doServe(swing.dir);
      return;
    }
    if (this.state !== 'rally' || this.lastHitBy === side) return;

    if (this.isServe && !this.serveBounced) {
      ui.toast('Deja botar el saque', 900);
      return;
    }

    const b = this.ball;
    const e = side === 'player' ? this.player : this.cpu;
    const dx = b.pos.x - e.x;
    const dz = b.pos.z - e.z;
    const inOwnHalf =
      side === 'player' ? b.pos.z > COURT.netZ - 0.3 : b.pos.z < COURT.netZ + 0.3;
    const reachable =
      inOwnHalf && Math.abs(dx) < REACH_X && Math.abs(dz) < REACH_Z && b.pos.y < 3;

    if (!reachable) {
      if (this.whiffCooldowns[side] <= 0) {
        if (side === 'player') this.logger.logWhiff();
        sfx.whiff();
        this.whiffCooldowns[side] = 0.5;
        e.startSwing('forehand');
      }
      return;
    }

    // El jugador de fondo está de cara: su derecha queda en -x
    const type = classifySwing(b.pos.y, side === 'player' ? dx : -dx, this.bounceCount, swing);

    // Calidad base: colocación respecto a la bola (buen timing = golpe preciso)
    let quality = clamp(
      1 - (Math.abs(dx) / REACH_X) * 0.45 - (Math.abs(dz) / REACH_Z) * 0.45,
      0.15,
      1,
    );
    // <0 = golpeó antes de tiempo (bola lejos), >0 = tarde (bola encima)
    const timing = side === 'player' ? b.pos.z - (e.z - 0.5) : e.z + 0.5 - b.pos.z;

    // La técnica del gesto real modifica el gameplay (solo con cámara)
    let speedMul = 1;
    if (swing.form) {
      // Mala postura → más probabilidad de error (golpe más impreciso)
      quality = clamp(quality * (0.72 + 0.28 * swing.form.posture), 0.1, 1);
      // Potencia del gesto → velocidad de bola (arriesgar tiene premio y riesgo)
      speedMul = 0.85 + 0.35 * swing.power;
      // Punto de impacto fuera del rango natural → bola floja e imprecisa
      if (swing.form.extension !== null) {
        const [lo, hi] = isOverheadShot(type) ? [0.7, 2.0] : [0.85, 1.8];
        if (swing.form.extension < lo || swing.form.extension > hi) {
          quality = clamp(quality - 0.18, 0.1, 1);
          speedMul *= 0.8;
        }
      }
    }

    if (side === 'player') {
      // Confianza: en racha el golpe sale más fino; hundido, más errático
      quality = clamp(quality + (this.confidence - 0.5) * 0.16, 0.1, 1);
      this.lastPlayerForm = swing.form ?? null;
      this.lastPlayerTiming = timing;
      if (quality > 0.7) {
        this.goodRun++;
        if (this.goodRun === 3) ui.toast('🔥 ¡En racha!', 900);
        ui.setFire(this.goodRun);
      } else {
        this.goodRun = 0;
        ui.setFire(0);
      }
      this.showShotFeedback(quality, timing, swing.form);
    }

    const aim = this.aimFor(type, swing.dir);
    if (side === 'cpu') aim.z = COURT.length - aim.z; // apunta al campo del jugador cercano
    this.executeHit(side, type, quality, aim, timing, speedMul);
  }

  /**
   * Lectura de técnica compacta con los datos que el gameplay ya calcula
   * para ese golpe (calidad, timing, y postura/potencia si viene de
   * cámara). No introduce ninguna métrica nueva.
   */
  private showShotFeedback(quality: number, timing: number, form: SwingForm | undefined): void {
    if (quality > 0.85) {
      ui.setShotFeedback('✨ Timing perfecto', 'good');
    } else if (timing > 0.5) {
      ui.setShotFeedback('Llegaste tarde', 'warn');
    } else if (timing < -0.5) {
      ui.setShotFeedback('Golpe adelantado', 'warn');
    } else if (form && form.posture < 0.6) {
      ui.setShotFeedback('Postura mejorable', 'warn');
    } else if (quality > 0.6) {
      ui.setShotFeedback('Buen golpe', 'good');
    } else if (quality < 0.35) {
      ui.setShotFeedback('Impacto flojo', 'bad');
    }
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
    speedMul = 1,
  ): void {
    const entity = side === 'player' ? this.player : this.cpu;
    this.ball.vel = computeShotVelocity(this.ball.pos, aim, type, quality);
    // Potencia real del gesto: bola más rápida (o floja) manteniendo el arco.
    // <1 puede quedarse en la red; >1 puede irse larga: riesgo real.
    const m = clamp(speedMul, 0.78, 1.18);
    this.ball.vel.x *= m;
    this.ball.vel.z *= m;
    // La víbora sale con efecto: curva en el aire y escupe en el bote
    this.ball.spin =
      type === 'vibora' ? Math.sign(this.ball.vel.x || 1) * SHOT_PARAMS.vibora.spin : 0;
    this.ball.active = true;
    entity.startSwing(type);

    sfx.hit(type);
    // El impacto visual acompaña la calidad real del golpe del jugador:
    // un golpe perfecto se siente más jugoso, uno flojo pasa discreto.
    const punch = side === 'player' ? clamp(quality, 0.35, 1) : 0.75;
    this.opts.renderer.burst(this.ball.pos, '255, 235, 130', Math.round(4 + punch * 5), 1.8 + punch * 1.2);
    if (type === 'smash') this.opts.renderer.shake(7);
    else if (type === 'vibora') this.opts.renderer.shake(5);
    else if (side === 'player' && quality > 0.85) this.opts.renderer.shake(3);

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
    this.whiffCooldowns.player -= dt;
    this.whiffCooldowns.cpu -= dt;
    this.opts.control.update(dt); // también en repetición: mantiene vivo el preview de cámara
    this.opts.controlP2?.update(dt);

    if (this.state === 'replay') {
      // Cualquier golpe o movimiento del jugador salta la repetición al
      // instante en vez de descartarlo en silencio: quien está probando el
      // juego rápido (o jugando de verdad) no debería quedarse esperando
      // una repetición que no pidió.
      const skipSwing = this.opts.control.consumeSwings().length > 0
        || (this.opts.controlP2?.consumeSwings().length ?? 0) > 0;
      const move = this.opts.control.getMove();
      const skipMove = move.mode === 'velocity' && (move.x !== 0 || move.z !== 0);
      if (skipSwing || skipMove) this.replayT = Infinity;
      this.updateReplay(dt);
      return;
    }

    for (const swing of this.opts.control.consumeSwings()) {
      this.tryHumanSwing('player', swing);
    }
    for (const swing of this.opts.controlP2?.consumeSwings() ?? []) {
      this.tryHumanSwing('cpu', swing);
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

    // Saque de la CPU (en partidas entre personas saca cada cual con su golpe,
    // con saque automático si quien saca se queda inactivo demasiado tiempo)
    if (this.state === 'preServe') {
      if (this.servingSide === 'cpu' && !this.isDuel) {
        this.cpuServeTimer -= dt;
        if (this.cpuServeTimer <= 0) this.doServe(Math.random() < 0.5 ? -0.5 : 0.5);
      } else if (this.isDuel) {
        this.preServeIdle += dt;
        if (this.preServeIdle > 12) {
          ui.toast('Saque automático por inactividad', 1200);
          this.doServe(0);
        }
      }
    }

    if (this.isDuel && this.opts.controlP2) {
      const m2 = this.opts.controlP2.getMove();
      if (m2.mode === 'velocity') {
        this.cpu.applyMoveInput(m2.x, m2.z, dt);
      } else {
        // Rival con cámara: x absoluta y profundidad automática (espejo del lado cercano)
        this.cpu.speed = 8;
        let targetZ = 2.5;
        if (this.ball.active && this.ball.vel.z < -0.1) {
          const land = this.ball.predictLanding();
          targetZ = clamp(land.z - 0.5, 0.6, COURT.netZ - 2);
        }
        this.cpu.moveToward(m2.x, targetZ, dt);
      }
    } else if (this.state === 'rally') {
      this.ai?.update(dt);
    } else if (this.ball.active === false && this.state !== 'preServe') {
      // entre puntos la CPU vuelve a su base
      this.cpu.moveToward(0, this.cpu.baseZ, dt);
    }

    this.player.update(dt);
    this.cpu.update(dt);
    this.ball.update(dt);
    this.recordFrame();

    // Transición tras el punto / falta
    if ((this.state === 'pointOver' || this.state === 'done') && this.pointOverTimer > 0) {
      this.pointOverTimer -= dt;
      if (this.pointOverTimer <= 0) {
        const wasDone = this.state === 'done';
        if (this.pendingReplay && this.frames.length > 60) {
          this.startReplay(wasDone);
        } else if (wasDone) {
          this.stop();
          this.opts.onFinish(this.logger, this.score);
        } else {
          this.setupServe();
        }
      }
    }
  }

  // ---------- Repetición a cámara lenta ----------

  private recordFrame(): void {
    if (this.state === 'rally') {
      this.postFrames = 0;
    } else if (this.state === 'pointOver' || this.state === 'done') {
      // Unos frames extra tras el punto para que se vea el bote decisivo
      if (this.postFrames >= 20) return;
      this.postFrames++;
    } else {
      return;
    }
    this.frames.push({
      bx: this.ball.pos.x, by: this.ball.pos.y, bz: this.ball.pos.z,
      px: this.player.x, pz: this.player.z, psw: this.player.swingType, pst: this.player.swingT,
      cx: this.cpu.x, cz: this.cpu.z, csw: this.cpu.swingType, cst: this.cpu.swingT,
    });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  private startReplay(finishAfter: boolean): void {
    this.pendingReplay = false;
    this.finishAfterReplay = finishAfter;
    this.state = 'replay';
    this.replayT = 0;
    this.ball.trail.length = 0;
    ui.setReplay(true);
  }

  private updateReplay(dt: number): void {
    this.replayT += dt * REPLAY_SPEED;
    const f = this.frames[Math.floor(this.replayT * 60)];
    if (!f) {
      // Fin de la repetición: seguir con el partido
      ui.setReplay(false);
      this.frames.length = 0;
      if (this.finishAfterReplay) {
        this.stop();
        this.opts.onFinish(this.logger, this.score);
      } else {
        this.setupServe();
      }
      return;
    }
    this.ball.pos.x = f.bx; this.ball.pos.y = f.by; this.ball.pos.z = f.bz;
    this.player.x = f.px; this.player.z = f.pz;
    this.player.swingType = f.psw; this.player.swingT = f.pst;
    this.cpu.x = f.cx; this.cpu.z = f.cz;
    this.cpu.swingType = f.csw; this.cpu.swingT = f.cst;
  }
}
