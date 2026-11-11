# CLAUDE.md

Instrucciones del proyecto para Claude Code. Las reglas compartidas están en `AGENTS.md`, que se importa aquí para no duplicarlas:

@AGENTS.md

## Específico de Claude Code

- Antes de usar skills, comprueba que `.claude/skills` existe. Si no, ejecuta `scripts/link-skills.ps1` una vez tras clonar el repositorio.
- Usa las skills de `.agents/skills` cuando la tarea coincida con su descripción. No copies sus archivos a `.claude/`.
- Para verificar la interfaz, prefiere la skill `playwright-cli` antes que añadir un MCP nuevo.
- La política de modelos para pruebas reales de `AGENTS.md` también rige cuando Claude Code ejecuta pruebas: no la sustituye el modelo con el que trabajas en la sesión (ver `docs/qa/test-model-policy.md`).
