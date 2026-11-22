# Rendimiento — Duovra 0.5.0 (Performance Update)

Registro histórico de 0.5.0. La arquitectura visual vigente se documenta en [Duovra](design-system.md).

La 0.5.0 conserva todas las funciones, la disposición y la estética aprobada de la 0.4.0. Solo cambia el coste del streaming, del fondo y del material de cristal.

Combina dos implementaciones candidatas que se evaluaron por separado:

- **Base:** la que aísla el streaming y difiere las lecturas de luz.
- **Añadidos de la otra:** sus optimizaciones compatibles, la principal el ahorro de GPU del fondo.

## Cambios

### Streaming

- Solo la respuesta activa se suscribe al contenido de su ejecución.
- El historial es una lista memoizada.
- El compositor, la barra lateral y las filas de conversación seleccionan solo los valores primitivos que muestran, en lugar del objeto completo de la ejecución.

### Resaltado de código

- Una caché LRU acotada reutiliza el HTML de highlight.js al volver a montar un bloque.
- Límites: 256 entradas y 1.000.000 de caracteres retenidos.
- El resultado no cambia, y el límite de 200.000 caracteres por bloque se mantiene.

### Borradores

- Se guardan en memoria (`draftOf`) y se persisten a los 350 ms.
- El estado global solo se actualiza cuando el borrador pasa de vacío a no vacío o al revés, así que escribir no vuelve a renderizar la aplicación.

### Comandos Tauri

Son asíncronos y ya no bloquean el hilo principal. Los afectados son `bootstrap`, `list_messages`, `set_draft`, `set_conversation_prefs`, `usage_summary`, `read_file` e `inspect_attachments`.

### Luz ambiental

- Se lee con lectura diferida: PBO + `fenceSync` en WebGL 2, sin esperas activas.
- `optics.ts` solo escribe `--env` y `--env-a` cuando cambian.

### Aurora: pase por columnas

- De las 46 llamadas a `noise()` por píxel, 26 dependen solo de *x* y del tiempo.
- Esas se calculan una vez por columna en una textura flotante W × 3:
  - WebGL 2: RGBA32F con `EXT_color_buffer_float`;
  - WebGL 1: `OES_texture_float` con `WEBGL_color_buffer_float`.
- La salida es idéntica a la del cálculo por píxel.
- Sin texturas flotantes renderizables, la aurora usa el cálculo por píxel.

### Restauración del contexto WebGL

- Antes, tras un reinicio de la GPU o del controlador, el fondo quedaba negro.
- Ahora la aurora:
  1. descarta los recursos al perder el contexto;
  2. al restaurarse, recrea el programa, los buffers, la textura y el FBO de columnas;
  3. reaplica la paleta y las lentes;
  4. continúa la animación.

## Fondo y material desacoplados

`src/lib/background.ts` define el contrato entre el renderizador de fondo y el material Liquid Glass:

- `LensSource`: rectángulos y radios de las superficies de cristal que el fondo debe curvar, con suscripción a cambios.
- `LightSampler`: muestreo de la luz final en puntos dados, para teñir el cristal.
- `BackgroundRenderer`: `LightSampler` más `setFps`, `setLens`, `setPointer` y `destroy`.

`aurora.ts` no importa nada del sistema de materiales y recibe las lentes por parámetro.

`optics.ts` aporta dos piezas:

- `lensSource`;
- el hook `useAmbientLight(sampler, animated, key)`.

`Background.tsx` es el único punto que conecta un renderizador con el material. Cualquier fondo futuro solo tendrá que implementar `BackgroundRenderer`; Aurora 2.0 se mantiene sin cambios visuales.

## Verificación

**Pruebas automáticas.** `npm run typecheck` y `npm test` (vitest). Incluyen:

- restauración del contexto;
- pase por columnas y su liberación;
- fallback sin texturas flotantes;
- presupuesto de la caché LRU;
- lectura con fence sin espera activa.

**Equivalencia de píxeles.** `node scripts/perf/aurora-equivalence.mjs`:

- Compila `aurora.ts` y lo ejecuta en Microsoft Edge (mismo motor que WebView2).
- Compara el pase por columnas con el cálculo por píxel en WebGL 2 y WebGL 1, con y sin lente.
- Prueba una pérdida y restauración real del contexto con `WEBGL_lose_context`.
- Resultado en Intel UHD Graphics 620 (ANGLE D3D11, 680 × 390): **0 bytes distintos** en los cuatro casos, y la aurora vuelve a dibujar y a animarse tras restaurar.

**QA en WebView2.** Build release con un identificador aislado y datos de prueba ficticios:

- intensidad Completa y Equilibrada;
- menús y Ajustes;
- 200 mensajes y búsqueda de un mensaje antiguo;
- borradores, incluida la persistencia tras recargar;
- recuperación del contexto WebGL.

Las capturas difieren de las de la 0.4.0 en un error absoluto medio de 0,002 a 0,13 sobre 255 por vista, sin cambios de geometría. La única diferencia esperada es la vista posterior a restaurar el contexto: la 0.4.0 muestra un fondo negro y la 0.5.0 la aurora.

## Mediciones

**Método.**

- Builds release reales de WebView2 en un solo equipo (Intel UHD Graphics 620), con agentes simulados: no se invoca a ningún proveedor.
- Cuatro versiones: 0.4.0, las dos candidatas y la combinada.
- 6 bloques pareados con orden alterno, 24 ejecuciones válidas y un arranque de calentamiento por versión, excluido de las medianas.
- Las diferencias son medianas de diferencias pareadas con intervalo bootstrap del 95 %.
- Datos de prueba ficticios, iguales en todas las ejecuciones.

