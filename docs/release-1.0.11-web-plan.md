# Duovra 1.0.11 — Agent Experience: plan de sincronización web

**Preparación local.** La web sigue anunciando la versión pública 1.0.10. No modificarla ni desplegarla hasta la autorización expresa de publicación y la comprobación de los artefactos firmados. Procedimiento: [RELEASE-WEB-SYNC.md](RELEASE-WEB-SYNC.md).

## Actualizaciones previstas en el proyecto existente

| Área | Cambio tras publicar y verificar Desktop |
| --- | --- |
| `duovra-web-prototype/src/lib/site.ts` | Cambiar la versión a `1.0.11`. Confirmar que las URLs derivadas corresponden exactamente al instalador y ZIP oficiales. Revisar también el ancla de instalación del README EN (`#download-and-get-started`). |
| `src/messages/site.ts`, `hero.ts`, `demos.ts`, `app-ui.ts` | Anunciar Agent Experience en ES/EN. Actualizar los ejemplos de interfaz y agrupar las novedades por capacidades, contexto y memoria, sesiones, planificación, control de ejecuciones y Activity Center. |
| `src/lib/site-metadata.ts` | Revisar títulos, descripciones y metadatos de ambas rutas para que reflejen el nuevo alcance sin promesas de capacidades universales. |
| `src/components/hero`, `features`, `demos`, `app-ui` y `stage` | Contrastar con la distribución final. Actualizar solo los ejemplos afectados: compositor y selectores, contexto, bifurcaciones, planes/preguntas, Activity Center y tareas/subagentes. Mantener navegación, estructura, Graphite Glass, acento, Dominó V2, Aura y Flujo, adaptabilidad y movimiento reducido. |
| `public/captures` | Sustituir únicamente las imágenes desactualizadas en ES/EN; conservar las que sigan siendo representativas. Usar perfil aislado, datos ficticios y la build de distribución verificada. |
| Changelog y compatibilidad | Enlazar las notas bilingües de [CHANGELOG.md](../CHANGELOG.md) y la documentación de compatibilidad. Mantener los requisitos de Windows x64, WebView2 y CLI compatible. |

Capturas prioritarias: hero con compositor definitivo, contexto y memoria, menú de conversación/bifurcación, aprobación de plan, pregunta interactiva y Activity Center con estados claramente diferenciados. Si se muestra progreso de Codex generado con fixtures, identificarlo como ejemplo. Conservar demostraciones de Worktrees, Live Preview, apariencia y apoyo.

## Mensajes y límites

Usar las notas ES/EN de 1.0.11 como fuente. No anunciar Instructions Center, biblioteca de prompts ni objetivos autónomos nativos de Codex. Los objetivos de Duovra son persistentes. El steering de Claude Code no está disponible con el transporte integrado; Codex requiere capacidad compatible para steering y experimental para planificación. Las tareas, subagentes y comandos nativos dependen del proveedor; no presentar los fixtures como resultados reales. Claude Code puede cambiar de modelo en determinadas configuraciones de planificación.

## Secuencia de publicación (pendiente de autorización)

1. Validar la CI de Windows y ejecutar el workflow oficial de firma sobre el commit aprobado. Comprobar versión, commit, identidad, firma, SHA-256 y los seis adjuntos. Probar instalador, ZIP y actualización desde 1.0.10 en Windows aislado.
2. Publicar únicamente tras aprobación. Confirmar los adjuntos públicos, `latest.json` y el canal de actualización. URLs previstas (todavía no verificadas como públicas):
   - `https://github.com/yagues1/duovra/releases/download/v1.0.11/Duovra-1.0.11-windows-x64-setup.exe`
   - `https://github.com/yagues1/duovra/releases/download/v1.0.11/Duovra-1.0.11-windows-x64-portable.zip`
3. Aplicar los cambios web anteriores; compilar con `npm run build`, servir en 3218 y ejecutar `npm run qa:release -- http://localhost:3218`. Comprobar ES/EN, escritorio y móvil, demostraciones y enlaces. No introducir un rediseño.
4. Con autorización, desplegar y promover siguiendo la vinculación existente. Verificar ambas rutas públicas, descargas, canal de actualización, 404 de `/lab` y redirección 308 del alias. Registrar commits, release, evidencia de actualización y despliegue.

En esta fase se prepara exclusivamente este plan: no se cambia el proyecto web ni el estado público.
