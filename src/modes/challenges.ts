import { Ball } from '../game/ball';
import { COURT, sideOfZ } from '../game/court';
import { PlayerEntity, REACH_X, REACH_Z } from '../game/player';
import { Renderer } from '../game/render';
import { classifySwing, computeShotVelocity, SHOT_PARAMS } from '../game/shots';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { clamp } from '../types';
import type { ControlAdapter, SwingEvent } from '../ui/input';
import type { ControlMode, ShotType } from '../types';

// Desafíos jugables: objetivos arcade sobre la pista virtual donde la
// calidad del gesto real (timing, postura, potencia) decide el resultado.

export type ChallengeId = 'diana' | 'muro';

export interface ChallengeDef {
  id: ChallengeId;
  icon: string;
  name: string;
  desc: string;
  stars: [number, number, number]; // umbrales de 1/2/3 estrellas
  unit: string;
  xpMul: number; // XP = score * xpMul
}

export const CHALLENGES: ChallengeDef[] = [
  {
    id: 'diana',
    icon: '🎯',
    name: 'Diana',
    desc: 'Haz botar tus golpes en la zona iluminada. Los aciertos seguidos multiplican los puntos.',
    stars: [500, 900, 1400],
    unit: 'pts',
    xpMul: 0.1,
  },
  {
    id: 'muro',
    icon: '🧱',
    name: 'El Muro',
    desc: 'Peloteo sin fallo: el muro lo devuelve todo y cada vez más rápido. ¿Cuántos golpes aguantas?',
    stars: [8, 15, 25],
    unit: 'golpes',
    xpMul: 8,
  },
];

export interface ChallengeResult {
  def: ChallengeDef;
  score: number;
  stars: number;
}

interface Zone {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

// Zonas de la Diana en el campo rival (z bajo = profundo)
const DIANA_ZONES: Zone[] = [
  { x0: -4.6, x1: -1.6, z0: 0.4, z1: 3.2 }, // esquina profunda izquierda
  { x0: 1.6, x1: 4.6, z0: 0.4, z1: 3.2 }, // esquina profunda derecha
  { x0: -1.8, x1: 1.8, z0: 6.4, z1: 9.2 }, // corta al centro (dejada)
];

const DIANA_BALLS = 12;

export interface ChallengeOptions {
  renderer: Renderer;
  control: ControlAdapter;
  controlMode: ControlMode;
  def: ChallengeDef;
  onFinish(result: ChallengeResult): void;
}

export class ChallengeMode {
  private opts: ChallengeOptions;
  private ball = new Ball();
  private player = new PlayerEntity('player');
  private machine = new PlayerEntity('cpu');

  private score = 0;
  private combo = 0;
  private ballIndex = 0; // diana
  private pace = 1; // muro: acelera con cada devolución
  private zone: Zone | null = null;

  private phase: 'waiting' | 'ball' | 'resolved' | 'done' = 'waiting';
  private timer = 1.2;
  private lastHitBy: 'machine' | 'player' = 'machine';
  private bounceCount = 0;
  private evaluated = false;
  private whiffCooldown = 0;

  private raf = 0;
  private lastT = 0;
  private running = false;

  constructor(opts: ChallengeOptions) {
    this.opts = opts;
    this.machine.x = 0;
    this.machine.z = 2;
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
    ui.updateScore(`${this.opts.def.icon} ${this.opts.def.name}`, '');
    ui.setServeInfo('');
    this.updateHud('¡Prepárate!');
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min((t - this.lastT) / 1000, 0.04);
      this.lastT = t;
      this.update(dt);
      this.opts.renderer.draw(this.ball, this.player, this.machine, this.phase === 'ball');
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.opts.renderer.targetZones = [];
    ui.setHudVisible(false);
    ui.setDrillHud(null);
    ui.setFire(0);
  }

  // ---------- Lanzamiento ----------

  private launchBall(): void {
    const isDiana = this.opts.def.id === 'diana';
    if (isDiana) {
      this.ballIndex++;
      this.zone = DIANA_ZONES[Math.floor(Math.random() * DIANA_ZONES.length)];
      this.opts.renderer.targetZones = [this.zone];
    }
    this.machine.x = (Math.random() - 0.5) * 4;
    const from = { x: this.machine.x, y: 1.1, z: this.machine.z };
    const side = Math.random() < 0.5 ? -1 : 1;
    const target = { x: side * (1.4 + Math.random() * 2), z: 14.5 + Math.random() * 2.5 };
    const vel = computeShotVelocity(from, target, 'forehand', 0.95);
    this.ball.launch(from, vel);
    this.machine.startSwing('forehand');
    sfx.hit('forehand');

    this.lastHitBy = 'machine';
    this.bounceCount = 0;
    this.evaluated = false;
    this.phase = 'ball';
    this.updateHud(isDiana ? '🎯 ¡Apunta a la zona iluminada!' : '🧱 ¡Aguanta el peloteo!');
  }

