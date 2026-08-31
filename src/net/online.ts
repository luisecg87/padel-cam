import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { clamp } from '../types';
import type { ShotType } from '../types';
import type { ControlAdapter, MoveIntent, SwingEvent } from '../ui/input';

// Partida online 1v1 por WebRTC (P2P). El anfitrión simula el partido completo
// (física, arbitraje, marcador) y retransmite el estado; el invitado envía su
// input y renderiza en espejo. La señalización usa PeerJS (nube pública por
// defecto; configurable con ?peer=host:puerto para un servidor propio).

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
const ID_PREFIX = 'padelcam-v1-';

export function makeCode(): string {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

// ---------- Protocolo ----------

interface InputMsg {
  t: 'in';
  mode: 'v' | 'a'; // velocidad (teclado) o x absoluta (cámara)
  x: number;
  z: number;
  sw: Array<{ d: -1 | 0 | 1; o: boolean; p: number }>;
}

export interface HudState {
  games: string;
  points: string;
  serve: string;
  toast: string;
  toastN: number; // secuencia: el invitado muestra el toast cuando cambia
  replay: boolean;
}

interface StateMsg {
  t: 'st';
  b: [number, number, number, number];
  p: [number, number, ShotType | null, number];
  c: [number, number, ShotType | null, number];
  hud: HudState;
}

interface EndMsg {
  t: 'end';
  title: string;
  games: string;
}

type NetMsg = InputMsg | StateMsg | EndMsg;

// ---------- Conexión ----------

function makePeer(id?: string): Peer {
  // ?peer=host:puerto permite usar un servidor de señalización propio (tests/producción)
  const param = new URLSearchParams(location.search).get('peer');
  if (param) {
    const [host, port] = param.split(':');
    const opts = { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', key: 'peerjs' };
    return id ? new Peer(id, opts) : new Peer(opts);
  }
  return id ? new Peer(id) : new Peer();
}

export type OnlineRole = 'host' | 'guest';

/** Gestiona señalización y canal de datos. Un objeto por partida. */
export class OnlineSession {
  role: OnlineRole;
  code: string;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private closed = false;

  onMessage: ((m: NetMsg) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(role: OnlineRole, code: string) {
    this.role = role;
    this.code = code;
  }

  /** Anfitrión: reserva un código y espera al rival. */
  static host(onReady: (code: string) => void, onPeerJoined: () => void, onError: (e: string) => void): OnlineSession {
    const code = makeCode();
    const s = new OnlineSession('host', code);
    const peer = makePeer(ID_PREFIX + code);
    s.peer = peer;
    peer.on('open', () => onReady(code));
    peer.on('connection', (conn) => {
      if (s.conn) {
        conn.close();
        return; // solo un rival
      }
      s.attach(conn);
      conn.on('open', () => onPeerJoined());
    });
    peer.on('error', (e) => onError(s.describeError(e)));
    return s;
  }

  /** Invitado: se conecta al código del anfitrión. */
  static join(code: string, onConnected: () => void, onError: (e: string) => void): OnlineSession {
    const s = new OnlineSession('guest', code.toUpperCase().trim());
    const peer = makePeer();
    s.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + s.code, { reliable: false });
      s.attach(conn);
      conn.on('open', () => onConnected());
    });
    peer.on('error', (e) => onError(s.describeError(e)));
    return s;
  }

  private describeError(e: { type?: string }): string {
    switch (e.type) {
      case 'peer-unavailable':
        return 'No existe ninguna partida con ese código.';
      case 'unavailable-id':
        return 'Código ocupado, vuelve a intentarlo.';
      case 'network':
      case 'server-error':
      case 'socket-error':
        return 'No se pudo contactar con el servidor de emparejamiento. Revisa tu conexión.';
      default:
        return 'Error de conexión. Inténtalo de nuevo.';
    }
  }

  private attach(conn: DataConnection): void {
    this.conn = conn;
    conn.on('data', (d) => {
      if (d && typeof d === 'object' && 't' in (d as Record<string, unknown>)) {
        this.onMessage?.(d as NetMsg);
      }
    });
    const bye = () => {
      if (!this.closed) {
        this.closed = true;
        this.onClose?.();
      }
    };
    conn.on('close', bye);
    conn.on('error', bye);
  }

  get connected(): boolean {
    return !!this.conn?.open;
  }

  send(m: NetMsg): void {
    if (this.conn?.open) this.conn.send(m);
  }

  destroy(): void {
    this.closed = true;
    this.onClose = null;
    this.onMessage = null;
    try {
      this.conn?.close();
      this.peer?.destroy();
    } catch {
      /* ya cerrado */
    }
  }
}

// ---------- Lado anfitrión: el rival remoto como ControlAdapter ----------

/** Adaptador de control alimentado por los mensajes de input del invitado. */
export class RemoteControl implements ControlAdapter {
  private move: MoveIntent = { mode: 'velocity', x: 0, z: 0 };
  private swings: SwingEvent[] = [];

  feed(m: InputMsg): void {
    this.move =
      m.mode === 'a'
        ? { mode: 'absolute', x: clamp(m.x, -4.6, 4.6) }
        : { mode: 'velocity', x: clamp(m.x, -1, 1), z: clamp(m.z, -1, 1) };
    for (const s of m.sw) {
      this.swings.push({ dir: s.d, overhead: s.o, power: clamp(s.p, 0, 1) });
    }
  }

  update(_dt: number): void {}

  getMove(): MoveIntent {
    return this.move;
  }

  consumeSwings(): SwingEvent[] {
    const s = this.swings;
    this.swings = [];
    return s;
  }

  destroy(): void {}
}

// ---------- Lado invitado: convertir el control local a coordenadas del anfitrión ----------

/**
 * El invitado se ve a sí mismo abajo (mundo espejado: x' = -x, z' = L - z),
 * así que su input se invierte antes de enviarse al anfitrión.
 */
export function buildInputMsg(control: ControlAdapter): InputMsg {
  const mv = control.getMove();
  const sw = control.consumeSwings().map((s) => ({
    d: (s.dir * -1) as -1 | 0 | 1,
    o: s.overhead,
    p: s.power,
  }));
  if (mv.mode === 'absolute') {
    return { t: 'in', mode: 'a', x: -mv.x, z: 0, sw };
  }
  return { t: 'in', mode: 'v', x: -mv.x, z: -mv.z, sw };
}
