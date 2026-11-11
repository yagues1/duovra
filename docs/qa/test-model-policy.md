# Política de modelos para pruebas reales

**Vigente desde:** 7 de noviembre de 2026. Prevalece sobre cualquier elección de modelos usada en pruebas anteriores.

Esta política se aplica a toda prueba que **invoque de verdad** a un proveedor (Claude Code o Codex) durante el desarrollo o la QA de Duovra, la haga una persona o un agente. No limita lo que el usuario puede elegir al usar la aplicación: los modelos predeterminados y el selector siguen ofreciendo todo lo que informe cada CLI.

## 1. Modelos y niveles autorizados

| Agente | Modelo | Nivel de razonamiento | ID real verificado (7-11-2026) |
|---|---|---|---|
| Codex | Luna 6.0 («GPT-6-Luna») | Alto (`high`) | `gpt-6-luna` — Codex App Server `model/list`, codex-cli 0.166.0 |
| Claude Code | Haiku 5.5 | Medio (`medium`) | `haiku` → resuelve a `claude-haiku-5-5` — Claude Code 2.1.316, `initialize` |

No se usan en pruebas reales:

- Codex: Luna 6.1, Luna 6.0 en Máximo u otro nivel distinto de Alto, Sol, Astra, Terra ni ningún otro modelo.
- Claude Code: Opus, Sonnet, Fable, Haiku con un nivel distinto de Medio ni ningún otro modelo.

Esta restricción se refiere a los modelos **invocados por las pruebas**, no al modelo del agente que desarrolla o revisa el código.

## 2. Comprobación de identificadores antes de probar

Los identificadores cambian entre versiones de las CLIs. Antes de cada sesión de pruebas reales:

1. Ejecutar `node scripts/qa/check-test-models.mjs`. Consulta los catálogos que informan las propias CLIs (Codex App Server `model/list` y `initialize` de Claude Code) **sin invocar ningún modelo** y comprueba:
   - que existe un modelo de Codex cuyo nombre corresponde a Luna 6.0 y que admite `high`;
   - que existe la entrada de Haiku 5.5 en Claude Code, a qué ID resuelve y que admite `medium`.
2. Usar en la aplicación exactamente el ID que devuelve el catálogo (en Claude Code, la entrada cuyo `resolvedModel` es `claude-haiku-5-5`).
3. Tras la prueba, confirmar en el historial que el chip del mensaje muestra el **modelo exacto** que informó el proveedor (`claude-haiku-5-5`, `gpt-6-luna`).

No se inventan identificadores internos. Si el script no encuentra el modelo, no se elige «el más parecido».

## 3. Prohibición de sustitución automática

- Ninguna prueba, script ni agente puede cambiar a otro modelo si el autorizado no está disponible.
- La aplicación tampoco lo hace en silencio: si el modelo guardado en una conversación desaparece del catálogo, el compositor lo anuncia y no envía hasta que el usuario confirme o elija otro (AUD-004).

## 4. Pruebas reales y pruebas con mocks

| Tipo | Qué invoca | Uso | Cómo se informa |
|---|---|---|---|
| Real | La CLI oficial y el proveedor, con cuenta y consumo reales | Integración, permisos, streaming, sesiones, cancelación | «Probado con `gpt-6-luna`/high» o «con `claude-haiku-5-5`/medium» |
| Mock | Nada externo (`vitest`, `src/dev/mockTauri.ts`) | Lógica local, distribución, estados visuales | «Probado con datos simulados». **Nunca** se presenta como verificación de un proveedor |

Las pruebas unitarias no necesitan proveedores. En las reales: pocas llamadas, mensajes breves, un directorio temporal aislado y ningún proyecto real del usuario.

## 5. Cuando una prueba no puede ejecutarse

Se registra en el informe de la iteración como **NOT TESTED**, con:

- la prueba y el motivo exacto (p. ej. «`gpt-6-luna` no figura en `model/list` de codex-cli X.Y.Z»);
- la salida relevante del script de comprobación (sin credenciales ni tokens);
- qué queda cubierto por otras pruebas y qué no.

No se ejecuta la prueba con otro modelo salvo autorización expresa del usuario, que también se anota.
