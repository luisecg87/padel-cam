# Pádel Cam — Guía para agentes

Juego de pádel en el navegador controlado con el cuerpo (MediaPipe Pose) o
teclado/táctil. Vite + TypeScript vanilla + Canvas 2D, sin backend propio.

**Lee `PLAN.md` antes de trabajar**: estado actual, hoja de ruta priorizada,
mapa de arquitectura y flujo de validación. `PRODUCT.md` tiene el contexto de
producto y `README.md` el de usuario.

## Reglas del propietario (obligatorias)

1. **Tareas visuales sin tocar gameplay** — física, scoring, IA, input y modos
   intactos salvo petición explícita.
2. **Nada de "frente falso"**: el jugador cercano se ve de espaldas de forma
   natural (la cámara está detrás). Legibilidad por silueta/pala/swing.
3. **Canvas (`src/game/render.ts`) es el renderer por defecto**; Three.js es
   experimental detrás de `?renderer=three` con carga perezosa — no invertir.
4. **Prueba visual antes de cerrar**: capturas 390×844 y 1280×800 + reporte
   honesto (qué se hizo, qué NO se tocó, build, hash de commit).
5. **Todo en español**: comentarios, UI, informes.

## Comandos

```bash
npm run dev          # localhost:5173
npm run typecheck    # debe salir limpio siempre
npm run build        # → dist/
npm run preview      # los scripts de prueba esperan --port 4173
npm run deploy       # publica a https://luisecg87.github.io/padel-cam/
```

## Validación mínima antes de commit

typecheck + build limpios → partido por teclado 30-60 s sin errores JS →
práctica y desafíos arrancan → sin `?renderer=three` el chunk de three NO se
descarga → capturas de lo cambiado. Hook de depuración para Playwright:
`window.__padel.getMode()` (no eliminarlo).

## Trampas conocidas

- La convención derecha/revés nace en `classifySwing` (`src/game/shots.ts`)
  y se voltea para CPU y zurdos (`dominantHand` del perfil): los renderers
  la espejan. No cambiarla de forma unilateral.
- El perfil local (`src/profile.ts`) alimenta paleta y lateralidad de ambos
  renderers vía `GameRenderer.playerPalette` y `PlayerEntity.dominantHand`.
- El invitado del online no simula nada: renderiza el estado del anfitrión.
- MediaPipe carga de CDN en runtime: sin red solo se rompe el modo cámara.
- Los entornos cloud no tienen webcam ni GPU: los flujos de cámara no se
  pueden probar end-to-end y el rendimiento de three.js medido en software
  no es representativo.
