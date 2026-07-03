import { Ball } from '../game/ball';
import { COURT, sideOfZ } from '../game/court';
import { PlayerEntity, REACH_X, REACH_Z } from '../game/player';
import { classifySwing, computeShotVelocity, SHOT_PARAMS } from '../game/shots';
import { GRAVITY, BALL_RADIUS } from '../game/ball';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { clamp, SHOT_ARTICLES, SHOT_NAMES } from '../types';
import type { Report } from '../analysis/coach';
import type { GameRenderer } from '../game/renderers/GameRenderer';
import type { ControlAdapter, SwingEvent } from '../ui/input';
import type { ControlMode, DrillType, ShotType } from '../types';

const N_BALLS = 10;

export interface PracticeOptions {
  renderer: GameRenderer;
  control: ControlAdapter;
  controlMode: ControlMode;
  drill: DrillType;
  onFinish(report: Report): void;
}

interface Attempt {
  expected: ShotType;
  hitType: ShotType | null;
  timing: number;
  quality: number;
  success: boolean;
  failReason: string | null;
}

export class PracticeMode {
  private opts: PracticeOptions;
  private ball = new Ball();
  private player = new PlayerEntity('player');
  private machine = new PlayerEntity('cpu'); // el "lanza-bolas" visual

  private ballIndex = 0;
  private attempts: Attempt[] = [];
  private whiffs = 0;
  private streak = 0;
  private bestStreak = 0;

  private phase: 'waiting' | 'ball' | 'resolved' | 'done' = 'waiting';
  private timer = 1.2;
  private expected: ShotType = 'forehand';
  private lastHitBy: 'machine' | 'player' = 'machine';
  private bounceCount = 0;
  private playerShotEvaluated = false;
  private currentAttempt: Attempt | null = null;
  private whiffCooldown = 0;

  private raf = 0;
  private lastT = 0;
  private running = false;

