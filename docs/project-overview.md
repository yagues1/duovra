# Duovra — visión general

## Objetivo

Aplicación de escritorio para Windows que permite usar **Claude Code** y **Codex** desde una misma interfaz. El usuario elige manualmente el agente y el modelo para cada mensaje, y el historial es compartido.

## Stack previsto

- Tauri (shell de escritorio para Windows)
- React + TypeScript (interfaz)
- Estilo definitivo: Graphite Glass, acento oficial, Dominó V2, Aura y Flujo (ver `design-system.md`)

## Estado

**Fase: primera versión funcional** (2026-11-07, rama `feat/desktop-app`). Aplicación Tauri 2 + React con persistencia SQLite, integración real con Codex (Codex App Server) y con Claude Code (`claude -p` en modo stream-json). Ver [architecture.md](architecture.md) y [agent-integration.md](agent-integration.md).

**Estado del worktree 1.0.11 (26/11/2026):** `feat/duovra-1.0.11`, base `ea42ff2` (fase 5).
Fase 6: Activity Center, tareas y subagentes. Instrucciones y Prompts retirados del alcance.
Validación histórica anterior a la retirada: Rust 136/136,
Vitest 245/245 (i18n 8/8), TypeScript correcto, 16 comprobaciones integradas conservadas y
la prueba de rechazo de herramientas revalidada en sesiones nuevas y reanudadas con las dos
rutas de salida (2/2 + 2/2), revisión visual dirigida 3/3, regresión Node 6/6 y ocho controles
negativos sobre el registro simulado.
Sin llamadas a modelos reales. Consultar [activity-instructions.md](activity-instructions.md#cierre-de-qa-de-la-fase-6-26112026)
para las correcciones, los límites de los transportes, las evidencias y la guía de revisión.
La fase 6 fue aprobada visualmente el 27/11/2026, incluida la QA de microanimaciones (63/63 escenarios WebView2, 19/19 pruebas unitarias dirigidas). Commit local `b95435b`. La fase 7 prepara la publicación sin subir cambios, etiquetar, publicar ni desplegar la web.
Validación local final de 1.0.11: [informe de fase 7](release-1.0.11-validation.md) y [plan web](release-1.0.11-web-plan.md).
Correcciones de la revisión visual: QA dirigida WebView2 6/6 (tres ciclos de minimización),
Rust 32/32, Vitest 26/26, i18n 8/8, Node QA 6/6 y TypeScript correcto. Cero llamadas
a modelos reales; datos históricos conservados. Ver el apartado «Revisión visual del alcance
definitivo» del informe de fase 6.

## Estructura

```
Duovra/
├─ src/                   Interfaz React (componentes, estado, estilos)
├─ src-tauri/             Backend Rust (SQLite, adaptadores de agentes, comandos)
├─ scripts/               tauri.mjs (envoltorio de compilación), render-icons.mjs, link-skills.ps1
├─ assets/brand/          Logotipo e icono de Duovra (scripts/brand.mjs)
├─ assets/references/     Capturas del diseño aprobado (pendiente de aportar)
├─ docs/                  Documentación
├─ .agents/skills/        Skills del proyecto (única copia)
├─ AGENTS.md · CLAUDE.md  Instrucciones para agentes
└─ README.md              Puesta en marcha
```

## Pendiente

1. Elegir nombre definitivo (el icono «Fusión» ya está aprobado y aplicado).
2. Incorporar las capturas aprobadas en `assets/references/` y contrastar la interfaz con ellas.
