// Perfil local del jugador (Fase 1: sin backend). Nombre, mano dominante y
// aspecto del avatar, guardados en localStorage igual que la progresión.
// Cuando exista inicio de sesión real (Fase 2), este módulo pasa a ser la
// caché local del perfil remoto sin cambiar a quienes lo consumen.

export interface PlayerProfile {
  name: string;
  dominantHand: 'left' | 'right';
  kit: number; // índice en KITS
  skin: number; // índice en SKINS
}

/** Equipaciones disponibles (color de camiseta + su sombra). */
export const KITS: Array<{ name: string; shirt: string; shirtDark: string }> = [
  { name: 'Menta', shirt: '#2fd6b3', shirtDark: '#118b72' },
  { name: 'Azul', shirt: '#4da3ff', shirtDark: '#1f5fb8' },
  { name: 'Rojo', shirt: '#f0564e', shirtDark: '#a82820' },
  { name: 'Morado', shirt: '#a06bf0', shirtDark: '#6533ad' },
  { name: 'Amarillo', shirt: '#f5c93d', shirtDark: '#b08a12' },
];

/** Tonos de piel disponibles. */
export const SKINS: Array<{ name: string; skin: string; hair: string }> = [
  { name: 'Claro', skin: '#efc296', hair: '#3a2a1c' },
  { name: 'Medio', skin: '#c68e5f', hair: '#241812' },
  { name: 'Oscuro', skin: '#8a5a3b', hair: '#120c08' },
];

const KEY = 'padelcam_profile_v1';

const DEFAULT_PROFILE: PlayerProfile = {
  name: '',
  dominantHand: 'right',
  kit: 0,
  skin: 0,
};

export function loadProfile(): PlayerProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const p = JSON.parse(raw) as Partial<PlayerProfile>;
    return {
      name: typeof p.name === 'string' ? p.name.slice(0, 14) : '',
      dominantHand: p.dominantHand === 'left' ? 'left' : 'right',
      kit: typeof p.kit === 'number' && KITS[p.kit] ? p.kit : 0,
      skin: typeof p.skin === 'number' && SKINS[p.skin] ? p.skin : 0,
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function saveProfile(p: PlayerProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // localStorage bloqueado (modo privado): el perfil vive solo en memoria
  }
}

/** Paleta de render del avatar según el perfil (pantalón fijo del kit base). */
export function profilePalette(p: PlayerProfile): {
  shirt: string; shirtDark: string; shorts: string; skin: string; hair: string;
} {
  const kit = KITS[p.kit] ?? KITS[0];
  const skin = SKINS[p.skin] ?? SKINS[0];
  return {
    shirt: kit.shirt,
    shirtDark: kit.shirtDark,
    shorts: '#14293e',
    skin: skin.skin,
    hair: skin.hair,
  };
}
