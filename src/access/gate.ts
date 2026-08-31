// Tope global de accesos gratuitos, aplicado en un backend real (Supabase)
// para que no se pueda evadir solo abriendo una ventana de incógnito nueva.
// Una vez que un navegador consigue su cupo, queda recordado en localStorage
// para no volver a descontarlo ni bloquear a quien ya jugó.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const STORAGE_KEY = 'padel_access_granted';

export interface AccessResult {
  granted: boolean;
  position?: number;
  cap?: number;
}

interface ClaimRow {
  allowed: boolean;
  position: number;
  cap: number;
}

export async function checkAccess(): Promise<AccessResult> {
  if (localStorage.getItem(STORAGE_KEY) === '1') {
    return { granted: true };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(
      '[padel-cam] Tope de acceso gratuito no configurado ' +
        '(faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY); se permite jugar sin límite.',
    );
    return { granted: true };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_free_slot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as ClaimRow[];
    const row = rows[0];
    if (row?.allowed) {
      localStorage.setItem(STORAGE_KEY, '1');
      return { granted: true, position: row.position, cap: row.cap };
    }
    return { granted: false, position: row?.position, cap: row?.cap };
  } catch (e) {
    // Si el backend del cupo falla (ej. Supabase caído), no bloqueamos
    // el lanzamiento por un problema nuestro: se deja jugar igual.
    console.error('[padel-cam] Error comprobando el cupo de acceso, se permite jugar:', e);
    return { granted: true };
  }
}
