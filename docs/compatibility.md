# Compatibilidad con Claude Code y Codex

Este documento separa lo que está **verificado en la documentación oficial** de lo que sigue **pendiente de prueba en ejecución**.

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
