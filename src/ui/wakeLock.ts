/**
 * Gestión de Screen Wake Lock API para evitar que la pantalla del móvil o
 * tablet se apague mientras el jugador está a 2-3 metros usando la cámara.
 * Incluye fallback seguro (try/catch) y re-adquisición automática al volver
 * la pestaña a primer plano (`visibilitychange`).
 */
class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (this.wanted && document.visibilityState === 'visible') {
          void this.requestLock();
        }
      });
    }
  }

  /** Solicita mantener la pantalla encendida durante una sesión o partido activo. */
  async acquire(): Promise<void> {
    this.wanted = true;
    await this.requestLock();
  }

  /** Libera el bloqueo de pantalla al volver al menú principal. */
  async release(): Promise<void> {
    this.wanted = false;
    if (!this.sentinel) return;
    try {
      await this.sentinel.release();
    } catch {
      /* el navegador ya lo había liberado */
    } finally {
      this.sentinel = null;
    }
  }

  private async requestLock(): Promise<void> {
    if (!this.wanted || this.sentinel) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) {
          this.sentinel = null;
        }
      });
    } catch {
      /* No soportado, ahorro de batería activo o permiso denegado */
    }
  }
}

export const wakeLock = new ScreenWakeLock();
