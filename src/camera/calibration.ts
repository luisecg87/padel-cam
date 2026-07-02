import { LM, PoseTracker, drawPreview } from './pose';
import { ui } from '../ui/screens';
import type { CalibrationData } from './gestures';

const STABLE_FRAMES = 25;

/**
 * Pantalla de calibración: espera a ver el cuerpo (caderas + hombros + una
 * muñeca) estable durante unos frames y captura la posición neutra.
 * Devuelve los datos de calibración, o null si el usuario cancela.
 */
export function runCalibration(
  tracker: PoseTracker,
  preview: HTMLCanvasElement,
): Promise<CalibrationData | null> {
  return new Promise((resolve) => {
    let stable = 0;
    let raf = 0;
    let done = false;
    let lastCalib: CalibrationData | null = null;

    const finish = (result: CalibrationData | null) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      ui.onCalibReady = null;
      ui.onCalibCancel = null;
      resolve(result);
    };

    ui.show('calib');
    ui.setCamPreviewVisible(true);
    ui.setCalibStatus('Buscándote… colócate frente a la cámara', 'wait');

    ui.onCalibReady = () => finish(lastCalib);
    ui.onCalibCancel = () => finish(null);

    const tick = () => {
      if (done) return;
      const frame = tracker.latest;
      drawPreview(preview, tracker.video, frame);

      if (!frame) {
        stable = 0;
        ui.setCalibStatus('No te veo. Aléjate un poco y busca buena luz.', 'wait');
      } else {
        const lm = frame.lm;
        const vis = (i: number) => (lm[i]?.visibility ?? 0) > 0.5;
        const bodyOk =
          vis(LM.L_HIP) && vis(LM.R_HIP) &&
          vis(LM.L_SHOULDER) && vis(LM.R_SHOULDER) &&
          (vis(LM.L_WRIST) || vis(LM.R_WRIST));

        if (!bodyOk) {
          stable = 0;
          ui.setCalibStatus('Te veo a medias: necesito verte de la cintura hacia arriba.', 'wait');
        } else {
          stable++;
          if (stable >= STABLE_FRAMES) {
            lastCalib = {
              neutralHipX: (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2,
              shoulderWidth: Math.abs(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x),
            };
            ui.setCalibStatus('✅ ¡Perfecto! Te veo bien. Pulsa "¡Listo, a jugar!"', 'ok');
          } else {
            ui.setCalibStatus(`Quieto ahí… (${Math.round((stable / STABLE_FRAMES) * 100)}%)`, 'wait');
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
