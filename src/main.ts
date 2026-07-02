import { Renderer } from './game/render';
import { MatchMode } from './game/match';
import { PracticeMode } from './modes/practice';
import { Ball } from './game/ball';
import { PlayerEntity } from './game/player';
import { analyzeMatch } from './analysis/coach';
import { PoseTracker } from './camera/pose';
import { CameraControl } from './camera/gestures';
import { runCalibration } from './camera/calibration';
import { ui } from './ui/screens';
import { KeyboardTouchControl } from './ui/input';
import type { ControlAdapter } from './ui/input';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const video = document.querySelector<HTMLVideoElement>('#cam')!;
const preview = document.querySelector<HTMLCanvasElement>('#camPreview')!;

const renderer = new Renderer(canvas);
ui.init();

let currentMode: MatchMode | PracticeMode | null = null;
let currentControl: ControlAdapter | null = null;
let lastModeWasMatch = true;
let tracker: PoseTracker | null = null;

// ---- Fondo animado del menú: pista vacía ----
const idleBall = new Ball();
const idlePlayer = new PlayerEntity('player');
const idleCpu = new PlayerEntity('cpu');
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

function backToMenu(): void {
  currentMode?.stop();
  currentMode = null;
  currentControl?.destroy();
  currentControl = null;
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
    onFinish: (logger, score) => {
      const report = analyzeMatch(logger);
      const title =
        score.winner === 'player'
          ? `🏆 ¡Ganaste ${score.games.player}-${score.games.cpu}!`
          : `Perdiste ${score.games.player}-${score.games.cpu}… ¡la próxima cae!`;
      ui.setCamPreviewVisible(false);
      ui.showReport(title, report);
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
      ui.setCamPreviewVisible(false);
      ui.showReport('🎯 Informe de práctica', report);
    },
  });
  currentMode = practice;
  practice.start();
}

ui.onStartMatch = () => void startMatch();
ui.onStartPractice = () => void startPractice();
ui.onQuit = backToMenu;
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
      getMode(): MatchMode | PracticeMode | null;
      ui: typeof ui;
    };
  }
}
window.__padel = {
  getMode: () => currentMode,
  ui,
};
