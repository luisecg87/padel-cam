import { Renderer } from './game/render';
import type { GameRenderer } from './game/renderers/GameRenderer';
import { profilePalette } from './profile';
import { MatchMode } from './game/match';
import { PracticeMode } from './modes/practice';
import { Ball } from './game/ball';
import { PlayerEntity } from './game/player';
import { analyzeMatch } from './analysis/coach';
import {
  DAILY_BONUS_XP,
  DAILY_GOAL,
  addTrophy,
  addXp,
  clearSessions,
  getXp,
  loadChallengeRecords,
  loadSessions,
  loadTrophies,
  pendingCorrections,
  saveChallengeResult,
  saveSession,
  suggestDrill,
  summarize,
} from './analysis/progress';
import type { SavedSession } from './analysis/progress';
import { CHALLENGES, ChallengeMode } from './modes/challenges';
import type { ChallengeDef, ChallengeId } from './modes/challenges';
import { RIVALS, ROUND_NAMES, TOURNEY_GAMES } from './modes/tournament';
import { sfx } from './audio/sfx';
import {
  INVITE_PARAM,
  OnlineSession,
  RemoteControl,
  cleanName,
  encodePose,
  inviteUrl,
  parseCode,
} from './net/online';
import type { PeerInfo } from './net/online';
import { GuestMatchView } from './net/guest';
import { CameraTrainingView } from './training/view';
import type { TrainingSummary } from './training/session';
import type { DrillType, ShotType } from './types';
import { SHOT_NAMES } from './types';
import { PoseTracker } from './camera/pose';
import { CameraControl } from './camera/gestures';
import { runCalibration } from './camera/calibration';
import { shareLink, ui } from './ui/screens';
import { KeyboardTouchControl } from './ui/input';
import type { ControlAdapter } from './ui/input';
import { checkAccess } from './access/gate';
import { initTelemetry, track } from './telemetry';
import { initCloud } from './cloud';

initTelemetry();
// Nube (Fase 2): no-op hasta configurar Supabase en src/cloud.ts
void initCloud();

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const trainCanvas = document.querySelector<HTMLCanvasElement>('#trainCanvas')!;
const video = document.querySelector<HTMLVideoElement>('#cam')!;
const preview = document.querySelector<HTMLCanvasElement>('#camPreview')!;

// Spike técnico: ?renderer=three activa el renderer WebGL/Three.js en vez
// del canvas 2D. Ambos implementan el mismo contrato (GameRenderer), así
// que el resto del juego no sabe (ni le importa) cuál está activo. Sin
// query param, o con cualquier otro valor, se usa el canvas de siempre.
// three.js se carga con import() dinámico SOLO cuando se pide ese
// renderer, así el bundle inicial del canvas (el que recibe todo el
// mundo por defecto) no crece ni un byte por el spike.
const startParams = new URLSearchParams(location.search);
const renderer: GameRenderer =
  startParams.get('renderer') === 'three'
    ? new (await import('./game/renderers/threeRenderer')).ThreeRenderer(canvas)
    : new Renderer(canvas);
ui.init();

let currentMode: MatchMode | PracticeMode | ChallengeMode | null = null;
let currentTraining: CameraTrainingView | null = null;
let currentControl: ControlAdapter | null = null;
let currentGuest: GuestMatchView | null = null;
// Marca la sesión lanzada desde el onboarding, para dar contexto al informe
// (evita mostrar métricas en 0 sin explicación al recién llegado).
let firstSessionPending = false;
let tracker: PoseTracker | null = null;
/** Qué hace el botón principal del informe ("Jugar otra vez" / "Revancha"). */
let again: (() => void) | null = null;

// ---- Fondo animado del menú: pista vacía ----
const idleBall = new Ball();
const idlePlayer = new PlayerEntity('player');
const idleCpu = new PlayerEntity('cpu');

