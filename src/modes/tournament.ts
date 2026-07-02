import type { AiParams } from '../game/ai';
import type { Palette } from '../game/render';
import type { Difficulty } from '../types';

// Torneo Pádel Cam: tres rondas contra rivales con personalidad propia.
// Se juega con sets cortos (a 3 juegos) para que quepa en una sesión.

export interface Rival {
  name: string;
  tagline: string; // descripción con sabor + pista táctica
  palette: Palette;
  difficulty: Difficulty;
  ai?: Partial<AiParams>;
}

export const ROUND_NAMES = ['Primera ronda', 'Semifinal', 'Final'] as const;

export const TOURNEY_GAMES = 3;

export const RIVALS: Rival[] = [
  {
    name: 'Rubén "Manoplas"',
    tagline: 'Le encanta el globo, pero su volea es de mantequilla. Súbele a la red.',
    palette: {
      shirt: '#8fce5e',
      shirtDark: '#5d9436',
      shorts: '#2b3a26',
      skin: '#e9b98d',
      hair: '#6b4a2b',
    },
    difficulty: 'easy',
    ai: { aimError: 1.5, qualityBase: 0.62 },
  },
  {
    name: 'Marta "La Muralla"',
    tagline: 'Devuelve TODO desde el fondo. Paciencia, profundidad… y a rematar.',
    palette: {
      shirt: '#a86ede',
      shirtDark: '#7440a8',
      shorts: '#241d33',
      skin: '#d9a06b',
      hair: '#151013',
    },
    difficulty: 'medium',
    ai: { missProb: 0.1, speed: 6.2, aimError: 1.2, qualityBase: 0.7 },
  },
  {
    name: 'El Káiser',
    tagline: 'Campeón vigente. Castiga cada bola corta con víboras al cristal.',
    palette: {
      shirt: '#e04545',
      shirtDark: '#8f1f1f',
      shorts: '#141414',
      skin: '#f0c9a0',
      hair: '#e8e3da',
    },
    difficulty: 'hard',
    ai: { speed: 7.2, missProb: 0.05, aimError: 0.55, qualityBase: 0.88 },
  },
];
