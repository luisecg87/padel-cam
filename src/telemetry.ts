// Telemetría de la beta: métricas de uso anónimas + captura de errores.
//
// APAGADO POR DEFECTO. Para activarlo, rellena las claves de abajo (las
// consigues creando una cuenta gratuita en cada servicio) y vuelve a
// desplegar. Sin claves, este módulo no carga nada externo ni usa cookies:
// solo instala un registro de errores en consola.
//
// - Analítica recomendada: Plausible (plausible.io) o Umami — sin cookies,
//   anónima, sin banner de consentimiento. Pega tu dominio y el src del script.
// - Errores recomendados: Sentry (sentry.io). Pega tu DSN.

interface TelemetryConfig {
  /** Analítica sin cookies. Deja `src` vacío para desactivarla. */
  analytics: { domain: string; src: string };
  /** DSN de Sentry para capturar errores. Vacío = desactivado. */
  sentryDsn: string;
}

// 👇 RELLENA AQUÍ PARA ACTIVAR (todo vacío = beta sin telemetría externa)
const CONFIG: TelemetryConfig = {
  analytics: {
    domain: '', // p.ej. 'luisecg87.github.io/padel-cam'
    src: '', // p.ej. 'https://plausible.io/js/script.tagged-events.js'
  },
  sentryDsn: '', // p.ej. 'https://xxxx@oXXXX.ingest.sentry.io/XXXX'
};

let analyticsReady = false;

/** Arranca la telemetría. Idempotente y seguro de llamar siempre. */
export function initTelemetry(): void {
  // 1) Suelo mínimo: los errores no capturados se ven en consola. Si Sentry
  //    está activo, además los captura con traza completa.
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[padel-cam] error no capturado:', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    // eslint-disable-next-line no-console
    console.error('[padel-cam] promesa rechazada:', e.reason);
  });

  // 2) Analítica anónima sin cookies (Plausible / Umami): un solo <script>.
  if (CONFIG.analytics.src && CONFIG.analytics.domain) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = CONFIG.analytics.src;
    s.setAttribute('data-domain', CONFIG.analytics.domain);
    document.head.appendChild(s);
    analyticsReady = true;
  }

  // 3) Captura de errores con Sentry (se carga solo si hay DSN).
  if (CONFIG.sentryDsn) {
    const s = document.createElement('script');
    s.src = 'https://browser.sentry-cdn.com/8.0.0/bundle.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => {
      const Sentry = (window as unknown as { Sentry?: { init(o: unknown): void } }).Sentry;
      Sentry?.init({ dsn: CONFIG.sentryDsn, tracesSampleRate: 0, replaysSessionSampleRate: 0 });
    };
    document.head.appendChild(s);
  }
}

/**
 * Registra un evento de producto (p.ej. 'partido_iniciado'). No-op si la
 * analítica no está configurada. Los KPIs del PRODUCT.md se miden con esto.
 */
export function track(event: string, props?: Record<string, string | number | boolean>): void {
  if (!analyticsReady) return;
  const plausible = (window as unknown as {
    plausible?: (e: string, o?: { props: Record<string, unknown> }) => void;
  }).plausible;
  plausible?.(event, props ? { props } : undefined);
}
