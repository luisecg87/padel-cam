# Pádel Cam — Análisis de producto

*Análisis de product manager: cómo convertir Pádel Cam en un producto de pago
para el público adicto al pádel.*

## 1. Propuesta de valor

**"Tu entrenador de pádel en el salón de casa."**

Pádel Cam no compite con los videojuegos de deportes ni con las apps de
reservas: es la única forma de **entrenar gestos de pádel con feedback de
entrenador, sin pista, sin compañero y sin cuota de club**, usando solo la
cámara del navegador. Todo el análisis de pose ocurre en local: ninguna
imagen sale del dispositivo (argumento fuerte de privacidad y de coste).

## 2. Público objetivo

El "adicto al pádel" amateur:

- 25–55 años, juega 1–3 veces por semana, España/LatAm/norte de Europa.
- Ya gasta en el deporte: pala (100–300 €), clases (15–30 €/h), pista
  (10–15 €/persona), Playtomic para reservar.
- Su frustración central: **entre partido y partido no mejora**. Las clases
  son caras y las bolas que falla (bandeja, víbora, volea de revés) se
  repiten semana tras semana.
- Momento de uso: 10–15 minutos en casa, el día que no tiene pista.

**Personas:**
- *El competitivo de liga interna*: quiere subir de categoría; paga por
  cualquier cosa que le dé ventaja medible.
- *El recién enganchado* (1er año): absorbe contenido, no distingue bandeja
  de víbora; necesita que alguien le diga qué entrenar.
- *El lesionado/ocupado*: no puede pisar pista esta semana pero no quiere
  perder el gesto ni la racha.

## 3. Por qué puede ser de pago

La disposición a pagar del segmento es alta y está anclada a precios claros:
una clase particular cuesta 15–30 €. Si Pádel Cam corrige de forma medible
las mismas cosas que el entrenador repite en clase, **un precio de 1/5 de
una clase al mes es trivial de justificar**.

El producto ya construye los tres pilares de una suscripción:

1. **Diagnóstico personalizado** — el informe post-sesión detecta tu golpe
   débil, tu timing y tus vicios (pared, dobles faltas).
2. **Plan accionable** — la tarjeta *"Entrenamiento del día"* del menú
   convierte la corrección pendiente en el drill exacto que toca hoy.
3. **Hábito** — racha de días entrenados, historial persistente y
   correcciones que se marcan como superadas cuando dejan de repetirse.

Ese bucle (jugar → informe → corrección guardada → drill sugerido → racha)
es el motor de retención, y la retención es lo que se cobra.

## 4. Modelo de monetización propuesto

**Freemium con suscripción** (referencia: 4,99 €/mes o 39,99 €/año).

| | Gratis | Premium |
|---|---|---|
| Partido vs CPU | ✅ | ✅ |
| Drill mixto | ✅ | ✅ |
| Drills específicos (víbora, bandeja, voleas…) | 1 al día (el sugerido) | Ilimitados |
| Informe del entrenador | Básico (3 consejos) | Completo + evolución por golpe |
| Historial y correcciones | Últimos 7 días | Ilimitado + gráficas de progreso |
| Racha y retos semanales | Racha simple | Retos, ligas de amigos |
| Multijugador online / modo espejo con vídeo | — | ✅ (futuro) |

Reglas de diseño del paywall:
- **Nunca capar el core loop gratuito**: partido + drill sugerido diario
  siempre gratis; es el generador de hábito y de datos de diagnóstico.
- **Cobrar la profundidad, no el juego**: el adicto paga por *saber* que
  mejora (histórico, gráficas, comparativas) y por entrenar *lo que quiera,
  cuando quiera*.
- Vía B2B2C complementaria: panel para entrenadores/clubes que mandan
  deberes a sus alumnos y ven sus métricas (licencia por alumno).

## 5. Métricas norte (KPIs)

- **Activación**: % de visitantes que completan su 1ª sesión con informe.
- **Retención D7 / sesiones por semana** (objetivo: ≥2 sesiones/semana).
- **% de usuarios con racha ≥3 días** (proxy del hábito, predice conversión).
- **% de drills lanzados desde "Entrenamiento del día"** (salud del loop).
- **Conversión free→pago** (benchmark apps fitness: 3–6%).

## 6. Roadmap

**Ahora (hecho en esta iteración):**
- Repertorio técnico completo: víbora, bandeja, voleas de derecha y revés.
- Correcciones persistentes + pantalla "Mi progreso".
- Entrenamiento del día + racha (motor de retención).
- Inmersión: sonido, efectos, física con efecto en la víbora.
- Modo Torneo con rivales con personalidad y palmarés de trofeos
  (contenido aspiracional: el "final boss" da razón para entrenar).
- Repetición a cámara lenta y público que reacciona (momentos compartibles,
  base para el futuro "compartir clip").

**Siguiente (pre-monetización):**
- Gráficas de evolución por golpe (calidad media semana a semana).
- Retos semanales ("10 víboras dentro esta semana") con recompensa visual.
- PWA instalable + recordatorio de racha (notificación local).
- Onboarding de 60 segundos que termina en el primer informe.

**Después (con la suscripción):**
- Cuentas y sincronización multi-dispositivo (el localStorage pasa a backend).
- Pasarela de pago (Stripe) y paywall según la tabla anterior.
- Repetición del gesto en vídeo con esqueleto superpuesto (el "modo espejo").
- Multijugador online por cámara y ligas entre amigos.

## 7. Riesgos y mitigaciones

- **Precisión del control por cámara** → mantener siempre el modo teclado,
  calibración corta y umbrales relativos al cuerpo (ya implementado).
- **Novedad que se agota** → el valor a 30 días no es el juego sino el
  diagnóstico: invertir en informes y progreso antes que en más modos.
- **Comparación con juegos de consola** → posicionarse como *entrenamiento*,
  no como videojuego: el lenguaje del producto es el de un coach.
- **Privacidad de la cámara** → todo en local; convertirlo en mensaje de
  marketing, no solo en detalle técnico.
