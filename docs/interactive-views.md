# Vistas interactivas de Duovra · Contrato v1

Claude Code y Codex pueden incluir un bloque Markdown con la etiqueta exacta `duovra-widget` y un objeto JSON. El cierre explícito de la cerca es obligatorio. Durante streaming, Duovra espera además el salto de línea que confirma el cierre. El mensaje original conserva el bloque para inspección, copia, búsqueda y relectura desde SQLite.

````markdown
```duovra-widget
{
  "version": 1,
  "title": "Doble de un valor",
  "state": {
    "n": { "type": "number", "initial": 2, "min": 0, "max": 100 }
  },
  "body": [
    { "type": "slider", "label": "Valor", "bind": "n" },
    { "type": "metric", "label": "Resultado", "value": { "op": "mul", "args": [{ "ref": "n" }, 2] } }
  ]
}
```
````

## Documento y parámetros

- Obligatorios `version: 1`, `title` y `body` (lista no vacía de componentes). `state` y `data` son diccionarios opcionales.
- Los identificadores empiezan por una letra ASCII, admiten letras, dígitos, guion y guion bajo, y tienen hasta 32 caracteres. Los nombres de Object.prototype y prototype están reservados.
- Toda propiedad no descrita se rechaza. Una referencia debe apuntar a una clave declarada en `state` y compatible con el uso que se haga de ella.
- El texto del esquema admite hasta 512 caracteres, con límites menores para títulos (100), etiquetas de componentes y opciones (100), etiquetas de columnas (80), opciones (80) y unidades (24). Usa texto plano sin etiquetas HTML ni URLs.

| Tipo de parámetro | Propiedades |
| --- | --- |
| `text` | `initial` de texto, `maxLength` entero opcional (512) y `required` booleano opcional (false). Un parámetro obligatorio vacío falla al validar el formulario. |
| `number` | `initial`, `min`, `max` y `step` positivo opcional (1, o la amplitud del intervalo si es menor). El parámetro sigue pasos desde min. |
| `choice` | `initial` y `options` con pares de texto `value`/ `label`. Cada valor debe ser único y el inicial debe existir. |
| `boolean` | `initial` booleano. |

## Componentes

Todos aceptan `showIf` opcional, una expresión booleana. El orden de `body` y `children` determina el orden de lectura y navegación.

| `type` | Propiedades específicas |
| --- | --- |
| `section`, `card` | `title` opcional, `children` y `layout` opcional (`stack` por defecto, o `grid` adaptable). |
| `text` | `value` escalar o expresión. |
| `metric` | `label`, `value` escalar, expresión o agregado, `unit` opcional, `digits` de 0 a 6 (2 por defecto). |
| `status` | `label` y `tone` (`neutral`, `success`, `warning`, `error`). |
| `textInput`, `numberInput`, `select`, `checkbox`, `slider`, `segmented` | `label` y `bind` al parámetro de tipo `text`, `number`, `choice`, `boolean`, `number` y `choice`, respectivamente. |
| `button` | `label` y `action`. |
| `table` | `id` único en el widget, `label`, `data`, `filter` opcional, `sortable` y `selectable` booleanos opcionales (false). |
| `chart` | `label`, `style` (`line` o `bar`) y `series`. `domain` opcional fija el eje vertical con `min` y `max`. El área del gráfico recorta valores fuera del eje y su tabla conserva el dato. |

## Datos, expresiones y acciones

Cada entrada de `data` tiene `columns` (lista de objetos con `key` única y `label`) y `rows` (listas con el mismo orden y longitud que las columnas). Las celdas contienen texto, números finitos o booleanos.

- Un filtro se escribe como `{ "column": "clave", "by": { "ref": "parametro" }, "mode": "equals" }`. Admite `equals` (igualdad estricta) y `contains` (búsqueda textual sin distinguir mayúsculas). `all` opcional indica el valor del parámetro que deja pasar todas las filas.
- Una expresión es un escalar, `{ "ref": "parametro" }` o `{ "op": "...", "args": [a, b] }`. Los operandos son escalares o referencias directas. `add`, `sub`, `mul`, `div`, `gt` y `gte` comparan u operan sobre números. `eq` comprueba igualdad entre valores del mismo tipo. `and` y `or` operan sobre booleanos.
- Un agregado de métrica usa `{ "op": "count", "data": "conjunto" }`, o `sum` / `average` con `column` numérica. Todos aceptan `filter`. Los cálculos indefinidos o fuera de rango se indican en la vista.
- Una serie puede usar `{ "data": "conjunto", "x": "etiqueta", "y": "valor" }` con `filter` opcional y columna `y` numérica. Para simular, usa `{ "from": expresiónNumérica, "to": expresiónNumérica, "points": 20, "curve": "linear" }`. La curva puede ser `linear` o `quadratic`, con muestras de inicio a fin.
- Una acción de botón admite `{ "type": "reset" }`, `{ "type": "validate" }`, `{ "type": "toggle", "bind": "booleano" }` o `{ "type": "set", "bind": "parametro", "value": escalar }`. Cada interacción aplica una sola acción. `validate` muestra el resultado local de la validación de los campos requeridos.

