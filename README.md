# 🎾 Pádel Cam

Juego de pádel para el navegador que se controla **con tu cuerpo a través de la cámara** (estilo Kinect/Wii Sports), con un entrenador virtual que corrige tu juego. Funciona en computadora y móvil, sin instalar nada.

## Modos de juego

- **🎾 Partido vs CPU** — reglas reales de pádel: saque diagonal con dos intentos, punto de oro, rebotes legales en las paredes de cristal, set a 6 juegos. Tres niveles de dificultad.
- **🌐 Online 1 vs 1** — juega contra otra persona, cada uno desde su dispositivo y con su propia cámara o teclado. Uno crea la partida y comparte un código de 4 letras; el otro se une. P2P por WebRTC (el anfitrión simula el partido; el invitado ve el mundo espejado). Señalización vía PeerJS (configurable con `?peer=host:puerto` para servidor propio).
- **🏟️ Torneo** — tres rondas contra rivales con personalidad propia (Rubén "Manoplas", Marta "La Muralla" y El Káiser), sets cortos a 3 juegos y trofeos que quedan en tu palmarés.
- **🎯 Modo práctica** — máquina lanza-bolas con drills de derecha, revés, voleas (derecha/revés), bandeja, víbora y remate, con corrección inmediata tras cada bola.
- **🧑‍🏫 Informe del entrenador** — al final de cada partido o práctica: estadísticas (winners, errores por golpe, puntos en la red…) y consejos personalizados en español.
- **📈 Mi progreso** — informes y correcciones guardados en el navegador, correcciones recurrentes pendientes, racha de días entrenando y "entrenamiento del día" sugerido por el coach.

## Golpes

Derecha, revés, volea de derecha, volea de revés, bandeja, víbora (con efecto real que curva la bola) y remate. Con cámara, la velocidad y dirección del gesto deciden el golpe: brazo arriba suave = bandeja, latigazo = remate, en diagonal = víbora.

Los puntos espectaculares se celebran con **repetición a cámara lenta**, público que salta en las gradas y sonido de estadio (100% sintetizado con WebAudio, sin assets).

## Controles

| Modo | Cómo se juega |
|------|---------------|
| 📷 **Cámara** (recomendado) | Muévete a los lados para desplazarte · mueve el brazo rápido para golpear · brazo por encima de la cabeza = remate/bandeja/víbora según el gesto |
| ⌨️ **Teclado** | Flechas/WASD para moverte · ESPACIO para golpear (←/→ dirigen · con globo: ↑+ESPACIO remate, ←/→+ESPACIO víbora, solo ESPACIO bandeja) |
| 📱 **Táctil** | Mitad izquierda de la pantalla para moverte · toca la mitad derecha para golpear |

El control por cámara usa [MediaPipe Pose](https://developers.google.com/mediapipe) directamente en el navegador (necesita internet la primera vez para descargar el modelo).

## Desarrollo

```bash
npm install
npm run dev      # servidor de desarrollo
npm run build    # build de producción (carpeta dist/)
npm run typecheck
```

Stack: Vite + TypeScript vanilla + Canvas 2D + `@mediapipe/tasks-vision` + `peerjs` (online P2P). Sin backend propio: la señalización online usa la nube pública de PeerJS por defecto.

Para probar el online en local: `npx peerjs --port 9000` (o un script con `PeerServer({ port: 9000, host: '127.0.0.1' })`) y abre dos pestañas con `?peer=127.0.0.1:9000`.

## Estructura

```
src/
  game/      pista, bola, física, IA rival, puntuación, render 2.5D, partido
  camera/    tracking de pose, detección de gestos, calibración
  modes/     modo práctica y torneo
  net/       partida online: señalización, protocolo y vista del invitado
  analysis/  registro de golpes, consejos del entrenador y progreso guardado
  audio/     efectos de sonido sintetizados (WebAudio)
  ui/        pantallas, HUD, control por teclado/táctil
```

## Pendiente / ideas futuras

- Ajuste fino de los umbrales de gestos con cámara real (`src/camera/gestures.ts`)
- Multijugador online (WebSockets)
- Informe del entrenador generado con IA (API de Claude)
- Sonidos y efectos