  /** El Muro devuelve todo, cada vez más rápido. */
  private machineReturn(): void {
    this.pace = Math.min(this.pace + 0.025, 1.4);
    const target = { x: (Math.random() - 0.5) * 5, z: 13.5 + Math.random() * 3.5 };
    this.ball.vel = computeShotVelocity(this.ball.pos, target, 'forehand', 0.95);
    this.ball.vel.x *= this.pace;
    this.ball.vel.z *= this.pace;
    this.ball.spin = 0;
    this.machine.startSwing(this.ball.pos.x <= this.machine.x ? 'forehand' : 'backhand');
    sfx.hit('forehand');
    this.lastHitBy = 'machine';
    this.bounceCount = 0;
    this.evaluated = false;
  }

  // ---------- Árbitro ----------

  private onGround(x: number, z: number): void {
    if (this.phase !== 'ball') return;
    this.bounceCount++;
    if (this.lastHitBy === 'machine') {
      if (this.bounceCount >= 2) this.fail('No llegaste a la bola');
      return;
    }
    // Primer bote del golpe del jugador
    if (this.evaluated) return;
    if (sideOfZ(z) === 'player') {
      this.fail('Tu golpe no cruzó la red');
      return;
    }
    this.evaluated = true;
    if (this.opts.def.id === 'diana') {
      const zn = this.zone;
      const inZone = !!zn && x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1;
      if (inZone) {
        this.combo++;
        const pts = 100 * this.combo;
        this.score += pts;
        sfx.good();
        this.opts.renderer.burst({ x, y: 0.1, z }, '52, 211, 153', 14, 3);
        this.opts.renderer.exciteCrowd(0.5);
        ui.setFire(this.combo);
        this.resolve(`✅ ¡Diana! +${pts} (combo x${this.combo})`);
      } else {
        this.combo = 0;
        this.score += 20;
        ui.setFire(0);
        this.resolve('🟡 Dentro, pero fuera de la zona: +20');
      }
    } else {
      // Muro: bola válida → el muro la devolverá (cuenta al devolverla)
      this.score++;
      this.updateHud(`🧱 Golpes: ${this.score} · velocidad x${this.pace.toFixed(2)}`);
    }
  }

  private onWall(): void {
    if (this.phase !== 'ball' || this.evaluated) return;
    if (this.lastHitBy === 'player' && this.bounceCount === 0) {
      this.fail('Directa a la pared: fuera');
    }
  }

  private onNet(): void {
    if (this.phase !== 'ball') return;
    if (this.lastHitBy === 'player') this.fail('Red');
    else {
      this.phase = 'resolved'; // bola de máquina defectuosa: repetir
      if (this.opts.def.id === 'diana') this.ballIndex--;
      this.timer = 0.8;
    }
  }

  private onOut(): void {
    if (this.phase !== 'ball') return;
    if (this.lastHitBy === 'player') this.fail('Fuera');
    else {
      this.phase = 'resolved';
      if (this.opts.def.id === 'diana') this.ballIndex--;
      this.timer = 0.8;
    }
  }

  private fail(reason: string): void {
    if (this.phase !== 'ball') return;
    this.combo = 0;
    ui.setFire(0);
    sfx.bad();
    if (this.opts.def.id === 'muro') {
      // En el muro un fallo termina el desafío
      this.ball.active = false;
      this.phase = 'done';
      this.updateHud(`❌ ${reason}`);
      window.setTimeout(() => this.finish(), 900);
      return;
    }
    this.resolve(`❌ ${reason}`);
  }

  private resolve(feedback: string): void {
    this.phase = 'resolved';
    this.timer = 1.3;
    this.ball.active = false;
    this.updateHud(feedback);
  }

  // ---------- Golpe del jugador ----------

