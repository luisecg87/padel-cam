import { Ball } from '../game/ball';
import { COURT } from '../game/court';
import { PlayerEntity } from '../game/player';
import { gamesLabel, pointsLabel } from '../game/scoring';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { buildInputMsg, decodePose, OnlineSession } from './online';
import type { StateMsg } from './online';
import type { Palette } from '../game/render';
import type { GameRenderer } from '../game/renderers/GameRenderer';
import type { ControlAdapter } from '../ui/input';

// Vista del invitado: no simula nada. Envía su input al anfitrión y renderiza
// el estado recibido con el mundo espejado (el invitado siempre se ve abajo).

interface GuestOptions {
  renderer: GameRenderer;
  control: ControlAdapter;
  session: OnlineSession;
  myName: string;
  rivalName: string;
  rivalPalette: Palette;
  /** Fin del partido: juegos propios y del rival. */
  onEnd(myGames: number, rivalGames: number): void;
  onDrop(): void; // conexión perdida
}

const mx = (x: number): number => -x;
const mz = (z: number): number => COURT.length - z;

// El anfitrión emite ~25 estados/s y aquí se pinta a 60: cada frame se
// persigue el último estado recibido en vez de saltar a él.
const BALL_CHASE = 36; // 1/s
const PLAYER_CHASE = 24;
const SNAP_DIST = 2.5; // m: salto real (saque, reinicio de punto), no se interpola

interface Target {
  x: number;
  z: number;
}

export class GuestMatchView {
  private opts: GuestOptions;
  private ball = new Ball();
  private me = new PlayerEntity('player'); // el invitado, abajo
  private rival = new PlayerEntity('cpu'); // el anfitrión, arriba

  private ballTarget = { x: 0, y: 1, z: COURT.length / 2 };
  private meTarget: Target = { x: this.me.x, z: this.me.z };
  private rivalTarget: Target = { x: this.rival.x, z: this.rival.z };
  private last: StateMsg | null = null;
  private prevBz = 0;
  private prevBy = 0;
  private prevDy = 0;
  private prevDzDir = 0;
  private raf = 0;
  private lastT = 0;
  private running = false;

  constructor(opts: GuestOptions) {
    this.opts = opts;
    opts.session.onMessage = (m) => {
      if (m.t === 'st') this.apply(m);
      else if (m.t === 'end') {
        this.stop();
        const [host, guest] = m.games;
        if (guest > host) sfx.matchWin();
        else sfx.matchLose();
        opts.onEnd(Number(guest) || 0, Number(host) || 0);
      }
    };
    opts.session.onClose = () => {
      this.stop();
      opts.onDrop();
    };
  }

