import type { DataConnection, Peer } from 'peerjs';
import { clamp } from '../types';
import type { ShotType } from '../types';
import type { Palette } from '../game/render';
import type { ArmPose, ControlAdapter, LivePose, MoveIntent, SwingEvent } from '../ui/input';

// Partida online 1v1 por WebRTC (P2P). El anfitrión simula el partido completo
// (física, arbitraje, marcador) y retransmite el estado; el invitado envía su
// input y renderiza en espejo. La señalización usa PeerJS (nube pública por
// defecto; configurable con ?peer=host:puerto para un servidor propio).
//
// La conexión sobrevive al final del partido: así los dos pueden pedir
// revancha sin volver a compartir código.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
const CODE_LEN = 4;
// v2: saludo con nombre/equipación, pose en vivo y revancha (incompatible con v1)
const ID_PREFIX = 'padelcam-v2-';
/** Parámetro de la URL de invitación: abrirla lleva directo a unirse a la sala. */
export const INVITE_PARAM = 'sala';

export function makeCode(): string {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

/** Normaliza un código tecleado o llegado por URL; null si no es válido. */
export function parseCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').toUpperCase().trim();
  if (code.length !== CODE_LEN) return null;
  return [...code].every((ch) => CODE_CHARS.includes(ch)) ? code : null;
}

/** Enlace para invitar al rival: al abrirlo solo tiene que pulsar "Unirse". */
export function inviteUrl(code: string): string {
  const url = new URL(location.href);
  const peer = url.searchParams.get('peer'); // servidor de señalización propio: el rival necesita el mismo
  url.search = '';
  url.hash = '';
  if (peer) url.searchParams.set('peer', peer);
  url.searchParams.set(INVITE_PARAM, code);
  return url.toString();
}

// ---------- Protocolo ----------

/** Quién es cada jugador: se intercambia una vez, al conectar. */
export interface PeerInfo {
  name: string;
  pal: Palette;
}

interface HelloMsg {
  t: 'hi';
  name: string;
  pal: Palette;
}

interface InputMsg {
  t: 'in';
  mode: 'v' | 'a'; // velocidad (teclado) o x absoluta (cámara)
  x: number;
  z: number;
  /** Golpes: dirección, alto, potencia y forma técnica [postura, extensión | -1]. */
  sw: Array<{ d: -1 | 0 | 1; o: boolean; p: number; f: [number, number] | null }>;
  ps: number[] | null; // pose en vivo del invitado (ver encodePose)
}

export interface StateMsg {
  t: 'st';
  n: number; // secuencia: el canal no garantiza el orden, el invitado descarta lo viejo
  b: [number, number, number, number];
  p: [number, number, ShotType | null, number];
  c: [number, number, ShotType | null, number];
  /** Marcador en crudo [juegos anfitrión, juegos invitado, puntos anfitrión, puntos invitado]. */
  sc: [number, number, number, number];
  serve: string;
  toast: string;
  toastN: number; // secuencia: el invitado muestra el toast cuando cambia
  replay: boolean;
  hp: number[] | null; // pose en vivo del anfitrión
}

interface EndMsg {
  t: 'end';
  games: [number, number]; // [anfitrión, invitado]
}

/** 're' = quiero revancha · 'go' = el anfitrión arranca la revancha. */
interface RematchMsg {
  t: 're' | 'go';
}

export type NetMsg = HelloMsg | InputMsg | StateMsg | EndMsg | RematchMsg;

// ---------- Datos del rival: nunca se confía en lo que llega por la red ----------

const HEX = /^#[0-9a-f]{6}$/i;

/** Nombre mostrable: sin caracteres de marcado (se pinta también como HTML en el historial). */
export function cleanName(raw: unknown, fallback: string): string {
  const name = String(raw ?? '')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 14);
  return name || fallback;
}

