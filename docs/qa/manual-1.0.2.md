# QA manual de Duovra 1.0.2

Procedimiento para las dos comprobaciones que solo puede hacer una persona delante de la interfaz: copia y restauración, y aviso nativo de Windows. Ambas se ejecutan únicamente en la **instalación QA**.

## Aislamiento

- Ejecutable: `src-tauri\target\release\duovra-distribution-qa.exe` (producto «Duovra Distribution QA», identificador `dev.duovra.studio.qa.distribution`).
- Datos de la app: `%APPDATA%\dev.duovra.studio.qa.distribution`. Es el perfil QA; la QA automatizada también escribe ahí.
- Perfil WebView2 aislado: `output\qa\manual-1.0.2\webview2`.
- No abras la instalación estable ni uses `%APPDATA%\dev.duovra.studio.beta` (perfil personal).
- Ningún paso envía mensajes a un proveedor: los datos de prueba son proyectos, títulos y borradores.
- Los datos de prueba llevan el prefijo `QA manual ·` para distinguirlos de los de la QA automatizada.

## Preparación

En PowerShell, desde la raíz del worktree `Duovra-1.0.2`:

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "$PWD\output\qa\manual-1.0.2\webview2"
Start-Process ".\src-tauri\target\release\duovra-distribution-qa.exe"
```

Crea un proyecto `QA manual · Copia` con dos conversaciones: `QA manual · Conversación A` y `QA manual · Conversación B`. No envíes ningún mensaje.

## A. Copia y restauración

1. **Ajustes → Datos y diagnóstico → Copias de seguridad.**
2. En `QA manual · Conversación A`, escribe el borrador `Borrador QA 1` (sin enviarlo).
3. Pulsa **Crear copia de seguridad…**. En el diálogo nativo elige la carpeta `output\qa\manual-1.0.2` y el nombre `copia-1.0.2.duovra`. Debe aparecer «Copia de seguridad guardada como «copia-1.0.2.duovra».».
4. Modifica los datos: renombra el proyecto a `QA manual · Modificado` y cambia el borrador a `Borrador QA 2`.
5. Pulsa **Restaurar copia…**, selecciona `copia-1.0.2.duovra` y revisa el resumen. Confirma con **Restaurar y reiniciar**.
6. Duovra se reinicia. Comprueba:
   - El proyecto se llama `QA manual · Copia` (no `Modificado`).
   - El borrador de la conversación A es `Borrador QA 1`.
   - Existe una copia previa `backups\antes-de-restaurar-*.duovra` en la carpeta de datos.

No restaures mientras un agente esté trabajando: Duovra lo impide.

## B. Notificación de prueba

Requisitos: **Ajustes → Actualizaciones y avisos → Notificaciones de Windows** activado (viene activado por defecto).

1. Abre `QA manual · Conversación B` para que la conversación A no sea la visible.
2. En PowerShell, en la raíz del worktree:

   ```powershell
   node scripts/qa/notification-tap.mjs enviar "QA manual · Conversación A"
   ```

   Debe imprimir «Aviso de prueba enviado». El aviso es sintético: usa el mismo comando nativo que los avisos de agentes, pero no hay ninguna ejecución real.
3. Mientras el aviso de Windows esté visible, **púlsalo con el ratón**. Si ya no está visible, repite el paso 2.
4. Comprueba que Duovra se trae al frente y que abre `QA manual · Conversación A`.
5. Ejecuta:

   ```powershell
   node scripts/qa/notification-tap.mjs comprobar
   ```

   Deben salir dos líneas `PASS`: la conversación abierta es la A y no hay ejecuciones nuevas.

Si Windows no muestra el aviso, o lo muestra sin abrir la conversación, anótalo como problema abierto. No lo des por verificado.

## Estado

| Comprobación | Estado |
| --- | --- |
| A. Copia y restauración | Pendiente de ejecución manual |
| B. Notificación y apertura de la conversación | Pendiente de ejecución manual |

El helper `scripts/qa/notification-tap.mjs` solo se ha verificado en sus rutas sin aviso: conexión CDP, búsqueda de conversación y rechazo de un título inexistente. El envío real y la pulsación no se han ejecutado.

## Cambios de QA automatizada en 1.0.2

- El fixture del canal (`scripts/qa/distribution-server.mjs`) anunciaba una versión nueva en cualquier modo distinto de `current`, también en `report-unavailable` y `report-error`. Como el chequeo automático de arranque ocurre a los 1,5 s, a veces caía en esa ventana, Duovra recibía una actualización falsa y «Buscar ahora» pasaba a «Ver novedades». Ahora los modos `report-*` no anuncian versiones.
- Ciclo `node scripts/qa/update-flow-lifecycle.mjs`: 5 ejecuciones seguidas completas tras la corrección.
