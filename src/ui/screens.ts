import type { Report } from '../analysis/coach';
import type { ControlMode, Difficulty, DrillType } from '../types';

export interface MenuSettings {
  control: ControlMode;
  difficulty: Difficulty;
  drill: DrillType;
}

type ScreenId = 'menu' | 'calib' | 'report' | 'none';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`No existe el elemento ${sel}`);
  return el;
};

class UI {
  settings: MenuSettings = { control: 'camera', difficulty: 'medium', drill: 'mixto' };

  onStartMatch: (() => void) | null = null;
  onStartPractice: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onAgain: (() => void) | null = null;
  onCalibReady: (() => void) | null = null;
  onCalibCancel: (() => void) | null = null;

  private toastTimer: number | null = null;

  init(): void {
    this.wireOptionRow('#controlRow', 'control', 'control');
    this.wireOptionRow('#difficultyRow', 'diff', 'difficulty');
    this.wireOptionRow('#drillRow', 'drill', 'drill');

    $('#btnMatch').addEventListener('click', () => this.onStartMatch?.());
    $('#btnPractice').addEventListener('click', () => this.onStartPractice?.());
    $('#btnQuit').addEventListener('click', () => this.onQuit?.());
    $('#btnAgain').addEventListener('click', () => this.onAgain?.());
    $('#btnReportMenu').addEventListener('click', () => this.show('menu'));
    $('#btnCalibReady').addEventListener('click', () => this.onCalibReady?.());
    $('#btnCalibCancel').addEventListener('click', () => this.onCalibCancel?.());

    const isTouch = 'ontouchstart' in window;
    $('#menuHint').textContent = isTouch
      ? 'Teclado/Táctil: lado izquierdo para moverte, toca el lado derecho para golpear.'
      : 'Teclado: flechas o WASD para moverte · ESPACIO para golpear (mantén ← o → para dirigir el golpe).';
  }

  private wireOptionRow(rowSel: string, dataKey: string, settingKey: keyof MenuSettings): void {
    const row = $(rowSel);
    row.querySelectorAll<HTMLButtonElement>('.opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.opt').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        (this.settings as unknown as Record<string, string>)[settingKey] =
          btn.dataset[dataKey] ?? '';
      });
    });
  }

  show(id: ScreenId): void {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    if (id !== 'none') $(`#${id}`).classList.add('active');
  }

  setHudVisible(v: boolean): void {
    $('#hud').classList.toggle('active', v);
  }

  setCamPreviewVisible(v: boolean): void {
    $('#camPreview').classList.toggle('visible', v);
  }

  updateScore(games: string, pointsLabel: string): void {
    $('#scoreGames').textContent = games;
    $('#scorePoints').textContent = pointsLabel;
  }

  setServeInfo(text: string): void {
    $('#serveInfo').textContent = text;
  }

  toast(text: string, ms = 1500): void {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  setDrillHud(html: string | null): void {
    const el = $('#drillHud');
    if (html === null) {
      el.classList.remove('active');
    } else {
      el.innerHTML = html;
      el.classList.add('active');
    }
  }

  setCalibStatus(text: string, state: 'wait' | 'ok' | 'err'): void {
    const el = $('#calibStatus');
    el.textContent = text;
    el.classList.toggle('ok', state === 'ok');
    el.classList.toggle('err', state === 'err');
    ($('#btnCalibReady') as HTMLButtonElement).disabled = state !== 'ok';
  }

  showReport(title: string, report: Report): void {
    $('#reportTitle').textContent = title;
    $('#reportStats').innerHTML = report.stats
      .map(
        (s) => `<div class="stat-card"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`,
      )
      .join('');
    $('#reportTips').innerHTML = report.tips
      .map((t) => `<div class="tip${t.warn ? ' warn' : ''}">${t.warn ? '⚠️' : '✅'} ${t.text}</div>`)
      .join('');
    this.show('report');
  }
}

export const ui = new UI();
