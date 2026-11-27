# Compatibilidad con Claude Code y Codex

Este documento separa lo que está **verificado en la documentación oficial** de lo que sigue **pendiente de prueba en ejecución**.

## Agent Experience · 1.0.11

Versiones detectadas el 27/11/2026 mediante `--version`: **Claude Code 2.1.325** y **Codex CLI 0.172.0**. La detección no consume modelos. Las capacidades se consultan en cada instalación/cuenta; no se presupone que todos los modelos o configuraciones ofrezcan lo mismo.

| Capacidad | Alcance y límites |
| --- | --- |
| Contexto, memoria y compactación | Contexto y memoria local por conversación; compactación por los mecanismos nativos comprobados en fases anteriores. Requiere sesión y consentimiento; puede consumir cuota. Ocupación solo cuando la CLI la comunica. |
| Bifurcaciones e importación | Bifurcación nativa con ancla y cuenta compatibles; reconstrucción de contexto cuando no se puede bifurcar. Claude requiere el mismo directorio para la bifurcación nativa; Codex admite otro `cwd`. No restaura archivos. |
| Planes y preguntas | Codex necesita `experimentalApi` para el modo plan y preguntas; el sandbox y las aprobaciones siguen vigentes. Claude puede sustituir el modelo en ciertas configuraciones de planificación; se muestra el modelo comunicado. Planificar en Claude no es un sandbox estricto. |
| Steering y cola | Codex admite `turn/steer` en turnos compatibles; Claude no ofrece steering real en stream-json. Cola e interrupción/continuación disponibles según el estado de ejecución. |
| Comandos y revisión | Operaciones nativas mapeadas explícitamente; los comandos Claude no verificados se identifican como tales. No se ejecutan automáticamente por elegirlos. |
| Objetivos | Recuerdos persistentes de la conversación, sin iniciar trabajo autónomo. |
| Tareas y subagentes | Solo se muestran eventos comunicados. El progreso de Codex se ha verificado mediante fixtures; disponibilidad variable de herramientas de tareas y subagentes. No hay cancelación individual fiable de subagentes. |

Detalles y evidencias anteriores: [capabilities](agent-capabilities.md), [contexto](context-engine.md), [sesiones](session-manager.md), [planificación](planning.md), [compositor](control-center.md) y [Activity Center](activity-instructions.md). La validación de integración local de fase 7 no sustituye una nueva prueba contra modelos reales.

## Instrucciones de proyecto

| Elemento | Claude Code | Codex | Cómo lo resolvemos |
|---|---|---|---|
| Archivo principal | `CLAUDE.md` (`./CLAUDE.md` o `./.claude/CLAUDE.md`) | `AGENTS.md` | Reglas compartidas en `AGENTS.md`. `CLAUDE.md` lo importa con `@AGENTS.md`, sin duplicar texto. |
| Importaciones | Sintaxis `@ruta` dentro de `CLAUDE.md`, hasta 4 niveles | No aplica | Solo usamos `@AGENTS.md`. |
| Lectura directa de AGENTS.md | Sí, pero solo si no hay `CLAUDE.md` en el directorio de trabajo o superiores (requiere Claude Code v2.1.277+) | Sí, es su archivo nativo | No dependemos de ese caso: `CLAUDE.md` existe y lo importa. |
| Límite de tamaño | Se recomienda < 200 líneas por archivo | 32 KiB combinados (`project_doc_max_bytes`) | `AGENTS.md` es corto. |

Fuentes: [documentación de memoria de Claude Code](https://code.claude.com/docs/en/memory) y [AGENTS.md de Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Skills

| Elemento | Claude Code | Codex |
|---|---|---|
| Ruta de proyecto | `.claude/skills/<nombre>/SKILL.md` | `.agents/skills/<nombre>/SKILL.md`, buscando desde el directorio actual hasta la raíz del repositorio |
| Ruta personal | `~/.claude/skills/` | `~/.agents/skills/` |
| Campos obligatorios | Ninguno; se recomienda `description` | `name` y `description` |
| Formato | Carpeta con `SKILL.md` y frontmatter YAML | Carpeta con `SKILL.md` y frontmatter YAML |

Fuentes: [skills de Claude Code](https://code.claude.com/docs/en/skills) y [skills de Codex](https://learn.chatgpt.com/docs/build-skills).

### Organización elegida

- **Copia única**: `.agents/skills/` es la fuente. Codex la lee tal cual.
- **Claude Code**: la documentación consultada **no menciona `.agents/skills`**, así que no lo damos por supuesto. Creamos una junction `.claude/skills` → `.agents/skills` con `scripts/link-skills.ps1`. Una junction no es una copia: los cambios se ven en ambos lados.
- La junction está en `.gitignore`. Cada clon debe ejecutar el script una vez.

### Diferencias que hay que conocer

- Claude Code admite campos de frontmatter propios (por ejemplo `allowed-tools`, que usa `playwright-cli`). Codex puede ignorarlos. No son obligatorios para que la skill funcione.
- Un skill con el mismo `name` en niveles distintos de Codex no se combina: aparece duplicado en los selectores. Por eso no hay skills repetidas en `.agents/skills`.

## Estado de la verificación

| Comprobación | Estado |
|---|---|
| Rutas de skills y formato, según documentación oficial | Verificado (documentación consultada) |
| Junction `.claude/skills` resuelve los archivos | Verificado en el sistema de archivos |
| Claude Code descubre y carga skills del proyecto | **Verificado en sesión (2026-11-07)**: la herramienta Skill cargó `design-system-patterns` desde `.claude\skills\` (junction). |
| Claude Code en modo no interactivo (`claude -p`) | **No ejecutable**: la CLI devolvió «OAuth session expired». No se ha podido repetir la prueba de forma aislada. |
| Codex descubre las skills del proyecto | **Verificado (2026-11-07)**: `codex exec` en el proyecto listó las 8 skills y no dio error de carga. |
| Codex recibe `AGENTS.md` | **Verificado (2026-11-07)**: en la misma ejecución, Codex citó con exactitud la primera regla de `AGENTS.md`. El modelo es quien informa, así que la prueba es una señal, no una inspección del proceso. |
| Claude Code recibe `CLAUDE.md` y `AGENTS.md` | **Verificado en sesión**: ambos contenidos llegaron al contexto. **No aislado**: no se ha comprobado si `AGENTS.md` llega por la importación `@AGENTS.md` o por lectura directa. |

Observación: durante la prueba, Codex intentó conectar a un servidor MCP en `localhost:4401` que no respondía. Es un error ajeno al proyecto; no se ha modificado ninguna configuración.
