# Integración con Claude Code y Codex

Versiones probadas en este equipo (2026-11-07): **Codex CLI 0.166.0** y **Claude Code 2.1.316**.

## Codex — Codex App Server

Se usa el protocolo oficial `codex app-server` (JSON-RPC 2.0 sin cabecera `jsonrpc`, una línea JSON por mensaje en stdio). Los tipos se generaron con `codex app-server generate-ts` para implementar el cliente contra la versión instalada.

| Función | Método | Estado |
|---|---|---|
| Detectar instalación y versión | PATH / rutas habituales, `codex --version` | Verificado |
| Estado de la cuenta | `account/read` | Verificado (ChatGPT, plan informado) |
| Modelos | `model/list` (paginado) con esfuerzos admitidos y predeterminado | Verificado |
| Crear sesión | `thread/start` (modelo, cwd, aprobación, sandbox) | Verificado |
| Continuar sesión | turnos sucesivos en el mismo hilo; `thread/resume` si el App Server se reinició | Verificado: turnos sucesivos y, tras cerrar y reabrir la aplicación (ejecutable de release), reanudación del hilo con `thread/resume` |
| Enviar mensaje | `turn/start` con texto e imágenes locales (`localImage`), modelo y esfuerzo por turno | Verificado (texto) |
| Streaming | `item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta` | Verificado |
| Actividad y herramientas | `item/started` / `item/completed` (comandos, cambios, MCP, búsqueda web, plan) y `turn/diff/updated` | Verificado (comandos y cambios de archivos) |
| Permisos | `item/commandExecution/requestApproval` y otros | Verificado (comando aprobado desde la interfaz) |
| Cancelar | `turn/interrupt` | Verificado (≈1 s) |
| Errores | notificación `error`, `turn.error` | Implementado |
| Cuotas | `account/rateLimits/read` | Verificado: ventanas de 5 h y 7 días con % y renovación |
| Inicio de sesión | `account/login/start` (`chatgpt`) → URL que abre el navegador | Implementado; no probado (la cuenta ya tenía sesión) |

Catálogo frente a autorización: el catálogo es el que devuelve App Server para la cuenta activa. La interfaz lo indica y, si el proveedor rechaza un modelo al usarlo, se muestra el error real del turno.

## Claude Code — modo no interactivo

Se ejecuta la CLI oficial instalada por el usuario (`claude -p`) con su propia autenticación y configuración. La aplicación **no lee, copia ni reutiliza tokens**, no modifica el ejecutable ni elude permisos.

```
claude -p --input-format stream-json --output-format stream-json --verbose
          --include-partial-messages --permission-prompts host --permission-prompt-tool stdio
          --permission-mode <modo> --model <modelo> [--effort <nivel>] [--resume <sesión>]
```

`--permission-prompt-tool stdio` es imprescindible: con solo `--permission-prompts host`, en modo `-p` la CLI no tiene a quién preguntar y deniega sola (comprobado con la 2.1.316). Con `stdio` envía `control_request` `can_use_tool` al host, como hace el Agent SDK oficial.

Pruebas reales del 2026-11-07 con **Haiku 5.5 (`haiku` → `claude-haiku-5-5`), razonamiento bajo**, cuenta `claude.ai` (plan Pro):

| Función | Mecanismo | Estado |
|---|---|---|
| Detectar instalación y versión | PATH / `%USERPROFILE%\.local\bin\claude.exe`, `claude --version` | Verificado |
| Estado de la cuenta | `claude auth status` (JSON) | Verificado: método `claude.ai`, plan Pro |
| Modelos y esfuerzos | `control_request` `initialize` (no envía nada al modelo) | Verificado: `default`, `opus`, `sonnet`, `fable`, `haiku`… con niveles low–max |
| Enviar y recibir con streaming | `stream_event` (`content_block_delta` de texto y razonamiento) | Verificado |
| Modelo exacto | `system/init.model`; se guarda el resuelto y el alias elegido en `usage.requestedModel` | Verificado (`haiku → claude-haiku-5-5`) |
| Herramientas | bloques `tool_use` / `tool_result` | Verificado con Write y PowerShell |
| Permisos | `control_request` `can_use_tool` → `allow` / `deny` (+ `updatedPermissions` para la sesión) | Verificado: tarjeta en la conversación, «Permitir», archivo creado en disco |
| Cancelar | `control_request` `interrupt`; si no responde en 8 s, se termina el proceso | Verificado: detenido en 2,8 s, sin procesos huérfanos |
| Continuar sesión | `--resume <session_id>` si la sesión existe en disco | Verificado tras reiniciar la aplicación: Claude recordó lo hablado en su sesión |
| Contexto compartido | Claude → Codex y Codex → Claude | Verificado en ambos sentidos (Codex con GPT-6-Luna, razonamiento alto) |
| Errores | `result` con `is_error`, o stderr si la CLI termina sin resultado | Verificado (sesión caducada antes de iniciar sesión) |
| Consumo | tokens por turno de `usage`; coste a partir de `total_cost_usd` | Verificado. Ver nota sobre el coste |
| Inicio de sesión | consola visible con `claude auth login`; el usuario lo completa | Implementado; el usuario inició sesión por su cuenta |

**Coste.** `total_cost_usd` es el acumulado de la sesión: con `--resume` incluye los turnos anteriores (en la prueba, 0,0042 → 0,0093 → 0,0112 USD con turnos casi idénticos). La aplicación guarda ese total en `usage.sessionCostUsd` y muestra como coste del mensaje la diferencia con el total anterior de la misma sesión. Si no hay referencia (sesiones anteriores a este cambio), no se da cifra. Es siempre una estimación de la CLI a precios de API; con suscripción no es un cargo real.

### Suscripción frente a API

- Si la CLI tiene sesión iniciada con una cuenta de Claude, se usa esa autenticación tal como la gestiona Claude Code. Ajustes → Cuentas muestra el método que informa `claude auth status`.
- Si la CLI está configurada con `ANTHROPIC_API_KEY`, el uso se factura por API. La aplicación no introduce ni guarda claves.
- El modo no interactivo no expone cuotas ni porcentajes de la suscripción: Uso y cuotas lo muestra como «No disponible».

## Cuentas

Una «cuenta» es un directorio de configuración de la CLI: `CODEX_HOME` para Codex y `CLAUDE_CONFIG_DIR` para Claude Code. La elegida se pasa como variable de entorno al lanzar la CLI; el inicio de sesión lo hace siempre la CLI oficial. SQLite solo guarda la etiqueta y la ruta.

## Lo que no hace

- No hay coordinación automática ni delegación entre agentes. El contexto compartido solo se envía al agente que el usuario eligió para ese mensaje.
- No se simulan respuestas: si un agente falla, se muestra su error.
