import { formatRatingDelta } from '../analysis/progress';
import type { BiomechanicPillars, PadelRatingInfo } from '../analysis/progress';
import { clamp } from '../types';

export interface ShareCardData {
  padelRating: PadelRatingInfo;
  /** Variación del Padel Rating tras la sesión (ej. +0.08 o -0.03). */
  ratingDelta?: number | null;
  streakDays: number;
  consistency: number; // 0..100
  sessionTitle: string;
  pillars: BiomechanicPillars;
  coachBadge: string;
  coachDiagnosis: string;
  coachExercise: string;
  date?: Date;
}

const CARD_W = 1080;
const CARD_H = 1350;

const PALETTE = {
  bg: '#0a0f1d',
  bgDeep: '#060913',
  cardBg: 'rgba(15, 24, 42, 0.88)',
  cardBorder: 'rgba(0, 245, 212, 0.32)',
  neon: '#00f5d4',
  neonSoft: 'rgba(0, 245, 212, 0.16)',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  gold: '#ffd166',
  text: '#f8fafc',
  muted: '#94a3b8',
} as const;

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines = 4,
): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

function pillarColor(pct: number): string {
  if (pct >= 75) return PALETTE.neon;
  if (pct >= 50) return PALETTE.warn;
  return PALETTE.bad;
}

/**
 * Dibuja en un `<canvas>` de 1080×1350 px (formato vertical 4:5 ideal para WhatsApp e Instagram)
 * la Ficha Técnica Compartible con estética Dark (`#0a0f1d`) + Neon Cyan (`#00f5d4`).
 */
