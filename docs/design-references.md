# Referencias de diseño

## Dirección establecida

Decisiones tomadas por el usuario (no se deben cambiar sin pedirlo):

- **Estilo**: Liquid Glass azul oscuro, premium y minimalista.
- **Movimiento**: microanimaciones fluidas y elásticas, con efectos de refracción.
- **Estructura**: chat principal, proyectos, barra lateral flotante y paneles contextuales.
- **Adaptabilidad**: diseño responsive y alto rendimiento.
- **Plataforma**: aplicación local para Windows.

Los criterios que traducen esta dirección en decisiones comprobables están en [design-system.md](design-system.md). La tecnología investigada está en [visual-technology.md](visual-technology.md).

## Criterios de calidad (resumen)

- Evitar componentes genéricos o plantillas por defecto que contradigan el estilo.
- Respetar `prefers-reduced-motion` y mantener el foco visible.
- Priorizar el rendimiento: animar `transform` y `opacity`; limitar el uso de `backdrop-filter` a superficies necesarias.

Las reglas de accesibilidad y revisión de interfaz están en la skill `web-design-guidelines`.

## Referencias visuales aprobadas

**Pendiente.** Las capturas del diseño aprobado no están en el repositorio (`assets/references/` sigue vacía a 2026-11-07). La interfaz se ha construido a partir de la especificación escrita y de [design-system.md](design-system.md); no se ha comparado con las capturas porque no se han visto.

Vistas implementadas, según el brief de desarrollo: 1) chat principal, 2) chat con panel derecho, 3) gestión de proyectos y conversaciones, 4) ajustes y consumo, 5) estados y elementos interactivos (trabajo en curso, aprobaciones, errores, menús, diálogos). Cuando se aporten las capturas, basta con ajustar tokens (`src/styles/tokens.css`) y estilos de componentes (`src/styles/components.css`): la estructura no depende de ellas.

No se han creado imágenes de referencia.

## Iconos conceptuales

- Identidad de Duovra: [assets/brand](../assets/brand) (generada con `scripts/brand.mjs`).
- El icono definitivo **no está elegido**.

## Skills relacionadas

Del proyecto (`.agents/skills/`):
- `frontend-design`: dirección estética y evitar diseños por defecto.
- `web-design-guidelines`: revisión de accesibilidad y responsive.
- `react-best-practices`: rendimiento en React.
- `interaction-design`: microinteracciones, transiciones y estados.
- `design-system-patterns`: tokens y arquitectura de componentes.
- `design-motion-principles`: movimiento con intención y auditoría de animaciones genéricas.
- `ui-ux-pro-max`: búsqueda de estilos, tipografía, paletas y reglas UX (requiere Python; sin ejecutar todavía).

Globales de la sesión: `apple-design`, `emil-design-eng`, `impeccable`.
