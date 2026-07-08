import { Renderer } from './game/render';
import type { GameRenderer } from './game/renderers/GameRenderer';
import { profilePalette } from './profile';
import { MatchMode } from './game/match';
import { PracticeMode } from './modes/practice';
import { Ball } from './game/ball';
import { PlayerEntity } from './game/player';
import { analyzeMatch } from './analysis/coach';
import {
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
import { CHALLENGES, ChallengeMode } from './modes/challenges';
import type { ChallengeId } from './modes/challenges';
import { RIVALS, ROUND_NAMES, TOURNEY_GAMES } from './modes/tournament';
import { sfx } from './audio/sfx';
import { OnlineSession, RemoteControl } from './net/online';
import { GuestMatchView } from './net/guest';
import { CPU_PALETTE } from './game/render';
import { CameraTrainingView } from './training/view';
import type { TrainingSummary } from './training/session';
import type { DrillType, ShotType } from './types';
import { SHOT_NAMES } from './types';
import { PoseTracker } from './camera/pose';
import { CameraControl } from './camera/gestures';
import { runCalibration } from './camera/calibration';
import { ui } from './ui/screens';
import { KeyboardTouchControl, SplitKeyboardControl } from './ui/input';
import type { ControlAdapter } from './ui/input';

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
const rendererParam = new URLSearchParams(location.search).get('renderer');
const renderer: GameRenderer =
  rendererParam === 'three'
    ? new (await import('./game/renderers/threeRenderer')).ThreeRenderer(canvas)
    : new Renderer(canvas);
ui.init();

let currentMode: MatchMode | PracticeMode | ChallengeMode | null = null;
let currentTraining: CameraTrainingView | null = null;
let currentControl: ControlAdapter | null = null;
let currentOnline: OnlineSession | null = null;
let currentGuest: GuestMatchView | null = null;
let lastModeWasMatch = true;
let tracker: PoseTracker | null = null;

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
  currentOnline?.destroy();
  currentOnline = null;
  currentControl?.destroy();
  currentControl = null;
  tourneyRound = -1;
  ui.setCamPreviewVisible(false);
  ui.setDrillHud(null);
  ui.show('menu');
  startIdle();
}

async function buildControl(): Promise<ControlAdapter | null> {
  if (ui.settings.control === 'keyboard') {
    return new KeyboardTouchControl();
  }
  // Cámara: arrancar tracker (si no está ya) y calibrar
  ui.show('calib');
  ui.setCalibStatus('Iniciando cámara y modelo de pose…', 'wait');
  if (!tracker) tracker = new PoseTracker(video);
  if (!tracker.running) {
    try {
      await tracker.start();
    } catch (e) {
      ui.setCalibStatus(
        `${tracker.error ?? 'Error de cámara'} — puedes volver y elegir Teclado.`,
        'err',
      );
      await new Promise<void>((res) => {
        ui.onCalibCancel = () => res();
      });
      ui.onCalibCancel = null;
      return null;
    }
  }
  const calib = await runCalibration(tracker, preview);
  if (!calib) return null;
  return new CameraControl(tracker, calib, preview);
}

async function startMatch(): Promise<void> {
  stopIdle();
  const control = await buildControl();
  if (!control) {
    backToMenu();
    return;
  }
  currentControl = control;
  lastModeWasMatch = true;
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');

  const match = new MatchMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    difficulty: ui.settings.difficulty,
    p1Name: ui.profile.name || undefined,
    onFinish: (logger, score) => {
      const report = analyzeMatch(logger);
      const title =
        score.winner === 'player'
          ? `🏆 ¡Ganaste ${score.games.player}-${score.games.cpu}!`
          : `Perdiste ${score.games.player}-${score.games.cpu}… ¡la próxima cae!`;
      const saved = saveSession({
        date: Date.now(),
        mode: 'match',
        title: `Partido ${score.games.player}-${score.games.cpu}`,
        stats: report.stats,
        tips: report.tips,
      });
      const xpGained = score.winner === 'player' ? 120 : 60;
      const xp = addXp(xpGained);
      ui.setCamPreviewVisible(false);
      ui.showReport(title, report, saved, `+${xpGained} XP${xp.leveledUp ? ' · ⬆️ ¡subes de nivel!' : ''}`);
    },
    onQuit: backToMenu,
  });
  currentMode = match;
  match.start();
}

