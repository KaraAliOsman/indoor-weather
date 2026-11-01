
## Noche

Archivos nuevos: `src/mechanisms/night.ts` (puro), `src/render/glsl/night.ts`, `src/render/night-veil-material.ts` y `tests/unit/night.test.ts`. No se ha tocado ningún archivo de M1.

**Cableado (un `NightSystem` en `mechanisms/night-system.ts`, prioridad única p. ej. 0.55, configData `{ ctx, rig }`, con el mismo patrón que `WindSystem`):**

- `init`:
  - `handle = createNightHandle()`, que es un `LinearHandle` hacia −Y con 5 cm y radio 0,035;
  - `ctx.handles.register(handle)`;
  - `bus.emit({ type: 'mechanism:register', id: 'night' })`, y `CHAPTER_ORDER` la encadena tras `wind`;
  - `model = createNightModel({ calm: settings.calm, highContrast: settings.contrast })`;
  - `ctx.probes.night = () => ({ ...model.state })`.
- El trinquete de `night` es el de `ActuationService`. `NIGHT_RATCHET` (muescas 0,25/0,5/0,75 y `completeAt` 0,98) coincide con `RATCHET_DEFAULTS`, así que no hay que configurar nada.
- `placement:commit` → `veil ??= createNightVeil(scene)` (una sola vez, como `WindView`). Va colgado de la escena, no de la caja: sigue a la cabeza.
- `update(delta, time)`:
  1. `rest` = cuenta en reposo, en mundo, desde `rig.anchors.night`. Luego `handle.setFrame(rest, NIGHT_PULL_AXIS, progress, enabled)` con `enabled = veil !== null && rig.visible && phase === 'night'`.
  2. `model.setTarget(ctx.actuation.progress('night'))`, seguido de `const s = model.step(ctx.clock.dt)`.
  3. `veil.setFrame(headWorld, poolWorld, tableY, boxYaw)`:
     - `headWorld` = `player.head` en mundo;
     - `poolWorld` = la bombilla proyectada sobre la tapa (mientras no exista la lámpara vale el centro de la tapa);
     - `tableY` = Y de la base de la caja;
     - `boxYaw` = ψ de la caja.
  4. `veil.setState(s)`, `veil.update(dt)` y, cuando existan las chispas, `veil.setSparks(...)` con un máximo de 4 entre las que estén a menos de 12 cm de la mesa.
  5. Por cada `m` de `s.milestones`: `bus.emit({ type: 'night:milestone', m })`. Es un evento nuevo que hay que añadir a `GameEvent` en `types.ts` cuando se libere. Lo usa el audio: `crickets` arranca los grillos y `closed` permite soltar las 12 chispas.
- Los eventos `notch{night}` y `mechanism:complete{night}` los emite el trinquete tal como están. El clic del interruptor y la vuelta de la cuenta con muelle son de la vista de la lámpara, que no forma parte de esta entrega.
- `?reset=1` o restaurar una partida: `model.reset(actuation.progress('night'))` salta al estado sin rampa y sin repetir hitos.
- Modos: cuando cambie `Settings`, llama a `model.setMode({ calm, highContrast })`. En Calma el cierre va a 40°/s (≥4,25 s) y el máximo es 0,45. En alto contraste el máximo es 0,45 y el charco 0,10.

**Notas de render:**

- El velo es una esfera BackSide de 3 m centrada en la cabeza, con `transparent`, `depthTest`/`depthWrite` false, `renderOrder −50`, alfa premultiplicado y `frustumCulled` false. Es 1 draw call y se oculta mientras `level === 0`. No usa `setClearColor`: la sala se oscurece con alfa sobre el passthrough.
- Con `depthTest` false, el velo cubre también el papel opaco. Dentro del charco (θ < 12°) el alfa está limitado a 0,15, así que la caja y las manos se siguen viendo. Lo que deba quedar "después del velo" (anillos y retícula de noche) necesita `renderOrder > −50` y `depthTest` false.
- Estrellas de papel: 24 estrellas de 4 puntas, deterministas (semilla `0x5ba2`). Las 6 primeras forman una constelación de cometa con hilos punteados muy tenues, situada sobre la caja. Entran con suavidad a partir de `level` 0,6 y no parpadean: no hay uniform de tiempo.
- Fotosensibilidad: cada cambio es una rampa continua. El test garantiza un Δα por frame menor de 0,035 a 72 Hz con el peor caso (tirón instantáneo) y ninguna bajada mayor que el labio de tinta (0,05). Un cierre completo dura ≥2,4 s.
- Los nombres de los uniforms van con prefijo `uVeil*` para no chocar en tipo con otros shaders. `glsl-multiview.test.ts` incluye `glsl/night.ts` de forma automática.

