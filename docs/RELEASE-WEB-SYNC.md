# Publicar Duovra Desktop y sincronizar la web

Cada release estable de Desktop incluye la actualización de la web oficial. La publicación termina al verificar la coherencia entre GitHub, el actualizador y las páginas públicas en español e inglés. Prepara ambos cambios para que el intervalo entre publicación y despliegue sea breve.

## 1. Publicar Desktop

1. Actualiza `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` y la entrada de Duovra en `src-tauri/Cargo.lock`. Prepara las notas ES/EN en `CHANGELOG.md` y revisa la documentación de instalación. Ajustes muestra la versión que devuelve Tauri.
2. Ejecuta `npm test`, `npm run build` y la CI de Windows. Integra la PR en `main` y ejecuta **Preparar release firmada de Windows** desde el commit que se va a etiquetar. El entorno `release` tiene la clave existente. Conserva el identificador, la clave pública y el endpoint del actualizador. [Flujo y formatos de distribución](distribution.md)
3. Descarga los artefactos del workflow. Contrasta los hashes y el commit de `build.json`. Prueba el instalador y el ZIP en un Windows desechable. Comprueba que el instalador sustituye a la versión estable anterior y conserva un proyecto, una conversación y un borrador de prueba. Comprueba que `latest.json` contiene esa versión nueva, la plataforma `windows-x86_64`, el instalador HTTPS correcto y la misma firma que el archivo `.exe.sig`. Verifica la firma Tauri y la versión firmada con la clave pública que ya trae la versión anterior. Registra Authenticode por separado.
4. Etiqueta el commit compilado como `v<versión>`. Prepara un borrador de GitHub Release con las notas bilingües, el instalador x64, el ZIP portátil, la firma, `latest.json`, `SHA256SUMS.txt` y `build.json`. Reutiliza la etiqueta o el borrador si ya existen y corresponden al mismo commit. Confirma los adjuntos y publícala como la última versión estable cuando pasen las comprobaciones de firma y compatibilidad.
5. Descarga los dos paquetes públicos y contrasta los hashes con los del workflow. Verifica `releases/latest/download/latest.json` y prueba desde una copia de la versión anterior que el canal detecta, descarga, verifica e instala la actualización. Reabre la app y comprueba la versión y el perfil de prueba. Usa un entorno aislado de la instalación personal.

## 2. Sincronizar la web

1. Abre el proyecto existente `duovra-web-prototype/`. Actualiza la versión en `src/lib/site.ts` y comprueba los nombres de los adjuntos. El enlace general puede usar `/releases/latest`. El instalador y el ZIP actuales incluyen la versión en el nombre, por lo que los enlaces se construyen con la etiqueta y la versión del archivo. Así, ambas páginas anuncian el mismo paquete que ofrecen para descargar. [Enlaces de GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
2. Revisa los textos ES/EN, las novedades, las funcionalidades nuevas o retiradas y los requisitos de instalación. Si cambia Desktop, compara el hero, las demostraciones de agentes y Workbench y las capturas con una build de distribución. Actualiza los ejemplos afectados y sustituye las capturas correspondientes en ambos idiomas. Conserva la estructura, el movimiento reducido y la navegación.
3. Construye la web con `npm run build` y sírvela localmente con `node node_modules/next/dist/bin/next start -p 3218`. Ejecuta `npm run qa:release -- http://localhost:3218`. Abre ambas páginas y usa los controles de las demostraciones en escritorio y móvil.
4. Guarda los cambios en Git y despliega desde la vinculación existente `duovra-web-preview` del equipo `Yagues`. Usa el despliegue de producción preparado y promuévelo después de comprobar ambas rutas. [Vercel CLI](https://vercel.com/docs/cli/deploy)

   ```powershell
   vercel deploy --prod --skip-domain --scope yagues
   vercel promote "URL_DEL_DESPLIEGUE_VERIFICADO" --scope yagues
   ```

## 3. Comprobar la consistencia pública

- Ejecuta `npm run qa:release` en el proyecto web. Consulta la última release estable de GitHub y comprueba el idioma, la versión y los dos enlaces presentes en `/` y `/en`. Se puede ejecutar también contra una URL local, sin credenciales ni servicios nuevos. [API de la última release estable](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- Verifica que las descargas sirven esa versión, el instalador supera la verificación de Tauri y el canal conserva los paquetes de versiones anteriores.
- Recorre el hero, las demostraciones y la sección de Apariencia en ambos idiomas. Comprueba que la imagen y los textos muestran las mismas capacidades y que funcionan los controles. Confirma el 404 público de `/lab` y el 308 del alias anterior hacia el dominio principal conservando la ruta.
- Registra la etiqueta estable, el resultado de la actualización desde la versión anterior, el commit web y el despliegue de Vercel.

La comprobación automática detecta versiones y enlaces desfasados. La revisión visual sigue siendo parte de cada release. Conviene mantener la versión anunciada como dato local de la web, de modo que el cambio de GitHub active una comprobación de sincronización y el anuncio pase a producción junto con sus textos e imágenes.
