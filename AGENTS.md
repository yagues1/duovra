# AGENTS.md

Instrucciones compartidas para agentes que trabajan en este proyecto (Claude Code y Codex).

## Proyecto

Aplicación de escritorio para Windows (Tauri + React + TypeScript) que permite usar Claude Code y Codex desde una misma interfaz, con selección manual de agente y modelo por mensaje e historial compartido.

Nombre: **Duovra** (antes Claude-Codex-Studio). Proyecto open source con licencia MIT en `yagues1/duovra`; rama principal `main`. Arquitectura en `docs/architecture.md`; integración con los agentes en `docs/agent-integration.md`.

## Reglas

- Respeta las decisiones de diseño: Liquid Glass azul oscuro, premium y minimalista, con microanimaciones fluidas. Consulta `docs/design-references.md`.
- No introduzcas elementos visuales genéricos que contradigan ese estilo.
- Mantén el código modular y prioriza funcionalidad y rendimiento.
- Reutiliza las skills y herramientas ya instaladas en `.agents/skills` antes de añadir otras nuevas.
- No modifiques archivos ajenos a este proyecto ni configuraciones globales de Claude Code o Codex.
- No agregues funcionalidades no solicitadas.
- No inventes resultados de pruebas, compatibilidad ni rendimiento: informa solo de lo que has ejecutado y verificado.
- No copies credenciales, tokens ni archivos `.env` de otros proyectos.
- No introduzcas servicios ni MCP de coordinación automática entre Claude y Codex: está descartado.
- Documentación y comunicación en español; términos técnicos e identificadores en su forma original.

## Pruebas con proveedores reales (política permanente)

- Toda prueba que invoque de verdad a un proveedor usa **solo**: Codex **Luna 6.0 (`gpt-6-luna`) / Alto** y Claude Code **Haiku 5.5 (`haiku` → `claude-haiku-5-5`) / Medio**. Ningún otro modelo ni nivel.
- Antes de probar, verifica los IDs con `node scripts/qa/check-test-models.mjs` (no invoca modelos). Si un modelo autorizado no está disponible, registra NOT TESTED y no lo sustituyas por otro sin autorización del usuario.
- Pocas llamadas, mensajes breves y un directorio temporal aislado. Las pruebas con mocks son válidas para lógica local, pero nunca se presentan como verificación de un proveedor.
- No cambies los modelos predeterminados de la aplicación por esta política: solo rige para las pruebas.
- Detalle y procedimiento: `docs/qa/test-model-policy.md`.

## Skills

- Las skills del proyecto viven en `.agents/skills/<nombre>/SKILL.md`. Es la única copia. Son herramientas opcionales de terceros y no se distribuyen en el repositorio público: cada colaborador las instala desde las fuentes de `docs/skills.md`.
- Claude Code las lee desde `.claude/skills`, que es una junction a `.agents/skills` creada por `scripts/link-skills.ps1`.
- Inventario, fuentes y verificación: `docs/skills.md`.