// Perfil local: aplica el aspecto/lateralidad al renderer y al avatar del
// menú, ahora y cada vez que cambie desde la sección de perfil del menú.
renderer.playerPalette = profilePalette(ui.profile);
ui.onProfileChange = (p) => {
  renderer.playerPalette = profilePalette(p);
  idlePlayer.dominantHand = p.dominantHand;
};
let idleRaf = 0;
function idleLoop(): void {
  renderer.draw(idleBall, idlePlayer, idleCpu, false);
  idleRaf = requestAnimationFrame(idleLoop);
}
function startIdle(): void {
  cancelAnimationFrame(idleRaf);
  idleLoop();
}
function stopIdle(): void {
  cancelAnimationFrame(idleRaf);
}

let tourneyRound = -1; // -1 = sin torneo en curso

function backToMenu(): void {
  currentMode?.stop();
  currentMode = null;
  currentTraining?.stop();
  currentTraining = null;
  currentGuest?.stop();
  currentGuest = null;
  closeOnline();
  currentControl?.destroy();
  currentControl = null;
  tourneyRound = -1;
  ui.setCamPreviewVisible(false);
  ui.setDrillHud(null);
  ui.show('menu');
  startIdle();
}

// ---- Control: cámara (con calibración) o teclado/táctil ----

/**
 * Arranca la cámara y el modelo de pose (una sola vez: el tracker se
 * reutiliza entre partidas). Si falla, espera a que el jugador pulse
 * "Volver" y devuelve null.
 */
async function ensureTracker(status: string, failHint: string): Promise<PoseTracker | null> {
  ui.show('calib');
  ui.setCalibCountdown(null);
  ui.setCalibStatus(status, 'wait');
  if (!tracker) tracker = new PoseTracker(video);
  if (tracker.running) return tracker;
  try {
    await tracker.start();
    return tracker;
  } catch {
    ui.setCalibStatus(`${tracker.error ?? 'Error de cámara'} — ${failHint}`, 'err');
    await new Promise<void>((res) => {
      ui.onCalibCancel = () => res();
    });
    ui.onCalibCancel = null;
    return null;
  }
}

async function buildControl(): Promise<ControlAdapter | null> {
  if (ui.settings.control === 'keyboard') {
    return new KeyboardTouchControl();
  }
  const t = await ensureTracker('Iniciando cámara y modelo de pose…', 'puedes volver y elegir Teclado.');
  if (!t) return null;
  const calib = await runCalibration(t, preview);
  if (!calib) return null;
  return new CameraControl(t, calib, preview);
}

/**
 * Entrada común a los modos de pista: prepara el control y deja la pantalla
 * lista para jugar. Si el jugador cancela (o falla la cámara) vuelve al menú.
 */
async function enterCourt(): Promise<ControlAdapter | null> {
  stopIdle();
  const control = await buildControl();
  if (!control) {
    backToMenu();
    return null;
  }
  currentControl = control;
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');
  return control;
}

// ---- Cierre de sesión: historial + XP + meta diaria ----

interface ClosedSession {
  saved: boolean;
  xp: number; // XP total ganada (incluye el bonus de la meta diaria)
  leveledUp: boolean;
  note: string; // línea lista para el informe
}

/**
 * Cierra una sesión jugada: la guarda en el historial (alimenta racha y
 * correcciones), suma la XP y, si es la sesión que completa la meta diaria,
 * añade el bonus. Todos los modos pasan por aquí.
 */
