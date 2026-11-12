# Reportes y distribución

## Código y compilaciones

El código es público en [yagues1/duovra](https://github.com/yagues1/duovra) bajo licencia MIT. El workflow **CI** (`.github/workflows/ci.yml`) se ejecuta en cada pull request con permisos de solo lectura y sin secretos. Comprueba tipos, pruebas de Vitest y de Rust, y genera un instalador NSIS **sin firmar** que conserva siete días como artefacto. Ese instalador es de pruebas: no es una versión de producción.

### Paso de Claude-Codex-Studio a Duovra

- El identificador de Tauri sigue siendo `dev.claudecodexstudio.app`. Por eso Duovra usa la misma carpeta de datos (`%APPDATA%\dev.claudecodexstudio.app\studio.sqlite3`) y el mismo perfil de WebView2, y conserva proyectos, conversaciones, borradores y preferencias sin migración. No lo cambies: Windows y Tauri lo tratarían como otra aplicación y los datos quedarían en la carpeta antigua.
- Sí cambian `productName` («Duovra») y el ejecutable (`duovra.exe`). El instalador NSIS instala Duovra en su propia carpeta. Una instalación anterior de «Claude-Codex-Studio» no se elimina automáticamente: se puede desinstalar desde Configuración de Windows sin perder datos, porque el desinstalador no borra la carpeta de datos salvo que se marque esa opción.
- Las compilaciones 0.1.x no tenían canal de actualizaciones de producción (clave pública vacía). Por eso no hay clientes que dependan de una clave anterior: la 0.2.0 se instala manualmente.

Mantén la versión SemVer en `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` y `src-tauri/tauri.conf.json`. Añade una sección con esa versión a `CHANGELOG.md`. Conserva el identificador de aplicación y el instalador NSIS x64 para actualizar sobre una instalación existente.

## Recibir reportes

El formulario **Reportar un error** envía el reporte desde la propia aplicación, sin abrir el navegador ni pedir una cuenta de GitHub. Muestra qué se enviará: título, categoría, texto saneado (correos, tokens y rutas de usuario ocultados), versión, sistema, identificador y, si el usuario la elige, una captura. No recopila conversaciones, código, rutas ni registros. El borrador se guarda en el equipo (`report.draft`) y sobrevive a fallos de red y reinicios. Un reintento usa el mismo identificador, así que no crea duplicados.

Si la compilación no incluye `STUDIO_REPORT_ENDPOINT`, el formulario lo indica («Esta compilación no puede enviar reportes») y conserva el borrador, sin simular el envío.

Los reportes llegan como Issues a **`yagues1/duovra-reports`**, un repositorio **privado** separado del código. Los Issues públicos de `yagues1/duovra` siguen abiertos para contribuciones voluntarias.

Para activar el servicio:

1. Crea en Cloudflare una base D1 (`studio-bug-reports`). Las capturas opcionales se guardan en su tabla privada `captures`. Si se activa R2, puede usarse en su lugar un bucket privado (`studio-private-bug-captures`, binding `CAPTURES`) con una regla de expiración en `reports/`; mantén desactivados el acceso público y el subdominio R2 público.
2. Desde `services/bug-reports`, copia `wrangler.example.jsonc` a `wrangler.jsonc`, fija el ID de D1 y aplica el esquema con `npx wrangler d1 execute studio-bug-reports --remote --file schema.sql`.
3. Genera un fine-grained PAT de `yagues1` con acceso **solo** a `yagues1/duovra-reports` y el permiso **Issues: Read and write**. Guárdalo únicamente con `npx wrangler secret put GITHUB_ISSUES_TOKEN`.
4. Despliega con `npx wrangler deploy`. Guarda la URL HTTPS del Worker terminada en `/report` en la variable de repositorio `STUDIO_REPORT_ENDPOINT` de `yagues1/duovra`. El workflow de release la incorpora al compilar.
5. Notificaciones: `yagues1` ya está suscrito a `duovra` y a `duovra-reports`. Elige el destino (correo o web) en las [preferencias de notificaciones de GitHub](https://github.com/settings/notifications).

El Worker valida en el servidor, limita el tamaño y la frecuencia por IP y en total, rechaza capturas que no sean JPEG limpios, evita duplicados por ID y no registra el contenido. Las IP solo se usan para limitar la frecuencia. Las capturas se guardan en D1 (o R2) privado y el Issue solo contiene su clave. La aplicación solo confirma el envío cuando GitHub devuelve un número de Issue.

**Estado actual:** el Worker está desplegado en `https://duovra-bug-reports.duovra.workers.dev/report` con D1 (reportes y capturas) y el secreto `GITHUB_ISSUES_TOKEN`. Verificado el 2026-11-11 con reportes sintéticos (con y sin captura) que llegaron a `yagues1/duovra-reports`. R2 no está activado en la cuenta; si se activa, basta con añadir el binding `CAPTURES`.

## Firma y canal de actualizaciones

La clave de producción ya existe y no se debe regenerar:

- Privada (cifrada con contraseña): `%USERPROFILE%\.duovra-signing\duovra-updater.key`.
- Contraseña: `%USERPROFILE%\.duovra-signing\duovra-updater.password.dpapi`, cifrada con DPAPI. Solo el usuario de Windows que la creó puede descifrarla.
- Pública: `duovra-updater.key.pub`. Su contenido está en `plugins.updater.pubkey` de `tauri.conf.json`, así que todas las compilaciones confían en ella.
- La carpeta solo es accesible para ese usuario.

**Copia de seguridad (obligatoria).** Si se pierde la clave, las instalaciones existentes no podrán actualizarse nunca más. Copia la carpeta a un medio cifrado sin conexión. Guarda también la contraseña en un gestor de contraseñas, porque la copia DPAPI no sirve en otro equipo. Para verla una sola vez:

```powershell
$s = Get-Content "$env:USERPROFILE\.duovra-signing\duovra-updater.password.dpapi" | ConvertTo-SecureString
[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
```

Publicar una versión:

1. Ejecuta tú `scripts/release/setup-release-env.ps1` con `gh` autenticado como `yagues1`. Crea el entorno `release`, limitado a `main` y con tu aprobación, sube por stdin `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` y guarda `STUDIO_UPDATER_PUBLIC_KEY`. Solo hace falta una vez.
2. Ejecuta **Release (Windows, signed)** con la versión. Produce instalador, firma y `latest.json`, y crea un **borrador** de Release `v<VERSIÓN>`. Publícalo a mano tras revisarlo.
3. El canal es `https://github.com/yagues1/duovra/releases/latest/download/latest.json`. La clave efímera de QA no sirve para producción.

**Compatibilidad:** las versiones 0.1.x y 0.2.0 no tenían clave pública, así que no pueden actualizarse solas. La 0.3.0 se instala manualmente una vez. Desde ella, las actualizaciones son automáticas y firmadas.

### Experiencia de actualización

1. Con «Comprobar al iniciar» activo, Duovra consulta el canal al abrirse y cada 4 horas. Si hay versión nueva, aparece un indicador en la barra lateral, y un aviso si «Avisar de versiones nuevas» está activo.
2. El indicador abre las novedades. **Actualizar ahora** muestra la pantalla de actualización a pantalla completa. Es un `<dialog>` modal que bloquea Duovra, pero no Windows: Alt+Tab y el escritorio siguen funcionando.
3. Fases: comprobación, descarga (porcentaje y MB reales cuando el servidor informa del tamaño), verificación de firma y versión (sin porcentaje), preparación e instalación.
4. Antes de instalar, Duovra espera a que no haya agentes trabajando. Ofrece «Detener tareas e instalar» o «Volver a Duovra». Guarda los borradores pendientes y anota la versión esperada.
5. Tauri lanza el instalador NSIS con su **interfaz básica** (`plugins.updater.windows.installMode = "basicUi"`), que muestra su propio progreso nativo, y Duovra se cierra. Al terminar, NSIS vuelve a abrir Duovra. No se usa el modo `passive`: en 0.3.0 provocó un bloqueo de Microsoft Defender.
6. Al reabrir, Duovra compara su versión con la esperada y lo comunica. Si la instalación falla, la versión anterior sigue funcionando y se puede reintentar.

## Instalador y accesos directos

- El instalador NSIS (en español) instala por usuario en `%LOCALAPPDATA%\Duovra`, crea la entrada del menú Inicio y ofrece en la última página la casilla **Crear acceso directo en el escritorio**. En modo pasivo o silencioso (primera instalación) crea el acceso directo del escritorio.
- Al actualizar (`/UPDATE`) no crea accesos nuevos: conserva los existentes y corrige su destino si cambió el ejecutable.
- El desinstalador elimina los accesos del menú Inicio y del escritorio que apuntan a su ejecutable. La carpeta de datos se conserva salvo que se marque la opción de borrarla.

## Prueba local en WebView2

La variante `qa-loopback` permite confiar en una CA local mediante `STUDIO_QA_TLS_CERT_PEM`. Usa un certificado TLS para `127.0.0.1`, una clave efímera de Tauri y un identificador y nombre de aplicación exclusivos de QA. Compila una base `0.1.1` y un instalador `0.1.2` firmado. Configura el manifiesto de ambas compilaciones en `https://127.0.0.1:17443/latest.json` y el reporte en `https://127.0.0.1:17443/report`.

Ejecuta `node scripts/qa/distribution-server.mjs output/qa/distribution <instalador-firmado>`. Abre la base con el puerto CDP 9333, como indica `scripts/qa/webview.mjs`. Lanza `node scripts/qa/webview.mjs scripts/qa/distribution-webview.mjs output/qa/distribution/capturas` para validar el formulario, el canal HTTPS, los fallos de descarga y la verificación de firma y versión. En la base de QA instalada, `STUDIO_QA_INSTALL=1` también prueba el arranque de NSIS.

Referencias: [Tauri Updater](https://v2.tauri.app/plugin/updater/) · [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Cloudflare R2](https://developers.cloudflare.com/r2/get-started/workers-api/).