  constructor(opts: PracticeOptions) {
    this.opts = opts;
    this.machine.x = 0;
    this.machine.z = 1.5;
    if (opts.controlMode === 'camera') this.player.speed = 8;

    this.ball.callbacks = {
      onGround: (pos) => {
        sfx.bounce();
        this.opts.renderer.burst(pos, '150, 200, 240', 5, 1.4);
        this.onGround(pos.z);
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
    ui.updateScore('Modo práctica', this.drillLabel());
    ui.setServeInfo('');
    this.updateDrillHud('¡Prepárate!');
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
    ui.setHudVisible(false);
    ui.setDrillHud(null);
  }

  private drillLabel(): string {
    if (this.opts.drill === 'mixto') return 'Golpes variados';
    if (this.opts.drill === 'volley') return 'Drill de voleas';
    return `Drill de ${SHOT_NAMES[this.opts.drill]}`;
  }

  // ---------- Lanzamiento de bolas ----------

  private launchBall(): void {
    this.ballIndex++;
    const drill = this.opts.drill;
    if (drill === 'mixto') {
      const pool: ShotType[] = [
        'forehand', 'backhand', 'volleyFh', 'volleyBh', 'bandeja', 'vibora', 'smash',
      ];
      this.expected = pool[Math.floor(Math.random() * pool.length)];
    } else if (drill === 'volley') {
      // El drill de voleas alterna derecha y revés
      this.expected = Math.random() < 0.5 ? 'volleyFh' : 'volleyBh';
    } else {
      this.expected = drill;
    }

    this.machine.x = (Math.random() - 0.5) * 4;
    const from = { x: this.machine.x, y: 1.1, z: this.machine.z };
    let vel;
    switch (this.expected) {
      case 'backhand': {
        const target = { x: -(1.6 + Math.random() * 1.8), z: 15 + Math.random() * 1.8 };
        vel = computeShotVelocity(from, target, 'forehand', 0.95);
        break;
      }
      case 'volleyFh':
      case 'volleyBh': {
        // Bola tensa y sin bote, hacia el lado del golpe pedido
        const side = this.expected === 'volleyFh' ? 1 : -1;
        const target = { x: side * (0.8 + Math.random() * 2), z: 16.5 };
        vel = computeShotVelocity(from, target, 'smash', 0.95);
        vel.y += 1.2; // que llegue a media altura, no al suelo
        break;
      }
      case 'smash':
      case 'bandeja':
      case 'vibora': {
        // Globo lento y alto
        const target = { x: (Math.random() - 0.5) * 2.4, z: 14 + Math.random() * 1.5 };
        const dx = target.x - from.x;
        const dz = target.z - from.z;
        const t = Math.hypot(dx, dz) / 4.6;
        vel = {
          x: dx / t,
          z: dz / t,
          y: (BALL_RADIUS - from.y) / t + 0.5 * GRAVITY * t,
        };
        break;
      }
      default: {
        const target = { x: 1.6 + Math.random() * 1.8, z: 15 + Math.random() * 1.8 };
        vel = computeShotVelocity(from, target, 'forehand', 0.95);
      }
    }
    this.ball.launch(from, vel);
    this.machine.startSwing('forehand');

    this.lastHitBy = 'machine';
    this.bounceCount = 0;
    this.playerShotEvaluated = false;
    this.currentAttempt = {
      expected: this.expected,
      hitType: null,
      timing: 0,
      quality: 0,
      success: false,
      failReason: null,
    };
    this.phase = 'ball';
    this.updateDrillHud(`🎯 ${this.hintFor(this.expected)}`);
  }

  private hintFor(t: ShotType): string {
    switch (t) {
      case 'forehand': return '¡Viene a tu derecha!';
      case 'backhand': return '¡Viene a tu revés!';
      case 'volleyFh': return '¡Volea de derecha, no la dejes botar!';
      case 'volleyBh': return '¡Volea de revés, no la dejes botar!';
      case 'smash': return '¡Globo! Remate: golpe fuerte por encima de la cabeza';
      case 'bandeja': return '¡Globo! Bandeja: golpe suave de control, sin gesto de remate';
      case 'vibora': return '¡Globo! Víbora: remata cruzando el brazo en diagonal';
      default: return '';
    }
  }

  private isVolleyDrill(): boolean {
    return this.expected === 'volleyFh' || this.expected === 'volleyBh';
  }

  // ---------- Árbitro del drill ----------

  private onGround(z: number): void {
    if (this.phase !== 'ball') return;
    this.bounceCount++;
    if (this.lastHitBy === 'machine') {
      if (this.isVolleyDrill() && this.bounceCount === 1 && sideOfZ(z) === 'player') {
        // En el drill de volea, dejarla botar ya es fallo
        this.resolveAttempt(false, 'La dejaste botar: la volea se golpea en el aire');
        return;
      }
      if (this.bounceCount >= 2) {
        this.resolveAttempt(false, 'No llegaste a la bola: muévete en cuanto salga lanzada');
      }
    } else {
      // Primer bote tras el golpe del jugador decide el resultado
      if (!this.playerShotEvaluated) {
        this.playerShotEvaluated = true;
        if (sideOfZ(z) === 'cpu') this.resolveAttempt(true, null);
        else this.resolveAttempt(false, 'Tu golpe no cruzó la red');
      }
    }
  }

  private onWall(): void {
    if (this.phase !== 'ball') return;
    if (this.lastHitBy === 'player' && this.bounceCount === 0 && !this.playerShotEvaluated) {
      this.playerShotEvaluated = true;
      this.resolveAttempt(false, 'Demasiado fuerte: directa a la pared (fuera)');
    }
  }

  private onNet(): void {
    if (this.phase !== 'ball') return;
    if (this.lastHitBy === 'player') {
      this.resolveAttempt(false, 'Red: dale un poco más de arco al golpe');
    } else {
      this.phase = 'resolved'; // bola de máquina defectuosa: repetir sin contar
      this.ballIndex--;
      this.timer = 0.8;
    }
  }

  private onOut(): void {
    if (this.phase !== 'ball') return;
    if (this.lastHitBy === 'player') {
      this.resolveAttempt(false, 'Fuera por encima del cristal: controla la fuerza');
    } else {
      this.phase = 'resolved';
      this.ballIndex--;
      this.timer = 0.8;
    }
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
        this.whiffs++;
        sfx.whiff();
        this.whiffCooldown = 0.5;
        this.player.startSwing('forehand');
        this.updateDrillHud('💨 Al aire: espera a que la bola llegue a ti');
      }
      return;
    }

    const type = classifySwing(b.pos.y, dx, this.bounceCount, swing);

    let quality = clamp(1 - (Math.abs(dx) / REACH_X) * 0.45 - (Math.abs(dz) / REACH_Z) * 0.45, 0.15, 1);
    let speedMul = 1;
    // La técnica del gesto real también cuenta en la práctica
    if (swing.form) {
      quality = clamp(quality * (0.72 + 0.28 * swing.form.posture), 0.1, 1);
      speedMul = clamp(0.85 + 0.35 * swing.power, 0.78, 1.18);
    }
    const timing = b.pos.z - (p.z - 0.5);

    if (this.currentAttempt) {
      this.currentAttempt.hitType = type;
      this.currentAttempt.timing = timing;
      this.currentAttempt.quality = quality;
    }

    let aim: { x: number; z: number };
    if (type === 'vibora') {
      aim = { x: clamp(swing.dir * 3.9 + (Math.random() - 0.5) * 0.8, -4.6, 4.6), z: 3.5 + Math.random() * 2.5 };
    } else if (type === 'bandeja') {
      aim = { x: clamp(swing.dir * 2.2 + (Math.random() - 0.5), -4, 4), z: 1.8 + Math.random() * 2.2 };
    } else {
      aim = { x: clamp(swing.dir * 2.5 + (Math.random() - 0.5), -4.2, 4.2), z: 3.5 + Math.random() * 4 };
    }
    b.vel = computeShotVelocity(b.pos, aim, type, quality);
    b.vel.x *= speedMul;
    b.vel.z *= speedMul;
    b.spin = type === 'vibora' ? Math.sign(b.vel.x || 1) * SHOT_PARAMS.vibora.spin : 0;
    this.player.startSwing(type);
    sfx.hit(type);
    this.opts.renderer.burst(b.pos, '255, 235, 130', 6, 2.4);
    if (type === 'smash') this.opts.renderer.shake(7);
    else if (type === 'vibora') this.opts.renderer.shake(5);
    this.lastHitBy = 'player';
    this.bounceCount = 0;
  }

