# Distribución para Windows

Duovra 1.0.1 apunta a Windows 11 x64 y requiere Microsoft Edge WebView2 Evergreen Runtime. Cada agente requiere su CLI instalada y una sesión iniciada. [Descargas de WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

## Instalar y actualizar

Para pasar de **1.0.0 a 1.0.1**, cierra Duovra, respalda toda la carpeta `%APPDATA%\dev.duovra.studio.beta` e instala manualmente `Duovra-1.0.1-windows-x64-setup.exe` desde GitHub Releases cuando esté disponible. Cuando el asistente detecte 1.0.0, elige **No desinstalar** para instalar encima. El instalador NSIS por usuario reutiliza el perfil de Windows, con sus proyectos, conversaciones, borradores y ajustes. El actualizador de 1.0.0 está desactivado. [GitHub Releases](https://github.com/yagues1/duovra/releases)

Para usar el ZIP portátil, extráelo entero y mantén `WebView2Loader.dll` junto a `duovra.exe`. La copia portátil comparte el mismo perfil de Windows. Al actualizar desde Duovra, NSIS reabre la instalación registrada. Para seguir usando una copia extraída, descarga y extrae el ZIP nuevo.

Comprueba `SHA256SUMS.txt` tras descargar los paquetes.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\Duovra-1.0.1-windows-x64-setup.exe
```

Desde 1.0.1, Duovra comprueba el canal al iniciar y cada cuatro horas si la opción está activada. Puedes buscar manualmente en **Ajustes → Actualizaciones y avisos**. El indicador de la barra lateral abre las notas. **Actualizar ahora** autoriza la descarga, verificación e instalación. Si hay agentes activos, Duovra espera o permite detener sus tareas expresamente. Guarda los borradores, cierra para ejecutar NSIS en modo de progreso, reabre automáticamente y confirma la versión instalada. Si NSIS falla después de que Duovra haya salido, vuelve a abrir Duovra para ver el resultado.

## Reportes y privacidad

**Reportar un error** abre el formulario con borrador local. El envío requiere consentimiento para los datos del formulario, versión, plataforma, identificador, fecha y captura opcional. Revisa lo que escribes y adjuntas. Duovra aplica filtros a datos sensibles comunes y adjunta únicamente lo indicado en el formulario.

El Worker existente en `https://duovra-bug-reports.duovra.workers.dev/report` registra el texto en el repositorio privado `yagues1/duovra-reports`, devuelve el número de incidencia y conserva la correspondencia entre UUID e incidencia en D1. Las capturas se guardan en D1 privado, con R2 privado como alternativa si se configura el binding `CAPTURES`. `GITHUB_ISSUES_TOKEN` es un secreto del Worker con permiso de escritura en Issues del repositorio receptor.

Se mantienen los límites por tamaño, IP y servicio. Un reintento con el mismo UUID devuelve el recibo existente una vez registrada la incidencia. Ante un resultado ambiguo de GitHub, D1 conserva la reserva para evitar otra incidencia. Si el reporte queda pendiente, el operador debe buscar el UUID en GitHub y conciliar la fila de D1 antes de liberar la reserva. La configuración de ejemplo y el esquema están en [services/bug-reports](../services/bug-reports).

## Perfiles y respaldos

| Datos | Ubicación |
| --- | --- |
| Proyectos, historial, borradores, ajustes y cola | `%APPDATA%\dev.duovra.studio.beta\studio.sqlite3` |
| Estado y caché de WebView2 | `%LOCALAPPDATA%\dev.duovra.studio.beta` |
| Credenciales y sesiones de agentes | Configuración de cada CLI o directorio de cuenta elegido en Duovra |

**Copias de seguridad (1.0.2).** En **Ajustes → Datos y diagnóstico** puedes crear un archivo `.duovra`. Es una instantánea consistente de la base SQLite, incluido el WAL, con proyectos, conversaciones, mensajes, borradores, ajustes, cola, fondos personalizados y las cuentas registradas (solo etiquetas y rutas de configuración). No copia las carpetas de código, las credenciales de Claude Code ni de Codex, ni las cachés de WebView2.

Al restaurar, Duovra valida la integridad y el formato de la copia, muestra su contenido y pide confirmación. Después guarda el estado actual en `backups\antes-de-restaurar-*.duovra`, aplica la copia al reiniciar y, si la copia no abre, devuelve tus datos anteriores. No se restaura mientras un agente esté trabajando. Las copias contienen datos privados: guárdalas en un lugar seguro.

**Beta 2.** Comparte perfil con las versiones estables. Cierra una edición antes de abrir la otra y conserva los datos si desinstalas la beta. Duovra crea `studio.pre-1.0.0.sqlite3.bak` antes de migrar una base sin la tabla de imágenes de fondo.

**0.5.1 o anterior.** Respalda `%APPDATA%\dev.claudecodexstudio.app`. Para migrar el historial, cierra Duovra y copia `studio.sqlite3` y su WAL asociado desde ese respaldo a un perfil estable que todavía carezca de base de datos. Duovra migra la copia y guarda `studio.pre-0.6.0.sqlite3.bak` para esquemas antiguos. Si el perfil estable ya tiene historial, conserva ambos perfiles.

Para restaurar un respaldo, cierra las ediciones y mueve primero el perfil actual a otra carpeta. Restaura SQLite en un directorio sin un WAL ajeno. Trata las copias como datos privados. Usa el canal indicado para reportar vulnerabilidades. [Política de seguridad](../SECURITY.md)

## Compilar y preparar una release

En Windows x64 necesitas Node.js 22, npm, Git, Rust estable, Microsoft C++ Build Tools con SDK de Windows y WebView2. [Requisitos de Tauri](https://v2.tauri.app/start/prerequisites/)

```powershell
npm ci
npm test
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build:windows -- --unsigned
```

La CI de Pull Requests tiene permisos de lectura y genera paquetes de verificación sin secretos en `output/distribution/Duovra-<versión>-unsigned/`. Esos binarios llevan ambos servicios desactivados.

Para preparar paquetes firmados usa `npm run build:windows` con `TAURI_SIGNING_PRIVATE_KEY` y, si corresponde, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` en el entorno del proceso. En Actions, ejecuta manualmente **Preparar release firmada de Windows** desde la rama principal. Lee los secretos del entorno protegido `release` y entrega paquetes para revisión. El flujo solo tiene permisos de lectura sobre el repositorio. Mantén la clave privada cifrada con un respaldo seguro. La clave pública está en `tauri.conf.json`.

En `output/distribution/Duovra-<versión>/` quedan el instalador x64, ZIP portátil, firma `.exe.sig`, `latest.json`, hashes, notas y referencia al commit. Tauri firma el instalador y vincula la versión a la firma. El actualizador exige ambas verificaciones. El manifiesto sirve la entrada `windows-x86_64` y apunta al instalador por HTTPS. Windows puede mostrar SmartScreen porque Tauri y Authenticode son firmas independientes. [Actualizador de Tauri](https://v2.tauri.app/plugin/updater/)

Cuando se apruebe una release estable, adjunta los dos paquetes, la firma, `latest.json` y los hashes al tag de la versión. Usa `notes.md` para el cuerpo de la release. GitHub debe marcarla como la última estable para que resuelva `/releases/latest/download/latest.json`. Para pruebas usa un producto, perfil, clave y URL de QA independientes del canal público.


## Verificar el flujo en Windows

```powershell
node scripts/qa/update-flow-build.mjs
node scripts/qa/update-flow-lifecycle.mjs
node scripts/qa/update-flow-lifecycle.mjs --live-report
```

La prueba usa Git para Windows con OpenSSL (o la ruta en `DUOVRA_QA_OPENSSL`), una CA local, una clave desechable y el producto **Duovra Distribution QA** con su propio perfil. El canal escucha solo en loopback. La segunda orden instala y actualiza ese producto con un proveedor simulado, verifica los fallos previstos y comprueba el perfil tras reiniciar. La tercera envía una incidencia sintética con el icono del proyecto al Worker real y requiere `gh` con acceso de lectura al repositorio de reportes para comprobar el recibo. Ninguna prueba requiere cuentas de proveedores de modelos.
