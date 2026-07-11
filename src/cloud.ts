// Nube (Fase 2): copia de seguridad y sincronización del perfil y el
// progreso entre dispositivos con Supabase (login por enlace mágico al
// correo, sin contraseñas).
//
// APAGADA por defecto: rellena SUPABASE_URL y SUPABASE_ANON_KEY con los
// valores de tu proyecto (Supabase → Project Settings → API) y ejecuta
// `supabase.sql` una vez en el SQL Editor del proyecto. La clave "anon" es
// pública por diseño (viaja en el bundle de cualquier app Supabase); la
// seguridad la ponen las políticas RLS del SQL: cada usuario solo puede
// leer y escribir SU fila.
//
// Diseño local-primero: el juego SIEMPRE lee y escribe localStorage
// (profile.ts y progress.ts no cambian, tal como pide PLAN.md). Este módulo
// copia esas claves a una fila jsonb por usuario y las restaura al iniciar
// sesión en otro dispositivo. Regla de fusión simple y explicable: gana el
// lado con más XP (nunca se pisa la partida más avanzada).
//
// La librería de Supabase se carga con import() dinámico: si la nube no
// está configurada, no entra ni un byte de ella en lo que descarga el
// jugador.

import type { Session, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://kbzepoqqggonpsfaovma.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qTbiz5RgGjyseBcGRBRXDg_9x3h9ICV';

/** Claves de localStorage que viajan a la nube. */
const SYNC_KEYS = [
  'padelcam_profile_v1',
  'padelcam.progress.v1',
  'padelcam.trophies.v1',
  'padelcam.xp.v1',
  'padelcam.challenges.v1',
  'padelcam_seen_welcome_v1',
];

const TABLE = 'jugadores';

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let db: SupabaseClient | null = null;
let session: Session | null = null;
let lastPushed = ''; // último snapshot subido, para no repetir subidas
let merged = false; // la fusión inicial ya corrió en esta carga

function $(sel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(sel);
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SYNC_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    } catch {
      /* sin almacenamiento: se sube lo que haya */
    }
  }
  return out;
}

function localXp(): number {
  try {
    return Number(localStorage.getItem('padelcam.xp.v1')) || 0;
  } catch {
    return 0;
  }
}

function setStatus(text: string): void {
  const el = $('#cloudStatus');
  if (el) el.textContent = text;
}

function syncUi(): void {
  const btn = $('#btnCloud');
  if (!btn) return;
  if (session) {
    setStatus(`☁️ Progreso guardado en la nube (${session.user.email ?? 'conectado'})`);
    btn.textContent = 'Cerrar sesión';
  } else {
    setStatus('☁️ Tu progreso solo vive en este dispositivo');
    btn.textContent = 'Guardar en la nube';
  }
}

/** Sube el estado local si cambió desde la última subida. */
async function push(force = false): Promise<void> {
  if (!db || !session) return;
  const snap = snapshot();
  const body = JSON.stringify(snap);
  if (!force && body === lastPushed) return;
  const { error } = await db
    .from(TABLE)
    .upsert({ id: session.user.id, datos: snap, updated_at: new Date().toISOString() });
  if (!error) lastPushed = body;
}

/**
 * Fusión al iniciar sesión: si la nube tiene MÁS XP que este dispositivo,
 * se restaura la nube y se recarga la página (para que todos los módulos
 * relean localStorage); si no, se sube lo local. Tras restaurar, ambos
 * lados quedan iguales, así que la recarga no puede entrar en bucle.
 */
async function mergeOnLogin(): Promise<void> {
  if (!db || !session || merged) return;
  merged = true;
  const { data, error } = await db.from(TABLE).select('datos').eq('id', session.user.id).maybeSingle();
  if (error) {
    setStatus('⚠️ No se pudo sincronizar (revisa la conexión)');
    return;
  }
  const remote = (data?.datos ?? null) as Record<string, string> | null;
  const remoteXp = remote ? Number(remote['padelcam.xp.v1']) || 0 : -1;
  if (remote && remoteXp > localXp()) {
    for (const k of SYNC_KEYS) {
      try {
        const v = remote[k];
        if (v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* sin almacenamiento */
      }
    }
    location.reload();
    return;
  }
  await push(true);
  syncUi();
}

function wireUi(): void {
  const btn = $('#btnCloud');
  if (!btn) return;
  btn.addEventListener('click', () => {
    void (async () => {
      if (!db) return;
      if (session) {
        await db.auth.signOut();
        lastPushed = '';
        return; // el estado de la UI se refresca vía onAuthStateChange
      }
      const email = prompt('Tu correo electrónico (te enviamos un enlace para entrar, sin contraseña):')?.trim();
      if (!email || !email.includes('@')) return;
      setStatus('Enviando enlace…');
      const { error } = await db.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      setStatus(
        error
          ? '⚠️ No se pudo enviar el enlace. Espera un minuto y reinténtalo.'
          : '📬 Revisa tu correo y abre el enlace EN ESTE dispositivo.',
      );
    })();
  });
}

/** Arranca la nube. Sin configurar es un no-op instantáneo. */
export async function initCloud(): Promise<void> {
  if (!cloudEnabled) return;
  const row = $('#cloudRow');
  if (row) row.hidden = false;
  setStatus('Conectando…');
  const { createClient } = await import('@supabase/supabase-js');
  db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  db.auth.onAuthStateChange((event, s) => {
    session = s;
    syncUi();
    // No llamar a Supabase DENTRO del callback (recomendación oficial):
    // la fusión se agenda fuera.
    if (event === 'SIGNED_IN') setTimeout(() => void mergeOnLogin(), 0);
  });

  const { data } = await db.auth.getSession();
  session = data.session;
  if (session) void mergeOnLogin();
  syncUi();
  wireUi();

  // Momentos naturales de subida: al esconder/cerrar la pestaña y cada 60 s
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void push();
  });
  window.addEventListener('pagehide', () => void push());
  window.setInterval(() => void push(), 60_000);
}