  private trySwing(swing: SwingEvent): void {
    if (this.phase !== 'ball' || this.lastHitBy === 'player') return;
    const b = this.ball;
    const p = this.player;
    const dx = b.pos.x - p.x;
    const dz = b.pos.z - p.z;
    const reachable =
      b.pos.z > COURT.netZ - 0.3 && Math.abs(dx) < REACH_X && Math.abs(dz) < REACH_Z && b.pos.y < 3;

    if (!reachable) {
      if (this.whiffCooldown <= 0) {
        sfx.whiff();
        this.whiffCooldown = 0.5;
        this.player.startSwing('forehand');
      }
      return;
    }

    const type: ShotType = classifySwing(b.pos.y, dx, this.bounceCount, swing);
    let quality = clamp(1 - (Math.abs(dx) / REACH_X) * 0.45 - (Math.abs(dz) / REACH_Z) * 0.45, 0.15, 1);
    let speedMul = 1;
    if (swing.form) {
      quality = clamp(quality * (0.72 + 0.28 * swing.form.posture), 0.1, 1);
      speedMul = clamp(0.85 + 0.35 * swing.power, 0.78, 1.18);
    }

    // En la Diana, apuntar con la dirección del gesto es la clave
    const aim = {
      x: clamp(swing.dir * 2.9 + (Math.random() - 0.5), -4.4, 4.4),
      z: this.zone ? (this.zone.z0 + this.zone.z1) / 2 + (Math.random() - 0.5) : 3.5 + Math.random() * 4,
    };
    if (this.opts.def.id === 'diana' && this.zone) {
      // El gesto decide el lado; la profundidad la marca la zona activa
      aim.x = clamp(((this.zone.x0 + this.zone.x1) / 2) * 0.35 + swing.dir * 3.1, -4.4, 4.4);
    }
    b.vel = computeShotVelocity(b.pos, aim, type, quality);
    b.vel.x *= speedMul;
    b.vel.z *= speedMul;
    b.spin = type === 'vibora' ? Math.sign(b.vel.x || 1) * SHOT_PARAMS.vibora.spin : 0;
    this.player.startSwing(type);
    sfx.hit(type);
    this.opts.renderer.burst(b.pos, '255, 235, 130', 6, 2.4);
    this.lastHitBy = 'player';
    this.bounceCount = 0;
  }

  // ---------- Fin ----------

  private starsFor(score: number): number {
    const [s1, s2, s3] = this.opts.def.stars;
    return score >= s3 ? 3 : score >= s2 ? 2 : score >= s1 ? 1 : 0;
  }

  private finish(): void {
    this.phase = 'done';
    this.stop();
    this.opts.onFinish({ def: this.opts.def, score: this.score, stars: this.starsFor(this.score) });
  }

  private updateHud(feedback: string): void {
    const head =
      this.opts.def.id === 'diana'
        ? `<b>Bola ${Math.min(Math.max(this.ballIndex, 1), DIANA_BALLS)}/${DIANA_BALLS}</b> · ${this.score} pts · Combo x${this.combo}`
        : `<b>Golpes: ${this.score}</b> · velocidad x${this.pace.toFixed(2)}`;
    ui.setDrillHud(`${head}<br>${feedback}`);
  }

  // ---------- Bucle ----------

  private update(dt: number): void {
    this.whiffCooldown -= dt;
    this.opts.control.update(dt);
    for (const swing of this.opts.control.consumeSwings()) this.trySwing(swing);

    const move = this.opts.control.getMove();
    if (move.mode === 'velocity') {
      this.player.applyMoveInput(move.x, move.z, dt);
    } else {
      let targetZ = 16.5;
      if (this.phase === 'ball' && this.ball.active && this.ball.vel.z > 0.1 && this.lastHitBy === 'machine') {
        const land = this.ball.predictLanding();
        targetZ = clamp(land.z + 0.5, COURT.netZ + 2, COURT.length - 0.6);
      }
      this.player.moveToward(move.x, targetZ, dt);
    }

    // El Muro se mueve hacia la bola y devuelve todo lo que llega
    if (this.opts.def.id === 'muro' && this.phase === 'ball') {
      if (this.ball.active && this.ball.vel.z < -0.1) {
        const land = this.ball.predictLanding();
        this.machine.moveToward(clamp(land.x, -4.5, 4.5), clamp(land.z + 0.5, 0.8, COURT.netZ - 1.3), dt);
        const mdx = Math.abs(this.ball.pos.x - this.machine.x);
        const mdz = Math.abs(this.ball.pos.z - this.machine.z);
        if (this.lastHitBy === 'player' && mdx < REACH_X && mdz < REACH_Z && this.ball.pos.y < 2.6 && this.ball.pos.z < COURT.netZ - 0.5) {
          this.machineReturn();
        }
      } else if (!this.ball.active) {
        this.machine.moveToward(0, 2, dt);
      }
    }

    this.player.update(dt);
    this.machine.update(dt);
    this.ball.update(dt);

    if (this.phase === 'waiting' || this.phase === 'resolved') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.opts.def.id === 'diana' && this.ballIndex >= DIANA_BALLS) {
          this.finish();
        } else {
          this.launchBall();
        }
      }
    }

    // Seguridad: bola muerta sin resolver
    if (this.phase === 'ball' && !this.ball.active) {
      if (this.lastHitBy === 'machine') this.fail('No llegaste a la bola');
      else if (this.opts.def.id === 'diana' && !this.evaluated) this.resolve('🟡 Bola sin bote claro');
      else if (this.opts.def.id === 'muro') this.resolve('↻ Sigue el peloteo');
    }
  }
}
