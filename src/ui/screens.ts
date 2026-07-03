import { sfx } from '../audio/sfx';
import { RIVALS, ROUND_NAMES, TOURNEY_GAMES } from '../modes/tournament';
import type { Report } from '../analysis/coach';
import type { ChallengeRecord, Correction, DrillSuggestion, ProgressSummary, SavedSession, XpInfo } from '../analysis/progress';
import type { ChallengeDef, ChallengeResult } from '../modes/challenges';
import type { TrainingSummary } from '../training/session';
import { SHOT_NAMES } from '../types';
import type { ControlMode, Difficulty, DrillType } from '../types';

export interface MenuSettings {
  control: ControlMode;
  difficulty: Difficulty;
  drill: DrillType;
}

type ScreenId =
  | 'menu'
  | 'calib'
  | 'report'
  | 'progress'
  | 'tourney'
  | 'online'
  | 'trainSummary'
  | 'challenges'
  | 'challengeEnd'
  | 'none';

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
  onStartTraining: (() => void) | null = null;
  onTrainAgain: (() => void) | null = null;
  onShowChallenges: (() => void) | null = null;
  onPlayChallenge: ((id: string) => void) | null = null;
  onChallengeAgain: (() => void) | null = null;

  private toastTimer: number | null = null;
  private shotChipTimer: number | null = null;
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
    $('#btnTraining').addEventListener('click', () => this.onStartTraining?.());
    $('#btnTrainAgain').addEventListener('click', () => this.onTrainAgain?.());
    $('#btnTrainMenu').addEventListener('click', () => this.show('menu'));
    $('#btnChallenges').addEventListener('click', () => this.onShowChallenges?.());
    $('#btnChallengesBack').addEventListener('click', () => this.show('menu'));
    $('#btnChallengeAgain').addEventListener('click', () => this.onChallengeAgain?.());
    $('#btnChallengeList').addEventListener('click', () => this.onShowChallenges?.());
    $('#btnChallengeMenu').addEventListener('click', () => this.show('menu'));
    $('#challengeList').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-challenge]');
      if (btn) this.onPlayChallenge?.(btn.dataset.challenge!);
    });

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
  setCoach(
    summary: ProgressSummary,
    suggestion: DrillSuggestion | null,
    trophies = 0,
    xp: XpInfo | null = null,
  ): void {
    const card = $('#coachCard');
    if (summary.totalSessions === 0 && (!xp || xp.xp === 0)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    if (xp && xp.xp > 0) {
      $('#coachLevel').textContent = `Nivel ${xp.level} · ${xp.title}`;
      $('#coachXpFill').style.width = `${Math.round((xp.levelXp / xp.levelSize) * 100)}%`;
      ($('#coachXpBar') as HTMLElement).style.display = 'block';
    } else {
      $('#coachLevel').textContent = '';
      ($('#coachXpBar') as HTMLElement).style.display = 'none';
    }
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
    const p = $('#scorePoints');
    if (p.textContent && p.textContent !== pointsLabel) {
      // Microanimación al cambiar el marcador
      p.classList.remove('bump');
      void p.offsetWidth; // reinicia la animación
      p.classList.add('bump');
    }
    p.textContent = pointsLabel;
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

  /**
   * Lectura de técnica breve tras un golpe del jugador (timing/postura/
   * calidad ya calculados por el gameplay): "Buen timing", "Postura
   * mejorable"... No es un sistema nuevo, solo expone datos existentes.
   */
  setShotFeedback(text: string, level: 'good' | 'warn' | 'bad'): void {
    const el = $('#shotChip');
    el.textContent = text;
    el.className = `show ${level}`;
    if (this.shotChipTimer !== null) clearTimeout(this.shotChipTimer);
    this.shotChipTimer = window.setTimeout(() => el.classList.remove('show'), 850);
  }

  /** Racha de buenos golpes: 🔥 visible a partir de 3 seguidos. */
  setFire(n: number): void {
    const el = $('#fireChip');
    if (n >= 3) {
      el.textContent = `🔥 x${n}`;
      el.classList.add('show');
    } else {
      el.classList.remove('show');
    }
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

  showReport(title: string, report: Report, saved = false, xpNote = ''): void {
    $('#reportTitle').textContent = title;
    $('#reportStats').innerHTML = report.stats
      .map(
        (s) => `<div class="stat-card"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`,
      )
      .join('');
    $('#reportTips').innerHTML = report.tips
      .map((t) => `<div class="tip${t.warn ? ' warn' : ''}">${t.warn ? '⚠️' : '✅'} ${t.text}</div>`)
      .join('');
    const parts = [
      saved ? '💾 Informe guardado en «Mi progresión»' : '',
      xpNote,
    ].filter(Boolean);
    $('#reportSaved').textContent = parts.join(' · ');
    this.show('report');
  }

  /** Selector de desafíos con récords y estrellas. */
  showChallenges(defs: ChallengeDef[], records: Record<string, ChallengeRecord>): void {
    $('#challengeList').innerHTML = defs
      .map((d) => {
        const r = records[d.id];
        const stars = '★'.repeat(r?.stars ?? 0) + '☆'.repeat(3 - (r?.stars ?? 0));
        const meta = r ? `${stars} · Récord: ${r.best} ${d.unit}` : `${stars} · Sin jugar todavía`;
        return `<div class="challenge-card"><div class="icon">${d.icon}</div><div class="info"><b>${d.name}</b><p>${d.desc}</p><div class="meta">${meta}</div></div><button class="play" data-challenge="${d.id}">Jugar</button></div>`;
      })
      .join('');
    this.show('challenges');
  }

  /** Resultado de un desafío: puntuación, estrellas, récord y XP. */
  showChallengeEnd(
    result: ChallengeResult,
    record: ChallengeRecord,
    isNewBest: boolean,
    xpGained: number,
    leveledUp: boolean,
  ): void {
    $('#ceName').textContent = `${result.def.icon} ${result.def.name.toUpperCase()}`;
    $('#ceStars').textContent = '★'.repeat(result.stars) + '☆'.repeat(3 - result.stars);
    $('#ceScore').textContent = `${result.score}`;
    $('#ceUnit').textContent = result.def.unit;
    $('#ceRecord').textContent = isNewBest
      ? '🎉 ¡Nuevo récord personal!'
      : `Récord personal: ${record.best} ${result.def.unit}`;
    $('#ceXp').textContent = `+${xpGained} XP${leveledUp ? ' · ⬆️ ¡SUBES DE NIVEL!' : ''}`;
    this.show('challengeEnd');
  }

  /** TrainingSessionSummary: resumen visual de la sesión de técnica. */
  showTrainingSummary(s: TrainingSummary, xpGained = 0): void {
    $('#tsShot').textContent =
      `SESIÓN · ${SHOT_NAMES[s.shot].toUpperCase()}` + (xpGained > 0 ? ` · +${xpGained} XP` : '');
    $('#tsReps').textContent = `${s.reps.length}`;
    $('#tsCorrect').textContent = `${s.correct}`;
    $('#tsStreak').textContent = `${s.bestStreak}`;
    $('#tsTiming').textContent =
      s.meanDtMs === null ? '—' : `${s.meanDtMs > 0 ? '+' : ''}${s.meanDtMs} ms`;

    // Gauge de consistencia (anillo conic-gradient, color por estado)
    const pct = s.consistency;
    const col = pct >= 75 ? 'var(--tr-good)' : pct >= 50 ? 'var(--tr-warn)' : 'var(--tr-bad)';
    const gauge = $('#tsGauge');
    gauge.style.background = `conic-gradient(${col} ${pct * 3.6}deg, rgba(255,255,255,.09) 0deg)`;
    const gv = $('#tsGaugeVal');
    gv.textContent = `${pct}%`;
    gv.style.color = col;

    this.drawTimingChart($('#tsChart') as HTMLCanvasElement, s);

    // TrainingInsightCard: error principal + recomendación
    const cards: string[] = [];
    if (s.mainIssue) {
      cards.push(
        `<div class="ts-insight warn"><b>A CORREGIR</b>${s.mainIssue.text}</div>`,
      );
    }
    cards.push(`<div class="ts-insight"><b>PRÓXIMA SESIÓN</b>${s.recommendation}</div>`);
    $('#tsInsights').innerHTML = cards.join('');

    this.show('trainSummary');
  }

  /**
   * Timing por repetición: barra con signo (arriba = tarde, abajo = pronto),
   * banda de ±150 ms como ventana ideal y color de estado por repetición.
   * El estado nunca va solo en el color: lo lleva también la altura/side.
   */
  private drawTimingChart(canvas: HTMLCanvasElement, s: TrainingSummary): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth || 500;
    const H = 120;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 8;
    const padR = 8;
    const midY = H / 2;
    const maxMs = 600; // escala fija: ±600 ms
    const yOf = (ms: number): number => midY - (Math.max(-maxMs, Math.min(maxMs, ms)) / maxMs) * (H / 2 - 12);

    // Banda de ventana ideal ±150 ms
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(padL, yOf(150), W - padL - padR, yOf(-150) - yOf(150));
    // Línea base 0
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, midY);
    ctx.lineTo(W - padR, midY);
    ctx.stroke();

    const n = s.reps.length;
    if (n === 0) return;
    const slot = (W - padL - padR) / n;
    const barW = Math.max(Math.min(slot - 4, 26), 6);

    let maxAbs = 0;
    let maxIdx = -1;
    s.reps.forEach((r, i) => {
      if (r.dtMs !== null && Math.abs(r.dtMs) > maxAbs) {
        maxAbs = Math.abs(r.dtMs);
        maxIdx = i;
      }
    });

    s.reps.forEach((r, i) => {
      const cx = padL + slot * i + slot / 2;
      if (r.dtMs === null) {
        // Sin golpe: hueco marcado en la base, sin barra
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(cx - barW / 2, midY - 4, barW, 8);
        ctx.setLineDash([]);
        return;
      }
      const abs = Math.abs(r.dtMs);
      const color = abs <= 150 ? '#34d399' : abs <= 350 ? '#fbbf24' : '#f87171';
      const y = yOf(r.dtMs);
      const top = Math.min(y, midY);
      const h = Math.max(Math.abs(y - midY), 3);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(cx - barW / 2, top, barW, h, 3);
      ctx.fill();
      // Etiqueta directa solo en la peor desviación (selectiva)
      if (i === maxIdx && abs > 150) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        const ly = r.dtMs > 0 ? top - 4 : top + h + 11;
        ctx.fillText(`${r.dtMs > 0 ? '+' : ''}${r.dtMs} ms`, cx, ly);
      }
    });
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
