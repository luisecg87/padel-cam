// Adaptador de control común: teclado/táctil y cámara implementan esta interfaz.

export interface SwingEvent {
  dir: -1 | 0 | 1; // hacia dónde se dirige el golpe (izq/centro/dcha)
  overhead: boolean; // gesto por encima de la cabeza (remate/bandeja/víbora)
  power: number; // 0..1: fuerza del gesto (cámara: velocidad de la muñeca)
}

export type MoveIntent =
  | { mode: 'velocity'; x: number; z: number } // -1..1 (teclado/táctil)
  | { mode: 'absolute'; x: number }; // posición x de pista deseada (cámara)

export interface ControlAdapter {
  update(dt: number): void;
  getMove(): MoveIntent;
  consumeSwings(): SwingEvent[];
  destroy(): void;
}

/**
 * Teclado dividido para el duelo local: cada jugador usa una mitad.
 * 'wasd' = WASD + ESPACIO (jugador cercano) · 'arrows' = flechas + ENTER (jugador de fondo).
 */
export class SplitKeyboardControl implements ControlAdapter {
  private keys = new Set<string>();
  private swings: SwingEvent[] = [];
  private map: { left: string; right: string; up: string; down: string; hit: string[] };

  constructor(scheme: 'wasd' | 'arrows') {
    this.map =
      scheme === 'wasd'
        ? { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', hit: ['Space', 'KeyF'] }
        : { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', hit: ['Enter', 'Numpad0'] };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (this.map.hit.includes(e.code)) {
      e.preventDefault();
      this.swings.push({
        dir: this.keys.has(this.map.left) ? -1 : this.keys.has(this.map.right) ? 1 : 0,
        overhead: this.keys.has(this.map.up),
        power: 1,
      });
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  update(_dt: number): void {}

  getMove(): MoveIntent {
    let x = 0;
    let z = 0;
    if (this.keys.has(this.map.left)) x -= 1;
    if (this.keys.has(this.map.right)) x += 1;
    if (this.keys.has(this.map.up)) z -= 1;
    if (this.keys.has(this.map.down)) z += 1;
    return { mode: 'velocity', x, z };
  }

  consumeSwings(): SwingEvent[] {
    const s = this.swings;
    this.swings = [];
    return s;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}

export class KeyboardTouchControl implements ControlAdapter {
  private keys = new Set<string>();
  private swings: SwingEvent[] = [];
  private touchMove = { x: 0, z: 0 };
  private touchId: number | null = null;
  private touchStart = { x: 0, y: 0 };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'Space' || e.code === 'KeyJ') {
      e.preventDefault();
      this.swings.push({
        dir: this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? -1
          : this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0,
        overhead: this.keys.has('ArrowUp') || this.keys.has('KeyW'),
        power: 1, // con teclado, ↑/W marca remate; sin ↑ la bola alta sale de bandeja
      });
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onTouchStart = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth / 2 && this.touchId === null) {
        // Mitad izquierda: joystick virtual
        this.touchId = t.identifier;
        this.touchStart = { x: t.clientX, y: t.clientY };
      } else {
        // Mitad derecha: golpe (la zona del toque marca la dirección)
        const rel = (t.clientX - window.innerWidth * 0.75) / (window.innerWidth * 0.25);
        this.swings.push({
          dir: rel < -0.33 ? -1 : rel > 0.33 ? 1 : 0,
          overhead: t.clientY < window.innerHeight * 0.35,
          power: 1,
        });
      }
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.touchId) {
        this.touchMove.x = Math.max(-1, Math.min(1, (t.clientX - this.touchStart.x) / 60));
        this.touchMove.z = Math.max(-1, Math.min(1, (t.clientY - this.touchStart.y) / 60));
      }
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.touchId) {
        this.touchId = null;
        this.touchMove = { x: 0, z: 0 };
      }
    }
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { passive: true });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
  }

  update(_dt: number): void {}

  getMove(): MoveIntent {
    let x = this.touchMove.x;
    let z = this.touchMove.z;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) x += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) z -= 1;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) z += 1;
    return { mode: 'velocity', x: Math.max(-1, Math.min(1, x)), z: Math.max(-1, Math.min(1, z)) };
  }

  consumeSwings(): SwingEvent[] {
    const s = this.swings;
    this.swings = [];
    return s;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('touchend', this.onTouchEnd);
  }
}
