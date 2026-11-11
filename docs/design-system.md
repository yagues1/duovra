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

## 3 bis. Materiales Liquid Glass (implementados)

Implementación: `src/styles/tokens.css` (tokens `--mat-*`) y `src/styles/materials.css`. Una sola fuente de luz, arriba a la izquierda, en todo el sistema.

| Material | Clase | Dónde | Rasgos |
|---|---|---|---|
| Primario | `.mat-primary` | Barra lateral, compositor, panel derecho, contenedores de Ajustes y Proyectos | Desenfoque de fondo en `::before`, borde especular de 1 px con degradado (`::after`), reflejo superior y sombra de separación. El compositor usa una lente Vaso en el canto en intensidad Completa. |
| Flotante | `.mat-float` | Menús, tooltips, diálogos, avisos | Capa de contraste densa (`--mat-float-fill` ≈ 0,88) + desenfoque: el texto subyacente no compite con las opciones (AUD-003). |
| Secundario | `.mat-secondary` y tarjetas | Burbujas, tarjetas, bloques de herramientas, ajustes | Sin desenfoque propio (barato); relleno degradado y borde fino. |
| Interactivo | `.mat-control`, `.btn` | Botones, selectores, cápsulas | Responde con luz (relleno y borde) y presión (`scale`). |
| Lectura | `.mat-reading` | Código, diffs, terminal | Relleno casi opaco y texto de alto contraste. |

Decisiones técnicas:
- El desenfoque del material primario vive en `::before`. La lente del compositor es una capa hermana de 9 px con máscara, fuera del árbol accesible y del hit testing. El relleno del centro mantiene el contraste del borrador.
- El selector de modelos comparte la geometría de su capa decorativa con el menú portado. Los controles y las etiquetas conservan su tamaño.
- Las superficies de cristal no animan `opacity` al entrar (lo que anula el desenfoque durante la transición): el cajón y el panel superpuesto se desplazan con `transform`; el panel en línea crece en anchura desde su borde.
- En *Reducida* se emplean rellenos opacos. En *Equilibrada* el desenfoque primario es de 26 px. En *Completa* es de 32 px y se activa la lente del compositor. `prefers-reduced-transparency` oculta la lente y aplica los rellenos opacos.

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