  start(): void {
    this.running = true;
    this.opts.renderer.cpuPalette = this.opts.rivalPalette;
    ui.setHudVisible(true);
    this.showScore([0, 0, 0, 0]);
    this.lastT = performance.now();
    const loop = (t: number): void => {
      if (!this.running) return;
      const dt = Math.min((t - this.lastT) / 1000, 0.04);
      this.lastT = t;
      this.opts.control.update(dt);
      this.opts.session.send(buildInputMsg(this.opts.control));
      // Mis brazos se pintan con la pose local: sin esperar la vuelta por la red
      this.me.livePose = this.last?.replay ? null : this.opts.control.getPose?.() ?? null;
      this.chase(dt);
      this.me.update(dt);
      this.rival.update(dt);
      this.opts.renderer.draw(this.ball, this.me, this.rival, true);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    ui.setHudVisible(false);
    ui.setReplay(false);
  }

  /** Marcador desde MI lado: yo primero, con los nombres de los dos. */
  private showScore(sc: [number, number, number, number]): void {
    ui.updateScore(gamesLabel(sc[1], sc[0]), pointsLabel(sc[3], sc[2]), {
      p1: this.opts.myName,
      p2: this.opts.rivalName,
    });
  }

  private chase(dt: number): void {
    const kb = 1 - Math.exp(-dt * BALL_CHASE);
    const kp = 1 - Math.exp(-dt * PLAYER_CHASE);
    const b = this.ball.pos;
    const t = this.ballTarget;
    if (this.ball.active) {
      if (Math.hypot(t.x - b.x, t.y - b.y, t.z - b.z) > SNAP_DIST) {
        this.ball.pos = { ...t };
        this.ball.trail.length = 0;
      } else {
        this.ball.trail.push({ ...b });
        if (this.ball.trail.length > 9) this.ball.trail.shift();
        b.x += (t.x - b.x) * kb;
        b.y += (t.y - b.y) * kb;
        b.z += (t.z - b.z) * kb;
      }
    } else {
      this.ball.pos = { ...t };
      this.ball.trail.length = 0;
    }
    for (const [p, tg] of [[this.me, this.meTarget], [this.rival, this.rivalTarget]] as const) {
      if (Math.hypot(tg.x - p.x, tg.z - p.z) > SNAP_DIST) {
        p.x = tg.x;
        p.z = tg.z;
      } else {
        p.x += (tg.x - p.x) * kp;
        p.z += (tg.z - p.z) * kp;
      }
    }
  }

  private apply(m: StateMsg): void {
    const { b, p, c } = m;
    // Estado mal formado (versión distinta o datos corruptos): se ignora
    if (![b, p, c, m.sc].every((a) => Array.isArray(a) && a.length === 4)) return;
    if (this.last && m.n <= this.last.n) return; // llegó desordenado: ya hay uno más nuevo
    this.ballTarget = { x: mx(b[0]), y: b[1], z: mz(b[2]) };
    this.ball.active = b[3] === 1;

    // Sonidos inferidos del movimiento (el invitado no simula la física)
    if (this.ball.active) {
      const dzNow = this.ballTarget.z - this.prevBz;
      const dir = Math.abs(dzNow) > 0.02 ? Math.sign(dzNow) : 0;
      if (dir !== 0 && this.prevDzDir !== 0 && dir !== this.prevDzDir) sfx.hit('forehand');
      if (dir !== 0) this.prevDzDir = dir;
      const dyNow = this.ballTarget.y - this.prevBy;
      if (this.prevDy < -0.01 && dyNow > 0.01) sfx.bounce();
      this.prevDy = dyNow;
    } else {
      this.prevDzDir = 0;
      this.prevDy = 0;
    }
    this.prevBz = this.ballTarget.z;
    this.prevBy = this.ballTarget.y;

    // Yo (lado 'cpu' del anfitrión) abajo; el anfitrión arriba
    this.meTarget = { x: mx(c[0]), z: mz(c[1]) };
    this.me.swingType = c[2];
    this.me.swingT = c[3];
    this.rivalTarget = { x: mx(p[0]), z: mz(p[1]) };
    this.rival.swingType = p[2];
    this.rival.swingT = p[3];
    this.rival.livePose = m.replay ? null : decodePose(m.hp);

    // Marcador: al cambiar, suena según quién se llevó el punto o el juego
    const prev = this.last;
    if (!prev || prev.sc.some((v, i) => v !== m.sc[i])) {
      this.showScore(m.sc);
      if (prev) {
        const gameMine = m.sc[1] > prev.sc[1];
        const gameRival = m.sc[0] > prev.sc[0];
        if (gameMine) sfx.gameWin();
        else if (gameRival || m.sc[2] > prev.sc[2]) sfx.pointLose();
        else if (m.sc[3] > prev.sc[3]) sfx.pointWin();
      }
    }
    if (!prev || prev.serve !== m.serve) ui.setServeInfo(m.serve);
    if ((!prev || prev.toastN !== m.toastN) && m.toast) ui.toast(m.toast, 1600);
    if (!prev || prev.replay !== m.replay) ui.setReplay(m.replay);
    this.last = m;
  }
}
