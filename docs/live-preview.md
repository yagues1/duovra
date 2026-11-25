# Live Preview (1.0.9 · fase 5)

Navegador de desarrollo integrado en Workbench para ver, probar e inspeccionar la aplicación web del
espacio activo (proyecto o worktree) y pasar al agente el contexto de lo que se quiere cambiar.

## Arquitectura

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| WebView de la página | `src-tauri/src/live_preview/mod.rs` | WebView2 hija (`lp-<espacio>`) creada con `Window::add_child` (feature `unstable` de Tauri) y colocada sobre el hueco de Workbench. |
| Puente CDP | `src-tauri/src/live_preview/cdp.rs` | `CallDevToolsProtocolMethod` y `GetDevToolsProtocolEventReceiver` de WebView2: consola, red, capturas, inspector y emulación táctil **desde el host**, sin inyectar scripts ni abrir puertos de depuración. |
| Inspector | `src-tauri/src/live_preview/inspector.js` | Función que se ejecuta bajo demanda (`Runtime.callFunctionOn`) sobre el elemento elegido. Solo lee; no deja nada en la página. |
| Servidores | `src-tauri/src/live_preview/server.rs` | Comando de desarrollo opcional por espacio. Job Object con `KILL_ON_JOB_CLOSE`: sin procesos huérfanos. |
| Interfaz | `src/components/livepreview/` | Vista fija «Live Preview» de Workbench, vista ampliada (portal a pantalla completa) y barra de la ventana independiente (`?lp=<espacio>`). |
| Estado | `src/state/livePreview.ts` | Todo indexado por espacio. Configuración persistida en el ajuste `ui.livePreview` (URL, comando, tamaño, recientes). |

### Ciclo de vida y rendimiento

- Nada se carga hasta abrir la vista: el código es un `lazy()` y la WebView se crea al pulsar «Abrir».
- La WebView **nace oculta** y solo la muestra la interfaz cuando su hueco está a la vista. Los sitios
  externos se confirman **antes** de crear nada.
- Apertura y cierre se serializan en el backend (`lifecycle`): dos aperturas seguidas o un cierre a mitad
  de una apertura no dejan WebViews duplicadas ni huérfanas. Cada creación usa una etiqueta nueva
  (`lp-<espacio>-<n>`), así que reabrir no choca con una WebView cuyo cierre nativo aún no terminó.
- Los avisos de posición (`live_preview_bounds`) llevan un número de orden: los comandos async pueden
  llegar desordenados y uno antiguo («ocultar» de una vista ya sustituida) se descarta.
- En la interfaz solo cuenta el último intento de apertura; un resultado tardío no pisa el estado.
- La vista ampliada mueve el mismo nodo de Workbench a `body` (no desmonta nada ni recarga la página).
- Si la carga del documento principal falla (`net::ERR_…`, detectado por CDP), la página se oculta y
  Live Preview muestra un aviso localizado con «Reintentar», servidor y navegador externo.
- Al expulsar una vista por el límite de 3, el backend avisa a la interfaz de ese espacio.
- Cambiar de pestaña, de worktree o cerrar Workbench **oculta** la WebView (conserva historial y estado).
  Como máximo hay 3 vivas; la menos reciente que no esté desacoplada se libera.
- «Cerrar Live Preview» destruye la WebView y su ventana independiente. No detiene servidores.
- Sin sondeo: el backend agrupa los avisos (máx. uno cada 150 ms por espacio) y la interfaz solo lee
  consola o red con su cajón abierto. Búferes limitados: 400 mensajes, 300 peticiones, 300 líneas de servidor.
- El inspector solo existe mientras se selecciona (`Overlay.setInspectMode`), no hay inspección permanente.
- Capturas: nombre por contenido (sin duplicados), máximo 24 por espacio y 7 días; JPEG si el PNG supera 4,5 MB.

### Simulación de tamaño

Se redimensiona la WebView nativa y se ajusta su zoom (`set_zoom`) para que la página mida exactamente
el ancho CSS del dispositivo: no recarga la página. «Emular táctil» añade agente de usuario móvil y
eventos táctiles por CDP (sí recarga). No es una emulación completa del dispositivo.

## Seguridad

La página es contenido no confiable. Capas, de fuera adentro:

1. **WebView separada.** Nunca se carga contenido de la página en la WebView privilegiada (`main`).
2. **Perfil InPrivate** (`incognito`): sin cookies, almacenamiento ni caché compartidos con Duovra.
3. **Capacidades por WebView.** `capabilities/default.json` usa `webviews: ["main"]` (antes `windows`,
   que las WebViews hijas heredarían). `lp-*` no aparece en ninguna capacidad. La barra de la ventana
   independiente (`lpbar-*`) solo puede escuchar eventos.
4. **Guarda de IPC por etiqueta** (`ipc_allowed`, envuelve `invoke_handler`): `main` invoca todo,
   `lpbar-*` solo `live_preview_*`, `lp-*` nada. Además Tauri rechaza comandos de orígenes remotos.
5. **Script de guarda** en todos los marcos: retira `chrome.webview` (y `__TAURI_INTERNALS__` donde es
   posible). En el marco principal Tauri define `__TAURI_INTERNALS__` como no configurable y sigue
   visible, pero toda orden enviada con él se rechaza por ACL (verificado: comandos de Duovra, eventos,
   opener, diálogos y ventana) y, detrás, por la guarda de etiquetas.
6. **Navegación:** solo http(s). Hosts locales libres; externos solo si el usuario los escribe y
   confirma, o los permite desde el aviso. `tauri.localhost`, `ipc.localhost` y `asset.localhost`
   están siempre bloqueados. `file:`, `data:` o `javascript:` nunca.
7. **Ventanas nuevas (`window.open`, `target=_blank`), descargas y permisos** (cámara, micrófono, ubicación, notificaciones…): se
   bloquean y se muestra un aviso con acciones explícitas.
8. **Red sin secretos:** no se leen cabeceras, cookies ni cuerpos (búfer de CDP a 0). Las URL ocultan
   credenciales y parámetros sensibles (`token`, `key`, `secret`, `auth`, `session`, `code`…).
9. **Contexto para el agente:** el HTML se sanea (sin valores de campos ni atributos sensibles) y se
   envía marcado como «datos, no instrucciones». Nada se envía solo: el usuario escribe y elige agente.
10. **Servidores:** solo el comando configurado, solo al pulsar «Iniciar» y tras confirmar, en el
    directorio del espacio. Duovra nunca detiene procesos que no inició.

### Limitaciones conocidas

- El inspector no puede atribuir un elemento a su archivo fuente salvo que el framework lo declare en
  desarrollo (`_debugSource` de React ≤ 18, `__file` de Vue, `__svelte_meta`). Si no, lo dice.
- Los avisos de bloqueo cubren la navegación principal; los iframes se cargan dentro de la página
  (aislados igual). Un iframe a `tauri.localhost` carga la interfaz pública de Duovra en el perfil
  InPrivate, sin puente IPC ni datos.
- Una WebView nativa siempre se pinta sobre el HTML de la interfaz: mientras haya un diálogo modal de
  Duovra, o un menú que se superpone a la página, esta se oculta. Los avisos (toasts) se colocan al lado
  de la página o encima de ella para no quedar tapados. Las descripciones emergentes que caigan sobre
  la página quedan por debajo.
- La consola muestra la representación de CDP de cada argumento, no objetos navegables.
- Con «Emular táctil» activado la página se recarga.
