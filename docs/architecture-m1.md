# Indoor Weather: arquitectura M1 (vertical slice: colocar + Viento)

Para los implementadores **A** (entrada), **B** (colocación), **C** (caja + Viento) e **I** (integrador).

- Los contratos compartidos están en `src/core/types.ts`. Ya está escrito, es puro y pasa `tsc --noEmit` y `--erasableSyntaxOnly`. Solo lo modifica I.
- Todas las APIs citadas se verificaron en `app/node_modules` (`@iwsdk/*` 1.0.1, `iwer` 2.5.0, `super-three` 0.181.0). Las referencias están en el §10.
- En este documento, `nm/` = `app/node_modules/`.

---

## 0. Alcance y decisiones

**M1, comprobado en IWER:**
1. Enter AR.
2. Colocar la caja: con hit-test (MesaSEM) o con fallback (sin SEM o sin superficie).
3. Pinch real sobre la pestaña: tirar y soltar.
4. Las hojas cruzan la mesa.
5. El slice termina en la fase `done`.

**Fuera de M1:** Noche, Tormenta, final, accesibilidad completa, governor, HUD y persistencia. Las interfaces ya les dejan sitio (§9).

**Decisiones:**
1. **Un `AppContext`** (`types.ts`) se inyecta en cada sistema con `registerSystem(Sys, { priority, configData: { ctx } })`. elics asigna `configData` **antes** de `init()` (`nm/elics/lib/world.js:37-43`). No hay singletons.
2. **La lógica vive en módulos puros**, que se prueban con `node --test`. Los sistemas ECS son pegamento fino: leen IWSDK/three, llaman a lo puro y escriben en `ctx`.
3. **Toda entrada termina en `ctx.actuation.actuate(target, amount, source)`.**
   - Hay un trinquete por target: monótono, idempotente, con muescas.
   - Los mecanismos (C) **solo leen** `progress()` y escuchan eventos. Nunca escriben progreso.
4. **Cada handle trae su cinemática** (`HandleSpec.amountFor`). Así el árbitro (A) es genérico: pestaña lineal en M1, manivela con `atan2` en M2, y solapa/hilo en M3.
5. **Colocación:**
   - Primero se hace una **sonda propia** de `requestHitTestSource`, y solo si funciona se añade `EnvironmentRaycastTarget`. El motivo: si la petición se rechaza, `EnvironmentRaycastSystem` reintenta en cada frame con `console.error` (`nm/@iwsdk/core/dist/environment-raycast/environment-raycast.js:116-141`), y eso ensucia los E2E y la consola.
   - La sonda es asíncrona: al resolverse solo actúa si sigue la **misma sesión** y el modelo sigue en `probing` (un `place()` de debug o un `session:end` pueden adelantarse).
   - `EnvironmentRaycastSystem` construye el rayo con el **global** `XRRay` (`environment-raycast.js:142-157`). IWER 2.5.0 no lo instala (`nm/iwer/lib/device/XRDevice.js:469-497`) y su clase `XRRay` tiene la rotación invertida (§8.2, R13). En Chromium se usa el `XRRay` nativo, que es correcto. **Nunca** se sustituye por `IWER.XRRay`.
   - Filtros puros, yaw hacia la cabeza, asentado de 0,5 s y fallback.
6. **Bus de eventos tipado y síncrono** con un log circular de 256 entradas. Lo usan game-state, foley, los tests y el HUD (M3).
7. **Timers con el `time` del mundo sin clamp** (fallback 6 s, retención 0,3 s, asentado 0,5 s). La integración usa `dt = min(delta, 0.05)`. Así un CI lento no alarga los timers.
   - Los timers que se **pausan** fuera de `visible` (fallback de 6 s) no usan `time − inicio`: acumulan `min(time − prevTime, 0.25)` solo en frames visibles. En Quest el rAF se para en `hidden`, así que el primer frame tras la pausa trae todo el hueco.

---

## 1. Árbol de archivos y dueños

```
app/
├─ docs/architecture-m1.md ................................. I
├─ tsconfig.json ............................................ I   (+ "erasableSyntaxOnly": true; el proyecto actual ya pasa)
├─ package.json, package-lock.json, .npmrc, .gitignore ...... I   (sin dependencias nuevas en M1)
├─ vite.config.ts, index.html, public/**, tools/check-dist.mjs  I   (M0)
├─ .github/**, THIRD_PARTY_NOTICES.md ........................ I   (M0)
├─ src/
│  ├─ main.ts ............................................... I   cableado (§6). Retira addPlaceholderBox
│  ├─ core/
│  │  ├─ types.ts ............ puro ........................ I   contratos (HECHO)
│  │  ├─ events.ts ........... puro ........................ I   createEventBus(clock)
│  │  ├─ game-state.ts ....... puro ........................ I   initialGame, reduceGame, createGameState(bus)
│  │  └─ frame-system.ts ..... ECS −10 ..................... I   FrameSystem, waitFrames(n)
│  ├─ boot/config.ts, reset.ts, cdn-guard.ts ................ I   (M0, sin cambios)
│  ├─ boot/flags.ts ......................................... I   + pinch=select|distance, veto (?veto=0), sem (?sem=mesa, solo dev)
│  ├─ input/
│  │  ├─ hands-state.ts ...... puro ........................ A   createHandsState(): HandsState
│  │  ├─ select-queue.ts ..... puro ........................ A   eventos select → ≤1 flanco por frame
│  │  ├─ distance-pinch.ts ... puro ........................ A   fuente B: histéresis + confirmación
│  │  ├─ palm.ts ............. puro ........................ A   palmToHead, vetoStart
│  │  ├─ pinch-fsm.ts ........ puro ........................ A   idle/armed/pulling/holding/released
│  │  ├─ ratchet.ts .......... puro ........................ A   createRatchet
│  │  ├─ actuation.ts ........ puro ........................ A   createActuation(): ActuationService
│  │  ├─ handles.ts .......... puro ........................ A   createHandleRegistry(): HandleRegistry
│  │  ├─ arbiter.ts .......... puro ........................ A   createArbiter(): núcleo por frame
│  │  ├─ select-source.ts .... IWSDK ....................... A   gamepads[h] | selectstart/selectend
│  │  ├─ hand-frame.ts ....... three ....................... A   jointTransforms → mundo
│  │  ├─ hands-system.ts ..... ECS −3.6 .................... A
│  │  └─ arbiter-system.ts ... ECS −3.4 .................... A
│  ├─ placement/
│  │  ├─ filters.ts .......... puro ........................ B   classifyHit, yawToHead, fallbackPose, settleEase, createStability
│  │  ├─ placement-model.ts .. puro ........................ B   modos, timers, commit
│  │  ├─ reticle.ts .......... three ....................... B   anillo válido/inválido (MeshBasicMaterial)
│  │  └─ placement-system.ts . ECS −0.5 .................... B
│  ├─ box/box-rig.ts ......... three ....................... C   createBoxRig(): BoxRig (implementa BoxRootPort)
│  ├─ mechanisms/
│  │  ├─ linear-handle.ts .... puro ........................ C   createLinearHandle, linearAmount
│  │  ├─ wind.ts ............. three ....................... C   pestaña + 40 hojas instanciadas
│  │  └─ wind-system.ts ...... ECS 0.5 ..................... C   (0 lo ocupan Transform/Visibility/Level/Audio… de IWSDK)
│  ├─ render/
│  │  ├─ glsl/noise.ts, glsl/paper.ts, glsl/leaves.ts  puro (solo strings) .. C
│  │  ├─ paper-material.ts ... three ....................... C   createPaperMaterial(opts): ShaderMaterial
│  │  ├─ leaves-material.ts .. three ....................... C
│  │  ├─ occluder-hand.ts, proxy-controller.ts ............. I   (M0, sin cambios)
│  │  └─ placeholder-box.ts ................................ I   (M0) deja de importarse en M1. Borrar el archivo con aviso al usuario
│  ├─ audio/foley.ts ......... WebAudio (OPCIONAL) ......... C   (I lo llama desde main.ts si existe)
│  ├─ debug/
│  │  ├─ debug-api.ts ........................................ I   window.__indoor (§7)
│  │  └─ mesa-sem.ts ......... autocontenido ............... B   installMesaSem(cfg): E2E (addInitScript) y ?sem=mesa en dev
│  ├─ ui/landing.ts, vendor/uikit-lucide-lite.ts ............ I   (M0)
└─ tests/
   ├─ unit/
   │  ├─ boot.test.ts ....................................... I   actualizar los defaults de Flags
   │  ├─ events.test.ts, game-state.test.ts ................. I
   │  ├─ helpers/noise.ts ................................... A   inyector de ruido con semilla
   │  ├─ select-queue / pinch-fsm / palm / ratchet / actuation / arbiter .test.ts .. A
   │  ├─ placement-filters / placement-model / mesa-sem .test.ts ........... B
   │  └─ linear-handle / glsl-multiview .test.ts ............................ C
   └─ e2e/
      ├─ playwright.config.ts, boot.spec.ts ................. I   (M0)
      ├─ fixtures/iwer.ts ................................... I   + opción sem, setHeadPose, waitFrames, events, DebugSnapshot
      ├─ fixtures/hands.ts .................................. A   setHand, pinch, calibratePinchOffset, pinchAt, dragPinch
      ├─ placement.spec.ts ... E2E-03, E2E-04a, E2E-04b ..... B
      └─ wind.spec.ts ........ E2E-05 ....................... C
```

**Reglas de propiedad:**
- Solo el dueño edita su archivo. Todo archivo que no aparezca en el árbol es de I; un archivo nuevo se pide a I antes de crearlo.
- Solo I toca `main.ts`, `package.json`, `vite.config.ts`, `tsconfig.json`, `playwright.config.ts` y `fixtures/iwer.ts`. El único fixture con otro dueño es `fixtures/hands.ts` (A).
- Un cambio de contrato (`types.ts`, firmas del §5) se le pide a I, que lo aplica y avisa.
- A entrega **primero** `hands-state`, `select-source`, `hand-frame` y `hands-system` (unas 2 h): B y C los necesitan para sus E2E.
- B entrega **primero** `debug/mesa-sem.ts`: `fixtures/iwer.ts` (I) lo importa para la opción `sem`.
- Hasta que C entregue `box-rig.ts`, I cablea en `main.ts` un `BoxRootPort` provisional (un `Group` vacío con `setPose/setVisible`) para que B pueda pasar E2E-03/04.

---

## 2. Reglas comunes

**Módulos puros:**
- Sin imports de `three` ni de `@iwsdk/core`.
- Imports relativos con extensión `.ts` explícita, por ejemplo `import type { Vec3 } from '../core/types.ts'`.
- Solo sintaxis borrable: nada de `enum`, `namespace` ni parameter properties.
- Un módulo no puro que importe uno puro también usa `.ts`, para que el especificador sea idéntico en todas partes. Entre módulos no puros vale el estilo M0, sin extensión.

