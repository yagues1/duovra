<div align="center">

<img src="../assets/brand/duovra-icon.svg" width="96" height="96" alt="Duovra">

# Duovra

**Un espacio de trabajo. Tus agentes de programación.**

Aplicación de escritorio open source para Claude Code y OpenAI Codex.

[English](../README.md)

</div>

Duovra reúne en una aplicación nativa de Windows los agentes de programación que ya usas: **Claude Code** y **Codex**. En cada mensaje eliges el agente, el modelo y el nivel de razonamiento. Ambos agentes comparten el historial de la conversación, y tus proyectos, conversaciones y borradores se quedan en tu equipo.

Duovra no sustituye a ninguna de las dos herramientas: utiliza las CLIs oficiales instaladas en tu equipo, con tu propio inicio de sesión y tu configuración. No incluye acceso a modelos ni orquesta los agentes automáticamente. El agente lo eliges tú.

## Funciones

- Claude Code y Codex en la misma conversación, con cambio manual de agente en cada mensaje.
- Modelo y razonamiento por mensaje, según el catálogo que informa cada CLI para tu cuenta.
- Proyectos locales con sus conversaciones y borradores.
- Streaming de respuestas, comandos y ediciones, y cancelación en cualquier momento.
- Permisos de herramientas en la propia conversación: permitir una vez, durante la sesión o rechazar.
- Panel contextual con archivos, diffs y salida de terminal.
- Historial persistente en SQLite local.
- Interfaz Liquid Glass y fondo de aurora dinámico, que se adaptan a la intensidad visual elegida y respetan la reducción de movimiento.
- **Actualizaciones:** el actualizador firmado ya está integrado, pero el canal público no está activo todavía.
- **Reportes de error:** el botón prepara un borrador de Issue en GitHub, que revisas antes de enviarlo.

## Instalación

Todavía no hay un instalador público. Se publicará en [Releases](https://github.com/yagues1/duovra/releases). Mientras tanto puedes compilar Duovra desde el código: consulta [Development](../README.md#development).

Requisitos: Windows 11 x64 con WebView2 y al menos una CLI instalada y con sesión iniciada (`claude` o `codex`).

## Primeros pasos

1. Instala Duovra y comprueba que `claude` o `codex` funcionan en una terminal.
2. En **Ajustes → Agentes**, verifica que se detectan las CLIs.
3. Añade un proyecto desde la cápsula de proyecto de la barra superior.
4. Crea una conversación (`Ctrl+N`).
5. Elige **Claude Code** o **Codex**, el modelo y el razonamiento, y escribe.

## Documentación técnica (en español)

- [Arquitectura](architecture.md) · [Integración con los agentes](agent-integration.md) · [Visión general](project-overview.md)
- [Sistema de diseño](design-system.md) · [Tecnología visual](visual-technology.md) · [Compatibilidad](compatibility.md)
- [Distribución, firma y reportes](distribution.md) · [Política de modelos para pruebas](qa/test-model-policy.md)

## Licencia y marcas

Licencia [MIT](../LICENSE). Duovra es un proyecto independiente: no está afiliado a Anthropic ni a OpenAI, y ninguna de las dos empresas lo respalda. Claude y Claude Code son marcas de Anthropic, PBC. OpenAI y Codex son marcas de OpenAI. Consulta [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
