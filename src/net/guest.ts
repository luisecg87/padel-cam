import { Ball } from '../game/ball';
import { COURT } from '../game/court';
import { PlayerEntity } from '../game/player';
import { sfx } from '../audio/sfx';
import { ui } from '../ui/screens';
import { buildInputMsg, OnlineSession } from './online';
import type { HudState, MatchNetState } from './online';
import type { GameRenderer } from '../game/renderers/GameRenderer';
import type { ControlAdapter } from '../ui/input';

// Vista del invitado: no simula nada. Envía su input al anfitrión y renderiza
// el estado recibido con el mundo espejado (el invitado siempre se ve abajo).

interface GuestOptions {
  renderer: GameRenderer;
  control: ControlAdapter;
  session: OnlineSession;
  onEnd(title: string, games: string): void;
  onDrop(): void; // conexión perdida
}

const mx = (x: number): number => -x;
const mz = (z: number): number => COURT.length - z;

export class GuestMatchView {
  private opts: GuestOptions;
  private ball = new Ball();
  private me = new PlayerEntity('player'); // el invitado, abajo
  private rival = new PlayerEntity('cpu'); // el anfitrión, arriba

  private hud: HudState | null = null;
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
        opts.onEnd(m.title, m.games);
      }
    };
    opts.session.onClose = () => {
      this.stop();
      opts.onDrop();
    };
  }

  start(): void {
    this.running = true;
    ui.setHudVisible(true);
    ui.updateScore('Partida online', '');
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min((t - this.lastT) / 1000, 0.04);
      this.lastT = t;
      this.opts.control.update(dt);
      this.opts.session.send(buildInputMsg(this.opts.control));
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

  private apply({ b, p, c, hud }: MatchNetState): void {
    // Bola espejada + estela local
    this.ball.trail.push({ ...this.ball.pos });
    if (this.ball.trail.length > 9) this.ball.trail.shift();
    this.ball.pos = { x: mx(b[0]), y: b[1], z: mz(b[2]) };
    this.ball.active = b[3] === 1;
    if (!this.ball.active) this.ball.trail.length = 0;

    // Sonidos inferidos del movimiento (el invitado no simula la física)
    if (this.ball.active) {
      const dzNow = this.ball.pos.z - this.prevBz;
      const dir = Math.abs(dzNow) > 0.02 ? Math.sign(dzNow) : 0;
      if (dir !== 0 && this.prevDzDir !== 0 && dir !== this.prevDzDir) sfx.hit('forehand');
      if (dir !== 0) this.prevDzDir = dir;
      const dyNow = this.ball.pos.y - this.prevBy;
      if (this.prevDy < -0.01 && dyNow > 0.01) sfx.bounce();
      this.prevDy = dyNow;
    } else {
      this.prevDzDir = 0;
      this.prevDy = 0;
    }
    this.prevBz = this.ball.pos.z;
    this.prevBy = this.ball.pos.y;

    // Yo (lado 'cpu' del anfitrión) abajo; el anfitrión arriba
    this.me.x = mx(c[0]);
    this.me.z = mz(c[1]);
    this.me.swingType = c[2];
    this.me.swingT = c[3];
    this.rival.x = mx(p[0]);
    this.rival.z = mz(p[1]);
    this.rival.swingType = p[2];
    this.rival.swingT = p[3];

    // HUD y eventos tipados retransmitidos
    if (!this.hud || this.hud.games !== hud.games || this.hud.points !== hud.points) {
      ui.updateScore(hud.games, hud.points);
    }
    if (!this.hud || this.hud.serve !== hud.serve) ui.setServeInfo(hud.serve);
    if ((!this.hud || this.hud.toastN !== hud.toastN) && hud.toast) {
      ui.toast(hud.toast, 1600);
      const evt = hud.toastEvt;
      if (evt?.kind === 'match') {
        sfx.cheer(true);
      } else if (evt?.kind === 'game' && evt.winner === 'cpu') {
        sfx.gameWin();
      } else if (evt?.kind === 'point' || evt?.kind === 'game') {
        if (evt.winner === 'cpu') sfx.pointWin();
        else if (evt.winner === 'player') sfx.pointLose();
      } else if (evt?.kind === 'fault') {
        sfx.fault();
      }
    }
    if (!this.hud || this.hud.replay !== hud.replay) ui.setReplay(hud.replay);
    this.hud = hud;
  }
}