## Tormenta

**Archivos nuevos:** `src/mechanisms/storm.ts` (lógica pura), `src/render/glsl/rain.ts` (`RAIN_VERT`/`RAIN_FRAG`), `src/render/rain-material.ts` (vista de lluvia, 1 draw call), `tests/unit/storm.test.ts` (12 tests).

**Gesto (experiencia.md B4):** etiqueta de la nube, tirón +Y. `stormAmount(startY, nowY)` → p 0..1 (`handM` 0,08). Vista: escala de nube `0,3 + 0,7·easeOutCubic(p)`; lluvia desde p > 0,35 (`smoothstep(0,35; 1; p)`). Al soltar con p ≥ 0,6 → evento `auto-complete` (el sistema llama a `actuate('auto')` / `mechanism:complete{storm}`), la nube flota en 0,6 s y se infla a 1 en 1,2 s. Con p < 0,6 → evento `return`, muelle de 0,4 s y vuelta a `idle` sin castigo.

**API:** `createStorm({ seed })` → `grab()`, `drag(amount)`, `release(): boolean`, `update(dt, attending): StormFrame`, `reset(completed?)`. `StormFrame` = `{ phase, pull, cloudScale, cloudLift, density, glow, bodyTime, events }` (objeto reutilizado). Eventos: `rain-start`, `auto-complete`, `return`, `body` (T_s0 → `storm:body`), `thunder{0,1}` (+6 s, +16 s: audio −24 dB y temblor de 2 mm/300 ms), `glow{i}`, `last-drop{0..2}` (+28,5/+29,2/+30,0 s: "plip, plip, plop"), `done`.

**Reloj:** cuerpo de 30 s de `storyTime`; solo avanza con `attending = true` (conectar a `ctx.visible()`/atención). Sin atención la lluvia baja al 30 % con una rampa (τ ≈ 0,4 s), nunca un escalón. Densidad: rampa de 2 s desde el nivel de suelta, 100 % hasta +22 s, coseno a 0 en +28 s; escala de nube 1 → 0,55 en el mismo tramo.

**Relámpago seguro (sin destellos):** nunca un flash. `glow` es un resplandor suave dentro de la nube: coseno alzado de 1,0 s de subida + 1,8 s de bajada (2,8 s ≥ 300 ms), pico 0,06, pendiente ≤ 0,1/s, separación ≥ 3 s, sin solaparse y siempre antes del vaciado. Uno precede a cada trueno en 0,6 s y la semilla coloca 2 lejanos en huecos fijos. El test lo muestrea a 1 kHz con 200 semillas: ≤ 3 picos/s (de hecho ≤ 1), ≥ 300 ms por resplandor, ΔL ≤ 10 %/s y ningún par opuesto > 0,1 en 333 ms (WCAG 2.3.1 + "Sin destellos"). Usar `frame.glow` como `uGlow` del material de la nube (sumar a su luminancia, no multiplicar el velo global) y del de lluvia.

**Lluvia:** `createRainView({ center, half, cloudY, floorY, seed })` → `{ mesh, uniforms, setHands, setQuality, dispose }`. El mesh vive en el marco de la caja (añadir al ancla de la caja con su offset, como las hojas); `frustumCulled = false`, `transparent`, `depthWrite: false`, `renderOrder 10`. Cada frame: `uTime`, `uDensity = frame.density`, `uGlow = frame.glow`, `uCloudY` (seguir `cloudLift`), y `setHands()` con hasta 16 esferas de `ctx.handField` en el marco de la caja (xyz + r). Las gotas colapsan sobre la esfera más alta que cubre su (x, z) y a < 0,35 m de la cabeza (`cameraPosition`, sin redeclararla). Gemelo en CPU: `rainHitY()` para salpicaduras y `sheltered()`. Governor: `setQuality(0|1|2)` → `instanceCount` 900/600/300 (`rainCountForQuality`). Alto contraste: `uRainColor = #FFFFFF`, `uAlpha = 0,7`, `uDropSize.x = 0,0016`.