**Sin helpers compartidos de matemáticas en M1.** Cada módulo puro trae los suyos (`dot`, `sub` y similares, unas 10 líneas). Así nadie bloquea a nadie.

**Patrón de sistema (todos):**
```ts
import { createSystem, Types } from '@iwsdk/core';
import type { AppContext } from '../core/types.ts';

export class XSystem extends createSystem({}, { ctx: { type: Types.Object, default: undefined } }) {
  private ctx!: AppContext;
  init(): void {
    this.ctx = this.config.ctx.value as AppContext;
  }
  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.05); // seconds; timers use `time`
  }
}
```
- No redeclares campos de la base (`config`, `queries`, `world`, `player`, `input`, `priority`…). Con ES2022, los campos de clase se inicializan después de `super()` y los pisarían.
- Los recursos que da la base son `this.world`, `this.input` (con `input.xr.gamepads/visualAdapters/multiPointers`), `this.xrFrame`, `this.player`, `this.camera`, `this.renderer` y `this.visibilityState` (`nm/@iwsdk/core/dist/ecs/system.d.ts:30-47`).

**Prioridades únicas.** Con prioridades iguales se ejecuta en orden de registro (`nm/elics/lib/world.js:45`), y no queremos depender de eso. IWSDK registra sin prioridad (= 0) Transform, Visibility, Environment, Light, Level, Audio, Camera y Follow (`nm/@iwsdk/core/dist/init/world-initializer.js:174-175, 406-422, 532, 571`), así que ningún sistema nuestro usa 0.

**Cero asignaciones en `update()`:**
- Usa vectores scratch a nivel de módulo.
- Los `Vec3` marcados `readonly v` en ctx se mutan in situ.
- Los payloads de eventos sí son copias nuevas, pero los eventos son raros.

**Shaders:**
- Solo `THREE.ShaderMaterial`. Nunca `RawShaderMaterial`.
- Nunca declares lo que three inyecta (`nm/three/src/renderers/webgl/WebGLProgram.js:662-693`): `modelMatrix`, `modelViewMatrix`, `projectionMatrix`, `viewMatrix`, `normalMatrix`, `cameraPosition`, `isOrthographic`, `position`, `normal`, `uv`, `instanceMatrix`, `instanceColor` y `color`. En multiview esas matrices pasan a ser arrays con `#define` (`:896-937`).
- Los atributos propios llevan prefijo `a` (`aInk`, `aSeed`, `aGroup`) y los uniforms prefijo `u`.
- Sin `sampler2D`: todo es procedural.
- El color se pasa como `THREE.Color` (lineal) y el fragment termina con `#include <colorspace_fragment>`.
- En multiview solo el **vertex** recibe arrays por vista (`modelViewMatrix`, `projectionMatrix`, `viewMatrix`, `normalMatrix`); `cameraPosition` sigue siendo uno solo. La luz fija se calcula en mundo con `normalize(mat3(modelMatrix) * normal)` (escala uniforme; con instancias, `mat3(modelMatrix * instanceMatrix)`), nunca con `normalMatrix`, que es de vista.

**Coordenadas:**
- Mundo = local-floor. El XROrigin nunca se mueve.
- Yaw ψ: la cabeza mira hacia `(-sin ψ, 0, -cos ψ)`. El +Z local de la caja mira hacia `(sin ψ, 0, cos ψ)`. "Mirar a la cabeza" es `ψ = atan2(head.x − box.x, head.z − box.z)`.
- Frame local de la caja: origen en el centro de la base (sobre la mesa), +Y arriba, +Z = cara frontal (hacia el usuario), +X = derecha del usuario.

**Comentarios** en inglés, concisos. TypeScript estricto. `npx tsc --noEmit` siempre en verde.

---

## 3. Flujo de datos por frame

El render loop de IWSDK, por frame (`nm/@iwsdk/core/dist/init/world-initializer.js:579-594`):
1. Actualiza `world.visibilityState`.
2. Ejecuta `world.update(delta, time)`, que corre los sistemas en orden ascendente de prioridad.
3. Llama a los callbacks de `world.onXRFrame`.
4. Ejecuta `renderer.render`.

| Prio | Sistema | Dueño | Lee | Escribe / emite |
|---|---|---|---|---|
| −10 | `FrameSystem` | I | `delta`, `time`, `world.visibilityState` | `ctx.clock`; `visibility` si cambia (ver §5.1: `hidden` llega por evento); resuelve `waitFrames` |
| −4 | `InputSystem` (IWSDK) | — | XRFrame | poses del rig, `player.head`, `gamepads[h]`, `visualAdapters` (`jointTransforms`, `OccluderHand.update`), `multiPointers` |
| −3.6 | `HandsSystem` | A | `input.xr.*`, `player.head.matrixWorld`, cola de eventos select | `ctx.hands.{left,right,head}`; `veto` |
| −3.5 | `CanvasPointerSystem` (IWSDK) | — | — | — |
| −3.4 | `ArbiterSystem` | A | `ctx.hands`, `ctx.handles`, `game.phase`, `ctx.visible()` | `actuation.actuate()`; `pinch`, `handle:grab/release`. A través de actuation: `notch`, `mechanism:complete` |
| −1 | `EnvironmentRaycastSystem` (IWSDK) | — | hit-test source del retículo | pose y `visible` del retículo; `xrHitTestResult` |
| −0.5 | `PlacementSystem` | B | `xrHitTestResult` (mismo frame), `ctx.hands` (`selectStart`, `pinchPoint`, `head`) | `ctx.box.setPose/setVisible`, retículo; `placement:*`, `box:placed` |
| 0 | Transform, Visibility, Level, Audio… (IWSDK) | — | — | — |
| 0.5 | `WindSystem` | C | `actuation.progress('wind')`, bus | pestaña, uniforms de las hojas, `handle.setFrame()`; `wind:gust` |
| — | `world.onXRFrame` | — | sin uso en M1 | — |

**Por qué este orden:**
- **`HandsSystem` va después de −4.** `gamepads`, `jointTransforms` y `gripSpace.matrixWorld` se actualizan dentro de `XRInputManager.update` (`nm/@iwsdk/xr-input/dist/xr-input-manager.js:141-180`).
- **`PlacementSystem` va después de −1.** IWSDK escribe `xrHitTestResult` en −1, y `getPose()` solo vale dentro del frame que lo produjo: IWER lanza `InvalidStateError` fuera de él (`nm/iwer/lib/frameloop/XRFrame.js:57-60`).
- **El árbitro lee los handles con un frame de retraso.** Los handles se actualizan en 0.5 y el árbitro los lee en −3.4 del frame siguiente. Es irrelevante: la caja no se mueve en `wind`.
- **El bus es síncrono.** `game-state` cambia de fase dentro del `emit`, así que un sistema posterior en el mismo frame ya ve la fase nueva. Un `emit` durante el dispatch se encola (FIFO).

**Secuencia de un tirón en IWER:**
1. El test llama a `IWER_DEVICE.hands.right.updatePinchValue(1)`. Al inicio del siguiente frame, IWER aplica el valor, dispara `select` y luego `selectstart`, e interpola la pose hacia "pinch" (`nm/iwer/lib/device/XRTrackedInput.js:67-95`, `XRHandInput.js:146-149`).
2. En −4, `gamepads.right.getSelectStart()` da `true` en ese frame. IWER expone el gamepad en las manos y el perfil `generic-hand` usa trigger = botón 0 (`nm/iwer/lib/device/XRHandInput.js:33`, `nm/@iwsdk/xr-input/dist/gamepad/generated-profiles.js:293-300`).
3. En −3.6, `HandsSystem` toma `selectPath='gamepad'`, `selectStart=true` y calcula `pinchPoint` = punto medio entre los joints 4 y 9 en mundo. El veto no salta. En ese mismo frame IWER ya aplicó la pose "pinch" (`updateHandPose` corre en `onFrameStart`, después del valor pendiente).
4. En −3.4, el árbitro comprueba que la fase es `wind` y la sesión está visible. `handles.nearest(pinchPoint)` devuelve la pestaña: la FSM pasa `idle→armed` y se emite `handle:grab`.
5. En los frames siguientes, con un desplazamiento > 3 mm la FSM pasa a `pulling`. Cada frame: `actuate('wind', handle.amountFor(start, now, p0), 'direct')`.
6. El ratchet emite `notch` en 0,25, 0,5 y 0,75, y luego `mechanism:complete{wind}`. `WindSystem` suelta una ráfaga por cada uno.
7. game-state pasa de `wind` a `done`: en M1 no hay más capítulos registrados.
8. El árbitro ve el target bloqueado y emite `handle:release{reason:'cancel'}`.

---

## 4. Máquina de estados del juego y eventos

### 4.1 Fases (`GamePhase`; reductor puro en `core/game-state.ts`)

```
         session:start         placement:commit          box:placed
 boot ─────────────────► placing ─────────────► settling ─────────────► wind ──complete(wind)──► night ─► storm ─► kite ─► dawn ─► finale ─► done
  ▲                                                                       │        (M2)          (M3)     (M3)    (M3)    (M2)
  │                                                                       └─ M1: night no registrado ─► done
  └──────────── session:end (desde cualquier fase: se pierde la pose, se conserva el progreso) ───────────
```

| Desde | Evento | Hacia |
|---|---|---|
| `boot` | `session:start` | `placing` |
| `placing` | `placement:commit` | `settling` |
| `settling` | `box:placed` | primer capítulo de `CHAPTER_ORDER` **registrado y no completado**; si no hay ninguno, `done` |
| capítulo X | `mechanism:complete{X}` | siguiente capítulo registrado y no completado. Si no queda ninguno: `done` (M1). En M2/M3 entran `kite`, `dawn` y `finale` |
| cualquiera | `session:end` | `boot` (`completed` se conserva) |

- `isUnlocked(t)` ⇔ `phase === t`. "Fase de capítulo" = `isChapterPhase(phase)` de `types.ts` (wind/night/storm/kite).
- Cada cambio emite `phase{from,to}`.
- `session:end` durante `settling` cancela el asentado: B no emite `box:placed` de esa sesión.
- Reentrar en AR vuelve a colocar la caja (la pose no sirve entre sesiones) y reanuda el primer capítulo pendiente.
- La pausa no es una fase: va aparte, con `ctx.visible()` y el evento `visibility`.

### 4.2 FSM del pinch, por mano (`input/pinch-fsm.ts`)

```
 idle ──start ∧ canGrab ∧ allowed──► armed ──|Δ|>3 mm──► pulling ──end──► released ─(1 frame)─► idle
                                      │end                  │¬tracked
                                      ▼                     ▼
                                   released              holding ──tracked ∧ (selecting ∨ start)──► pulling
                                                           │ tracked ∧ ¬selecting ──► released(release)
                                                           │ t ≥ 0,30 s ──► released(tracking-lost)
 armed/pulling/holding ──¬allowed o target bloqueado──► released(cancel)
```

