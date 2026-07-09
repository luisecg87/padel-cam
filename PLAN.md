# Pádel Cam — Plan técnico y hoja de ruta

*Documento de traspaso para agentes/modelos que continúen el desarrollo.
Última actualización: julio 2026, rama `claude/game-immersion-features-kyqihy`.
Contexto de producto: ver `PRODUCT.md`. Contexto de usuario: ver `README.md`.*

---

## 1. Estado actual (qué está hecho y verificado)

### Núcleo jugable (estable, no romper)
- **5 modos funcionando**: Partido vs IA (reglas reales de pádel), Torneo (3
  rondas, rivales con personalidad), Online 1v1 (P2P vía PeerJS), Práctica
  libre (máquina lanza-bolas por drill), Desafíos (Diana, El Muro).
- **Entrenamiento técnico con cámara**: sesiones de 10 repeticiones con
  anuncio de golpe, bola virtual entrante (llega a la zona de impacto en el
  beat, origen horizontal aleatorio por rep), esqueleto coloreado por calidad
  de postura (verde/ámbar/rojo), evaluación de timing/zona/preparación/
  postura y resumen con recomendación. El drill "Voleas" rota derecha/revés
  con bolsa barajada; "Mixto" rota 6 tipos de golpe.
- **Control por cámara**: MediaPipe Pose en local, calibración con **arranque
  automático** (cuenta atrás de 3 s al detectar pose estable — el jugador está
  a 2 m y no puede tocar la pantalla).
- **Perfil local (Fase 1)**: nombre, mano dominante (diestro/zurdo), 5
  equipaciones y 3 tonos de piel en `src/profile.ts` + sección en el menú.
  Persistido en localStorage. La lateralidad afecta al dibujo del avatar en
  ambos renderers Y a la clasificación derecha/revés (simétrico, no cambia el
  equilibrio del juego).
- **Renderer canvas 2.5D** (`src/game/render.ts`, por defecto): jugador
  cercano visto de espaldas de forma natural (regla del usuario: NUNCA
  "frente falso"), pala en alto en espera, brazos visibles a los costados,
  anillos de identidad bajo los jugadores (referencia Premier Padel),
  repetición a cámara lenta saltable con cualquier tecla.

### Spike Three.js (experimental, NO es candidato a producción todavía)
- `src/game/renderers/threeRenderer.ts`, activable con `?renderer=three`,
  carga perezosa (import() dinámico — NO entra en el bundle por defecto:
  94 KB gzip canvas vs +130 KB del chunk three).
- Ambos renderers implementan `GameRenderer`
  (`src/game/renderers/GameRenderer.ts`): el gameplay no sabe cuál dibuja.
- HUD de rendimiento con `?renderer=three&debug=perf`.
- **Veredicto de la fase 3 (jul 2026): mantener como experimental.** En
  software rendering: canvas 60 fps estables, three 10-22 fps. Falta la
  validación en móviles Android reales con GPU — es EL bloqueante para
  decidir migración. Norte visual acordado con el usuario: look "Premier
  Padel" (cámara elevada, pista limpia, vallas de patrocinio).

---

## 2. Hoja de ruta priorizada

### P1 — Validación con cámara real (pendiente de usuario/dispositivo)
Los flujos de cámara (cuenta atrás de calibración, bola del entrenamiento,
esqueleto por colores) están verificados solo por compilación y regresión de
los modos sin cámara — **este entorno de desarrollo no tiene webcam**. Antes
de construir más encima: probar en dispositivo real y corregir lo que se
sienta mal (sensibilidad de detección, tiempos, legibilidad).

### P2 — Perfiles Fase 2: cuentas reales
- Backend recomendado: **Supabase** (o Firebase) en plan gratuito.
- Login con Google/email; `src/profile.ts` pasa a ser caché local del perfil
  remoto (ya está diseñado para eso — no cambiar su API).
- Sincronizar: perfil, XP/nivel, trofeos, sesiones (`src/analysis/progress.ts`
  hoy es todo localStorage).
- Después: rankings/ligas (ver PRODUCT.md §monetización).

### P3 — Decisión Three.js
1. Probar `?renderer=three&debug=perf` en 2-3 Android de gama media (Chrome).
2. Si rinde jugable (≥30 fps sostenidos): invertir en paridad visual
   (animación de golpes al nivel del canvas) y look Premier Padel; considerar
   ofrecerlo como "modo premium".
3. Si no rinde: descartar migración y seguir puliendo el canvas.

### P4 — Más personalización de avatar
- Más equipaciones/peinados (los presets viven en `src/profile.ts`: KITS y
  SKINS; el renderer ya toma todo de `playerPalette`).
- Nombre del jugador en más sitios (marcador, informe post-partido).

### P5 — Deuda técnica / mejoras menores
- El chunk `threeRenderer` pesa >500 KB minificado (aviso de Vite) — solo
  afecta a quien usa el flag; si se productiza, dividir three.js.
- El online usa la nube pública de PeerJS: para producción, servidor de
  señalización propio (`?peer=host:puerto` ya soportado).
- `speedMul` de potencia de gesto está acotado en `executeHit`
  (`clamp 0.78-1.18`) Y en practice.ts — unificar en un solo sitio.

---