**Pendiente:** vista de nube (malla + `uGlow`), etiqueta/mechón como `HandleSpec`, salpicaduras (pool de 96 + 64), mapa de mojado, refugio P1 de la cometa y audio por superficie. `glsl-multiview.test.ts` ya cubre `rain.ts` (escanea `src/render/glsl/`).

## Almanaque

**Archivos:** `src/core/almanac.ts` (puro, sin three ni `@iwsdk/core`, sin `Math.random`/`Date.now`) y `tests/unit/almanac.test.ts` (14 tests).

**Qué hace:**
- **Página del día** determinista: `dailyPage(day, firstDay)` con semilla FNV-1a de `'YYYY-MM-DD'` (fecha **local**, `localDateKey(new Date())`). Devuelve paleta de hojas (0..4, sesgada por estación), sentido del remolino y modo melódico (alternan por paridad del día epoch: par = D mayor pentatónica, impar = B menor pentatónica), estampado de cometa (0..5), forma de nube (0..2), `variant` empaquetado, fase lunar en octavos (calculada a mediodía local), sorpresa del ciclo de 7 (día 1 = canónico) y rótulo del sello `'31·10'`.
- **Sellos** por día como máscara de bits: `wind=1`, `night=2`, `storm=4`, `kite=8` ([S] glifo secreto). `earnSeal(state, day, id)` es inmutable e idempotente. `isFinaleReady(state, day)` / `isStoryComplete(mask)` = los tres capítulos sellados (el bit de la cometa no cuenta). `nextChapter(mask)` da el siguiente capítulo en orden.
- **Cinta**: `recordStrip(state, day, holes)` guarda 36 columnas × 6 bits como base64 de 36 B; `stripDays(state, today, n)` da los últimos n días (los saltados, `null`: segmento en blanco, sin rachas). `seedDemoWeek` para `?demoWeek=1`; `todayKey(now, offset)` para `?day=+1`.
- **Persistencia** en una sola clave `indoorweather.v1` (prefijo de `boot/reset.ts`, así `?reset=1` la borra). `createAlmanacStore(storage)` recibe un `Storage` inyectado; todo en `try/catch`. `save(state, nowMs, force)` escribe como mucho cada 5 s salvo `force` (frontera de beat, sello, `hidden`).
- **Versionado/migración**: `version: 1`. v0 = snapshot M1 sin `version` (`{ day, completed: [...] }`) → máscara de sellos (`status 'migrated'`). Versión mayor que la del build → `status 'future'` y el store queda `readOnly` (no pisa un guardado más nuevo). JSON corrupto o forma inválida → `status 'corrupt'`, el texto se copia una vez a `indoorweather.v1.corrupt` y se arranca limpio. Campos sueltos inválidos se reparan (fase/variante se recalculan, fechas imposibles se descartan, `firstDay` = el día más antiguo). Los campos de otros módulos (`settings`, `metrics`, `anchor`) se conservan tal cual en `state.extra`.

**Enganche (integrador, en M2):**
1. Al arrancar: `const store = createAlmanacStore(globalThis.localStorage); const today = todayKey(new Date(), flags.dayOffset ?? 0); let { state } = store.load(today);` Si `flags.demoWeek`, `state = seedDemoWeek(state, today)`.
2. `const page = dailyPage(today, state.firstDay)` → variantes de WindView/nube/cometa/melodía.
3. Si `isFinaleReady(state, today)`: ir directo a juego libre. Si no, `resumeBeat(state, today)` o `nextChapter(sealOf(state, today))`.
4. En `mechanism:complete{target}` con `target` en `wind|night|storm`: `state = earnSeal(state, today, target); store.save(state, nowMs, true)`. Cuando `isFinaleReady` pasa a `true` → fase `finale`.
5. Al terminar el final: `recordStrip(state, today, holes)` y guardado forzado en el sello (+0,55 s de B7).
6. En `visibility hidden` / `sessionend`: `store.save(state, nowMs, true)`; en frontera de beat: `setProgress(state, today, beat)` + `save` con throttle.

**Pendiente/no hecho:** `flags.dayOffset`/`flags.demoWeek` no existen aún en `boot/flags.ts` (no se tocó); el tipo `DayRecord`/`AlmanacState` vive en `almanac.ts`, no en `types.ts`.
