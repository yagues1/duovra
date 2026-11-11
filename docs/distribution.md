# Reportes y distribución

## Código y compilaciones

El código es público en [yagues1/duovra](https://github.com/yagues1/duovra) bajo licencia MIT. El workflow **CI** (`.github/workflows/ci.yml`) se ejecuta en cada pull request con permisos de solo lectura y sin secretos. Comprueba tipos, pruebas de Vitest y de Rust, y genera un instalador NSIS **sin firmar** que conserva siete días como artefacto. Ese instalador es de pruebas: no es una versión de producción.

### Paso de Claude-Codex-Studio a Duovra

- El identificador de Tauri sigue siendo `dev.claudecodexstudio.app`. Por eso Duovra usa la misma carpeta de datos (`%APPDATA%\dev.claudecodexstudio.app\studio.sqlite3`) y el mismo perfil de WebView2, y conserva proyectos, conversaciones, borradores y preferencias sin migración. No lo cambies: Windows y Tauri lo tratarían como otra aplicación y los datos quedarían en la carpeta antigua.
- Sí cambian `productName` («Duovra») y el ejecutable (`duovra.exe`). El instalador NSIS instala Duovra en su propia carpeta. Una instalación anterior de «Claude-Codex-Studio» no se elimina automáticamente: se puede desinstalar desde Configuración de Windows sin perder datos, porque el desinstalador no borra la carpeta de datos salvo que se marque esa opción.
- Las compilaciones 0.1.x no tenían canal de actualizaciones de producción (clave pública vacía). Por eso no hay clientes que dependan de una clave anterior: la 0.2.0 se instala manualmente.

Mantén la versión SemVer en `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` y `src-tauri/tauri.conf.json`. Añade una sección con esa versión a `CHANGELOG.md`. Conserva el identificador de aplicación y el instalador NSIS x64 para actualizar sobre una instalación existente.

## Recibir reportes

Si el servicio está desactivado, la aplicación abre en el navegador un borrador de Issue en `yagues1/duovra`, que el usuario revisa antes de enviarlo. Los reportes largos muestran el texto listo para copiar. El navegador ofrece el envío y la carga manual de capturas.

Para permitir reportes desde la aplicación sin cuenta de GitHub:

1. Crea una base D1 y un bucket R2 privado en Cloudflare. Configura una regla de expiración en el prefijo `reports/` según la retención acordada. Deja desactivados el acceso público y el subdominio R2 público.
2. Desde `services/bug-reports`, copia `wrangler.example.jsonc` a `wrangler.jsonc`, fija el ID de D1 y aplica el esquema con `npx wrangler d1 execute studio-bug-reports --remote --file schema.sql`.
3. Genera un fine-grained PAT con **Issues: Read and write** restringido a este repositorio. Guárdalo solo con `npx wrangler secret put GITHUB_ISSUES_TOKEN` o en el panel de secretos del Worker.
4. Despliega con `npx wrangler deploy`. Configura `STUDIO_REPORT_ENDPOINT` como la URL HTTPS del Worker terminada en `/report` al compilar la aplicación. En Actions puede ser una variable de entorno `signing`. La URL es pública y el cliente envía únicamente el contenido elegido.
5. En el repositorio, selecciona **Watch → Custom → Issues** y elige el destino en las [preferencias de notificaciones de GitHub](https://github.com/settings/notifications).

El Worker limita tamaño y frecuencia por IP y por ubicación de Cloudflare, valida el contenido y evita duplicados por ID. Las IP se usan para limitar frecuencia y quedan fuera del reporte. Las capturas se recodifican como JPEG antes del envío y el Issue contiene la clave del objeto privado, visible para el mantenedor con acceso a R2. La confirmación exige un número de incidencia devuelto por GitHub. Si GitHub no confirma un envío, consulta el Issue por ID antes de resolver la reserva en D1 para permitir otro intento.

## Firma y canal de actualizaciones

1. El propietario genera el par con `npx tauri signer generate --write-keys <ruta-segura-fuera-del-repo>`. Protege la clave privada con contraseña y guarda copia cifrada fuera de Git. La clave pública puede publicarse.
2. Crea el entorno `release` de GitHub Actions, limitado a la rama `main` y con revisión obligatoria. Configura en él los secretos `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Guarda en la variable de repositorio `STUDIO_UPDATER_PUBLIC_KEY` el **contenido** del archivo público. Las pull requests no tienen acceso a este entorno.
3. Ejecuta manualmente **Release (Windows, signed)** con la versión. Produce instalador, firma y `latest.json`, y crea un **borrador** de Release `v<VERSIÓN>` en este mismo repositorio. Publícalo a mano tras revisarlo. El instalador apunta a `https://github.com/yagues1/duovra/releases/latest/download/latest.json`.
4. Conserva siempre la misma clave pública: las instalaciones existentes solo aceptan actualizaciones firmadas con su pareja. La clave efímera de QA no sirve para producción y no debe reutilizarse.

**Estado actual:** la clave de producción y el entorno `release` aún no existen. Hasta crearlos no hay Releases públicas ni actualizaciones automáticas.

El updater compara SemVer, exige HTTPS también al descargar y verifica la firma y la versión incluida en ella. La firma de actualización de Tauri es independiente de Authenticode. En Windows, la acción **Reiniciar para actualizar** cierra la aplicación y abre el instalador visible después de verificar el archivo. Se puede descargar durante una tarea y completar la instalación cuando los agentes estén libres.

## Prueba local en WebView2

La variante `qa-loopback` permite confiar en una CA local mediante `STUDIO_QA_TLS_CERT_PEM`. Usa un certificado TLS para `127.0.0.1`, una clave efímera de Tauri y un identificador y nombre de aplicación exclusivos de QA. Compila una base `0.1.1` y un instalador `0.1.2` firmado. Configura el manifiesto de ambas compilaciones en `https://127.0.0.1:17443/latest.json` y el reporte en `https://127.0.0.1:17443/report`.

Ejecuta `node scripts/qa/distribution-server.mjs output/qa/distribution <instalador-firmado>`. Abre la base con el puerto CDP 9333, como indica `scripts/qa/webview.mjs`. Lanza `node scripts/qa/webview.mjs scripts/qa/distribution-webview.mjs output/qa/distribution/capturas` para validar el formulario, el canal HTTPS, los fallos de descarga y la verificación de firma y versión. En la base de QA instalada, `STUDIO_QA_INSTALL=1` también prueba el arranque de NSIS.

Referencias: [Tauri Updater](https://v2.tauri.app/plugin/updater/) · [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Cloudflare R2](https://developers.cloudflare.com/r2/get-started/workers-api/).
