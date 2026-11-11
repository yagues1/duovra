# Duovra — visión general

## Objetivo

Aplicación de escritorio para Windows que permite usar **Claude Code** y **Codex** desde una misma interfaz. El usuario elige manualmente el agente y el modelo para cada mensaje, y el historial es compartido.

## Stack previsto

- Tauri (shell de escritorio para Windows)
- React + TypeScript (interfaz)
- Estilo: Liquid Glass azul oscuro (ver `design-references.md`)

## Estado

**Fase: primera versión funcional** (2026-11-07, rama `feat/desktop-app`). Aplicación Tauri 2 + React con persistencia SQLite, integración real con Codex (Codex App Server) y con Claude Code (`claude -p` en modo stream-json). Ver [architecture.md](architecture.md) y [agent-integration.md](agent-integration.md).

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