function closeSession(session: Omit<SavedSession, 'date'>, xpBase: number): ClosedSession {
  const saved = saveSession({ date: Date.now(), ...session });
  const goalHit = saved && summarize(loadSessions()).sessionsToday === DAILY_GOAL;
  if (goalHit) track('meta_diaria_cumplida');
  const xp = Math.max(0, Math.round(xpBase)) + (goalHit ? DAILY_BONUS_XP : 0);
  const info = addXp(xp);
  const note = [
    `+${Math.round(xpBase)} XP`,
    goalHit ? `🎯 ¡Meta diaria cumplida! +${DAILY_BONUS_XP} XP` : '',
    info.leveledUp ? '⬆️ ¡subes de nivel!' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { saved, xp, leveledUp: info.leveledUp, note };
}

function resultTitle(won: boolean, mine: number, theirs: number, name = ''): string {
  return won
    ? `🏆 ¡Ganaste ${mine}-${theirs}${name ? `, ${name}` : ''}!`
    : `Perdiste ${mine}-${theirs}… ¡la próxima cae!`;
}

/** "Jugar otra vez" de los modos locales: limpia la pantalla y relanza. */
function againLocal(start: () => Promise<void>): void {
  again = () => {
    ui.show('none');
    void start();
  };
  ui.setAgain();
}

// ---- Partido vs IA ----

async function startMatch(): Promise<void> {
  const control = await enterCourt();
  if (!control) return;

  track('partido_iniciado', { control: ui.settings.control, dificultad: ui.settings.difficulty });
  const match = new MatchMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    difficulty: ui.settings.difficulty,
    p1Name: ui.profile.name || undefined,
    onFinish: (logger, score) => {
      const won = score.winner === 'player';
      track('informe_visto', { modo: 'partido', ganado: won });
      const report = analyzeMatch(logger);
      const { player: p, cpu: c } = score.games;
      const closed = closeSession(
        { mode: 'match', title: `Partido ${p}-${c}`, stats: report.stats, tips: report.tips },
        won ? 120 : 60,
      );
      ui.setCamPreviewVisible(false);
      againLocal(startMatch);
      ui.showReport(resultTitle(won, p, c, ui.profile.name), report, closed.saved, closed.note);
    },
    onQuit: backToMenu,
  });
  currentMode = match;
  match.start();
}

// ---- Práctica libre ----

async function startPractice(): Promise<void> {
  const control = await enterCourt();
  if (!control) return;

  track('practica_iniciada', { control: ui.settings.control, drill: ui.settings.drill });
  const practice = new PracticeMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    drill: ui.settings.drill,
    onFinish: (report) => {
      const drill = ui.settings.drill;
      const drillName =
        drill === 'mixto' ? 'golpes variados' : drill === 'volley' ? 'voleas' : SHOT_NAMES[drill];
      const closed = closeSession(
        { mode: 'practice', title: `Práctica de ${drillName}`, stats: report.stats, tips: report.tips },
        40,
      );
      ui.setCamPreviewVisible(false);
      ui.setFirstSessionBanner(firstSessionPending);
      firstSessionPending = false;
      againLocal(startPractice);
      ui.showReport('🎯 Informe de práctica', report, closed.saved, closed.note);
    },
  });
  currentMode = practice;
  practice.start();
}

// ---- Torneo: tres rondas contra rivales con personalidad ----

async function startTournament(): Promise<void> {
  const control = await enterCourt();
  if (!control) return;
  tourneyRound = 0;
  ui.setCamPreviewVisible(false);
  ui.showTourney(0, 'play');
}

function playTourneyRound(): void {
  if (tourneyRound < 0 || !currentControl) return;
  const round = tourneyRound;
  const rival = RIVALS[round];
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');

  const match = new MatchMode({
    renderer,
    control: currentControl,
    controlMode: ui.settings.control,
    difficulty: rival.difficulty,
    p1Name: ui.profile.name || undefined,
    targetGames: TOURNEY_GAMES,
    rival,
    onFinish: (logger, score) => {
      const won = score.winner === 'player';
      const report = analyzeMatch(logger);
      closeSession(
        {
          mode: 'match',
          title: `Torneo · ${ROUND_NAMES[round]} vs ${rival.name} ${score.games.player}-${score.games.cpu}`,
          stats: report.stats,
          tips: report.tips,
        },
        won ? 100 : 50,
      );
      ui.setCamPreviewVisible(false);
      if (!won) {
        ui.showTourney(round, 'lost');
      } else if (round === RIVALS.length - 1) {
        const trophies = addTrophy();
        addXp(300);
        sfx.cheer(true);
        ui.showTourney(round, 'champion', trophies);
      } else {
        tourneyRound = round + 1;
        ui.showTourney(tourneyRound, 'play');
      }
      currentMode = null;
    },
    onQuit: backToMenu,
  });
  currentMode = match;
  match.start();
}