| Métrica (mediana) | 0.4.0 | 0.5.0 | 0.5.0 − 0.4.0 [IC 95 %] |
|---|---:|---:|---|
| Streaming Completa: FPS | 51,35 | 56,05 | +4,55 [3,75; 5,45] |
| Streaming Completa: frame p99 (ms) | 53,25 | 18,85 | −33,95 [−34,85; −18,05] |
| Streaming Completa: frames > 50 ms | 8,5 | 0 | −8,5 [−11,5; −5,5] |
| Streaming Completa: retraso de emisión p95 (ms) | 30,6 | 6,15 | −23,8 [−35,7; −23,3] |
| Streaming Completa: tareas del renderer (ms) | 5682 | 3908 | −1663 [−1955; −1068] |
| Streaming Equilibrada: frame p99 (ms) | 35,3 | 18,8 | −16,65 [−17,2; −15,95] |
| Streaming Equilibrada: GPU 3D (%) | 66,0 | 56,7 | −8,33 [−9,76; −6,02] |
| Reposo Completa: GPU 3D (%) | 55,8 | 44,6 | −11,99 [−12,29; −9,84] |
| Reposo Completa: tareas del renderer (ms) | 695 | 280 | −415 [−442; −403] |
| Reposo Equilibrada: GPU 3D (%) | 38,0 | 28,7 | −8,68 [−10,75; −7,46] |
| Scroll: GPU 3D (%) | 66,5 | 57,2 | −9,4 [−10,52; −7,99] |
| Interacción: Long Animation Frames | 54,5 | 34,5 | −23,5 [−28,5; −14,5] |
| Interacción: frame p99 (ms) | 88,65 | 70,75 | −17,9 [−53,1; −17,6] |
| Apertura de una conversación larga (ms) | 627,7 | 575,3 | −49,65 [−68,05; −28,35] |

**Sin cambios concluyentes:**

- FPS en reposo y en scroll (unos 56);
- memoria y nodos DOM;
- arranque en caliente.

**Peor que en la 0.4.0:** solo la CPU durante la interacción, en +0,62 puntos [0,11; 1,97].

Frente a la candidata de streaming, la versión combinada no empeora en ninguna de las 64 métricas medidas. Frente a la candidata de GPU, conserva su ahorro y emite el streaming antes: retraso p95 en Completa −14,1 ms.

**Excluido a propósito:** el montaje progresivo de mensajes de una de las candidatas. Abría antes las conversaciones largas, pero tenía una regresión de anclaje del scroll y de búsqueda.

**Limitaciones:**

- Un único equipo y n = 6 por versión.
- Las métricas con mucha dispersión (arranque, memoria) tienen intervalos que incluyen 0.
- El streaming es simulado.
- Las pruebas con proveedores reales siguen la [política de modelos para pruebas](qa/test-model-policy.md).

## 0.5.1 (Dot Matrix Flow y Liquid Glass óptico): mediciones preliminares

Cifras tomadas durante el desarrollo de 0.5.1 en un único equipo (i7-8550U con UHD 620, WebView2 157, ventana de 1360 × 779) con agentes simulados. **No son mediciones definitivas.**

Limitaciones:

- Mediana de solo n = 2 pasadas en caliente por versión, no las 6 del protocolo de 0.5.0.
- En esa sesión, 0.5.0 midió peor que en su propia evaluación del 15/11, aunque sus dos pasadas (antes y después de medir 0.5.1) coinciden entre sí. Las diferencias absolutas pueden estar infladas.
- La segunda tanda del arnés de fondos es ruidosa: probablemente la ventana quedó tapada (con la ventana oculta, `requestAnimationFrame` baja a 1 fps).
- La escena «menú abierto con ondas» no es válida (el clic sintético cierra el menú) y no se incluye.

Protocolo de 0.5.0 con Aurora en intensidad *Completa*:

| Métrica | 0.5.0 (1.ª / 2.ª pasada) | 0.5.1 |
|---|---|---|
| Reposo · FPS | 47,7 / 42,7 | 59,9 |
| Reposo *Equilibrada* · GPU % | 21,8 / 22,7 | 12,6 |
| Streaming · FPS | 28,6 / 28,0 | 57,5 |
| Streaming · GPU % / CPU % | 40,3 / 42,6 · 29,0 / 31,4 | 28,9 · 21,4 |
| Interacción · INP p75 ms | 316 / 152 | 64 |
| Arranque → contenido · ms | 3380 / 3498 | 3605 |
| RAM final · MB | 411 / 387 | 389 |

Fondo nuevo (arnés complementario, primera tanda):

| Escena | Dot Matrix Flow | Aurora 0.5.1 |
|---|---|---|
| Reposo tras las ondas · GPU % | 0 (no dibuja) | 17,4 |
| Ondas continuas · FPS / GPU % | 57,7 / 34,3 | 59,9 / 18,5 |
| Streaming con ondas · FPS / GPU % | 54,9 / 37,6 | 46,8 / 26,7 |

Lo que sí es estructural y no depende de la medición: en reposo, Dot Matrix Flow detiene su bucle y no dibuja ningún fotograma. Una prueba A/B en Edge (modo desarrollo) atribuye al filtro SVG de los menús un coste de unos 3–8 fps con ondas detrás, solo mientras el menú está abierto.