## 3. Reglas duras aprendidas del propietario (NO violar)

1. **Las tareas visuales NUNCA tocan gameplay**: física, scoring, IA, input y
   modos quedan intactos salvo petición explícita. Si un fix visual necesita
   un dato nuevo (p. ej. `dominantHand`), añadir el dato al modelo es
   aceptable; cambiar comportamiento no.
2. **Cámara detrás del jugador = jugador de espaldas de verdad.** Prohibido el
   "frente falso" (revelar cara/pecho del jugador cercano). La legibilidad
   sale de silueta, hombros, brazos, pala y dirección del swing.
3. **Canvas es el renderer por defecto.** Three.js vive detrás de
   `?renderer=three` con carga perezosa. No invertir esto sin decisión
   explícita del propietario.
4. **Entregar con prueba visual**: capturas móvil (390×844) y escritorio
   (1280×800) antes de dar por cerrada una tarea visual, y reporte honesto
   (qué se hizo, qué NO se tocó, resultado del build, hash del commit).
5. **El idioma del proyecto y del usuario es español** (código comentado en
   español, UI en español, informes en español).

---

## 4. Mapa de arquitectura (dónde está cada cosa)

```
src/
  main.ts            Orquestador: modos, control, perfil→renderer, menú
  profile.ts         Perfil local (nombre, mano, kit, piel) — localStorage
  types.ts           ShotType, DrillType, Vec3, SHOT_NAMES, helpers
  game/
    match.ts         Partido completo: estados, saque, puntos, replay, IA hooks
    ball.ts          Física de bola (gravedad, red, paredes, spin)
    player.ts        PlayerEntity (posición, swing, dominantHand del perfil)
    ai.ts            CPU (parámetros por dificultad, puntería, fallos)
    shots.ts         classifySwing + computeShotVelocity + SHOT_PARAMS
    court.ts         Dimensiones de pista y cajas de saque
    scoring.ts       Marcador de pádel real
    render.ts        Renderer canvas 2.5D (por defecto) — el más pulido
    renderers/
      GameRenderer.ts   Contrato común (draw/shake/burst/palettes)
      threeRenderer.ts  Spike WebGL (experimental)
  camera/
    pose.ts          PoseTracker (MediaPipe, CDN en runtime)
    gestures.ts      Gesto→golpe (velocidad de muñeca en anchos de cuerpo)
    calibration.ts   Calibración con cuenta atrás y arranque automático
  training/
    session.ts       Máquina de fases por repetición (pool de golpes, bolsa)
    metrics.ts       Postura/zona de impacto/preparación desde la pose
    view.ts          Cámara fullscreen + esqueleto por colores + bola entrante
  modes/             practice.ts, challenges.ts, tournament.ts
  net/               online.ts (PeerJS host), guest.ts (vista del invitado)
  analysis/          logger.ts, coach.ts (informes), progress.ts (XP/sesiones)
  ui/                screens.ts (todas las pantallas DOM), input.ts (teclado/táctil)
  audio/sfx.ts       Sonido 100% WebAudio sintetizado
```

Puntos de acoplamiento que hay que conocer:
- `window.__padel.getMode()` (main.ts): hook de depuración usado por los
  tests de Playwright para leer/forzar estado. No eliminarlo.
- La convención de signos derecha/revés nace en `classifySwing`
  (`dx = bola.x - jugador.x`, se voltea para CPU y para zurdos); los
  renderers la espejan con `dominantHand`. Cambiarla rompe render y drills.
- El invitado online NO simula: renderiza el estado que envía el anfitrión.

---

## 5. Flujo de trabajo y validación

```bash
npm run dev          # desarrollo (localhost:5173)
npm run typecheck    # tsc --noEmit — debe salir limpio SIEMPRE
npm run build        # vite build → dist/
npm run preview      # sirve dist/ (los tests esperan --port 4173)
npm run deploy       # publica a GitHub Pages (gh-pages branch)
                     # → https://luisecg87.github.io/padel-cam/
```

Validación usada hasta ahora (no hay suite de tests en el repo; los scripts
viven fuera): Playwright con Chromium apuntando a `vite preview`, usando
`window.__padel.getMode()` para forzar estados difíciles (p. ej. un revés) y
capturar pantalla. Patrón de regresión mínimo antes de cada commit:
1. `npm run typecheck` + `npm run build` limpios.
2. Partido real de 30-60 s por teclado sin errores JS y con marcador
   progresando.
3. Práctica y Desafíos arrancan sin errores.
4. Con `?renderer=three`: verificar que el chunk NO se carga sin el flag.
5. Capturas móvil/escritorio de lo cambiado.

**Limitación conocida del entorno cloud**: sin webcam (los flujos de cámara
no se pueden ejercitar end-to-end) y sin GPU (el rendimiento de three.js en
software no es representativo).

## 6. Despliegue

- **GitHub Pages** (`npm run deploy`): build + push forzado a `gh-pages`.
  URL pública HTTPS → el modo cámara funciona ahí (getUserMedia exige HTTPS)
  y también desde móviles.
- MediaPipe descarga modelo/wasm de CDNs (jsdelivr + storage.googleapis.com)
  en runtime: entornos con red bloqueada rompen SOLO el modo cámara; el
  resto del juego funciona offline tras cargar.