- **Veto palma→cara:**
  - Lo aplica `HandsSystem` sobre el flanco de inicio, antes de la FSM, y emite `veto`.
  - Solo se aplica al **inicio**: mientras se tira, nunca suelta.
  - También aplica al select que coloca la caja.
- **Un falso release no cuesta nada.** Al volver a agarrar, `progressAtStart` = progreso actual, porque el trinquete no retrocede.

### 4.3 Colocación (`placement/placement-model.ts`)

```
 idle ─session:start─► probing ─sonda OK─► hit-test ─select ∧ valid─► committed ─0,5 s─► (box:placed)
                          │ sonda falla            │ 6 s visibles sin hit válido
                          ▼                        ▼
                       fallback ◄──────────────────┘
                          │ 10 hits válidos estables (solo si hit-test disponible) ─► hit-test ('surface-found')
                          └─ select ─► committed (source 'fallback')
 probing | hit-test | fallback ──place() de debug──► committed (source 'debug')
```

- En `fallback` el retículo se muestra en el candidato (estado `valid`) como única afordancia de "pellizca para colocar"; en `hit-test` sigue al impacto.
- `session:end` en cualquier modo → `idle`.

### 4.4 Eventos (`GameEvent` en `types.ts`)

| Evento | Emisor | Consumidores |
|---|---|---|
| `session:start` / `session:end` | I (`main.ts`, `renderer.xr`) | game, placement, arbiter (desactiva el rayo), foley |
| `visibility` | I (`FrameSystem` + `visibilitychange` de la sesión, deduplicado) | arbiter (cancela), M2 pausa |
| `phase` | I (game-state) | wind (habilita el handle), debug |
| `placement:mode` | B (también `{probing,'start'}` en `session:start` y `{committed,'commit'}` justo antes de `placement:commit`) | debug, tests (E2E-04) |
| `placement:commit` | B | game (→`settling`), wind (crea materiales: compilan durante el asentado) |
| `box:placed` | B | game (→capítulo), wind |
| `pinch` | A | HUD (M3) |
| `veto` | A | tests, HUD |
| `handle:grab` / `handle:release` | A | foley, wind (resalte de la pestaña) |
| `actuate:reject` | A (actuation) | tests (en el flujo normal debe haber 0) |
| `notch` | A (actuation) | wind (ráfaga), foley |
| `mechanism:complete` | A (actuation), una vez por `ActuationTarget` | game, wind (ráfaga final), foley |
| `mechanism:register` | C (`WindSystem.init`); M3 registra también `kite` | game |
| `wind:gust` | C | foley, tests |

---

## 5. Contratos por módulo

Las firmas exactas están abajo. Los tipos vienen de `src/core/types.ts`.

### 5.1 Core (I)

```ts
// core/events.ts (pure)
export function createEventBus(clock: Readonly<FrameClock>, capacity?: number /* 256 */): EventBus;
//   stamps {t: clock.time, frame: clock.frame}; FIFO queue for nested emits; log = ring (oldest first)
//   handlers run in subscription order (typed and onAny alike): game-state, subscribed first, has already
//   reduced an event when later handlers of that event run. A throwing handler → console.error, the rest still run.

// core/game-state.ts (pure)
export function initialGame(): GameSnapshot;                    // { phase: 'boot', registered: [], completed: [] }
export function reduceGame(s: GameSnapshot, e: GameEvent): GameSnapshot; // returns `s` itself when nothing changes
export function createGameState(bus: EventBus): GameStateApi;   // bus.onAny → reduce; emits 'phase' on change

// core/frame-system.ts (ECS −10)
export class FrameSystem /* createSystem({}, { ctx }) */ {}
//   update: clock.frame++, clock.time = time, clock.dt = min(delta, 0.05); emits 'visibility' on change.
//   Quest does not run rAF while 'hidden', so main.ts also forwards the session's 'visibilitychange'
//   (same dedupe: one 'visibility' event per actual change).
export function emitVisibility(bus: EventBus, state: XRVisibility): void; // no-op if equal to the last emitted state
export function waitFrames(n: number): Promise<number>;
//   resolved inside FrameSystem.update of the n-th next frame; the awaiting code resumes in the
//   microtask checkpoint after that whole rAF callback (all systems + render). IWER input set before
//   the call is applied at the start of frame 1, so n = 1 already sees it; fixtures use 2 for margin.
```

### 5.2 Entrada (A)

```ts
// input/hands-state.ts (pure)
export function createHandsState(): HandsState;  // stable objects, tracked=false, handScale 0.09, NaN distances

// input/select-queue.ts (pure). Mirrors nm/@iwsdk/xr-input/dist/xr-input-manager.js:283-306, 346-379
export interface SelectQueue {
  push(edge: 'start' | 'end'): void;           // repeated edge = ignored; at max, drops the oldest pair first
  take(): { start: boolean; end: boolean; selecting: boolean }; // at most ONE edge per call (one per frame)
  reset(): void;
}
export function createSelectQueue(maxTransitions?: number /* 4 = MAX_HAND_SELECT_TRANSITIONS, :20 */): SelectQueue;

// input/distance-pinch.ts (pure). Source B: diagnostics + ?pinch=distance escape hatch
export interface DistancePinchConfig { enterM: number; exitM: number; confirmSamples: number; refHandScaleM: number }
export const DISTANCE_PINCH_DEFAULTS: Readonly<DistancePinchConfig>; // 0.015, 0.03, 3, 0.09
export function createDistancePinch(cfg?: Partial<DistancePinchConfig>): {
  update(tipDistance: number, handScale: number): { start: boolean; end: boolean; selecting: boolean };
  reset(): void;
};
//   thresholds × (handScale / refHandScaleM); only NEW samples (value ≠ previous) count toward confirmation,
//   so 30 Hz tracking on 72 Hz frames cannot confirm with three copies of one noisy sample.

// input/palm.ts (pure)
export const PALM_VETO_COS = 0.7;
export function palmToHead(palmNormal: Readonly<Vec3>, wrist: Readonly<Vec3>, head: Readonly<Vec3>): number; // cos; NaN if degenerate
export function vetoStart(palmToHeadCos: number, enabled: boolean): boolean; // NaN → false

// input/pinch-fsm.ts (pure)
export interface PinchFsmConfig { retentionS: number /* 0.30 */; deadzoneM: number /* 0.003 */ }
export interface PinchFsmInput {
  time: number; tracked: boolean;
  selectStart: boolean; selectEnd: boolean; selecting: boolean;
  canGrab: boolean;   // a handle accepted this start (in range, enabled, unlocked, free)
  moved: number;      // |pinchPoint − grabStart| (m)
  allowed: boolean;   // visible ∧ chapter phase ∧ owned target still unlocked
}
export interface PinchFsmStep { state: PinchState; prev: PinchState; grabbed: boolean; released: ReleaseReason | null }
export function createPinchFsm(cfg?: Partial<PinchFsmConfig>): {
  readonly state: PinchState; step(i: PinchFsmInput): PinchFsmStep; reset(): void;
};

// input/ratchet.ts (pure)
export interface RatchetConfig { notches: readonly number[] /* [0.25, 0.5, 0.75] */; completeAt: number /* 0.98 → snaps to 1 */ }
export interface RatchetStep { value: number; changed: boolean; notches: readonly number[]; completed: boolean } // reused object
export function createRatchet(cfg?: Partial<RatchetConfig>): {
  readonly value: number; push(amount: number): RatchetStep; reset(value?: number): void;
};

// input/actuation.ts (pure)
export function createActuation(deps: {
  bus: EventBus; game: GameStateApi; clock: Readonly<FrameClock>; visible: () => boolean; mode?: InputMode;
}): ActuationService;
//   gate order: invalid (NaN/±Inf) → locked (!game.isUnlocked) → hidden (!visible) → mode (source ∉ {mode,'debug','auto'})
//   reject: rejected++ and ONE 'actuate:reject' per (target, source, reason) until that source gets a call
//   accepted on that target again (no spam; a stray 'ray' caller is reported once even while 'direct' keeps being accepted)
//   accept: ratchet.push → 'notch' for each crossed index, in order → 'mechanism:complete' once per target
//   doubleActuations++ if two different InputModes hit the same target in the same clock.frame

// input/handles.ts (pure)
export function createHandleRegistry(): HandleRegistry;

// input/arbiter.ts (pure)
export interface ArbiterFrame { time: number; allowed: boolean; mode: InputMode; hands: HandsState }
export function createArbiter(deps: {
  handles: HandleRegistry; actuation: ActuationService; bus: EventBus; game: GameStateApi;
}): ArbiterView & { step(f: ArbiterFrame): void; cancelAll(reason: ReleaseReason): void };
//   one owner per handle and one handle per hand. Tie on the same frame → nearer pinchPoint, then 'right'.
//   controllers: grabRadius × 1.5. No actuate once isComplete(target). Target locked mid-grab → release('cancel').
//   M1 only acts when mode === 'direct'. Emits 'pinch' on every FSM transition, plus 'handle:grab' and 'handle:release'.

// input/select-source.ts (IWSDK)
export function createSelectSource(input: InputManager): {
  attach(session: XRSession): void; detach(): void;
  read(h: Handedness, out: HandSample): void;  // fills selectStart/End/selecting/rawSelectStart/selectPath
};
//   input.xr.gamepads[h] present → 'gamepad': getSelectStart/getSelectEnd/getSelecting, queue reset.
//   Otherwise selectstart/selectend on the session, filtered by e.inputSource.hand && handedness → queue → 'events'.
//   NEVER the 'select' event (IWER 2.5.0 fires it on press, before selectstart).

// input/hand-frame.ts (three)
export function readHandFrame(adapter: XRHandVisualAdapter, head: Readonly<HeadSample>, out: HandSample): boolean;
//   tracked = adapter.connected && adapter.isPrimary && adapter.jointTransforms && adapter.gripSpace
//             && jointTransforms[15] === 1   (the array is zero-filled until the first successful fillPoses)
//   joint i (relative to grip): jointTransforms[i*16+12..14]; world = adapter.gripSpace.matrixWorld × p
//   (matrixWorld is fresh: XRInputManager calls xrOrigin.updateMatrixWorld(true) at −4)
//   indices (XRHand order, nm/iwer/lib/input/XRHand.js): 0 wrist, 4 thumb-tip, 9 index-finger-tip,
//   11 middle-finger-phalanx-proximal (handScale). Read only these 4 joints.
//   palmNormal = −Y of the wrist joint, in world (verify the sign, §11-R4); pinchStrength = adapter.getPinchStrength()
export function readControllerFrame(adapter: XRControllerVisualAdapter, out: HandSample): boolean; // pinchPoint = grip

// input/hands-system.ts (ECS −3.6). Head from player.head.matrixWorld (forward = −Z projected on XZ,
//   yaw/pitch; if the projection is < 1e-3 (looking straight down) keep the previous forward),
//   then per hand: device ('hand' if visualAdapters.hand[h].connected && isPrimary, else controller),
//   tracked/lostFor, select (path; with ?pinch=distance → distance-pinch), veto (flags.veto), geometry.
//   session:start → selectSource.attach(renderer.xr.getSession()); session:end → detach + reset samples.
// input/arbiter-system.ts (ECS −3.4). Sets ctx.arbiter in init, and there (MultiPointers already exist
//   and IWSDK only ever toggles 'touch', input-system.js:96-109) calls
//   input.xr.multiPointers[h].toggleSubPointer('ray', actuation.mode === 'ray') (M1: off). Every frame:
//   arbiter.step({ time, allowed: ctx.visible() && isChapterPhase(game.phase), mode: actuation.mode, hands: ctx.hands }).
//   session:end and visibility ≠ 'visible' → arbiter.cancelAll('cancel').
```

