# Sistema de diseño (criterios)

Este documento fija **decisiones y criterios de calidad**. No define valores finales (colores exactos, duraciones, radios). Esos valores se definirán en la fase de desarrollo, comprobándolos en WebView2 y en Windows real. Cualquier valor que aparezca aquí es un punto de partida, no una especificación.

Basado en la skill `design-system-patterns` (instalada en `.agents/skills/`), en `design-motion-principles` y en las decisiones de diseño del proyecto (ver [design-references.md](design-references.md)).

## 1. Decisiones ya establecidas

| Área | Decisión |
|---|---|
| Estética | Liquid Glass azul oscuro, premium y minimalista. |
| Acento | Azul claro / cian, usado con moderación. |
| Tipografía | Sans moderna de estilo Geist / SF Pro. Ver nota de licencia en §4. |
| Fondo | Ondas y volúmenes de cristal sutiles, sin texturas que compitan con el contenido. |
| Formas | Cápsulas redondeadas para controles; paneles más sobrios y con menos radio. |
| Luz | Reflejos luminosos puntuales y desenfoque moderado. |
| Movimiento | Elástico y líquido en transiciones entre componentes; respuesta inmediata en interacciones. |
| Jerarquía | Minimalista: un único elemento protagonista por vista. |
| Intensidad | Ajuste automático y manual de la intensidad visual (ver §7). |

## 2. Criterios de calidad

Cada criterio es comprobable. Si no se puede comprobar, no es un criterio.

### Color y contraste

- Texto normal: contraste de al menos 4.5:1 sobre su fondo real, incluido el cristal. Texto grande: al menos 3:1.
- Medir el contraste con el fondo más claro que pueda quedar detrás del panel (por ejemplo, una onda iluminada).
- El acento cian no se usa como único indicador de estado. Debe ir acompañado de forma, texto o icono.

### Cristal y transparencia

- Ningún texto de cuerpo debe quedar sobre un panel translúcido sin una capa de contraste propia.
- El desenfoque debe ser moderado: lo bastante para separar planos, no tanto como para convertir el fondo en un color plano.
- Los reflejos y brillos son puntuales (una fuente de luz por superficie). Si hay más de uno visible a la vez, se considera exceso.

### Movimiento

- Las transiciones de respuesta a una acción del usuario son inmediatas en percepción. No deben bloquear el uso.
- Las duraciones se miden en la fase de desarrollo. Criterio: un usuario que repite una acción muchas veces no debe percibir espera.
- Los rebotes elásticos son sutiles: no deben desplazar el contenido de forma que lo haga difícil de leer o de pulsar.
- Las transformaciones líquidas (cápsulas que se expanden o cambian de forma) deben conservar el destino: el usuario tiene que poder seguir visualmente de dónde viene y a dónde va el elemento.

### Rendimiento

- Animar solo `transform` y `opacity` siempre que sea posible.
- Limitar el número de superficies con `backdrop-filter` activas a la vez. El número máximo se medirá en WebView2 durante el desarrollo.
- Ninguna animación debe provocar trabajo de layout en cada fotograma (medir con las herramientas de rendimiento del navegador).
- El objetivo es un movimiento fluido en equipos Windows normales. La cifra concreta de fotogramas se definirá al medir.

### Accesibilidad

- `prefers-reduced-motion`: sustituir movimientos espaciales por cambios de opacidad o desaparecer. No se eliminan los cambios de estado, solo su trayectoria.
- Foco visible en todos los controles, con contraste suficiente.
- Ninguna información depende solo del color o del movimiento.

## 3. Tokens: estructura (no valores)

Siguiendo `design-system-patterns`, los tokens se organizan en tres niveles:

1. **Primitivos**: valores crudos (colores de la escala, tamaños, radios, duraciones, curvas). Sin significado de uso.
2. **Semánticos**: nombre por función (`text-primary`, `surface-glass`, `accent-interactive`, `motion-enter`). Cambian entre temas.
3. **De componente**: uso concreto (`pill-selector-bg`, `panel-sidebar-blur`). Solo se crean cuando un componente lo necesita.