export function renderShareCardCanvas(data: ShareCardData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d')!;

  // 1. Fondo principal Dark (#0a0f1d) + resplandores cian neón (#00f5d4)
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const topGlow = ctx.createRadialGradient(CARD_W * 0.82, 160, 20, CARD_W * 0.82, 160, 560);
  topGlow.addColorStop(0, 'rgba(0, 245, 212, 0.22)');
  topGlow.addColorStop(1, 'rgba(0, 245, 212, 0)');
  ctx.fillStyle = topGlow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const bottomGlow = ctx.createRadialGradient(CARD_W * 0.18, CARD_H - 180, 20, CARD_W * 0.18, CARD_H - 180, 520);
  bottomGlow.addColorStop(0, 'rgba(0, 245, 212, 0.14)');
  bottomGlow.addColorStop(1, 'rgba(0, 245, 212, 0)');
  ctx.fillStyle = bottomGlow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Líneas sutiles de pista de pádel en el fondo
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 245, 212, 0.045)';
  ctx.lineWidth = 2;
  for (let y = 140; y < CARD_H; y += 120) {
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(CARD_W - 48, y);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(CARD_W / 2, 140);
  ctx.lineTo(CARD_W / 2, CARD_H - 90);
  ctx.stroke();
  ctx.restore();

  // Marco exterior neón sutil
  ctx.strokeStyle = 'rgba(0, 245, 212, 0.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(28, 28, CARD_W - 56, CARD_H - 56, 36);
  ctx.stroke();

  const padX = 68;
  const innerW = CARD_W - padX * 2;

  // 2. Cabecera con logo/título "PADEL-CAM AI COACH" y fecha
  const now = data.date ?? new Date();
  const dateStr = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(now)
    .toUpperCase();

  // Icono/píldora neón izquierda
  ctx.fillStyle = PALETTE.neonSoft;
  ctx.strokeStyle = PALETTE.neon;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(padX, 66, 68, 68, 18);
  ctx.fill();
  ctx.stroke();

  ctx.font = '900 36px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.neon;
  ctx.fillText('🎾', padX + 34, 102);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 34px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText('PADEL-CAM ', padX + 86, 98);
  const titleW = ctx.measureText('PADEL-CAM ').width;
  ctx.fillStyle = PALETTE.neon;
  ctx.fillText('AI COACH', padX + 86 + titleW, 98);

  ctx.font = '700 18px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText('FICHA TÉCNICA BIOMECÁNICA · VISIÓN POR COMPUTADOR', padX + 86, 126);

  // Píldora de fecha a la derecha
  ctx.font = '800 20px "Segoe UI", system-ui, sans-serif';
  const dateW = ctx.measureText(dateStr).width + 38;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(CARD_W - padX - dateW, 76, dateW, 46, 23);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(dateStr, CARD_W - padX - dateW / 2, 106);

  // 3. Bloque Hero: Padel Rating gigante (ej. NIVEL 3.45) + Categoría + Delta + Racha de días
  const heroY = 166;
  const heroH = 310;
  ctx.fillStyle = PALETTE.cardBg;
  ctx.strokeStyle = PALETTE.neon;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(padX, heroY, innerW, heroH, 28);
  ctx.fill();
  ctx.stroke();

  // Etiqueta superior dentro del Hero
  ctx.textAlign = 'left';
  ctx.font = '800 20px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.neon;
  ctx.fillText('PADEL RATING OFICIAL (ESCALA 1.00 – 7.00)', padX + 38, heroY + 46);

  ctx.textAlign = 'right';
  ctx.font = '800 19px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText(data.sessionTitle.toUpperCase(), CARD_W - padX - 38, heroY + 46);

  // Texto gigante NIVEL X.XX
  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = '900 112px "Segoe UI", system-ui, sans-serif';
  ctx.shadowColor = 'rgba(0, 245, 212, 0.45)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = PALETTE.text;
  const ratingLabel = `NIVEL ${data.padelRating.formatted}`;
  ctx.fillText(ratingLabel, padX + 36, heroY + 172);
  ctx.restore();

  // Delta badge (+0.08 ▲ / -0.03 ▼) si aplica
  if (typeof data.ratingDelta === 'number' && Math.abs(data.ratingDelta) >= 0.005) {
    const dInfo = formatRatingDelta(data.ratingDelta);
    const deltaCol = dInfo.dir === 'up' ? PALETTE.neon : dInfo.dir === 'down' ? PALETTE.bad : PALETTE.muted;
    const deltaBg =
      dInfo.dir === 'up'
        ? 'rgba(0, 245, 212, 0.16)'
        : dInfo.dir === 'down'
          ? 'rgba(248, 113, 113, 0.18)'
          : 'rgba(255,255,255,0.08)';
    ctx.font = '900 32px "Segoe UI", system-ui, sans-serif';
    const dw = ctx.measureText(dInfo.text).width + 44;
    const dx = CARD_W - padX - 38 - dw;
    const dy = heroY + 102;
    ctx.fillStyle = deltaBg;
    ctx.strokeStyle = deltaCol;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(dx, dy, dw, 60, 18);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = deltaCol;
    ctx.fillText(dInfo.text, dx + dw / 2, dy + 41);
  }

  // Fila inferior del Hero: Categoría + Racha de días + Consistencia técnica
  const pillY = heroY + 216;
  const catText = `🏆 CATEGORÍA: ${data.padelRating.category.toUpperCase()}`;
  ctx.font = '800 22px "Segoe UI", system-ui, sans-serif';
  const catW = ctx.measureText(catText).width + 42;
  ctx.fillStyle = 'rgba(0, 245, 212, 0.18)';
  ctx.strokeStyle = PALETTE.neon;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(padX + 38, pillY, catW, 56, 16);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = PALETTE.neon;
  ctx.fillText(catText, padX + 59, pillY + 36);

  const streakText =
    data.streakDays > 0
      ? `🔥 RACHA: ${data.streakDays} ${data.streakDays === 1 ? 'DÍA' : 'DÍAS'}`
      : '🔥 RACHA ACTIVA HOY';
  const streakW = ctx.measureText(streakText).width + 40;
  const streakX = padX + 38 + catW + 18;
  ctx.fillStyle = 'rgba(255, 209, 102, 0.14)';
  ctx.strokeStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.roundRect(streakX, pillY, streakW, 56, 16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(streakText, streakX + 20, pillY + 36);

  // Consistencia a la derecha
  ctx.textAlign = 'right';
  ctx.font = '800 22px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(`CONSISTENCIA: ${clamp(Math.round(data.consistency), 0, 100)}%`, CARD_W - padX - 38, pillY + 36);

  // 4. Anillos y barras de los 4 Pilares Biomecánicos (Rodillas, Giro de Hombros, Armado, Timing)
  const bioSectionY = 516;
  ctx.textAlign = 'left';
  ctx.font = '900 24px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText('PILARES BIOMECÁNICOS ANALIZADOS', padX, bioSectionY);

  ctx.textAlign = 'right';
  ctx.font = '700 18px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText('PRECISIÓN TÉCNICA (0 – 100%)', CARD_W - padX, bioSectionY);

  const pillarsList: Array<{ label: string; sub: string; val: number }> = [
    { label: 'RODILLAS', sub: 'Flexión y centro de gravedad', val: clamp(Math.round(data.pillars.knees), 0, 100) },
    {
      label: 'GIRO DE HOMBROS',
      sub: 'Perfilado lateral del tronco',
      val: clamp(Math.round(data.pillars.shoulderTurn), 0, 100),
    },
    { label: 'ARMADO', sub: 'Preparación temprana de pala', val: clamp(Math.round(data.pillars.prep), 0, 100) },
    { label: 'TIMING', sub: 'Sincronización en el impacto', val: clamp(Math.round(data.pillars.timing), 0, 100) },
  ];

  const gridTop = bioSectionY + 24;
  const colGap = 24;
  const rowGap = 22;
  const boxW = (innerW - colGap) / 2;
  const boxH = 164;

  pillarsList.forEach((p, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const bx = padX + col * (boxW + colGap);
    const by = gridTop + row * (boxH + rowGap);
    const pCol = pillarColor(p.val);

    ctx.fillStyle = PALETTE.cardBg;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 22);
    ctx.fill();
    ctx.stroke();

    // Anillo circular izquierdo dentro de la tarjeta del pilar
    const ringCx = bx + 64;
    const ringCy = by + boxH / 2;
    const ringR = 38;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = pCol;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + (p.val / 100) * Math.PI * 2);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 22px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(`${p.val}%`, ringCx, ringCy + 1);

    // Nombre del pilar y barra de progreso horizontal
    const textX = bx + 122;
    const barW = boxW - 148;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '900 23px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(p.label, textX, by + 58);

    ctx.font = '600 17px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(p.sub, textX, by + 86);

    // Barra de fondo
    const barY = by + 108;
    const barH = 16;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.beginPath();
    ctx.roundRect(textX, barY, barW, barH, 8);
    ctx.fill();

    // Relleno de barra
    const fillW = Math.max(12, (barW * p.val) / 100);
    ctx.fillStyle = pCol;
    ctx.beginPath();
    ctx.roundRect(textX, barY, fillW, barH, 8);
    ctx.fill();
  });

  // 5. Tarjeta inferior: Diagnóstico del Coach de la sesión
  const coachY = gridTop + boxH * 2 + rowGap + 34;
  const coachH = 310;

  ctx.fillStyle = 'rgba(14, 25, 45, 0.94)';
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(padX, coachY, innerW, coachH, 26);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = '900 26px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText('🧑‍🏫 DIAGNÓSTICO DEL COACH', padX + 34, coachY + 52);

  // Badge de diagnóstico a la derecha
  ctx.font = '800 18px "Segoe UI", system-ui, sans-serif';
  const badgeTxt = data.coachBadge.toUpperCase();
  const badgeW = ctx.measureText(badgeTxt).width + 34;
  ctx.fillStyle = 'rgba(0, 245, 212, 0.15)';
  ctx.strokeStyle = PALETTE.neon;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.roundRect(CARD_W - padX - 34 - badgeW, coachY + 22, badgeW, 42, 21);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.neon;
  ctx.fillText(badgeTxt, CARD_W - padX - 34 - badgeW / 2, coachY + 49);

  // Párrafo de diagnóstico
  ctx.textAlign = 'left';
  ctx.font = '600 24px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.text;
  const diagLines = wrapLines(ctx, data.coachDiagnosis, innerW - 68, 3);
  diagLines.forEach((line, i) => {
    ctx.fillText(line, padX + 34, coachY + 104 + i * 34);
  });

  // Caja de recomendación de ejercicio
  const drillBoxY = coachY + coachH - 86;
  ctx.fillStyle = 'rgba(0, 245, 212, 0.1)';
  ctx.strokeStyle = 'rgba(0, 245, 212, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(padX + 30, drillBoxY, innerW - 60, 62, 16);
  ctx.fill();
  ctx.stroke();

  ctx.font = '800 21px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.neon;
  const exLines = wrapLines(ctx, `🎯 EJERCICIO RECOMENDADO: ${data.coachExercise}`, innerW - 100, 1);
  ctx.fillText(exLines[0] ?? '', padX + 52, drillBoxY + 39);

  // 6. Pie de tarjeta
  ctx.textAlign = 'center';
  ctx.font = '700 20px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText(
    '🎾 Entrena con tu cámara desde el navegador · PADEL-CAM AI COACH',
    CARD_W / 2,
    CARD_H - 52,
  );

  return canvas;
}