### 5.3 Colocación (B)

```ts
// placement/filters.ts (pure)
export interface PlacementConfig {
  minUpDot: number;        // 0.9   hit normal · (0,1,0)
  belowHeadMinM: number;   // 0.15
  belowHeadMaxM: number;   // 0.75
  minFloorY: number;       // 0.30  only when floorKnown
  minDistM: number;        // 0.25  horizontal, head → hit
  maxDistM: number;        // 0.90
  stableFrames: number;    // 10
  stableTolM: number;      // 0.01
  fallbackAfterS: number;  // 6     visible seconds without a valid hit
  fallbackAheadM: number;  // 0.45
  fallbackBelowM: number;  // 0.45
  pinchBandM: readonly [number, number]; // [0.25, 0.75] below the head: pinch height usable in fallback
  pinchToBaseM: number;    // 0.07  pinch marks the lid → base = pinchY − 0.07
  settleS: number;         // 0.5
  settleLiftM: number;     // 0.04
  reticlePitchDeg: number; // 25 (downwards, ray in Viewer space)
  reticleMaxDistM: number; // 1.5
}
export const PLACEMENT_DEFAULTS: Readonly<PlacementConfig>;
export function classifyHit(p: Readonly<Vec3>, normal: Readonly<Vec3>, head: Readonly<Vec3>, floorKnown: boolean,
  cfg?: Readonly<PlacementConfig>): HitVerdict;  // check order: tilted, floor, too-high, too-low, too-near, too-far
export function yawToHead(box: Readonly<Vec3>, head: Readonly<Vec3>): number;
export function fallbackPose(head: Readonly<HeadSample>, pinchY: number | null, cfg?: Readonly<PlacementConfig>, out?: BoxPose): BoxPose;
//   position = head + fallbackAheadM·forward − (0, fallbackBelowM, 0); if pinchY lies in [head.y−0.75, head.y−0.25]
//   → y = pinchY − pinchToBaseM; yaw = yawToHead(position, head)
export function settleEase(t01: number): number;  // easeOutCubic, clamped to [0, 1]
export function createStability(cfg?: Readonly<PlacementConfig>): { push(p: Readonly<Vec3> | null): number; reset(): void };

// placement/placement-model.ts (pure)
export interface PlacementInput {
  time: number; visible: boolean;
  hitTest: 'unknown' | 'available' | 'unavailable';
  hit: { position: Vec3; normal: Vec3 } | null;
  head: Readonly<HeadSample>; floorKnown: boolean;  // floorKnown = head.position.y > 0.6 (Local space ⇒ head ≈ 0)
  selectStart: boolean; pinchY: number | null;      // first hand with selectStart
}
export interface PlacementOutput {
  status: Readonly<PlacementStatus>;
  commit: { pose: BoxPose; source: PlacementSource } | null;
  modeChange: { mode: PlacementMode; reason: PlacementModeReason } | null;
}
export function createPlacementModel(cfg?: Partial<PlacementConfig>): {
  start(time: number): void; step(i: PlacementInput): PlacementOutput;
  forceCommit(pose: BoxPose | null, time: number): PlacementOutput | null;  // debug; null pose = current candidate
  reset(): void;
};
//   `elapsed` and the 6 s timer only advance while visible: += min(time − prevTime, 0.25) per visible step
//   (never `time − startTime`). No commits while not visible.

// placement/reticle.ts (three)
export function createReticle(): { readonly object: Object3D; setState(s: 'hidden' | 'invalid' | 'valid'): void };

// placement/placement-system.ts (ECS −0.5). Sets ctx.placement: PlacementService in init.
```

**`PlacementSystem` paso a paso:**
1. **Al arrancar:** crea una sola vez la entidad del retículo, `world.createTransformEntity(reticle.object)`, oculta.
2. **En `session:start`:**
   1. `model.start(time)`.
   2. Sonda asíncrona: `session.enabledFeatures?.includes('hit-test')` (la misma condición con la que IWSDK activa su sistema, `environment-raycast.js:110-111`) → `requestReferenceSpace('viewer')` → `session.requestHitTestSource({ space })`, todo dentro de un `try/catch` silencioso.
   3. Al resolverse, si `session !== renderer.xr.getSession()` o el modelo no está en `probing` **ni en `fallback`**: `source?.cancel()` y nada más. (M1: el modelo también hace timeout de 6 s en `probing` → `fallback/'timeout'`; una sonda tardía que funciona añade el target y `'surface-found'` puede tomar el relevo.)
   4. Si va bien: `source.cancel()` y `entity.addComponent(EnvironmentRaycastTarget, { space: RaycastSpace.Viewer, maxDistance: 1.5, offsetQuaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), −25°) })`. Además `hitTest = 'available'`.
   5. Si falla: `hitTest = 'unavailable'`, y el modelo pasa a `fallback` con `reason: 'no-hit-test'`.
3. **En `update`, si la fase es `placing`:**
   1. Lee `xrHitTestResult` con `getPose(world.xrReferenceSpace)`, en `try/catch`. Del `transform.matrix` (column-major), la posición está en `m[12..14]` y la normal es la columna Y, `m[4..6]`.
   2. Pasa al modelo el `selectStart` de cualquier mano (`ctx.hands.left/right`).
   3. El retículo **siempre** se sobrescribe después de −1, porque IWSDK pone `visible=true` con cualquier impacto (`environment-raycast.js:280-285`). Estados: `valid` (tinta llena), `invalid` (gris) u `hidden`. En `fallback` B lo coloca en el candidato (posición, yaw) con estado `valid`.
4. **Al hacer commit:**
   1. Emite `placement:commit`.
   2. `removeComponent(EnvironmentRaycastTarget)`, que cancela la source (`environment-raycast.js:48-50, 296-325`).
   3. Oculta el retículo y muestra la caja.
   4. Asentado durante 0,5 s: `setPose({ position: final + (0, (1−e)·0.04, 0), yaw }, 0.85 + 0.15·e)` con `e = settleEase(t / 0.5)`, reutilizando una pose scratch.
   5. Al terminar, emite `box:placed`.
5. **En `session:end`:** reset del modelo, cancela el asentado en curso (sin `box:placed`), quita el componente, oculta la caja y deja `pose = null`. El target se recrea en cada sesión.

Mientras A no entregue `HandsSystem`, B puede leer `player.head` y `gamepads[h]` directamente. La versión final usa `ctx.hands`.

### 5.4 Caja + Viento (C)

```ts
// box/box-rig.ts (three)
export interface BoxRig extends BoxRootPort {
  readonly root: Group;  // hidden until commit. Root keeps matrixAutoUpdate = true (B moves it during the
                         // settle; with false, getWorldPosition() on the anchors would read a stale root).
                         // Static children: merged geometry, matrixAutoUpdate = false.
  readonly anchors: { readonly wind: Group; readonly night: Group; readonly storm: Group };
}
export function createBoxRig(): BoxRig;  // size 0.26 × 0.07 × 0.18 (x, y, z)
//   anchors (box local): wind = front face, left third (−0.07, 0.035, 0.09); night = right face (0.13, 0.035, 0);
//   storm = lid (0, 0.07, −0.02). M1 draws night/storm as closed paper seals (static, no handle).

// mechanisms/linear-handle.ts (pure)
export function linearAmount(start: Readonly<Vec3>, now: Readonly<Vec3>, axis: Readonly<Vec3>, travel: number, progressAtStart: number): number;
//   = progressAtStart + dot(now − start, axis) / travel   (no clamping: the ratchet clamps)
export interface LinearHandle extends HandleSpec {
  setFrame(rest: Readonly<Vec3>, axis: Readonly<Vec3>, progress: number, enabled: boolean): void;
  //   grabPoint = rest + axis·progress·travel; hint = { axis, travel }
}
export function createLinearHandle(o: { target: ActuationTarget; travel: number; grabRadius: number }): LinearHandle;

// mechanisms/wind.ts (three)
export const WIND: { readonly travelM: 0.06; readonly grabRadiusM: 0.035; readonly leafCount: 40; readonly groups: 4; readonly areaM: readonly [0.4, 0.3] };
export interface WindView extends Qualityable {
  readonly tab: Object3D;
  readonly leaves: InstancedMesh;              // frustumCulled = false, count = leafCount (governor lever in M3)
  setProgress(p: number): void;                // tab slides along +Z, from 0 to travelM
  gust(group: number, time: number): void;     // uGust[group] = time
  update(time: number, dt: number): void;      // uTime
  readonly leavesReleased: number;
  dispose(): void;
}
export function createWindView(anchor: Group): WindView;  // builds meshes + materials (call on placement:commit)

// mechanisms/wind-system.ts (ECS 0.5, configData { ctx, rig }; schema: ctx and rig both { type: Types.Object, default: undefined })
//   init: bus.emit({type:'mechanism:register', id:'wind'}); ctx.handles.register(handle);
//         ctx.probes.wind = () => ({ gusts, leavesReleased, leafCount })
//   placement:commit → view ??= createWindView(rig.anchors.wind)   (ONCE: re-entering AR reuses it, no leak)
//   update: handle.setFrame(restWorld = anchor + WIND_TAB_GRIP_Z (0.018 m) along the anchor's +Z (centre of the
//           tab's pull end), axisWorld = rig's +Z rotated by yaw,
//           progress, enabled = phase === 'wind' && view !== null)
//           view.setProgress(actuation.progress('wind')); view.update(time, dt)
//   notch{target:'wind', index:i} → gust(i); mechanism:complete{wind} → gust(3); each gust → 'wind:gust'{group, leaves: 10}

// render/paper-material.ts (three)
export interface PaperMaterialOptions { inks?: readonly [number, number, number, number, number]; octaves?: 1 | 2 | 3; instanced?: boolean }
export function createPaperMaterial(o?: PaperMaterialOptions): ShaderMaterial;
//   uniforms: uInks (Color[5]), uTime, uGrain, uKeyDir (vec3 world), uContrast (M2). Per-vertex attribute aInk (0..4).
//   Fragment: fbm (PAPER_OCTAVES define, default 2) for fibres + fixed key lambert + ambient, no scene lights.
//   World normal from mat3(modelMatrix) (§2), so the lighting is identical in both multiview views.
//   First render compiles the programs (one hitch at commit, hidden by the settle). Programs compiled
//   outside XR are NOT reused in XR (multiview is part of the program key), so no pre-session compile.

// render/leaves-material.ts (three)
//   instanced attributes aSeed (vec4), aGroup (float 0..3); uniforms uGust (vec4: release time per group, −1 = inside the box),
//   uTime, uWindDir (vec2, box local), uArea (vec2 half-extents 0.20 × 0.15), uInks.
//   Path in box local space: exits through the slot, flutters across the table (fake: y = 0 is the surface), settles,
//   and SHRINKS (no transparency) on leaving the 40 × 30 cm area or after its lifetime.

// render/glsl/*.ts (pure): export const X_VERT / X_FRAG / X_CHUNK = /* glsl */ `...`; ONLY strings, no imports.

// audio/foley.ts (OPTIONAL, WebAudio)
export function createFoley(bus: EventBus, handles: HandleRegistry): { dispose(): void };
//   ThreeAudioContext.getContext() (the same context as IWSDK's AudioListener on player.head, audio-system.js:74);
//   noise buffer synthesised once; ≤3 voices; HRTF PannerNode at handle.grabPoint (refDistance 0.3, maxDistance 5);
//   master → DynamicsCompressor. grab → tick, notch → rustle, complete → whoosh.
//   Do NOT use AudioSource: it needs a `src` URL (nm/@iwsdk/core/dist/audio/audio.d.ts:53).
```