Reglas:
- Los componentes solo consumen tokens semánticos o de componente, nunca primitivos.
- Un token no referencia a otro token de su mismo nivel (evitar ciclos).
- Los tokens de movimiento se definen una vez y se reutilizan; no se escriben duraciones sueltas en los componentes.

## 3 bis. Materiales Liquid Glass 2.0 (implementados, 0.4.0)

Implementación: `src/styles/tokens.css` (tokens `--mat-*`, `--control-shadow*`, `--glass-fresnel`, `--rim-light`), `src/styles/materials.css` (materiales) y `src/styles/experience.css` (aplicación a cada pieza). Una sola fuente de luz, arriba a la izquierda, y una luz ambiental por superficie.

Tres niveles:

| Nivel | Clases | Dónde | Rasgos |
|---|---|---|---|
| A. Premium | `.mat-primary`, `.mat-float`, variante `.mat-optical` | Barra lateral, compositor, panel contextual, Ajustes, menús, popovers, tooltips, diálogos, avisos | Desenfoque en `::before` con arco especular, veta, cáustica ambiental y relleno de contraste; anillo especular en `::after`; Fresnel interior. `.mat-float` mantiene la capa de contraste densa (AUD-003). `.mat-optical` añade el canto óptico. |
| B. Interactivo | `.mat-control`, `.btn`, cápsulas y pastillas | Botones, selectores, cápsulas, pestañas, interruptores, segmentados | Cúpula de luz arriba, cáustica del entorno abajo, canto superior nítido; hover con más luz y presión que invierte la luz (`--control-shadow-press`). |
| C. Lectura | `.mat-secondary`, `.mat-reading`, tarjetas, bloques de código | Burbujas, tarjetas, código, diffs, terminal, formularios | Sin desenfoque propio. Relleno estable y canto discreto; en el panel, una placa de lectura bajo código y diffs. |

### Óptica compartida (`src/lib/optics.ts`)

- **Canto óptico.** Las superficies con `.mat-optical` se registran como lentes (`useOpticalSurface`). El shader de la aurora lee sus rectángulos al dibujar y curva el fondo en una banda de 30 px junto al borde (perfil de bisel circular) con una cáustica ligera. Un hijo `.glass-edge` con desenfoque de 1,5 px deja verlo, y la placa esmerilada (`::before`) se desvanece en `--edge-band`. No hay filtros SVG añadidos: la distorsión la hace el shader que ya se dibuja. Máximo cuatro lentes. No se usa en contenedores que se desplazan (la columna de Ajustes).
- **Luz ambiental.** Cada elemento `[data-env]` recibe `--env` (tono RGB) y `--env-a` (fuerza 0–1). La aurora lee 2–3 píxeles junto a cada uno tras dibujar, unas tres veces por segundo en movimiento o cada 2 s con el fondo estático, con suavizado exponencial. Los tokens compuestos que dependen de `--env` se redeclaran en `[data-env]` porque una variable compuesta se resuelve donde se declara.
- **Sin aurora** (desactivada o sin WebGL) quedan los valores por defecto de `--env`; el cristal se ve igual de coherente, sin variación.

Decisiones técnicas:
- El desenfoque del material primario vive en `::before`: un elemento con `backdrop-filter` sería *backdrop root* y sus capas hermanas (lente Vaso, canto óptico) no verían el fondo real.
- El selector de modelos conserva el comportamiento estable de 0.3.1 (sin morphing del menú); 0.4.0 solo cambia sus materiales.
- Las superficies de cristal no animan `opacity` al entrar: el cajón y el panel superpuesto se desplazan con `transform`; el panel en línea crece en anchura desde su borde.
- *Reducida* usa rellenos opacos, sin canto óptico ni lente. *Equilibrada* activa lente y canto óptico (fuerza 0,75). *Completa* usa fuerza 1. `prefers-reduced-transparency` y el ajuste *Refracción del cristal* los desactivan.

### Movimiento (`src/lib/motion.ts`)

- `SPRING.pill`: pastillas de selección (agente, conversación, Ajustes, pestañas, segmentados). Un rebote corto y amortiguado.
- `SPRING.surface`: barra lateral y panel. Sin rebote.
- `SPRING.enter`: avisos, diálogos y tarjetas. Rebote mínimo.
- `SPRING.quick`: tooltips.
- Ninguna transición escala texto: las entradas usan opacidad y desplazamiento. Todas son interrumpibles.

