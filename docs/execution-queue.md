# Cola de mensajes y control de ejecuciones

Cada conversación de Duovra tiene su propia cola. Desde 1.0.4 el compositor tiene un único botón principal que cambia según la ejecución y el borrador: **Enviar mensaje** sin ejecución activa, **Cancelar ejecución** con el agente trabajando y el compositor vacío, y **Añadir a la cola** con el agente trabajando y un borrador (texto o adjuntos). Enter envía o encola, nunca cancela; Mayús+Enter añade una línea. Al cancelar, la cola conserva sus encargos y queda en pausa. El backend decide con el comando `submit_message`, bajo el mismo bloqueo de ciclo de vida que inicia los turnos: si la conversación está libre (sin ejecución, preparación, intervención ni cola pendiente o pausada) empieza el turno; si no, el mensaje se encola con el agente, el modelo, el esfuerzo, la velocidad (modo rápido) y el perfil de proveedor de ese momento. Dos envíos simultáneos nunca inician dos ejecuciones en la misma conversación. El texto que se sigue escribiendo y sus adjuntos constituyen el borrador de esa conversación.

Contraída, la bandeja muestra solo el próximo encargo («Siguiente: …»), cuántos quedan («+N pendientes») y si está pausada. Desplegada, lista todos los encargos con altura máxima y desplazamiento propio, sin tapar el compositor.

La bandeja junto al compositor permite desplegar los encargos, consultar su configuración y sus adjuntos, editar, mover con los botones Subir y Bajar, retirar, vaciar con confirmación y pausar o reanudar. La edición conserva la configuración capturada salvo que se active **Revisar agente, modelo y cuenta**. Las referencias del proyecto se guardan como rutas relativas. Los adjuntos siguen siendo rutas a los archivos originales.

La bandeja presenta las acciones de cola junto al compositor. Los informes de revisión guiaron los estados y la recuperación de sesiones.

## Despacho y recuperación

- Rust prepara un candidato por conversación. La transacción de SQLite vuelve a comprobar la cabeza, su revisión y el estado de la pausa, y guarda en conjunto la reserva y los dos mensajes del historial. El despacho reutiliza los adaptadores, los eventos de streaming y los permisos de Duovra.
- La cuenta se comprueba al capturar el encargo y antes de enviarlo. Claude Code informa correo y organización cuando están disponibles. Codex App Server informa correo y, según la versión, el espacio de trabajo. Un perfil por API key o un proveedor que omita una identidad verificable requiere revisión del encargo. La base guarda el identificador local y los datos de identidad que el proveedor publica, sin credenciales.
- Se vuelve a comprobar el modelo, su resolución si existe un alias y el esfuerzo efectivo que informó el catálogo. La pertenencia al catálogo de Codex no garantiza acceso al modelo en la API. Si el proveedor rechaza el turno, la cola se pausa. El intento conserva la configuración elegida.
- Una ejecución o un permiso pendiente conserva su conversación aunque cambie la vista. Una cancelación o un error pausa el despacho. Un fallo al guardar el cierre deja el estado bloqueado para revisión, con protección contra un nuevo inicio. Una segunda instancia que use la misma base no puede recuperar los turnos de la primera mientras esta mantenga los datos abiertos.
- Al abrir Duovra, las entradas que estaban pendientes siguen en su orden y requieren reanudar. Las que estaban en ejecución quedan en revisión, con la respuesta parcial que alcanzó a guardarse. Para un encargo de Codex con hilo y turno identificados, **Consultar a Codex** usa una lectura del proveedor. Si el turno exacto aparece completado, recupera sus elementos disponibles. La cola permanece pausada. El historial conserva los intentos cancelados e interrumpidos.
- **Preparar reintento** requiere confirmar los posibles efectos del intento anterior, y **Reanudar cola** es una acción aparte. Una ejecución directa sin entrada en la cola se revisa en su mensaje del historial. Si no hay un identificador verificable o la respuesta del proveedor es incompleta, la revisión es manual. Una cola de otra conversación sigue su propio estado.

## Intervenir en Codex

**Intervenir en el turno activo de Codex** usa JSON-RPC **turn/steer** en la misma conexión, con **threadId** y **expectedTurnId**. Duovra muestra la acción cuando el servidor reconoce el método y hay un turno válido que no está deteniéndose ni esperando autorización. Un acuse con el ID del turno se registra como **Intervención aceptada por Codex**. Significa que el servidor aceptó la instrucción. Las herramientas iniciadas o los efectos previos pueden continuar. El comando Detener afecta al turno entero. Este protocolo no ofrece retirar una intervención individual que ya obtuvo acuse.

Una intervención rechazada conserva el borrador. Si se pierde el acuse, el historial registra la incertidumbre y exige revisión. Las intervenciones sin confirmar quedan fuera del contexto compartido del próximo turno.

La CLI local de Claude Code, incluida la versión 2.1.325, admite mensajes adicionales por streaming. La prioridad **next** puede trasladarlos a un turno nuevo si el actual termina primero y **now** puede interrumpir el turno y continuar en otro. La integración actual no tiene un identificador de turno esperado ni un acuse que garantice la intervención en ese mismo turno. Con Claude Code, Enviar durante una ejecución encola el mensaje. [Contrato de entrada del SDK de Claude](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage)

Fuentes de integración de Codex. [Código de Codex App Server](https://github.com/openai/codex/tree/main/codex-rs/app-server) · [Flujo oficial de intervención de Codex](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)

## QA local

Los dos proveedores simulados permiten probar cambios de configuración, cancelaciones, permisos y cierres forzados sin cuota. La comprobación real de Codex App Server 0.169.0 con Luna 6.0 / Alto abrió un solo turno, devolvió su ID en el acuse de Steer e incluyó la clave solicitada por la intervención en la respuesta.

- Comprueba el frontend con **npm run typecheck**, **npm test** y **npm run build**.
- Ejecuta **cargo test --locked** desde **src-tauri**, con el enlazador correspondiente al toolchain. En Windows GNU, usa el mismo entorno que configura **scripts/tauri.mjs**.
- Compila la build portable de Windows con **node scripts/qa/execution-queue-build.mjs**. Usa un identificador de aplicación dedicado y el actualizador aislado.
- Prueba WebView2, SQLite y los dos proveedores simulados con **node scripts/qa/execution-queue-webview.mjs**. Requiere WebView2, Node con SQLite y FFmpeg. El script restaura los ajustes anteriores del perfil QA y elimina sus proyectos de prueba de SQLite al terminar. Conserva los registros, las capturas y el vídeo en **output/qa/execution-queue**.
- Comprueba el protocolo real con **node scripts/qa/execution-queue-steer-real.mjs** si tienes una cuenta disponible. Verifica primero la política de modelos y usa un proyecto aislado, una petición inicial a Codex y una intervención en ese mismo turno.