## Límites y aislamiento

Máximo de 65 536 unidades UTF-16 por bloque, 64 componentes, 6 niveles, 24 parámetros, 12 opciones por selector, 4 conjuntos, 150 filas y 10 columnas por conjunto, 3 000 celdas totales, 4 000 celdas renderizadas entre tablas, 96 puntos por gráfico, 384 puntos entre gráficos y 64 operaciones por widget. El rango numérico es ±1 000 000 000. Las referencias apuntan únicamente a valores escalares, sin recursión ni dependencias circulares. El estado temporal está acotado a los parámetros, la selección y orden de las tablas y el resultado de validación.

El renderizador lee el esquema validado y usa componentes React de Duovra y eventos nativos. Las cadenas solo se entregan como texto o valores de controles. El contrato carece de destinos de navegación, propiedades DOM arbitrarias, callbacks, estilos definidos por el proveedor y operaciones de red, archivos, base de datos o IPC. Tampoco ejecuta HTML ni JavaScript del proveedor. Los errores conservan la definición original como texto copiable. El Workbench usa los mismos componentes que la conversación y comparte el estado mientras la sesión del widget está abierta. El estado temporal no se guarda en SQLite. Al regresar a una conversación, el widget se reconstruye con los valores iniciales del esquema.

## Ejemplos y QA

La galería usa los fixtures de Codex y Claude Code para cargar la calculadora, el dashboard, la tabla, el formulario y la simulación sin invocar proveedores. Se ejecuta en Windows desde la raíz del proyecto, con WebView2 y las dependencias locales instaladas.

```powershell
node scripts/qa/execution-queue-build.mjs --interactive-views
node scripts/qa/execution-queue-webview.mjs --interactive-views --gallery
```

La build QA usa el identificador `dev.duovra.interactiveviews.qa`. El arnés usa perfiles de prueba y borra su proyecto y sus cuentas simuladas al cerrar. Los cinco esquemas viven en [interactive-views-content.mjs](../scripts/qa/interactive-views-content.mjs) y se pueden usar como referencia para pedir una vista al proveedor.

Las comprobaciones reproducibles usan la misma build portable y registran resultados en `output/qa/interactive-views`.

```powershell
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
node scripts/qa/execution-queue-webview.mjs --interactive-views --regression-visual
node scripts/qa/execution-queue-webview.mjs --interactive-views --agent-insights --regression-queue
```

## Mediciones y cobertura

- El build de Vite pasó de 358 134 a 359 221 bytes gzip en los JS y CSS que referencia el HTML inicial, un incremento del 0,30 %. Los cuatro archivos específicos de widgets suman 11 829 bytes gzip y se cargan bajo demanda. WebView2 confirmó que un bloque pendiente no carga el motor.
- Las pruebas usan perfiles y conversaciones de QA con los dos adaptadores de protocolo simulados. La cobertura incluye streaming, historial, autoría del turno, cola, Steer, tareas, subagentes, estadísticas, búsqueda, controles por teclado, Workbench y movimiento reducido.
- Las pruebas adversarias verifican rechazo de propiedades, componentes, expresiones, acciones y referencias inválidas, límites numéricos y de tamaño, texto HTML y URLs. La comprobación en WebView2 conserva cada definición, observa red e IPC y vuelve a probar un widget válido al cerrar el inválido.
- La regresión de las vistas estáticas filtra recursos CSS externos antes de aplicar la CSP del iframe HTML. Las hojas de estilo con esas referencias se descartan completas. Los fragmentos SVG locales y el CSS sin recursos externos se conservan.

## Referencia

Duovra muestra el bloque visual dentro de la respuesta, aplica límites al intérprete declarativo y aísla las vistas estáticas en un iframe.