## 4. Tipografía

- Criterio: sans moderna, legible a tamaños pequeños, con pesos suficientes para jerarquía (regular, medio y semibold).
- Geist y SF Pro son referencias de estilo, no necesariamente la fuente final. **SF Pro es propiedad de Apple** y no se puede empaquetar libremente en una aplicación. Geist debe verificarse su licencia antes de incluirla.
- Como alternativa de sistema, usar la pila de fuentes de Windows (por ejemplo, Segoe UI Variable). Comprobarlo en WebView2.
- Tamaños y espaciado se definen como escala de tokens, no con valores sueltos.

## 5. Fondos y volúmenes

- Las ondas y volúmenes de cristal son decorativos y de baja intensidad. Nunca compiten con el contenido ni reducen el contraste.
- Deben poder desactivarse por completo (ver §7) sin afectar a la estructura.
- Se evalúan por rendimiento: un fondo que obliga a repintar en cada fotograma se considera caro.

## 6. Guía para evitar

### Efectos genéricos y repetitivos
- Glassmorphism aplicado a todo sin jerarquía.
- El mismo efecto de brillo o rebote en todos los componentes.
- Gradientes arcoíris o neones que contradicen el azul oscuro.

### Animaciones lentas
- Transiciones que superan lo necesario para entender el cambio.
- Esperas antes de que aparezca la respuesta de un control.
- Animaciones de entrada en listas que retrasan la lectura de contenido ya disponible.

### Exceso de brillos
- Más de un reflejo visible en la misma superficie.
- Brillos que se mueven continuamente sin función.

### Transparencias que dificultan la lectura
- Texto sobre cristal sin capa de contraste.
- Paneles tan translúcidos que el contenido de detrás compite con el texto.

### Inconsistencia visual
- Radios, sombras o duraciones distintas entre componentes equivalentes.
- Un mismo control con dos estilos de hover.

### Coste de rendimiento
- Varios `backdrop-filter` grandes superpuestos.
- Animar propiedades de layout (`width`, `height`, `top`, `left`) en lugar de `transform`.
- Efectos SVG complejos (filtros de desplazamiento) en cada fotograma.

## 7. Intensidad visual: automática y manual

Tres niveles: **reducida**, **equilibrada** (por defecto), **completa**.

Ajuste automático:
- Si el sistema tiene activado `prefers-reduced-motion`, se usa como mínimo el nivel **reducida**.
- Si el rendimiento medido en la aplicación cae por debajo de un umbral sostenido, se reduce un nivel. El umbral se definirá al medir.

Ajuste manual:
- El usuario puede elegir el nivel en ajustes. La elección manual prevalece sobre la automática, salvo `prefers-reduced-motion`, que siempre se respeta.

Cada nivel debe ser una combinación de tokens, no una lista de condiciones dispersas en los componentes.

## 8. Limitaciones de WebView2

- La aplicación se ejecutará en WebView2, que usa el motor de Chromium. Eso no garantiza que cada versión del runtime instalado tenga las mismas capacidades que una versión reciente de Chrome. Hay que comprobar en equipos con versiones distintas del runtime.
- Los efectos que dependen de filtros SVG sobre el contenido de fondo (`backdrop-filter` con `url()`) deben probarse específicamente. No hay garantía de que se vean igual en todos los motores ni versiones.
- Si una capacidad falla, debe existir un fallback sin efecto que mantenga la legibilidad.

## 9. Lista de comprobación antes de dar algo por terminado

- [ ] Contraste de texto medido sobre el fondo real.
- [ ] Funciona con `prefers-reduced-motion` activo.
- [ ] Foco visible en teclado.
- [ ] Ninguna animación anima propiedades de layout.
- [ ] Probado en WebView2 con el runtime instalado en el equipo.
- [ ] Probado en los tres niveles de intensidad.
- [ ] Ningún componente usa un valor fuera de los tokens.

El estado de estos criterios en cada iteración se registra en `docs/qa/` (última: `docs/qa/terra-fixes-liquid-glass.md`).