async function startPractice(): Promise<void> {
  stopIdle();
  const control = await buildControl();
  if (!control) {
    backToMenu();
    return;
  }
  currentControl = control;
  lastModeWasMatch = false;
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');

  const practice = new PracticeMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    drill: ui.settings.drill,
    onFinish: (report) => {
      const drill = ui.settings.drill;
      const drillName =
        drill === 'mixto' ? 'golpes variados' : drill === 'volley' ? 'voleas' : SHOT_NAMES[drill];
      const saved = saveSession({
        date: Date.now(),
        mode: 'practice',
        title: `Práctica de ${drillName}`,
        stats: report.stats,
        tips: report.tips,
      });
      const xpP = addXp(40);
      ui.setCamPreviewVisible(false);
      ui.showReport('🎯 Informe de práctica', report, saved, `+40 XP${xpP.leveledUp ? ' · ⬆️ ¡subes de nivel!' : ''}`);
    },
  });
  currentMode = practice;
  practice.start();
}

// ---- Torneo: tres rondas contra rivales con personalidad ----

async function startTournament(): Promise<void> {
  stopIdle();
  const control = await buildControl();
  if (!control) {
    backToMenu();
    return;
  }
  currentControl = control;
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
      const report = analyzeMatch(logger);
      saveSession({
        date: Date.now(),
        mode: 'match',
        title: `Torneo · ${ROUND_NAMES[round]} vs ${rival.name} ${score.games.player}-${score.games.cpu}`,
        stats: report.stats,
        tips: report.tips,
      });
      addXp(score.winner === 'player' ? 100 : 50);
      ui.setCamPreviewVisible(false);
      if (score.winner !== 'player') {
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

function onlineDropped(): void {
  backToMenu();
  ui.setOnlineStatus('❌ Se perdió la conexión con el rival', 'err');
  ui.show('online');
}

async function hostOnline(): Promise<void> {
  stopIdle();
  const control = await buildControl();
  ui.show('online');
  startIdle();
  if (!control) {
    ui.setOnlineStatus('No se pudo iniciar el control', 'err');
    return;
  }
  currentControl = control;
  ui.setCamPreviewVisible(false);
  ui.setOnlineStatus('Creando sala…', 'wait');
  currentOnline?.destroy();
  const session = OnlineSession.host(
    (code) => ui.setOnlineStatus(`Código: ${code} — compártelo con tu rival y no cierres esta pantalla`, 'ok'),
    () => startOnlineMatch(session),
    (err) => ui.setOnlineStatus(err, 'err'),
  );
  currentOnline = session;
}

function startOnlineMatch(session: OnlineSession): void {
  if (!currentControl) return;
  stopIdle();
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');
  lastModeWasMatch = true;

  const remote = new RemoteControl();
  session.onMessage = (m) => {
    if (m.t === 'in') remote.feed(m);
  };
  session.onClose = () => {
    onlineDropped();
  };

  // Interceptar los toasts para retransmitirlos al invitado
  let toastN = 0;
  let lastToast = '';
  const origToast = ui.toast.bind(ui);
  ui.toast = (text: string, ms?: number) => {
    toastN++;
    lastToast = text;
    origToast(text, ms);
  };
  const scoreGamesEl = document.querySelector('#scoreGames')!;
  const scorePointsEl = document.querySelector('#scorePoints')!;
  const serveInfoEl = document.querySelector('#serveInfo')!;

  const match = new MatchMode({
    renderer,
    control: currentControl,
    controlMode: ui.settings.control,
    difficulty: 'medium',
    targetGames: 3,
    controlP2: remote,
    p1Name: ui.profile.name || 'Anfitrión',
    rival: { name: 'Invitado', tagline: '', palette: CPU_PALETTE, difficulty: 'medium' },
    onFinish: (logger, score) => {
      cleanup();
      const p = score.games.player;
      const c = score.games.cpu;
      session.send({
        t: 'end',
        title: score.winner === 'cpu' ? `🏆 ¡Ganaste ${c}-${p}!` : `Perdiste ${c}-${p}… ¡la próxima cae!`,
        games: `${c} - ${p}`,
      });
      window.setTimeout(() => session.destroy(), 400);
      currentOnline = null;
      const report = analyzeMatch(logger);
      const saved = saveSession({
        date: Date.now(),
        mode: 'match',
        title: `Online vs Invitado ${p}-${c}`,
        stats: report.stats,
        tips: report.tips,
      });
      const xpGained = score.winner === 'player' ? 150 : 60;
      const xpO = addXp(xpGained);
      ui.setCamPreviewVisible(false);
      ui.showReport(
        score.winner === 'player' ? `🏆 ¡Ganaste ${p}-${c}!` : `Perdiste ${p}-${c}… ¡la próxima cae!`,
        report,
        saved,
        `+${xpGained} XP${xpO.leveledUp ? ' · ⬆️ ¡subes de nivel!' : ''}`,
      );
    },
    onQuit: () => {
      cleanup();
      backToMenu();
    },
  });

  const broadcast = window.setInterval(() => {
    if (!session.connected) return;
    const st = match.netState();
    session.send({
      t: 'st',
      b: st.b,
      p: st.p,
      c: st.c,
      hud: {
        games: scoreGamesEl.textContent ?? '',
        points: scorePointsEl.textContent ?? '',
        serve: serveInfoEl.textContent ?? '',
        toast: lastToast,
        toastN,
        replay: st.replay,
      },
    });
  }, 40);

  function cleanup(): void {
    window.clearInterval(broadcast);
    ui.toast = origToast;
  }

  currentMode = match;
  match.start();
}

async function joinOnline(code: string): Promise<void> {
  stopIdle();
  const control = await buildControl();
  ui.show('online');
  startIdle();
  if (!control) {
    ui.setOnlineStatus('No se pudo iniciar el control', 'err');
    return;
  }
  currentControl = control;
  ui.setCamPreviewVisible(false);
  ui.setOnlineStatus(`Conectando a ${code.toUpperCase()}…`, 'wait');
  currentOnline?.destroy();
  const session = OnlineSession.join(
    code,
    () => startGuestView(session),
    (err) => ui.setOnlineStatus(err, 'err'),
  );
  currentOnline = session;
}

function startGuestView(session: OnlineSession): void {
  if (!currentControl) return;
  stopIdle();
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');

  const guest = new GuestMatchView({
    renderer,
    control: currentControl,
    session,
    onEnd: (title, games) => {
      session.destroy();
      currentOnline = null;
      currentGuest = null;
      ui.setCamPreviewVisible(false);
      ui.showReport(
        title,
        {
          stats: [{ lbl: 'Resultado (tú - rival)', val: games }],
          tips: [{
            warn: false,
            text: 'En esta versión el informe del entrenador lo recibe quien crea la partida. Juega un partido vs CPU o una práctica para recibir el tuyo.',
          }],
        },
        false,
      );
    },
    onDrop: onlineDropped,
  });
  currentGuest = guest;
  guest.start();
}

// ---- Desafíos jugables ----

let lastChallengeId: ChallengeId = 'diana';

async function startChallenge(id: ChallengeId): Promise<void> {
  const def = CHALLENGES.find((c) => c.id === id);
  if (!def) return;
  lastChallengeId = id;
  stopIdle();
  const control = await buildControl();
  if (!control) {
    backToMenu();
    return;
  }
  currentControl = control;
  ui.show('none');
  ui.setCamPreviewVisible(ui.settings.control === 'camera');

  const challenge = new ChallengeMode({
    renderer,
    control,
    controlMode: ui.settings.control,
    def,
    onFinish: (result) => {
      currentMode = null;
      const { record, isNewBest } = saveChallengeResult(def.id, result.score, result.stars);
      const xpGained = Math.max(5, Math.round(result.score * def.xpMul));
      const xp = addXp(xpGained);
      if (xp.leveledUp) sfx.cheer(true);
      saveSession({
        date: Date.now(),
        mode: 'practice',
        title: `Desafío ${def.name}: ${result.score} ${def.unit}`,
        stats: [
          { lbl: 'Puntuación', val: `${result.score} ${def.unit}` },
          { lbl: 'Estrellas', val: '★'.repeat(result.stars) || '—' },
        ],
        tips: [],
      });
      ui.setCamPreviewVisible(false);
      ui.showChallengeEnd(result, record, isNewBest, xpGained, xp.leveledUp);
    },
  });
  currentMode = challenge;
  challenge.start();
}

// ---- Entrenamiento técnico con cámara ----

function drillToShot(d: DrillType): ShotType {
  if (d === 'mixto') return 'forehand';
  if (d === 'volley') return 'volleyFh';
  return d;
}

async function startTraining(): Promise<void> {
  stopIdle();
  ui.show('calib');
  ui.setCalibStatus('Iniciando cámara y análisis de pose…', 'wait');
  if (!tracker) tracker = new PoseTracker(video);
  if (!tracker.running) {
    try {
      await tracker.start();
    } catch {
      ui.setCalibStatus(`${tracker.error ?? 'Error de cámara'} — vuelve al menú.`, 'err');
      await new Promise<void>((res) => {
        ui.onCalibCancel = () => res();
      });
      ui.onCalibCancel = null;
      backToMenu();
      return;
    }
  }
  ui.show('none');
  const shot = drillToShot(ui.settings.drill);

  const view = new CameraTrainingView({
    canvas: trainCanvas,
    tracker,
    shot,
    onFinish: (summary: TrainingSummary) => {
      currentTraining = null;
      const timingTxt =
        summary.meanDtMs === null ? '—' : `${summary.meanDtMs > 0 ? '+' : ''}${summary.meanDtMs} ms`;
      saveSession({
        date: Date.now(),
        mode: 'practice',
        title: `Técnica · ${SHOT_NAMES[shot]}`,
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
      });
      const xpT = addXp(summary.consistency);
      if (xpT.leveledUp) sfx.cheer(true);
      ui.showTrainingSummary(summary, summary.consistency);
    },
    onQuit: () => {
      currentTraining = null;
      backToMenu();
    },
  });
  currentTraining = view;
  view.start();
}

function showProgress(): void {
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
ui.onMenuShown = refreshCoachCard;
ui.onStartTournament = () => void startTournament();
ui.onTourneyGo = playTourneyRound;
ui.onTourneyQuit = backToMenu;
ui.onOnlineHost = () => void hostOnline();
ui.onOnlineJoin = (code) => void joinOnline(code);
ui.onOnlineBack = backToMenu;
ui.onStartTraining = () => void startTraining();
ui.onTrainAgain = () => void startTraining();
ui.onShowChallenges = () => ui.showChallenges(CHALLENGES, loadChallengeRecords());
ui.onPlayChallenge = (id) => void startChallenge(id as ChallengeId);
ui.onChallengeAgain = () => void startChallenge(lastChallengeId);
ui.onCoachTrain = () => {
  if (!lastSuggestion) return;
  ui.selectDrill(lastSuggestion.drill);
  void startPractice();
};
refreshCoachCard();
ui.onAgain = () => {
  ui.show('none');
  if (lastModeWasMatch) void startMatch();
  else void startPractice();
};

startIdle();

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