// ---- Online 1v1: el anfitrión simula, el invitado renderiza en espejo ----

/** Conexión viva con un rival: dura varias partidas para poder pedir revancha. */
interface OnlineLink {
  session: OnlineSession;
  iWant: boolean; // he pedido revancha
  rivalWants: boolean; // el rival ha pedido revancha
}
let online: OnlineLink | null = null;

function myInfo(fallbackName: string): PeerInfo {
  return { name: ui.profile.name || fallbackName, pal: profilePalette(ui.profile) };
}

function closeOnline(): void {
  online?.session.destroy();
  online = null;
  again = null;
  ui.setAgain();
  ui.setOnlineInvite(false);
}

function onlineDropped(): void {
  backToMenu();
  ui.setOnlineStatus('❌ Se perdió la conexión con el rival', 'err');
  ui.show('online');
}

/** Prepara el control y vuelve a la pantalla online (con la pista de fondo). */
async function prepareOnline(): Promise<boolean> {
  stopIdle();
  const control = await buildControl();
  ui.show('online');
  startIdle();
  if (!control) {
    ui.setOnlineStatus('No se pudo iniciar el control', 'err');
    return false;
  }
  currentControl = control;
  ui.setCamPreviewVisible(false);
  closeOnline();
  return true;
}

async function hostOnline(): Promise<void> {
  if (!(await prepareOnline())) return;
  ui.setOnlineStatus('Creando sala…', 'wait');
  const session = OnlineSession.host(
    myInfo('Anfitrión'),
    (code) => {
      ui.setOnlineStatus(`Sala ${code} lista: envía la invitación a tu rival y no cierres esta pantalla`, 'ok');
      ui.setOnlineInvite(true);
    },
    () => startOnlineMatch(session),
    (err) => ui.setOnlineStatus(err, 'err'),
  );
  online = { session, iWant: false, rivalWants: false };
}

async function joinOnline(rawCode: string): Promise<void> {
  const code = parseCode(rawCode);
  if (!code) {
    ui.setOnlineStatus('Ese código no es válido: son 4 letras o números', 'err');
    return;
  }
  if (!(await prepareOnline())) return;
  ui.setOnlineStatus(`Conectando a ${code}…`, 'wait');
  const session = OnlineSession.join(
    code,
    myInfo('Invitado'),
    () => startGuestView(session),
    (err) => ui.setOnlineStatus(err, 'err'),
  );
  online = { session, iWant: false, rivalWants: false };
}

async function shareInvite(): Promise<void> {
  if (!online) return;
  const code = online.session.code;
  track('invitacion_enviada');
  const outcome = await shareLink(`🎾 Te reto a un partido en Pádel Cam (sala ${code}).`, inviteUrl(code));
  if (outcome === 'copied') {
    ui.setOnlineStatus(`Enlace copiado: pégaselo a tu rival · Sala ${code}`, 'ok');
  } else if (outcome === 'failed') {
    ui.setOnlineStatus(`No se pudo compartir: díctale el código ${code}`, 'ok');
  }
}

