# Skills del proyecto

Ubicación única: `.agents/skills/<nombre>/SKILL.md`.

> El repositorio público no incluye estas skills: son material de terceros con sus propias licencias. Para usarlas, clónalas desde las fuentes de la tabla en `.agents/skills/`, que está excluida de Git.
Codex la lee directamente. Claude Code la lee a través de `.claude/skills`, que es una junction creada por `scripts/link-skills.ps1`.

## Instaladas y verificadas

Todas se descargaron de repositorios públicos de GitHub con `git clone --depth 1` en una carpeta temporal. Se revisó su contenido y se copiaron solo los archivos necesarios. No se ejecutó ningún script de instalación.

| Skill | Fuente | Commit | Licencia | Contenido copiado |
|---|---|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) · `skills/frontend-design` | `ca45fc4` | Apache-2.0 | `SKILL.md`, `LICENSE.txt` |
| `react-best-practices` (nombre interno `vercel-react-best-practices`) | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) · `skills/react-best-practices` | `1a2c79d` | MIT, según su frontmatter | `SKILL.md`, `rules/`, `AGENTS.md`, `README.md`, `metadata.json` |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) · `skills/web-design-guidelines` | `1a2c79d` | Ver nota de licencia | `SKILL.md`, `LICENSE-MIT.txt` (de [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines)) |
| `playwright-cli` | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) · `skills/playwright-cli` | `4bc00fb` | Apache-2.0 | `SKILL.md`, `references/` (10 guías) |
| `interaction-design` | [wshobson/agents](https://github.com/wshobson/agents) · `plugins/ui-design/skills/interaction-design` | `4bde316` | MIT | `SKILL.md`, `references/` (3 guías), `LICENSE-MIT.txt` |
| `design-system-patterns` | [wshobson/agents](https://github.com/wshobson/agents) · `plugins/ui-design/skills/design-system-patterns` | `4bde316` | MIT | `SKILL.md`, `references/` (4 guías), `LICENSE-MIT.txt` |
| `design-motion-principles` | [kylezantos/design-motion-principles](https://github.com/kylezantos/design-motion-principles) · `skills/design-motion-principles` | `4a9ca87` | MIT | `SKILL.md`, `references/`, `workflows/`, `LICENSE-MIT.txt` |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) · `.claude/skills/ui-ux-pro-max` | `b7d5353` | MIT | `SKILL.md`, `references/`, `data/` (3,1 MB), `scripts/` (4 archivos), `LICENSE-MIT.txt` |

Las cuatro últimas son las aprobadas en la segunda ronda (2026-11-07). Las cuatro primeras son de la primera ronda.

### Verificación realizada

- Todos los `SKILL.md` tienen frontmatter con `name` y `description`.
- **Descubrimiento en Claude Code (en sesión)**: al cargar la skill `design-system-patterns` con la herramienta Skill, se resolvió desde `<repo>\.claude\skills\design-system-patterns`. Es decir, la junction funciona para Claude Code.
- **Descubrimiento en Codex (ejecución no interactiva, `codex exec`)**: listó las 8 skills del proyecto sin error.
- Revisión de contenido sin ejecución (ver notas por skill abajo).

### Notas por skill

- **`playwright-cli`** indica instalar `@playwright/cli` globalmente con npm. **No se ha instalado nada global.**
- **`web-design-guidelines`** indica descargar las guías en tiempo de ejecución desde `vercel-labs/web-interface-guidelines`. Ese contenido puede cambiar sin pasar por este repositorio.
  - Licencia: el repositorio `vercel-labs/web-interface-guidelines` tiene licencia MIT (Vercel Labs, 2025), y su copia está en `LICENSE-MIT.txt`. El `SKILL.md` procede de `vercel-labs/agent-skills`, que no tiene archivo LICENSE en la raíz y no declara licencia en el propio skill. Antes de distribuir la aplicación, confirmar esa licencia con el titular.
- **`design-motion-principles`** contiene `references/demo-shell.html`, `report-template.html` y `output-format.md`. Esos archivos cargan fuentes desde `fonts.googleapis.com` y `fonts.gstatic.com`. Un informe generado por la skill usará esas fuentes desde Internet salvo que se edite la plantilla. No afecta a la aplicación, pero sí a los informes.
- **`ui-ux-pro-max`**:
  - Requiere Python 3 en el PATH. Sus scripts usan solo la biblioteca estándar.
  - Revisión estática: no hay llamadas de red ni `subprocess` ni `eval` en `core.py`, `search.py`, `design_system.py` ni `reasoning_contract.py`. `design_system.py` borra un archivo temporal propio con `os.unlink`.
  - **No se ha ejecutado** ningún script: la ejecución fue bloqueada por el clasificador de permisos del entorno. Para verificar el funcionamiento hace falta autorizarlo explícitamente.
  - No se copiaron `scripts/tests/` ni `validate_data.py` (herramientas de desarrollo del repositorio original).
  - `data/` incluye datos de Google Fonts y Phosphor Icons con su procedencia (`data-provenance.json`, `google-font-licenses.json`). Licencias de iconos y fuentes deben confirmarse antes de usar sus recursos en la aplicación.

## Consideradas y descartadas

| Área | Resultado | Motivo |
|---|---|---|
| Tauri v2 | Sin skill oficial. El repositorio `tauri-apps/tauri` no contiene carpeta `skills` ni `.agents`. | Las skills comunitarias no se han revisado en origen. **Pendiente**: revisar la documentación oficial de Tauri al iniciar el stack. |
| Motion for React | El repositorio `motiondivision/motion` solo contiene dos skills internas (`.agents/skills/fix` e `improve`). | Están pensadas para contribuir a la propia librería, no para construir una aplicación. Descartadas. |
| Liquid Glass | Los resultados son para iOS/SwiftUI (`axiom-liquid-glass`, `liquid-glass-design`) o Compose Multiplatform (`KMP Liquid Glass`). | No aplican a un WebView2 con React. Los efectos se tratan en `docs/visual-technology.md`. |
| Tailwind CSS | Sin skill oficial de `tailwindlabs`. | Solo hay comunitarias. El stack no ha decidido todavía si usa Tailwind. |

Se han revisado tres skills adicionales y ninguna aportó una capacidad distinta de las ya instaladas. Por eso no se han añadido.

## Ya disponibles en el entorno (no copiadas, para evitar duplicados)

Estas skills están instaladas globalmente en la sesión. No se han copiado al repositorio:

- Diseño y UI: `impeccable`, `emil-design-eng`, `apple-design`, `taste`, `dataviz`.
- Animación: `animation-vocabulary`, `find-animation-opportunities`, `improve-animations`.
- Revisión de código: `code-reviewer`, `security-reviewer`, `test-master`.

Estas skills globales y las del proyecto cubren solapamientos de motion (por ejemplo, `emil-design-eng` y `design-motion-principles`). Si se decide fijar una versión por proyecto, se copiará a `.agents/skills/` y se documentará aquí.