function cleanPalette(raw: unknown, fallback: Palette): Palette {
  const p = (raw ?? {}) as Record<string, unknown>;
  const pick = (k: keyof Palette): string => (typeof p[k] === 'string' && HEX.test(p[k] as string) ? (p[k] as string) : fallback[k]);
  return { shirt: pick('shirt'), shirtDark: pick('shirtDark'), shorts: pick('shorts'), skin: pick('skin'), hair: pick('hair') };
}

// ---------- Pose en vivo por la red ----------

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** [¿dcha?, ex, ey, hx, hy, ¿izq?, ex, ey, hx, hy, tilt] con 2 decimales. */
export function encodePose(p: LivePose | null): number[] | null {
  if (!p) return null;
  const arm = (a: ArmPose | null): number[] => (a ? [1, r2(a.ex), r2(a.ey), r2(a.hx), r2(a.hy)] : [0, 0, 0, 0, 0]);
  return [...arm(p.right), ...arm(p.left), r2(p.tilt)];
}

export function decodePose(raw: unknown): LivePose | null {
  if (!Array.isArray(raw) || raw.length !== 11 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  const a = raw as number[];
  const arm = (i: number): ArmPose | null =>
    a[i] === 1
      ? { ex: clamp(a[i + 1], -3, 3), ey: clamp(a[i + 2], -3, 3), hx: clamp(a[i + 3], -3, 3), hy: clamp(a[i + 4], -3, 3) }
      : null;
  return { right: arm(0), left: arm(5), tilt: clamp(a[10], -0.35, 0.35) };
}

// ---------- Conexión ----------

/**
 * PeerJS se carga con import() dinámico: solo lo descarga quien entra al
 * online, no todo el que abre el juego.
 */
async function makePeer(id?: string): Promise<Peer> {
  const { Peer: PeerCtor } = await import('peerjs');
  // ?peer=host:puerto permite usar un servidor de señalización propio (tests/producción)
  const param = new URLSearchParams(location.search).get('peer');
  if (param) {
    const [host, port] = param.split(':');
    const opts = { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', key: 'peerjs' };
    return id ? new PeerCtor(id, opts) : new PeerCtor(opts);
  }
  return id ? new PeerCtor(id) : new PeerCtor();
}

export type OnlineRole = 'host' | 'guest';

/** Gestiona señalización y canal de datos. Un objeto por rival (dura varias partidas). */
export class OnlineSession {
  role: OnlineRole;
  code: string;
  /** Datos del rival: disponibles desde que llega su saludo. */
  rival: PeerInfo | null = null;
  private me: PeerInfo;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private closed = false;
  private onRival: (() => void) | null = null;

  onMessage: ((m: NetMsg) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(role: OnlineRole, code: string, me: PeerInfo) {
    this.role = role;
    this.code = code;
    this.me = me;
  }

  /** Anfitrión: reserva un código y espera al rival. */
  static host(
    me: PeerInfo,
    onReady: (code: string) => void,
    onPeerJoined: () => void,
    onError: (e: string) => void,
  ): OnlineSession {
    const code = makeCode();
    const s = new OnlineSession('host', code, me);
    s.onRival = onPeerJoined;
    void s.open(ID_PREFIX + code, onError, (peer) => {
      peer.on('open', () => onReady(code));
      peer.on('connection', (conn) => {
        if (s.conn) {
          conn.close();
          return; // solo un rival
        }
        s.attach(conn);
      });
    });
    return s;
  }

  /** Invitado: se conecta al código del anfitrión. */
  static join(code: string, me: PeerInfo, onConnected: () => void, onError: (e: string) => void): OnlineSession {
    const s = new OnlineSession('guest', code.toUpperCase().trim(), me);
    s.onRival = onConnected;
    void s.open(undefined, onError, (peer) => {
      peer.on('open', () => {
        s.attach(peer.connect(ID_PREFIX + s.code, { reliable: false }));
      });
    });
    return s;
  }

  /** Carga PeerJS, abre la señalización y deja que `wire` enganche los eventos del rol. */
  private async open(id: string | undefined, onError: (e: string) => void, wire: (peer: Peer) => void): Promise<void> {
    let peer: Peer;
    try {
      peer = await makePeer(id);
    } catch {
      onError('No se pudo cargar el modo online. Revisa tu conexión.');
      return;
    }
    if (this.closed) {
      peer.destroy(); // se canceló mientras cargaba
      return;
    }
    this.peer = peer;
    peer.on('error', (e) => onError(this.describeError(e)));
    wire(peer);
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
    // Saludo: cada lado se presenta en cuanto abre el canal; la partida
    // arranca cuando llega el saludo del otro (así ya hay nombre y colores).
    conn.on('open', () => this.send({ t: 'hi', name: this.me.name, pal: this.me.pal }));
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object' || !('t' in (d as Record<string, unknown>))) return;
      const m = d as NetMsg;
      if (m.t === 'hi') {
        if (this.rival) return; // un solo saludo por conexión
        this.rival = {
          name: cleanName(m.name, this.role === 'host' ? 'Invitado' : 'Anfitrión'),
          pal: cleanPalette(m.pal, this.me.pal),
        };
        const cb = this.onRival;
        this.onRival = null;
        cb?.();
        return;
      }
      this.onMessage?.(m);
    });
    const bye = (): void => {
      if (!this.closed) {
        this.closed = true;
        this.onClose?.();
      }
    };
    conn.on('close', bye);
    conn.on('error', bye);
  }

  get connected(): boolean {
    return !this.closed && !!this.conn?.open;
  }

  send(m: NetMsg): void {
    if (this.conn?.open) this.conn.send(m);
  }

  destroy(): void {
    this.closed = true;
    this.onClose = null;
    this.onMessage = null;
    this.onRival = null;
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
  private pose: LivePose | null = null;

  feed(m: InputMsg): void {
    this.move =
      m.mode === 'a'
        ? { mode: 'absolute', x: clamp(Number(m.x) || 0, -4.6, 4.6) }
        : { mode: 'velocity', x: clamp(Number(m.x) || 0, -1, 1), z: clamp(Number(m.z) || 0, -1, 1) };
    for (const s of Array.isArray(m.sw) ? m.sw : []) {
      // La forma técnica viaja con el golpe: con cámara, el gesto del invitado
      // pesa en el juego exactamente igual que el del anfitrión.
      const f = Array.isArray(s.f) && s.f.length === 2 && s.f.every((n) => Number.isFinite(n)) ? s.f : null;
      this.swings.push({
        dir: s.d === 1 ? 1 : s.d === -1 ? -1 : 0,
        overhead: !!s.o,
        power: clamp(Number(s.p) || 0, 0, 1),
        ...(f ? { form: { posture: clamp(f[0], 0, 1), extension: f[1] < 0 ? null : clamp(f[1], 0, 4) } } : {}),
      });
    }
    this.pose = decodePose(m.ps);
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

  getPose(): LivePose | null {
    return this.pose;
  }

  destroy(): void {}
}

// ---------- Lado invitado: convertir el control local a coordenadas del anfitrión ----------

/**
 * El invitado se ve a sí mismo abajo (mundo espejado: x' = -x, z' = L - z),
 * así que su input se invierte antes de enviarse al anfitrión. La pose es
 * relativa al propio cuerpo: viaja tal cual.
 */
export function buildInputMsg(control: ControlAdapter): InputMsg {
  const mv = control.getMove();
  const sw = control.consumeSwings().map((s) => ({
    d: (s.dir * -1) as -1 | 0 | 1,
    o: s.overhead,
    p: s.power,
    f: s.form ? ([s.form.posture, s.form.extension ?? -1] as [number, number]) : null,
  }));
  const ps = encodePose(control.getPose?.() ?? null);
  if (mv.mode === 'absolute') {
    return { t: 'in', mode: 'a', x: -mv.x, z: 0, sw, ps };
  }
  return { t: 'in', mode: 'v', x: -mv.x, z: -mv.z, sw, ps };
}