function startOnlineMatch(session: OnlineSession): void {
  const rival = session.rival;
  if (!currentControl || !rival) return;
  stopIdle();
  ui.show('none');
  ui.setOnlineInvite(false);
  ui.setCamPreviewVisible(ui.settings.control === 'camera');
  track('online_iniciado', { rol: 'anfitrion' });

  const remote = new RemoteControl();
  session.onMessage = (m) => {
    if (m.t === 'in') remote.feed(m);
  };
  session.onClose = onlineDropped;

  let seq = 0;
  let broadcast = 0;
  const match = new MatchMode({
    renderer,
    control: currentControl,
    controlMode: ui.settings.control,
    difficulty: 'medium',
    targetGames: 3,
    controlP2: remote,
    p1Name: ui.profile.name || 'Anfitrión',
    rival: { name: rival.name, tagline: '', palette: rival.pal, difficulty: 'medium' },
    onFinish: (logger, score) => {
      window.clearInterval(broadcast);
      currentMode = null;
      const { player: p, cpu: c } = score.games;
      const won = score.winner === 'player';
      session.send({ t: 'end', games: [p, c] });
      const report = analyzeMatch(logger);
      const closed = closeSession(
        { mode: 'match', title: `Online vs ${rival.name} ${p}-${c}`, stats: report.stats, tips: report.tips },
        won ? 150 : 60,
      );
      ui.setCamPreviewVisible(false);
      ui.showReport(resultTitle(won, p, c), report, closed.saved, closed.note);
      awaitRematch(session);
    },
    onQuit: () => {
      window.clearInterval(broadcast);
      backToMenu();
    },
  });

  broadcast = window.setInterval(() => {
    if (!session.connected) return;
    const st = match.netState();
    session.send({
      t: 'st',
      n: seq++,
      b: st.b,
      p: st.p,
      c: st.c,
      sc: st.sc,
      serve: st.serve,
      toast: st.toast,
      toastN: st.toastN,
      replay: st.replay,
      hp: encodePose(st.pose),
    });
  }, 40);

  currentMode = match;
  match.start();
}

function startGuestView(session: OnlineSession): void {
  const rival = session.rival;
  if (!currentControl || !rival) return;
  stopIdle();
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');
  track('online_iniciado', { rol: 'invitado' });

  const guest = new GuestMatchView({
    renderer,
    control: currentControl,
    session,
    myName: ui.profile.name || 'Invitado',
    rivalName: rival.name,
    rivalPalette: rival.pal,
    onEnd: (mine, theirs) => {
      currentGuest = null;
      ui.setCamPreviewVisible(false);
      const won = mine > theirs;
      const stats = [{ lbl: 'Resultado (tú - rival)', val: `${mine} - ${theirs}` }];
      // El invitado también suma: sesión para la racha y XP como el anfitrión
      const closed = closeSession(
        { mode: 'match', title: `Online vs ${rival.name} ${mine}-${theirs}`, stats, tips: [] },
        won ? 150 : 60,
      );
      ui.showReport(
        resultTitle(won, mine, theirs),
        {
          stats,
          tips: [{
            warn: false,
            text: 'El informe técnico completo lo calcula quien crea la sala. Crea tú la próxima (o juega un partido vs IA) para recibir el tuyo.',
          }],
        },
        closed.saved,
        closed.note,
      );
      awaitRematch(session);
    },
    onDrop: onlineDropped,
  });
  currentGuest = guest;
  guest.start();
}

/**
 * Tras un partido online la conexión sigue abierta: cualquiera puede pedir
 * revancha desde el informe y, cuando los dos quieren, el anfitrión la
 * arranca. Salir del informe (menú, progreso) cierra la conexión.
 */
