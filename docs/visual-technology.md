# Tecnología visual: bibliotecas y técnicas (investigación, sin instalar)

Este documento recoge lo investigado para el futuro desarrollo. **No se ha instalado ninguna dependencia** ni se ha implementado ningún componente. Los datos de mantenimiento se tomaron el 2026-11-07 de la API de npm y de GitHub.

Leyenda de mantenimiento: **último push** es la fecha del último cambio en el repositorio de GitHub.

## 1. Animación: Motion for React

| Opción | Licencia | Mantenimiento | Compatibilidad | Recomendación |
|---|---|---|---|---|
| [`motion`](https://www.npmjs.com/package/motion) (antes `framer-motion`) | MIT | Repositorio [motiondivision/motion](https://github.com/motiondivision/motion): ~35.000 estrellas, último push 2026-11-07. | Peer dependencies: React 18 o 19. | **Recomendada** como base de animación: transiciones de layout, gestos, springs elásticos y `prefers-reduced-motion`. |

Notas:
- Usar el paquete `motion` con el import `motion/react`. `framer-motion` es el mismo proyecto con el nombre antiguo.
- Para elásticos y transformaciones entre componentes, los springs de Motion son adecuados. Hay que medir su coste si se animan muchos elementos a la vez.
- La API de reduced motion debe verificarse en la versión que se instale.

## 2. Componentes de movimiento: Motion Primitives

| Opción | Licencia | Mantenimiento | Recomendación |
|---|---|---|---|
| [ibelick/motion-primitives](https://github.com/ibelick/motion-primitives) | MIT | ~6.900 estrellas, último push 2026-09-28. Publicado también como paquete npm `motion-primitives` 0.1.0, que es una herramienta de línea de comandos. | **Útil como referencia de patrones** (texto animado, transiciones de contenedor, botones con movimiento). Se recomienda copiar el código concreto que se necesite, revisado, en lugar de depender del paquete. |

Motion Primitives está construido sobre Motion, así que no introduce una segunda librería de animación.

## 3. Efectos de refracción Liquid Glass

Ninguna opción investigada es un estándar para este caso. Todas usan técnicas distintas y tienen límites distintos.

| Opción | Técnica | Licencia | Mantenimiento | Limitaciones según su documentación | Valoración |
|---|---|---|---|---|---|
| [liquid-glass-react](https://github.com/rdev/liquid-glass-react) (npm `liquid-glass-react` 1.1.1) | Filtros SVG de desplazamiento + `backdrop-filter`; aberración cromática configurable | MIT | ~6.600 estrellas, **último push 2025-06-13**. Más de un año sin cambios. | Peer dependency **React 19 o superior**. El README indica que Safari y Firefox soportan el efecto solo parcialmente: el desplazamiento no se ve. | La más conocida. Buena como referencia visual. El mantenimiento es el riesgo principal. |
| [@specy/liquid-glass-react](https://github.com/Specy/liquid-glass) (npm 1.0.2) | Three.js (WebGL) | MIT | Sin revisar en detalle en esta ronda. | Depende de Three.js; es una carga de renderizado 3D para un efecto de UI. | Demasiado costosa para una barra de navegación o paneles. Solo para piezas puntuales. |
| [@ogtirth/liquid-glass-oss](https://github.com/ogtirth/LiquidGlass-OSS) (npm 0.1.0) | WebGL, refracción física | MIT | Versión 0.1.0, sin revisar en detalle. | Versión muy temprana. | Interesante por la refracción real. Riesgo de estabilidad. |
| [liquid-glass2](https://github.com/yinhunfeixue/Liquid-Glass) (npm 0.1.1) | Filtros SVG | MIT | Sin revisar en detalle. | Versión temprana. | Alternativa ligera si se decide usar SVG. |
| [@duido/ui](https://duido-ui.vercel.app) (npm 0.7.0) | Kit de componentes "Liquid Glass" | MIT | Sin revisar en detalle. | Requiere `lucide-react` 1.x como peer. | Interesante como referencia de componentes completos, pero añade un sistema de diseño ajeno al nuestro. |
| CSS nativo: `backdrop-filter` + `box-shadow` + gradientes | CSS | No aplica | Estándar del navegador | WebView2 es Chromium, así que soporta `backdrop-filter`. El coste crece con cada capa. | **Recomendada como base**: es lo más estable y barato. Se combina con reflejos hechos en CSS. |

### Conclusión de esta sección

1. **Base**: CSS nativo (`backdrop-filter`, gradientes, bordes con brillo) más Motion para el movimiento. Es lo que más se acerca al estilo deseado con menos riesgo.
2. **Refracción**: tratarla como un efecto puntual para superficies clave (por ejemplo, el selector de agente), no como capa global. Probar primero `liquid-glass-react` como referencia, y evaluar si se copia el enfoque en lugar de depender del paquete, dado su mantenimiento.
3. **No se recomienda** Three.js para estos efectos de interfaz.

## 4. Compatibilidad con React y Windows

- **React**: Motion acepta React 18 y 19. `liquid-glass-react` exige React 19. Si se elige React 19, ambos son compatibles. No se ha probado la combinación.
- **Tauri y WebView2**: la aplicación se ejecuta sobre el runtime de WebView2 instalado en el equipo. Hay que probar cada efecto con el runtime real. Ningún dato de esta página sustituye esa prueba.
- **Posibles incompatibilidades**: los efectos que dependen de filtros SVG sobre fondo (`backdrop-filter` con `url()`) pueden no renderizarse igual que en Chrome. Está documentado por el README de `liquid-glass-react` para Safari y Firefox, no para WebView2 en concreto.

## 5. Calidad visual real

**No se ha comprobado visualmente ninguna de estas bibliotecas.** Esta investigación se basa en documentación, repositorios y metadatos de registro. La calidad visual solo se puede evaluar renderizando los efectos en WebView2 con el contenido real.

## 6. Pendiente antes de instalar

- Decidir si la refracción es un efecto clave o un extra.
- Crear una página de prueba aislada en WebView2 para comparar `liquid-glass-react` con una solución CSS.
- Medir coste de `backdrop-filter` con varias superficies activas.
- Confirmar licencias de las fuentes elegidas (ver `design-system.md` §4).