  // ---------- Evaluación y feedback ----------

  private resolveAttempt(landedIn: boolean, failReason: string | null): void {
    if (this.phase !== 'ball') return;
    const a = this.currentAttempt;
    if (!a) return;
    this.phase = 'resolved';
    this.timer = 1.6;
    this.ball.active = false;

    const correctType = a.hitType === null ? false : a.hitType === a.expected;
    a.success = landedIn && a.hitType !== null && correctType;
    a.failReason = failReason;
    this.attempts.push(a);

    let fb: string;
    if (a.hitType === null) {
      fb = `❌ ${failReason ?? 'Fallo'}`;
      this.streak = 0;
      sfx.bad();
    } else if (!landedIn) {
      fb = `❌ ${failReason}`;
      this.streak = 0;
      sfx.bad();
    } else if (!correctType) {
      fb = `🟡 Dentro, pero fue ${SHOT_NAMES[a.hitType]} y tocaba ${SHOT_NAMES[a.expected]}`;
      this.streak = 0;
      sfx.bad();
    } else {
      sfx.good();
      const timingTxt =
        a.timing > 0.5 ? ' (llegaste un poco tarde)' : a.timing < -0.5 ? ' (un poco pronto)' : ' ¡timing perfecto!';
      const fem = SHOT_ARTICLES[a.expected] === 'la';
      fb = a.quality > 0.75
        ? `✅ ¡${SHOT_NAMES[a.expected]} ${fem ? 'perfecta' : 'perfecto'}!${timingTxt}`
        : `✅ ${fem ? 'Buena' : 'Buen'} ${SHOT_NAMES[a.expected]}${timingTxt}`;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    }
    this.updateDrillHud(fb);
  }

  private updateDrillHud(feedback: string): void {
    const hits = this.attempts.filter((a) => a.success).length;
    ui.setDrillHud(
      `<b>Bola ${Math.min(this.ballIndex, N_BALLS)}/${N_BALLS}</b> · Aciertos ${hits} · Racha ${this.streak}<br>${feedback}`,
    );
  }

  // ---------- Informe final ----------