function awaitRematch(session: OnlineSession): void {
  const link = online;
  if (!link || link.session !== session) return;
  link.iWant = false;
  link.rivalWants = false;
  const rivalName = session.rival?.name ?? 'tu rival';

  const refresh = (): void => {
    if (link.iWant) ui.setAgain(`⏳ Esperando a ${rivalName}…`, false);
    else if (link.rivalWants) ui.setAgain(`🔁 ${rivalName} quiere revancha: ¡aceptar!`);
    else ui.setAgain('🔁 Revancha');
  };
  const start = (): void => {
    again = null;
    ui.setAgain();
    track('revancha_online');
    if (session.role === 'host') {
      session.send({ t: 'go' });
      startOnlineMatch(session);
    } else {
      startGuestView(session);
    }
  };

  session.onMessage = (m) => {
    if (m.t === 're') {
      link.rivalWants = true;
      if (session.role === 'host' && link.iWant) start();
      else refresh();
    } else if (m.t === 'go' && session.role === 'guest' && link.iWant) {
      start();
    }
  };
  session.onClose = () => {
    closeOnline();
    ui.setAgain(`${rivalName} se ha ido`, false);
  };
  again = () => {
    link.iWant = true;
    session.send({ t: 're' });
    if (session.role === 'host' && link.rivalWants) start();
    else refresh();
  };
  refresh();
}

// ---- Desafíos jugables (y retos entre amigos por enlace) ----

/** Reto recibido por enlace: "supera mis N puntos en este desafío". */
interface Duel {
  def: ChallengeDef;
  pts: number;
  by: string;
}

const DUEL_PARAM = 'reto';

function parseDuel(params: URLSearchParams): Duel | null {
  const def = CHALLENGES.find((c) => c.id === params.get(DUEL_PARAM));
  const pts = Number(params.get('pts'));
  if (!def || !Number.isInteger(pts) || pts <= 0 || pts > 1_000_000) return null;
  return { def, pts, by: cleanName(params.get('de'), 'Un amigo') };
}

function duelUrl(def: ChallengeDef, pts: number, by: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(DUEL_PARAM, def.id);
  url.searchParams.set('pts', String(pts));
  if (by) url.searchParams.set('de', by);
  return url.toString();
}

let duel: Duel | null = parseDuel(startParams);
let lastChallengeId: ChallengeId = 'diana';

function showChallenges(): void {
  const banner = duel
    ? `⚔️ ${duel.by} te reta en ${duel.def.name}: supera sus ${duel.pts} ${duel.def.unit}`
    : '';
  ui.showChallenges(CHALLENGES, loadChallengeRecords(), banner);
}

async function startChallenge(id: ChallengeId): Promise<void> {
  const def = CHALLENGES.find((c) => c.id === id);
  if (!def) return;
  lastChallengeId = id;
  const control = await enterCourt();
  if (!control) return;

  const challenge = new ChallengeMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    def,
    onFinish: (result) => {
      currentMode = null;
      const { record, isNewBest } = saveChallengeResult(def.id, result.score, result.stars);
      const closed = closeSession(
        {
          mode: 'practice',
          title: `Desafío ${def.name}: ${result.score} ${def.unit}`,
          stats: [
            { lbl: 'Puntuación', val: `${result.score} ${def.unit}` },
            { lbl: 'Estrellas', val: '★'.repeat(result.stars) || '—' },
          ],
          tips: [],
        },
        Math.max(5, Math.round(result.score * def.xpMul)),
      );
      if (closed.leveledUp) sfx.cheer(true);

      // Reto de un amigo: ¿lo ha superado?
      let outcome: { text: string; won: boolean } | null = null;
      if (duel && duel.def.id === def.id) {
        const won = result.score > duel.pts;
        outcome = {
          won,
          text: won
            ? `🏆 ¡Superaste a ${duel.by}! ${result.score} contra ${duel.pts} ${def.unit}. Devuélvele el reto.`
            : `⚔️ ${duel.by} sigue por delante con ${duel.pts} ${def.unit}: te faltaron ${duel.pts - result.score + 1}.`,
        };
        if (won) {
          track('reto_superado', { desafio: def.id });
          duel = null;
        }
      }
      ui.setCamPreviewVisible(false);
      ui.showChallengeEnd(result, record, isNewBest, closed.xp, closed.leveledUp, outcome);
    },
  });
  currentMode = challenge;
  challenge.start();
}