**Presupuesto en Viento:** ≤40 draw calls. Lo esperado ronda 9:
- caja fusionada: 1-3;
- pestaña: 1;
- hojas: 1;
- oclusor de manos: 2 × 2.

---

## 6. Cableado de `main.ts` (I)

Se mantiene todo lo de M0: flags, reset, landing, assetPath, cdn-guard, `World.create`, `checkShaderErrors`, visuales propios, `setFramebufferScaleFactor`, foveation/72 Hz y Enter AR síncrono. Encima se añade esto:

```ts
import { AudioContext as ThreeAudioContext, World } from '@iwsdk/core';
import { createBoxRig } from './box/box-rig';
import { createEventBus } from './core/events.ts';
import { FrameSystem, emitVisibility } from './core/frame-system';
import { createGameState } from './core/game-state.ts';
import { DEFAULT_SETTINGS, type AppContext, type FrameClock } from './core/types.ts';
import { createActuation } from './input/actuation.ts';
import { ArbiterSystem } from './input/arbiter-system';
import { createHandleRegistry } from './input/handles.ts';
import { createHandsState } from './input/hands-state.ts';
import { HandsSystem } from './input/hands-system';
import { WindSystem } from './mechanisms/wind-system';
import { PlacementSystem } from './placement/placement-system';
// …M0 imports and boot unchanged…

const clock: FrameClock = { frame: 0, time: 0, dt: 0 };
// Read the session directly: world.visibilityState is only refreshed once per rendered frame.
// renderer.xr.getSession(), not world.session: IWSDK assigns world.session only after three's 'sessionstart'.
const visible = () => world.renderer.xr.getSession()?.visibilityState === 'visible';
const bus = createEventBus(clock);
const game = createGameState(bus);
const rig = createBoxRig();
world.createTransformEntity(rig.root);

const ctx: AppContext = {
  flags, settings: { ...DEFAULT_SETTINGS }, clock, bus, game,
  hands: createHandsState(),
  handles: createHandleRegistry(),
  actuation: createActuation({ bus, game, clock, visible }),
  arbiter: null, placement: null, box: rig, visible, probes: {},
};

// Unique priorities = data flow (docs/architecture-m1.md §3).
world.registerSystem(FrameSystem, { priority: -10, configData: { ctx } });
world.registerSystem(HandsSystem, { priority: -3.6, configData: { ctx } });
world.registerSystem(ArbiterSystem, { priority: -3.4, configData: { ctx } });
world.registerSystem(PlacementSystem, { priority: -0.5, configData: { ctx } });
world.registerSystem(WindSystem, { priority: 0.5, configData: { ctx, rig } });
// Optional (C): if (createFoley) createFoley(bus, ctx.handles);

world.renderer.xr.addEventListener('sessionstart', () => {
  // …M0: foveation, updateTargetFrameRate(72), landing.setInSession(true)…
  const session = world.renderer.xr.getSession();
  // IWSDK suspends the context on sessionend (audio-system.js:58-67): resume on the first in-XR select too.
  session?.addEventListener('selectstart', () => {
    const audio = ThreeAudioContext.getContext();
    if (audio.state === 'suspended') void audio.resume();
  });
  // rAF does not run while 'hidden' on Quest: FrameSystem alone would never see it.
  session?.addEventListener('visibilitychange', () => emitVisibility(bus, session.visibilityState));
  bus.emit({ type: 'session:start' });
});
world.renderer.xr.addEventListener('sessionend', () => {
  landing.setInSession(false);
  bus.emit({ type: 'session:end' });
});

// M0's addPlaceholderBox(world) is gone: the box only appears after placement.

// Both BEFORE landing.setReady(): Enter AR must not be clickable before the SEM
// is installed (IWER checks it inside requestHitTestSource) or before __indoor exists.
if (import.meta.env.DEV && flags.sem === 'mesa') {
  // Dev-only: never reaches dist (check-dist fails on "IWER_DEVICE").
  const { installMesaSem, MESA_DEFAULT } = await import('./debug/mesa-sem.ts');
  installMesaSem(MESA_DEFAULT);
}
if (import.meta.env.DEV || flags.debug) installDebugApi(world, flags, ctx);

// …M0: landing.onEnter(() => { resume(); world.launchXR(); }) stays EXACTLY as is
// (no await, no new work before launchXR), then isSessionSupported → landing.setReady.
```

- `emitVisibility(bus, state)` (I, en `frame-system.ts`) emite `visibility` solo si el estado cambió; `FrameSystem` usa la misma función.
- Mientras C no entregue `box-rig.ts`, `rig` es un stub de I (`Group` vacío que implementa `BoxRootPort`, con `anchors` vacíos) y `WindSystem` no se registra.

**Nuevos flags** (I, en `boot/flags.ts`; hay que actualizar `boot.test.ts`, que compara los defaults con `deepEqual`):
- `pinch: 'select' | 'distance'` (`?pinch=distance`);
- `veto: boolean` (`?veto=0` lo apaga);
- `sem: 'mesa' | null` (`?sem=mesa`, solo con efecto en dev).

---

## 7. `window.__indoor` (I, `debug/debug-api.ts`)

Solo se instala si `import.meta.env.DEV` o `?debug=1`, igual que en M0.

```ts
export interface IndoorDebugApi {
  flags: Flags; world: World; ctx: AppContext;            // M0 + ctx (not serialisable: only inside evaluate)
  state(): DebugSnapshot;                                 // types.ts, JSON only (Vec3Tuple, degrees)
  readonly events: readonly LoggedEvent[];                // = ctx.bus.log (ring buffer of 256)
  clearEvents(): void;
  waitFrames(n: number): Promise<number>;                 // core/frame-system.ts
  place(pose?: { x: number; y: number; z: number; yawDeg: number }): boolean; // ctx.placement.commit(); false outside 'placing'
  actuate(target: ActuationTarget, amount: number): number;                    // source 'debug' (skips only the mode check)
  handles(): Partial<Record<ActuationTarget, {
    point: Vec3Tuple; radius: number; enabled: boolean; axis: Vec3Tuple | null; travel: number | null;
  }>>;
}
```

`state()` mantiene los campos de M0 (`inSession`, `visibility`, `audio`, `drawCalls`, `triangles`), de los que depende E2E-02, y añade:
- `frame`, `time`, `phase`, `head`;
- `placement` (con `verdict`) y `box`;
- `mechanisms`;
- `hands`, con `fsm`, `owner`, `selectPath`, `pinchPoint`, `tipDistance` y `palmToHead`;
- `input`, con `rejected` y `doubleActuations`;
- `probes`, por ejemplo `probes.wind = { gusts, leavesReleased, leafCount }`.

M3 añadirá `quality()`.

---

## 8. Tests

### 8.1 Unitarios (`node --test`, módulos puros, semilla fija)

