import { sfx } from '../audio/sfx';
import { RIVALS, ROUND_NAMES, TOURNEY_GAMES } from '../modes/tournament';
import type { Report } from '../analysis/coach';
import type { Correction, DrillSuggestion, ProgressSummary, SavedSession } from '../analysis/progress';
import type { ControlMode, Difficulty, DrillType } from '../types';

export interface MenuSettings {
  control: ControlMode;
  difficulty: Difficulty;
  drill: DrillType;
}

type ScreenId = 'menu' | 'calib' | 'report' | 'progress' | 'tourney' | 'online' | 'none';

export type TourneyPhase = 'play' | 'lost' | 'champion';

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
  onShowProgress: (() => void) | null = null;
  onClearProgress: (() => void) | null = null;
  onCoachTrain: (() => void) | null = null;
  onMenuShown: (() => void) | null = null;
  onStartTournament: (() => void) | null = null;
  onTourneyGo: (() => void) | null = null;
  onTourneyQuit: (() => void) | null = null;
  onOnlineHost: (() => void) | null = null;
  onOnlineJoin: ((code: string) => void) | null = null;
  onOnlineBack: (() => void) | null = null;

  private toastTimer: number | null = null;
  private tourneyPhase: TourneyPhase = 'play';

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
    $('#btnProgress').addEventListener('click', () => this.onShowProgress?.());
    $('#btnReportProgress').addEventListener('click', () => this.onShowProgress?.());
    $('#btnProgressBack').addEventListener('click', () => this.show('menu'));
    $('#btnProgressClear').addEventListener('click', () => this.onClearProgress?.());
    $('#btnCoachTrain').addEventListener('click', () => this.onCoachTrain?.());
    $('#btnTournament').addEventListener('click', () => this.onStartTournament?.());
    $('#btnTourneyGo').addEventListener('click', () => {
      if (this.tourneyPhase === 'play') this.onTourneyGo?.();
      else this.onTourneyQuit?.();
    });
    $('#btnTourneyQuit').addEventListener('click', () => this.onTourneyQuit?.());
    $('#btnOnline').addEventListener('click', () => {
      this.setOnlineStatus('Elige una opción', 'wait');
      this.show('online');
    });
    $('#btnOnlineHost').addEventListener('click', () => this.onOnlineHost?.());
    $('#btnOnlineJoin').addEventListener('click', () => {
      const code = ($('#onlineCode') as HTMLInputElement).value;
      if (code.trim().length >= 4) this.onOnlineJoin?.(code);
      else this.setOnlineStatus('Escribe el código de 4 letras de la partida', 'err');
    });
    $('#btnOnlineBack').addEventListener('click', () => this.onOnlineBack?.());

    // Sonido: desbloquear el AudioContext con el primer gesto y clicks de UI
    const btnSound = $('#btnSound') as HTMLButtonElement;
    const syncSound = () => {
      btnSound.textContent = sfx.muted ? '🔇' : '🔊';
      btnSound.title = sfx.muted ? 'Activar sonido' : 'Silenciar';
    };
    btnSound.addEventListener('click', () => {
      sfx.unlock();
      sfx.setMuted(!sfx.muted);
      syncSound();
    });
    syncSound();
    window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
    window.addEventListener('keydown', () => sfx.unlock(), { once: true });
    $('#ui').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) sfx.click();
    });

    const isTouch = 'ontouchstart' in window;
    $('#menuHint').textContent = isTouch
      ? 'Táctil: lado izquierdo para moverte, toca el lado derecho para golpear (zona alta de la pantalla = remate).'
      : 'Teclado: flechas o WASD para moverte · ESPACIO golpea (←/→ dirigen). Con globo: ESPACIO = bandeja · ↑+ESPACIO = remate · ←/→+ESPACIO = víbora.';
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
    if (id === 'menu') this.onMenuShown?.();
  }

  /** Selecciona un drill en el menú (igual que si el usuario pulsara el botón). */
  selectDrill(drill: DrillType): void {
    this.settings.drill = drill;
    $('#drillRow')
      .querySelectorAll<HTMLButtonElement>('.opt')
      .forEach((b) => b.classList.toggle('selected', b.dataset.drill === drill));
  }

  /** Tarjeta "entrenamiento del día" del menú: racha + drill sugerido. */
  setCoach(summary: ProgressSummary, suggestion: DrillSuggestion | null, trophies = 0): void {
    const card = $('#coachCard');
    if (summary.totalSessions === 0) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const fire = summary.streakDays >= 3 ? '🔥🔥' : '🔥';
    const cup = trophies > 0 ? `🏆 ${trophies} · ` : '';
    $('#coachStreak').textContent =
      cup +
      (summary.streakDays > 0
        ? `${fire} Racha: ${summary.streakDays} ${summary.streakDays === 1 ? 'día' : 'días'} entrenando` +
          (summary.trainedToday ? ' · ¡hoy ya cuenta!' : ' · entrena hoy para no perderla')
        : `${summary.totalSessions} sesiones guardadas · entrena hoy para empezar una racha`);
    const tip = $('#coachTip');
    const btn = $('#btnCoachTrain') as HTMLButtonElement;
    if (suggestion) {
      tip.textContent = `🧑‍🏫 ${suggestion.reason}`;
      btn.hidden = false;
    } else {
      tip.textContent = '🧑‍🏫 Sin correcciones pendientes: ¡a por un partido!';
      btn.hidden = true;
    }
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

  setReplay(v: boolean): void {
    $('#replayBadge').classList.toggle('show', v);
  }

  setOnlineStatus(text: string, state: 'wait' | 'ok' | 'err'): void {
    const el = $('#onlineStatus');
    el.textContent = text;
    el.classList.toggle('ok', state === 'ok');
    el.classList.toggle('err', state === 'err');
  }

  /** Pantalla del torneo: presentación de ronda, eliminación o título de campeón. */
  showTourney(round: number, phase: TourneyPhase, trophies = 0): void {
    this.tourneyPhase = phase;
    const rival = RIVALS[Math.min(round, RIVALS.length - 1)];

    if (phase === 'play') {
      $('#tourneyTitle').textContent = `🏟️ ${ROUND_NAMES[round]} · te espera ${rival.name}`;
      $('#tourneySub').textContent = `${rival.tagline} (set corto: a ${TOURNEY_GAMES} juegos)`;
      ($('#btnTourneyGo') as HTMLButtonElement).textContent = '¡A jugar!';
      $('#btnTourneyQuit').hidden = false;
    } else if (phase === 'lost') {
      $('#tourneyTitle').textContent = '💔 Eliminado del torneo';
      $('#tourneySub').textContent = `${rival.name} te mandó a casa. Entrena en el Modo Práctica y vuelve a por el título.`;
      ($('#btnTourneyGo') as HTMLButtonElement).textContent = 'Volver al menú';
      $('#btnTourneyQuit').hidden = true;
    } else {
      $('#tourneyTitle').textContent = '🏆 ¡CAMPEÓN DEL TORNEO!';
      $('#tourneySub').textContent = `El Káiser ha caído. Trofeos en tu palmarés: ${trophies} 🏆`;
      ($('#btnTourneyGo') as HTMLButtonElement).textContent = 'Volver al menú';
      $('#btnTourneyQuit').hidden = true;
    }

    $('#tourneyBracket').innerHTML = RIVALS.map((r, i) => {
      let icon: string;
      if (phase === 'champion' || i < round) icon = '✅';
      else if (i === round) icon = phase === 'lost' ? '❌' : '🎾';
      else icon = '🔒';
      const now = i === round && phase === 'play';
      return `<div class="session-card${now ? ' current-round' : ''}"><div class="session-head"><span>${icon} ${ROUND_NAMES[i]}</span><span class="session-date">${r.name}</span></div></div>`;
    }).join('');

    this.show('tourney');
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

  showReport(title: string, report: Report, saved = false): void {
    $('#reportTitle').textContent = title;
    $('#reportStats').innerHTML = report.stats
      .map(
        (s) => `<div class="stat-card"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`,
      )
      .join('');
    $('#reportTips').innerHTML = report.tips
      .map((t) => `<div class="tip${t.warn ? ' warn' : ''}">${t.warn ? '⚠️' : '✅'} ${t.text}</div>`)
      .join('');
    $('#reportSaved').textContent = saved
      ? '💾 Informe guardado: revisa tus correcciones en «Mi progreso»'
      : '';
    this.show('report');
  }

  showProgress(sessions: SavedSession[], corrections: Correction[], trophies = 0): void {
    $('#progressTrophies').textContent =
      trophies > 0 ? `🏆 Torneos ganados: ${trophies}` : '';
    const cEl = $('#progressCorrections');
    if (corrections.length === 0) {
      cEl.innerHTML =
        '<p class="hint">Aún no hay correcciones guardadas. Juega un partido o una práctica y tu entrenador anotará aquí lo que tienes que trabajar.</p>';
    } else {
      cEl.innerHTML = corrections
        .slice(0, 6)
        .map(
          (c) =>
            `<div class="tip${c.active ? ' warn' : ''}"><b>${
              c.active ? '📌 Pendiente' : '✅ Sin repetir últimamente'
            }</b> · vista en ${c.count} ${c.count === 1 ? 'sesión' : 'sesiones'}<br>${c.text}</div>`,
        )
        .join('');
    }

    const sEl = $('#progressSessions');
    if (sessions.length === 0) {
      sEl.innerHTML = '<p class="hint">Sin sesiones todavía.</p>';
    } else {
      const fmt = new Intl.DateTimeFormat('es', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      sEl.innerHTML = [...sessions]
        .slice(-10)
        .reverse()
        .map((s) => {
          const stats = s.stats
            .slice(0, 3)
            .map((st) => `${st.lbl}: <b>${st.val}</b>`)
            .join(' · ');
          return `<div class="session-card"><div class="session-head"><span>${
            s.mode === 'match' ? '🏆' : '🎯'
          } ${s.title}</span><span class="session-date">${fmt.format(
            new Date(s.date),
          )}</span></div><div class="session-stats">${stats}</div></div>`;
        })
        .join('');
    }
    this.show('progress');
  }
}

export const ui = new UI();