async function shareChallenge(): Promise<void> {
  const def = CHALLENGES.find((c) => c.id === lastChallengeId);
  const record = def ? loadChallengeRecords()[def.id] : undefined;
  if (!def || !record) return;
  track('reto_enviado', { desafio: def.id });
  const who = ui.profile.name ? `${ui.profile.name} te reta` : 'Te reto';
  const outcome = await shareLink(
    `⚔️ ${who} en Pádel Cam: supera mis ${record.best} ${def.unit} en ${def.name}.`,
    duelUrl(def, record.best, ui.profile.name),
  );
  if (outcome === 'copied') ui.flashButton('#btnChallengeShare', '✅ Enlace copiado: pégaselo');
  else if (outcome === 'failed') ui.flashButton('#btnChallengeShare', 'No se pudo copiar el enlace');
}

// ---- Entrenamiento técnico con cámara ----

/** Golpes que entrena cada drill (varios = rotan por repetición) y su nombre. */
function drillToShots(d: DrillType): { shots: ShotType[]; label: string } {
  if (d === 'mixto') {
    return {
      shots: ['forehand', 'backhand', 'volleyFh', 'volleyBh', 'bandeja', 'smash'],
      label: 'golpes variados',
    };
  }
  if (d === 'volley') return { shots: ['volleyFh', 'volleyBh'], label: 'voleas' };
  return { shots: [d], label: SHOT_NAMES[d] };
}

async function startTraining(): Promise<void> {
  stopIdle();
  const t = await ensureTracker('Iniciando cámara y análisis de pose…', 'vuelve al menú.');
  if (!t) {
    backToMenu();
    return;
  }
  ui.show('none');
  const { shots, label } = drillToShots(ui.settings.drill);
  track('entrenamiento_iniciado', { drill: ui.settings.drill });

  const view = new CameraTrainingView({
    canvas: trainCanvas,
    tracker: t,
    shots,
    label,
    onFinish: (summary: TrainingSummary) => {
      currentTraining = null;
      const timingTxt =
        summary.meanDtMs === null ? '—' : `${summary.meanDtMs > 0 ? '+' : ''}${summary.meanDtMs} ms`;
      const closed = closeSession(
        {
          mode: 'practice',
          title: `Técnica · ${label}`,
          stats: [
            { lbl: 'Consistencia', val: `${summary.consistency}%` },
            { lbl: 'Correctos', val: `${summary.correct} / ${summary.reps.length}` },
            { lbl: 'Timing medio', val: timingTxt },
            { lbl: 'Mejor racha', val: `${summary.bestStreak}` },
          ],
          tips: [
            ...(summary.mainIssue
              ? [{ id: summary.mainIssue.tipId, warn: true, text: summary.mainIssue.text }]
              : []),
            { warn: false, text: summary.recommendation },
          ],
        },
        summary.consistency,
      );
      if (closed.leveledUp) sfx.cheer(true);
      ui.setFirstSessionBanner(firstSessionPending);
      firstSessionPending = false;
      ui.showTrainingSummary(summary, closed.xp);
    },
    onQuit: () => {
      currentTraining = null;
      backToMenu();
    },
  });
  currentTraining = view;
  view.start();
}

// ---- Progreso y tarjeta del coach ----

function showProgress(): void {
  closeOnline(); // salir del informe de un partido online suelta al rival
  const sessions = loadSessions();
  ui.showProgress(sessions, pendingCorrections(sessions), loadTrophies());
}

let lastSuggestion: ReturnType<typeof suggestDrill> = null;
function refreshCoachCard(): void {
  const sessions = loadSessions();
  lastSuggestion = suggestDrill(pendingCorrections(sessions));
  ui.setCoach(summarize(sessions), lastSuggestion, loadTrophies(), getXp());
}