| Archivo (dueño) | Casos | Criterio de aceptación |
|---|---|---|
| `select-queue.test.ts` (A) | start+end entre dos frames; start duplicado; más de 4 transiciones; reset | frame 1 `{start, selecting}`, frame 2 `{end, !selecting}`; un solo flanco por `take()`; tras desbordar, `selecting` = estado físico final |
| `pinch-fsm.test.ts` (A) + `helpers/noise.ts` | tirón limpio; tap sin moverse; start fuera de rango; pérdida de 250 ms y de 350 ms; recupera sin selecting; `allowed=false` | ver abajo |
| `palm.test.ts` (A) | palma hacia la cabeza (cos≈1); pose por defecto de IWER; pose de E2E-05; NaN | veto con cos>0,7. **Regresión:** la muñeca derecha de IWER (matriz de `nm/iwer/lib/device/configs/hand/pinch.js:9-16`, espejada; −Y ≈ (−0,08, −0,81, −0,58)) en (0,25, 1,5, −0,4) con la cabeza en (0, 1,6, 0) da cos≈−0,6, **sin veto**. **Caso que detecta el signo:** misma −Y con la muñeca sobre la pestaña (−0,02, 0,79, −0,27) y la cabeza sentada (0, 1,2, 0) da cos≈−1; con el signo invertido daría ≈+1 (veto). El test fija ambos valores |
| `ratchet.test.ts` (A) | 10 000 importes aleatorios (incluye <0 y >1); repetición; NaN/±Inf; salto 0→0,8; llegada a 0,98 | valor = máximo acumulado de `clamp(a,0,1)` y nunca baja; repetir no cambia nada; NaN/±Inf se ignoran; muescas `[0,1,2]` en orden y una sola vez; `completed` una sola vez y valor 1 |
| `actuation.test.ts` (A) | orden de las puertas con un bus y un game falsos; rechazo repetido; aceptado tras rechazo; dos modos en el mismo `clock.frame`; `reset` | `invalid`→`locked`→`hidden`→`mode` (la primera que falla gana); un solo `actuate:reject` por (target, source, reason) hasta el siguiente aceptado de esa fuente; `rejected` cuenta todos; `notch` en orden y `mechanism:complete` una vez; `doubleActuations` sube solo con dos `InputMode` distintos en el mismo frame (`'debug'` no cuenta) |
| `arbiter.test.ts` (A) | dos manos sobre la pestaña en el mismo frame; dos handles en rango; target bloqueado; `allowed=false` a mitad; bloqueo a mitad; después de completar; `actuate(…,'ray')` en modo direct | un dueño (el más cercano; empate → right); el más cercano gana; sin grab ni actuate; `release('cancel')`; `release('cancel')`; ya no hay actuate; rechazado con un único `actuate:reject{reason:'mode'}`; `doubleActuations === 0` |
| `placement-filters.test.ts` (B) | cabeza en (0, 1,2, 0): mesa (−0,274, 0,74, −0,475) → `ok`; suelo y=0 → `floor`; pared n=(0,0,1) y n inclinada 30° → `tilted`; y=1,1 → `too-high`; y=0,40 → `too-low`; dist 0,2 → `too-near`, 1,0 → `too-far`; `floorKnown=false` se salta la regla de y | veredicto exacto en cada caso. `yawToHead` de la mesa da 30° ±0,01°. `fallbackPose(cabeza yaw 30°)` da (−0,225, 0,75, −0,390) y yaw 30°; con pinchY 0,85 → y=0,78; con pinchY 1,47 → y=0,75. Stability: 10 iguales → 10; jitter de 5 mm → sigue; salto de 2 cm → 1; null → 0. `settleEase`: 0→0, 0,5→0,875, 1→1, monótono |
| `placement-model.test.ts` (B) | hit-test `unavailable`; `available` sin impactos; impactos válidos; fallback seguido de impactos válidos; no visible; `forceCommit` | `fallback/'no-hit-test'` en el primer step. En t=5,9 s sigue `hit-test` y en t≥6,0 pasa a `fallback/'timeout'` una sola vez. Un select en el frame 9 no hace nada y en el 10 hace commit `'hit-test'` con la pose del hit y `yawToHead`. Vuelve a `hit-test/'surface-found'`. No visible: sin commit y sin avanzar el timer. `forceCommit` da `'debug'` y un segundo commit se ignora |
| `mesa-sem.test.ts` (B) | `installMesaSem` con un `window.IWER_DEVICE` falso que captura el constructor; rayo desde (0, 1,2, 0) con yaw 30° y pitch −40° | un único resultado en (−0,274, 0,74, −0,475) ±1 mm con rotación identidad; rayo hacia arriba → `[]`; fuera del rectángulo → suelo y=0; `kind:'empty'` → `[]` |
| `linear-handle.test.ts` (C) | 3 cm sobre el eje (travel 6 cm, p0 0,2); movimiento perpendicular; hacia atrás; `setFrame` | 0,7; p0; p0−x (sin clamp); `grabPoint = rest + axis·p·travel` y `hint = {axis, travel}` |
| `glsl-multiview.test.ts` (C) | carga dinámica de cada `src/render/glsl/*.ts` y de cada string exportado | sin declaraciones de los identificadores inyectados del §2. Regex adaptada de `refs/immersive-web-sdk/packages/core/tests/environment/gradient-environment.test.ts:35-53`, con cabecera MIT de Meta. Sin `#version`, `sampler2D`, `texture(`, `texture2D(` ni `gl_DrawID`. `*_VERT` contiene `gl_Position` y `*_FRAG` contiene `gl_FragColor`; `*_FRAG` no usa `modelViewMatrix`, `normalMatrix` ni `projectionMatrix` (en multiview solo existen en el vertex). Autoprueba: la regex detecta `uniform mat4 viewMatrix;`. Grep **sensible a mayúsculas, por identificador** sobre `src/**/*.ts`: sin `RawShaderMaterial`, `TextureLoader`, `DRACOLoader` ni `KTX2Loader` (el comentario "Draco/KTX2" de `boot/cdn-guard.ts` no debe disparar) |
| `events.test.ts`, `game-state.test.ts` (I) | emit anidado; capacidad del ring; stamps; tabla del §4.1 | orden FIFO; `log.length ≤ 256`; `t/frame` del reloj; `phase` solo cuando cambia; `session:end` desde `wind` → `boot` conservando `completed`; `isUnlocked` |

**U-pinch: inyector de ruido** (`tests/unit/helpers/noise.ts`):
- Generador puro con semilla (mulberry32): `noisyPull({ seed, jitterM, latencyS, sampleHz, frameHz })`.
- Produce frames de 72 Hz con:
  - las puntas de pulgar e índice con ruido gaussiano isótropo (RMS 3D = `jitterM`);
  - una línea de retardo de `latencyS`;
  - muestreo con retención (sample & hold) a `sampleHz`.
- Guion: abierta 0,5 s (6 cm) → cierra en 70 ms hasta 0,4 cm → mantiene 2 s moviendo la mano 6 cm → abre en 70 ms → abierta 0,5 s.

**Criterios con `jitterM=0,01`, 70 ms, 30 Hz y 500 semillas, sobre distance-pinch + FSM:**
- Sueltas falsas (antes de apertura + latencia + 3 muestras) en **menos del 2 %** de las pasadas.
- Agarres falsos con la mano abierta en **menos del 1 %**.
- Suelta real detectada en ≤0,184 s (70 ms + 3/30 s + 1/72 s) en ≥98 % de las pasadas.
- Determinista con la misma semilla.

**Retención:**
- Pérdida de 250 ms tirando → `holding` → `pulling`, sin suelta.
- Pérdida de 350 ms → `released('tracking-lost')` a los 0,30 s ±1/72 s.

### 8.2 Harness E2E (Playwright sobre `vite preview` en el puerto 47173, IWER 2.5.0 propio)

**`fixtures/iwer.ts` (I):**
- Opción `sem: 'none' | 'mesa' | 'empty'`, declarada como fixture `['none', { option: true }]`. En el spec: `test.use({ sem: 'mesa' })`.
- Orden de los init scripts:
  1. `{ path: iwer.min.js }`;
  2. dispositivo de M0 (`XRDevice(metaQuest3)`, `installRuntime({ forceInstall: true })`, `primaryInputMode = 'hand'`, `stereoEnabled = false`, `window.IWER_DEVICE`);
  3. si `sem ≠ 'none'`: `page.addInitScript(installMesaSem, { ...MESA_DEFAULT, kind: sem })`.
- El SEM tiene que estar instalado antes de `requestHitTestSource`: IWER lo comprueba en ese momento (`nm/iwer/lib/session/XRSession.js:646-662`).
- **`XRRay`:** el fixture **no** asigna `window.XRRay = IWER.XRRay`. IWER 2.5.0 no instala `XRRay` (`XRDevice.js:469-497`) y su `XRRay.matrix` rota la dirección hacia −Z, es decir, la **inversa** de la del spec (`nm/iwer/lib/hittest/XRRay.js:68-90`, eje `cross(dir, −Z)`): con ella el rayo de −25° saldría hacia arriba. El `XRRay` nativo de Chromium es correcto: comprobado el 31-oct en el Chromium de Playwright sobre `http://localhost`, un rayo de −25° da la columna −Z = (0, −0,423, −0,906). `open()` comprueba `typeof XRRay === 'function'` y falla con un mensaje claro si no existe.
- Helpers nuevos:
  - `state(): Promise<DebugSnapshot>`;
  - `waitFrames(n)`;
  - `events(type?)` y `clearEvents()`;
  - `shot(name)` guarda `<output>/<name>.png` y devuelve los píxeles; `pixels()` igual sin guardar (`fixtures/pixels.ts`: decodificador PNG mínimo, `countPixels`, `isWarmInk`, `isDarkInk`). Los specs comprueban lo que el emulador **dibujó**, no solo contadores de debug;
  - `setHeadPose({ position, yawDeg = 0, pitchDeg = 0 })`, que hace `IWER_DEVICE.position.set(…)` y `IWER_DEVICE.quaternion.set(x, y, z, w)` (`nm/iwer/lib/utils/Math.js:35,103`). Cuaternión yaw·pitch con c/s del ángulo mitad: **`(cy·sx, sy·cx, −sy·sx, cy·cx)`**. Pitch negativo = mirar hacia abajo.
- El default de IWER es la cabeza de pie en (0, 1,6, 0) (`nm/iwer/lib/device/XRDevice.js:43`). Todos los E2E de M1 fijan antes de `enterAR()` la pose **sentada** `(0, 1,20, 0)`.

**`fixtures/hands.ts` (A):**
```ts
setHand(page, h, pos: Vec3Tuple, quat: [number, number, number, number] = [0, 0, 0, 1]): Promise<void>; // hands[h].position/quaternion.set
pinch(page, h, v: 0 | 1, settleFrames = 2): Promise<void>;  // hands[h].updatePinchValue(v) + waitFrames (never setPinchValueImmediate)
calibratePinchOffset(page, h): Promise<Vec3Tuple>;  // pinch(1) away from every handle, offset = state().hands[h].pinchPoint − hand.position, pinch(0)
pinchAt(page, h, point: Vec3Tuple, offset: Vec3Tuple): Promise<void>;  // setHand(point − offset), waitFrames(2), pinch(1)
dragPinch(page, h, from: Vec3Tuple, to: Vec3Tuple, offset: Vec3Tuple, frames: number, target: ActuationTarget): Promise<number[]>;
//   ONE page.evaluate: for i in 1..frames { hand.position = lerp(from, to, i/frames) − offset; await __indoor.waitFrames(1);
//   push(__indoor.state().mechanisms[target].progress) }
```

**Sobre el pinch en IWER 2.5.0:**
- `updatePinchValue` deja un valor pendiente que se aplica al inicio del siguiente frame (`XRHandInput.js:124-133`, `XRTrackedInput.js:67-95`).
- El cambio 0→1 dispara `select` + `selectstart` y el regreso a 0 dispara `selectend`.
- La pose de las puntas se interpola según `pinchValue`. Con 1, el punto de pellizco queda unos 2,5 cm por debajo y 1,2 cm por delante del target-ray (`configs/hand/pinch.js:45-99`). Por eso se calibra el offset en tiempo de ejecución y no se hardcodea.
- Las manos por defecto están en (±0,25, 1,5, −0,4) (`XRTrackedInput.js:12-25`).
- `hands[h].connected = false` saca la fuente (`XRDevice.js:649-660`). Es para E2E-08 (M2).

**MesaSEM (B, `src/debug/mesa-sem.ts`):** implementa `SyntheticEnvironmentModule` (`nm/iwer/lib/device/XRDevice.d.ts:76-90`).
- **Cómo lo llama IWER:**
  - En cada frame de `immersive-ar`, si `hasHitTest`, y antes de actualizar las entradas y la vista (`XRSession.js:174-179`), IWER calcula `rayGlobalOffset = globalOffset(source.space) × offsetRay.matrix` y llama a `sem.computeHitTestResults(rayGlobalOffset)` (`:393-412`).
  - Cada `mat4` devuelto se envuelve como `new XRSpace(globalSpace, matrix)` y luego `XRHitTestResult`. Su `getPose(local-floor)` coincide con el global, porque local-floor = global space (`:528-533`).
- **Formato:**
  - `mat4` de gl-matrix = `Float32Array(16)` column-major. `XRSpace` lo clona con `mat4.clone` (`nm/iwer/lib/spaces/XRSpace.js:13-19`).
  - Origen del rayo = `m[12..14]`. Dirección = `−(m[8], m[9], m[10])`: el `XRRay.matrix` **nativo** (el que usa IWSDK, ver arriba) rota −Z hacia la dirección y traslada al origen. La sonda de B no pasa `offsetRay`, así que IWER usa su `new XRRay()` por defecto, cuya matriz es la identidad y no tiene el problema.
  - El resultado lleva rotación identidad, así que la normal es +Y: IWSDK usa el eje Y de la pose como normal (`environment-raycast.js:277-283`).
