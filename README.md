# 🎾 Pádel Cam

Juego de pádel para el navegador que se controla **con tu cuerpo a través de la cámara** (estilo Kinect/Wii Sports), con un entrenador virtual que corrige tu juego. Funciona en computadora y móvil, sin instalar nada.

## Modos de juego

- **🏆 Partido vs CPU** — reglas reales de pádel: saque diagonal con dos intentos, punto de oro, rebotes legales en las paredes de cristal, set a 6 juegos. Tres niveles de dificultad.
- **🎯 Modo práctica** — máquina lanza-bolas con drills de derecha, revés, volea y remate, y corrección inmediata tras cada bola.
- **🧑‍🏫 Informe del entrenador** — al final de cada partido o práctica: estadísticas (winners, errores por golpe, puntos en la red…) y consejos personalizados en español.

## Controles

| Modo | Cómo se juega |
|------|---------------|
| 📷 **Cámara** (recomendado) | Muévete a los lados para desplazarte · mueve el brazo rápido para golpear · brazo por encima de la cabeza = remate |
| ⌨️ **Teclado** | Flechas/WASD para moverte · ESPACIO para golpear (mantén ← o → para dirigir el golpe) |
| 📱 **Táctil** | Mitad izquierda de la pantalla para moverte · toca la mitad derecha para golpear |

El control por cámara usa [MediaPipe Pose](https://developers.google.com/mediapipe) directamente en el navegador (necesita internet la primera vez para descargar el modelo).

## Desarrollo

```bash
npm install
npm run dev      # servidor de desarrollo
npm run build    # build de producción (carpeta dist/)
npm run typecheck
```

Stack: Vite + TypeScript vanilla + Canvas 2D + `@mediapipe/tasks-vision`. Sin backend.

## Estructura

```
src/
  game/      pista, bola, física, IA rival, puntuación, render 2.5D, partido
  camera/    tracking de pose, detección de gestos, calibración
  modes/     modo práctica
  analysis/  registro de golpes y motor de consejos del entrenador
  ui/        pantallas, HUD, control por teclado/táctil
```

## Tope de accesos gratuitos

El juego puede limitar cuántas personas entran gratis (mientras se define cómo cobrar) con un cupo global real, no evadible solo abriendo incógnito: se guarda en una tabla de Supabase y se reclama con una función atómica (`supabase/schema.sql`).

**Activarlo:**
1. Crear un proyecto en [supabase.com](https://supabase.com) (o reutilizar uno existente).
2. Abrir el **SQL Editor** del proyecto y ejecutar el contenido de `supabase/schema.sql` (ajusta el cupo `cap` ahí antes de correrlo, o después con `update access_counter set cap = 200 where id = 1;`).
3. Copiar `.env.example` a `.env` y completar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (Project Settings → API en el dashboard de Supabase).
4. `npm run deploy` como siempre — el cupo queda activo en el sitio publicado.

Sin esas variables configuradas, el juego se lanza **sin límite** (no bloquea a nadie). Cada navegador que consigue acceso lo recuerda en `localStorage`, así que quien ya jugó no vuelve a gastar cupo ni se le corta a mitad de partida; alguien que borre sus datos o use otro navegador sí puede reclamar un cupo nuevo si aún queda — es una limitación conocida al no pedir cuentas de usuario.

⚠️ El proyecto gratuito de Supabase se pausa tras ~1 semana sin actividad (y puede llegar a borrarse si queda pausado mucho tiempo — esto ya le pasó a otro proyecto del usuario). Con tráfico real del lanzamiento no debería ser problema, pero si el juego está inactivo varios días revisa el dashboard de Supabase.

## Pendiente / ideas futuras

- Ajuste fino de los umbrales de gestos con cámara real (`src/camera/gestures.ts`)
- Multijugador online (WebSockets)
- Informe del entrenador generado con IA (API de Claude)
- Sonidos y efectos