ui.onStartMatch = () => void startMatch();
ui.onStartPractice = () => void startPractice();
ui.onQuit = backToMenu;
ui.onShowProgress = showProgress;
ui.onClearProgress = () => {
  if (confirm('¿Borrar todo tu historial de informes y correcciones?')) {
    clearSessions();
    showProgress();
  }
};
ui.onMenuShown = () => {
  closeOnline(); // volver al menú desde el informe online también suelta al rival
  refreshCoachCard();
};
ui.onStartTournament = () => void startTournament();
ui.onTourneyGo = playTourneyRound;
ui.onTourneyQuit = backToMenu;
ui.onOnlineHost = () => void hostOnline();
ui.onOnlineJoin = (code) => void joinOnline(code);
ui.onOnlineBack = backToMenu;
ui.onOnlineShare = () => void shareInvite();
ui.onStartTraining = () => void startTraining();
ui.onTrainAgain = () => void startTraining();
ui.onShowChallenges = showChallenges;
ui.onPlayChallenge = (id) => void startChallenge(id as ChallengeId);
ui.onChallengeAgain = () => void startChallenge(lastChallengeId);
ui.onChallengeShare = () => void shareChallenge();
ui.onCoachTrain = () => {
  if (!lastSuggestion) return;
  ui.selectDrill(lastSuggestion.drill);
  void startPractice();
};
refreshCoachCard();
ui.onAgain = () => again?.();

// "Empezar sesión" en la pantalla de primera sesión lanza una sesión
// enfocada en el golpe elegido, que termina en informe (el onboarding de
// 60 s del PRODUCT.md). Con cámara → entrenamiento técnico (el HUD de
// repeticiones con corrección de postura); con teclado → práctica libre
// (la máquina lanza-bolas de ese golpe). Ambos dan informe.
ui.onWelcomeDone = () => {
  track('bienvenida_completada', { control: ui.settings.control, drill: ui.settings.drill });
  firstSessionPending = true;
  if (ui.settings.control === 'camera') void startTraining();
  else void startPractice();
};

// Enlaces compartidos: ?sala=CÓDIGO (invitación a un partido online) y
// ?reto=… (reto de un amigo en un desafío). Se leen una vez y se quitan de
// la barra de direcciones para que recargar no los repita.
const inviteCode = parseCode(startParams.get(INVITE_PARAM));
if (startParams.has(INVITE_PARAM) || startParams.has(DUEL_PARAM)) {
  const rest = new URLSearchParams(startParams);
  for (const k of [INVITE_PARAM, DUEL_PARAM, 'pts', 'de']) rest.delete(k);
  const qs = rest.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
}

// Tope de accesos gratuitos (mientras se define el cobro): se resuelve antes
// de soltar al jugador en cualquier pantalla. Sin backend configurado no
// bloquea a nadie (ver src/access/gate.ts).
checkAccess().then((access) => {
  if (!access.granted) {
    ui.showFull(access.cap ?? 50);
    return;
  }
  startIdle();
  if (inviteCode) {
    // Quien llega invitado va directo a unirse: la bienvenida puede esperar
    track('invitacion_abierta');
    ui.showOnlineJoin(inviteCode);
  } else if (duel) {
    track('reto_abierto', { desafio: duel.def.id });
    showChallenges();
  } else if (ui.isFirstVisit) {
    // Primera visita: en vez de soltar al recién llegado en un menú con 7 modos,
    // se le da una bienvenida breve que lo lleva a su primer partido.
    track('bienvenida_vista');
    ui.showWelcome();
  }
});

// Gancho de depuración (útil para pruebas automatizadas)
declare global {
  interface Window {
    __padel: {
      getMode(): MatchMode | PracticeMode | ChallengeMode | null;
      ui: typeof ui;
    };
  }
}
window.__padel = {
  getMode: () => currentMode,
  ui,
};

// PWA: el service worker hace la app instalable y jugable sin conexión
// (los modos sin cámara). Solo en producción para no interferir con el dev.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Sin SW se juega igual: solo se pierde offline/instalación
    });
  });
}