- **Restricciones de serialización** (Playwright serializa la función):
  - todo dentro de `installMesaSem`;
  - **sin class fields ni helpers externos** (el transform de Playwright podría inyectar `_defineProperty`): se usa una función constructora que devuelve un literal;
  - `environmentCanvas` se crea de forma perezosa en el getter, para que el test unitario no necesite `document`.

```ts
export interface MesaSemConfig {
  kind: 'mesa' | 'empty'; tableY: number;
  rect: { minX: number; maxX: number; minZ: number; maxZ: number }; floor: boolean;
}
export const MESA_DEFAULT: MesaSemConfig = {
  kind: 'mesa', tableY: 0.74, rect: { minX: -0.6, maxX: 0.6, minZ: -1.0, maxZ: -0.2 }, floor: true,
};

/** Self-contained: Playwright serialises it with addInitScript(installMesaSem, cfg). */
export function installMesaSem(cfg: MesaSemConfig): void {
  const w = window as unknown as { IWER_DEVICE?: { installSEM(ctor: unknown): void } };
  if (!w.IWER_DEVICE) { console.warn('[mesa-sem] IWER_DEVICE missing'); return; }
  const at = (x: number, y: number, z: number) =>
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  function MesaSEM() {
    let canvas: HTMLCanvasElement | null = null;
    const planes = new Set<unknown>();
    const meshes = new Set<unknown>();
    return {
      version: 'mesa-1', planesVisible: false, boundingBoxesVisible: false, meshesVisible: false,
      render() {}, loadEnvironment() {}, loadDefaultEnvironment() {}, deleteAll() {},
      get environmentCanvas() { return (canvas ??= document.createElement('canvas')); },
      get trackedPlanes() { return planes; },
      get trackedMeshes() { return meshes; },
      computeDepthBuffer() { return null; },
      computeHitTestResults(m: ArrayLike<number>): Float32Array[] {
        if (cfg.kind === 'empty') return [];
        const ox = m[12], oy = m[13], oz = m[14];
        const dx = -m[8], dy = -m[9], dz = -m[10];
        if (dy > -1e-6) return [];                       // only rays going down
        const t = (cfg.tableY - oy) / dy;                // table plane first (it occludes the floor)
        if (t > 0) {
          const x = ox + t * dx, z = oz + t * dz, r = cfg.rect;
          if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return [at(x, cfg.tableY, z)];
        }
        if (!cfg.floor) return [];
        const tf = -oy / dy;
        return tf > 0 ? [at(ox + tf * dx, 0, oz + tf * dz)] : [];
      },
    };
  }
  w.IWER_DEVICE.installSEM(MesaSEM);
}
```

**Comunes a todos los E2E:** `errors` (pageerror + console.error) `== []` y `crossOrigin == []`, igual que en M0. La URL es `/?debug=1&hands=show`.

### 8.3 E2E-03: colocar con MesaSEM (B, `placement.spec.ts`, `test.use({ sem: 'mesa' })`)

Pasos:
1. `open()`.
2. `setHeadPose({ position: [0, 1.2, 0], yawDeg: 180, pitchDeg: -45 })`: mirar al suelo detrás de la mesa.
3. `enterAR()`.
4. Esperar `placement.mode === 'hit-test'`.
5. Durante 20 frames: `placement.verdict === 'floor'` y `valid === false`.
   - Cuentas: rayo a −70°, distancia 3D 1,28 m (<1,5); impacto en el suelo en (0, 0, 0,437), fuera del rectángulo.
6. `pinch(right, 1)` y `pinch(right, 0)` → la fase sigue en `placing` y no hay `placement:commit`.
7. `setHeadPose({ position: [0, 1.2, 0], yawDeg: 30, pitchDeg: -15 })`. Con el retículo a 25° más, el rayo baja a −40° e impacta en **(−0,274, 0,74, −0,475)**.
8. `waitFrames(14)` → `verdict === 'ok'`, `stableFrames ≥ 10`, `valid === true`, `reticleVisible === true`.
9. `pinch(right, 1)` y `pinch(right, 0)`.

Aceptación:
- Los eventos, en orden, son `placement:commit{source:'hit-test'}`, `phase placing→settling`, `box:placed` y `phase settling→wind`.
- El tiempo entre commit y `box:placed` está en [0,45, 0,65] s.
- Cuando la fase es `wind`: `box.position[1] = 0,74 ±0,01`, `box.position[0,2]` a ≤1 cm de (−0,274, −0,475), `|box.yawDeg − 30| ≤ 5`, `box.scale = 1`, `reticleVisible === false`.
- Todo antes de que salte el fallback: no hay ningún `placement:mode{mode:'fallback'}`.
- Captura `e2e-03-placed`. En ella, la tinta oscura de la tapa (>300 px) está en la columna central (±8 % del ancho: la cabeza mira a la caja) y por debajo de la mitad (pitch −15°).

### 8.4 E2E-04: fallback (B, `placement.spec.ts`)

**04a, sin SEM** (`sem: 'none'`). IWER rechaza la petición con `OperationError` (`XRSession.js:654-655`).
1. `setHeadPose({ position: [0, 1.2, 0], pitchDeg: -15 })`.
2. `enterAR()`.

Aceptación:
- `placement:mode{mode:'fallback', reason:'no-hit-test'}` llega a ≤1,0 s de `session:start` (comparando `t`).
- Ningún `console.error`: con la sonda, IWSDK nunca ve un target.
- `placement.candidate` en (0, 0,75, −0,45) ±0,02, con yaw 0 ±5°.
- `pinch(right,1/0)`: la mano por defecto está a y≈1,475, fuera de la banda, así que se usa la altura por defecto. Después llegan `placement:commit{source:'fallback'}` y la fase `wind`, con `box.position` = candidato ±0,02.

**04b, SEM sin superficies** (`sem: 'empty'`). La sonda funciona y nunca hay impactos.

Aceptación:
- `placement.mode === 'hit-test'` a los 5,0 s.
- `placement:mode{fallback, reason:'timeout'}` con `t − t(session:start) ∈ [5,9, 6,6]` s.
- `reticleVisible === false` mientras `mode === 'hit-test'`; tras el fallback, `true` en el candidato (afordancia del §4.3).
- Luego pinch → commit `fallback`.

### 8.5 E2E-05: Viento con pinch de IWER (C, `wind.spec.ts`, `sem: 'none'`)

Pasos:
1. `setHeadPose({ position: [0, 1.2, 0], pitchDeg: -20 })`, `enterAR()` y esperar `phase === 'placing'`.
2. `__indoor.place({ x: 0, y: 0.74, z: -0.45, yawDeg: 0 })` y esperar `phase === 'wind'`. La colocación ya la cubren E2E-03 y E2E-04; aquí se aísla Viento.
3. **Calibrar:** `off = calibratePinchOffset(right)`. La mano está en el default (0,25, 1,5, −0,4), a unos 0,8 m de la pestaña.
   - Esperado: ningún `handle:grab` y la FSM sigue en `idle`.
4. **Primer tirón parcial:**
   1. `h = handles().wind`: `enabled`, `radius = 0,035`, `axis ≈ (0, 0, 1)`, `travel = 0,06`.
   2. `pinchAt(right, h.point, off)`. Esperado: `hands.right.fsm === 'armed'`, `owner === 'wind'` y evento `handle:grab{right, wind}`.
   3. `dragPinch(right, h.point, h.point + axis·0,033, off, 20, 'wind')`.
   4. Esperado: muestras **monótonas no decrecientes**; la última en [0,50, 0,60]; `notch` con índices [0, 1]; 2 × `wind:gust`; `probes.wind.leavesReleased === 20`.
   5. **Trinquete real (sin soltar):** `dragPinch` de vuelta −0,015 m en 8 frames, con el pinch aún sujeto y el target desbloqueado. Esperado: todas las muestras iguales a la última del paso 4.4, ningún `actuate:reject` y la FSM sigue en `pulling`.
5. **Soltar:**
   1. `pinch(right, 0)` → `handle:release{reason:'release'}` y FSM `idle` en ≤2 frames.
   2. `waitFrames(10)`: el progreso no cambia (trinquete).
6. **Segundo tirón:**
   1. Volver a leer `handles().wind.point`: se ha movido `axis·progress·travel`.
   2. `pinchAt`, luego `dragPinch` de +0,04 m en 25 frames.
   3. Esperado: muestras monótonas, se llega a 1; `notch` [2]; `mechanism:complete{wind}` **exactamente una vez**; 4 `wind:gust` en total; `phase wind→done`; `handle:release{reason:'cancel'}`.
7. **Bloqueado tras completar:** `dragPinch` de −0,03 m en 10 frames → todas las muestras valen 1 y no hay `handle:grab` nuevo (esto prueba el bloqueo de fase; el trinquete lo prueba el paso 4.5). Después `pinch(right, 0)`.
8. **Cierre:** `waitFrames(30)`.

Aceptación:
- `probes.wind.leavesReleased === 40`.
- `state().drawCalls ≤ 40`.
- `input.doubleActuations === 0` y ningún `actuate:reject`.
- `hands.left.owner === null` todo el tiempo.
- Capturas `e2e-05-mid`, `e2e-05-done` y `e2e-05-leaves` (mano fuera de la vista). Las hojas añaden ≥3000 px de tinta cálida respecto a la línea base tomada al entrar en `wind` (medido ≈7900), y la mancha se extiende más allá de la caja.
- La ruta es la real: `device 'hand'`, `selectPath 'gamepad'`, `probes.hands.vetoes === 0`, `input.rejected === 0`.
- `errors == []` y `crossOrigin == []`. `checkShaderErrors` está activo en debug: un error de compilación sale por `console.error` y hace fallar el test.

---

## 9. Huecos para M2/M3 (sin cambios de contrato)