  private buildReport(): Report {
    const hits = this.attempts.filter((a) => a.success).length;
    const late = this.attempts.filter((a) => a.hitType !== null && a.timing > 0.5).length;
    const early = this.attempts.filter((a) => a.hitType !== null && a.timing < -0.5).length;
    const wrongType = this.attempts.filter(
      (a) => a.hitType !== null && a.hitType !== a.expected,
    ).length;
    const noReach = this.attempts.filter((a) => a.hitType === null).length;
    const avgQ =
      this.attempts.filter((a) => a.hitType !== null).reduce((s, a) => s + a.quality, 0) /
      Math.max(1, this.attempts.filter((a) => a.hitType !== null).length);

    const stats = [
      { lbl: 'Aciertos', val: `${hits} / ${this.attempts.length}` },
      { lbl: 'Mejor racha', val: `${this.bestStreak}` },
      { lbl: 'Calidad media', val: `${Math.round(avgQ * 100)}%` },
      { lbl: 'Golpes al aire', val: `${this.whiffs}` },
    ];

    const tips: Report['tips'] = [];
    if (late >= 3) {
      tips.push({
        id: 'timing-tarde',
        warn: true,
        text: `Llegaste tarde ${late} veces. Colócate donde va a botar la bola ANTES de que bote, y golpea cuando esté a la altura de tu cadera.`,
      });
    }
    if (early >= 3) {
      tips.push({
        id: 'timing-pronto',
        warn: true,
        text: `Golpeaste demasiado pronto ${early} veces. Espera a que la bola baje tras el bote: en pádel hay más tiempo del que crees.`,
      });
    }
    if (noReach >= 3) {
      tips.push({
        id: 'llegar-bola',
        warn: true,
        text: `${noReach} bolas se te escaparon sin llegar. Muévete en cuanto la bola salga lanzada, no cuando ya esté en tu lado.`,
      });
    }
    if (wrongType >= 2) {
      tips.push({
        id: 'eleccion-golpe',
        warn: true,
        text: `${wrongType} veces usaste un golpe distinto al pedido. Lee la bola: si no ha botado y estás adelantado es volea; si viene alta y lenta, remate.`,
      });
    }
    if (this.whiffs >= 3) {
      tips.push({
        id: 'golpes-al-aire',
        warn: true,
        text: `${this.whiffs} golpes al aire: no muevas el brazo hasta que la bola esté entrando en tu zona de alcance.`,
      });
    }
    if (hits >= this.attempts.length * 0.8 && this.attempts.length > 0) {
      tips.push({
        warn: false,
        text: '¡Gran sesión! Sube la dificultad o juega un partido para poner a prueba este golpe.',
      });
    }
    if (tips.length === 0) {
      tips.push({ warn: false, text: 'Buen trabajo. Repite el drill buscando una racha perfecta de 10.' });
    }
    return { stats, tips: tips.slice(0, 5) };
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
      // En volea el juego te adelanta a la red; en el resto, según la bola
      let targetZ = this.isVolleyDrill() && this.phase === 'ball' ? 12.6 : 16.5;
      if (
        this.phase === 'ball' &&
        !this.isVolleyDrill() &&
        this.ball.active &&
        this.ball.vel.z > 0.1 &&
        this.lastHitBy === 'machine'
      ) {
        const land = this.ball.predictLanding();
        targetZ = clamp(land.z + 0.5, COURT.netZ + 2, COURT.length - 0.6);
      }
      this.player.moveToward(move.x, targetZ, dt);
    }

    this.player.update(dt);
    this.machine.update(dt);
    this.ball.update(dt);

    if (this.phase === 'waiting' || this.phase === 'resolved') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.ballIndex >= N_BALLS) {
          this.phase = 'done';
          this.stop();
          this.opts.onFinish(this.buildReport());
        } else {
          this.launchBall();
        }
      }
    }

    // Seguridad: si la bola de máquina muere sin resolverse (se queda rodando)
    if (this.phase === 'ball' && !this.ball.active && this.currentAttempt) {
      if (this.lastHitBy === 'machine') {
        this.resolveAttempt(false, 'No llegaste a la bola');
      } else if (!this.playerShotEvaluated) {
        this.resolveAttempt(true, null);
      }
    }
  }
}