export async function generateShareCardBlob(data: ShareCardData): Promise<Blob> {
  const canvas = renderShareCardCanvas(data);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('No se pudo generar la imagen PNG de la Ficha Técnica'));
    }, 'image/png');
  });
}

function downloadBlobAsPng(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Comparte la Ficha Técnica mediante `navigator.share({ files: [file] })` en móviles
 * o descarga automáticamente el archivo PNG en escritorio si Web Share de archivos no está disponible.
 */
export async function shareTechnicalCard(
  data: ShareCardData,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await generateShareCardBlob(data);
  const filename = `padel-cam-nivel-${data.padelRating.formatted.replace('.', '_')}.png`;
  const file = new File([blob], filename, { type: 'image/png' });

  const shareTitle = `Padel-Cam AI Coach · Nivel ${data.padelRating.formatted}`;
  const shareText = `🎾 Mi Padel Rating en Padel-Cam AI Coach es NIVEL ${data.padelRating.formatted} (${data.padelRating.category}). ¡Entrena tu biomecánica con la cámara!`;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const canShareFiles =
      typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
    if (canShareFiles) {
      try {
        await navigator.share({
          files: [file],
          title: shareTitle,
          text: shareText,
        });
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return 'cancelled';
        }
        // Si falló por soporte parcial de archivos, hacemos fallback a descarga PNG
      }
    }
  }

  downloadBlobAsPng(blob, filename);
  return 'downloaded';
}