| Pieza | Archivos | Dónde se engancha |
|---|---|---|
| Noche (manivela `atan2`, velo, luciérnagas, luna) | `mechanisms/night*.ts`, `render/veil.ts`, `state/moon.ts` | `mechanism:register{night}` (CHAPTER_ORDER la encadena sola tras wind), `HandleSpec.amountFor` con `atan2`, `anchors.night`, `probes.night` |
| Tormenta, cometa y amanecer | `mechanisms/storm*.ts`, `kite.ts` | `mechanism:register{kite}` (`kite` ya está en `CHAPTER_ORDER` y `mechanism:complete` acepta cualquier `ActuationTarget`), fases `kite`/`dawn` ya en `GamePhase`, `grabRadius` 0,08 |
| Final lean-back | `mechanisms/finale.ts` | `ActuationSource 'auto'`, fase `finale` |
| Accesibilidad | `input/access/{scanning,dwell,ray-mode,contrast}.ts` | `Settings` → `actuation.mode`; todos llaman a `actuate()`; `ArbiterSystem` activa el rayo; `doubleActuations` vigila |
| Pausa y robustez | `state/pause-system.ts` | evento `visibility`, `ctx.visible()`, `releaseReason 'tracking-lost'` |
| Persistencia | `state/save.ts` | `GameSnapshot.completed`, `actuation.reset()` |
| Governor | `perf/governor*.ts` | `Qualityable.setQuality` (WindView: `leaves.count`; materiales: `PAPER_OCTAVES`) |
| HUD | `debug/hud.ts` | `ctx.probes`, `bus.log`, `ctx.arbiter`, `HandSample.selectPath/tipDistance` |
| Mandos | ya en `HandsSystem` (`device 'controller'`) | E2E-14 |

---

## 10. APIs verificadas (rutas relativas a `nm/`)

| API | Evidencia | Nota |
|---|---|---|
| `RaycastSpace.Viewer`, `EnvironmentRaycastTarget` (`space`, `maxDistance`, `offsetQuaternion`, `xrHitTestResult`) | `@iwsdk/core/dist/environment-raycast/raycast-target.d.ts:12-113` | `offsetQuaternion` es un `Quaternion` de three; rota −Z |
| `EnvironmentRaycastSystem` (prio −1) | `environment-raycast.js:56` (requiere hit-test concedido), `:116-141` (si rechaza: `console.error` y reintento), `:175-178` (viewer), `:252-270` (`maxDistance` = distancia 3D), `:271-295` (`setFromUnitVectors`: pierde el yaw; `visible` sí/no), `:48-50, 296-325` (cleanup al quitar el componente) | de ahí la sonda y la sobrescritura del retículo |
| Prioridades | `@iwsdk/core/dist/init/world-initializer.js:454-463` (Input −4, CanvasPointer −3.5), `:526-528` (EnvRaycast −1), `:579-594` (bucle); `elics/lib/world.js:29,37-45` | por defecto 0; orden ascendente; `configData` antes de `init` |
| Base de `System` | `@iwsdk/core/dist/ecs/system.d.ts:30-47`, `ecs/system.js:37-63` | `xrFrame` = `renderer.xr.getFrame()` |
| `world.visibilityState`, `xrReferenceSpace`, `session`, `requestHitTestSource` | `ecs/world.d.ts:19-24, 80, 185`; `ecs/world.js:360-371` | la versión de World hace `warn` y devuelve `undefined`; la sonda usa la de session |
| `input.xr.gamepads[h]`, `visualAdapters` | `@iwsdk/xr-input/dist/xr-input-manager.d.ts:74-86`; `.js:141-180` (orden), `:20` (`MAX_HAND_SELECT_TRANSITIONS = 4`), `:284-306, 346-379` (gamepad o eventos, ≤1 flanco/frame), `:488-503` (gamepad solo si `inputSource.gamepad`) | IWSDK 1.0.1 no expone `getSelectState` ni `handSelectFrameState` (privados) |
| `getSelectStart/End/getSelecting` | `gamepad/stateful-button-axes-device.js:139-147` | `selectComponentId` del perfil (`generic-hand` → trigger: `generated-profiles.js:293-300`) |
| `jointTransforms`, `gripSpace`, `getPinchStrength`, `connected`, `isPrimary` | `visual/adapter/hand-visual-adapter.d.ts:13-14, 39`; `.js:86-101` (orden XRHand, grip), `:125` (`fillPoses` relativo al grip); `base-visual-adapter.d.ts:46-48, 78-79` | el modelo se coloca en el grip (lo usa `OccluderHand` de M0) |
| `multiPointers[h].toggleSubPointer('ray', on)` | `pointer/multi-pointer.d.ts:10, 138` | — |
| `AudioListener` en `player.head` y suspensión en `sessionend` | `@iwsdk/core/dist/audio/audio-system.js:58-74`; `AudioSource.src` en `audio/audio.d.ts:53` | el foley usa WebAudio directo |
| Interfaz SEM e `installSEM` | `iwer/lib/device/XRDevice.d.ts:73-90, 208`; `XRDevice.js:553-555`, `:220-224` (canvas del SEM) | — |
| Hit-test en IWER | `iwer/lib/session/XRSession.js:174-179, 393-412, 646-662`; `hittest/XRHitTest.js:10-23` (`cancel()` saca la source); `frameloop/XRFrame.js:57-60, 172-178` (`getHitTestResults` lanza si no hay resultados de ese frame) | local-floor = global (`XRSession.js:528-533`) |
| `XRRay` | `iwer/lib/device/XRDevice.js:469-497` (IWER **no** lo instala como global); `iwer/lib/hittest/XRRay.js:68-90` (matriz invertida); `@iwsdk/core/dist/environment-raycast/environment-raycast.js:142-157` (`new XRRay` global) | en E2E se usa el nativo de Chromium (comprobado); nunca `IWER.XRRay` |
| Manos de IWER | `iwer/lib/device/XRHandInput.js:31-35, 102-149`; `XRTrackedInput.js:12-25, 61-102`; `XRDevice.js:43, 649-660`; `utils/Math.js:35, 103`; `input/XRHand.js` (orden de joints: 11 = `middle-finger-phalanx-proximal`) | sí hay gamepad en las manos; `select` antes de `selectstart`; la pose "pinch" se aplica en el mismo frame que el flanco |
| SEM | `iwer/lib/device/XRDevice.d.ts:73-90`; `XRDevice.js:553-555` (`new semConstructor(device)`) y accesos `sem.render/environmentCanvas/trackedPlanes/trackedMeshes/computeDepthBuffer/computeHitTestResults` | MesaSEM implementa todos |
| Inyección GLSL y multiview | `three/src/renderers/webgl/WebGLProgram.js:662-693, 896-937` (en el fragment solo `viewMatrix` pasa a array; `cameraPosition` no); `WebGLPrograms.js:114, 205` (multiview forma parte de la clave del programa) | super-three 0.181.0 |
| Transform y visibilidad de entidades | `@iwsdk/core/dist/transform/transform.js` (`position/quaternion/scale` respaldados por el ECS), `visibility/visibility.js` (`object3D.visible` ↔ componente) | escribir `object3D.position/visible` sigue funcionando |

---

## 11. Riesgos y mitigaciones

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | No sabemos si Quest Browser expone gamepad en las manos (dudoso). IWER **siempre** lo expone, así que la ruta `events` no pasa por E2E | `select-queue` replica la lógica privada de IWSDK y tiene tests unitarios; el HUD y `state()` muestran `selectPath`; pregunta en el Monday Unblock |
| R2 | `EnvironmentRaycastSystem` registra un `console.error` por frame si la petición se rechaza. Si Quest acepta pero nunca devuelve impactos (sin Space Setup) | sonda antes de añadir el componente; fallback a los 6 s (E2E-04b) |
| R3 | `xrHitTestResult.getPose()` solo vale en su frame | PlacementSystem en −0,5 (después de −1) y `try/catch`, que lo trata como "sin impacto" |
| R4 | El signo de la normal de la palma (−Y de la muñeca) está sin verificar: un error vetaría todos los pinch | U-palm con la pose de E2E-05 (cos≈−1; con el signo invertido ≈+1 → veto); E2E-05 falla si se veta (la pose por defecto sola no lo detecta: cos≈±0,6 < 0,7); `?veto=0` como escape |
| R5 | IWER no emula multiview | U-glsl más `checkShaderErrors` en E2E; la prueba real es con un tester con Quest |
| R6 | Umbrales de la fuente B sin calibrar | B no controla nada por defecto (solo con `?pinch=distance`); se calibran con datos de testers |
| R7 | CI lento (SwiftShader) | timers con `time` real; clamp solo en la integración; criterios E2E con margen (04b: [5,9, 6,6] s) |
| R8 | Serialización de `installMesaSem` en Playwright | sin class fields ni helpers externos; E2E-03 lo detecta (pageerror) |
| R9 | IWER calcula el hit-test con la pose de cabeza del frame anterior (`XRSession.js:174-179`) | ventana de estabilidad de 10 frames; los E2E esperan ≥14 |
| R10 | Cambia la forma de `Flags`; se retira `placeholder-box` | I actualiza `boot.test.ts`; borrar `placeholder-box.ts` se avisa antes al usuario |
| R11 | Completar el capítulo con el pinch todavía sujeto | release `'cancel'` documentado en la FSM; E2E-05 lo verifica |
| R12 | Los draw calls se miden en mono (`stereoEnabled=false`) | límite por vista de ≤40; el presupuesto global (≤80) se revisa en M3 |
| R13 | `XRRay` de IWER 2.5.0 con la rotación invertida y sin instalar como global: si alguien lo "arregla" asignando `IWER.XRRay`, el retículo apunta 25° hacia arriba y E2E-03 falla sin error claro; si el navegador no tuviera `XRRay`, `EnvironmentRaycastSystem` haría `console.error` en cada frame | nunca se asigna; `open()` comprueba `typeof XRRay`; en Quest el `XRRay` es nativo |
| R14 | Con la sesión en `hidden`, Quest no llama al rAF: ningún sistema corre ni ve el cambio | `visibilitychange` de la sesión → bus (I); `ctx.visible()` lee la sesión; timers pausables con paso ≤0,25 s |
| R15 | La sonda de hit-test se resuelve después de un `place()` de debug o de `session:end` | B comprueba sesión y modo `probing` antes de añadir el target |

---

## 12. Orden de trabajo y definición de hecho

1. **I (unas 2 h)**: `types.ts` (hecho), `events.ts`, `game-state.ts`, `frame-system.ts`, los flags, `debug-api.ts`, `fixtures/iwer.ts` (helpers sin `sem`) y `main.ts` con stubs para los sistemas que falten y para la caja (§6). A partir de aquí los contratos quedan congelados.
2. **A, B y C en paralelo.**
   - A entrega primero `hands-state`, `select-source`, `hand-frame` y `hands-system`; luego `ratchet`, `actuation`, `handles`, `pinch-fsm`, `arbiter` y sus tests.
   - B entrega primero `mesa-sem.ts` + su test (I añade entonces la opción `sem` al fixture); luego los módulos puros y sus tests, el sistema, E2E-03 y E2E-04.
   - C: los módulos puros (`linear-handle`, GLSL y U-glsl); después `box-rig`, materiales, `wind` y E2E-05; el foley al final, si da tiempo.
3. **I integra:** cableado, `debug-api`, `erasableSyntaxOnly` en tsconfig y retirada del placeholder (con aviso al usuario).

**Hecho M1 =** `npm test` en verde:
- `typecheck`, `test:unit` (todos los U del §8.1) y `build` con `check-dist` (sin IWER en dist);
- `test:e2e` con E2E-01 a E2E-05;
- ≤40 draw calls en Viento, 0 peticiones cross-origin y 0 `console.error`.
