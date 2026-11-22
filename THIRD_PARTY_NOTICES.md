# Third-party notices

Duovra's own source code is licensed under the [MIT License](LICENSE). Third-party components keep their own licenses and notices:

- **Notices shipped with the app:** [runtime notices](public/third-party-notices.txt) and [license texts](public/licenses/), including those for the visual and search code, fonts, renderers, image codecs and WebView2 loader.
- **Dependency notices:** the Windows build includes `DEPENDENCY-NOTICES.txt` with package versions, published sources and license and notice files collected from the installed dependencies.
- **Full dependency list:** [`package-lock.json`](package-lock.json) for npm and [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) for Cargo. These lockfiles record the exact versions and integrity hashes of the distributed dependencies.

## Trademarks and agent identity

- *Claude* and *Claude Code* are trademarks of Anthropic, PBC. *OpenAI* and *Codex* are trademarks of OpenAI.
- Duovra identifies each agent by its name in text and by neutral glyphs drawn for this project: a terminal prompt `›_` for Claude Code and braces `{ }` for Codex. Neither glyph is a logo of Anthropic or OpenAI.
- Duovra doesn't include the Anthropic, Claude, OpenAI or Codex logos. Their brand guidelines require permission to use them in third-party products, and they wouldn't fall under this project's MIT license. References: [Anthropic trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines) · [OpenAI brand](https://openai.com/brand/).
- The Duovra name and logo (`assets/brand/`) identify this project. You can use them to refer to Duovra, but not in a way that suggests a fork or derivative is the official project.

## WebView2

The Windows packages include Microsoft's x64 `WebView2Loader.dll` from SDK 1.0.3800.47. The matching [SDK license](public/licenses/WebView2-SDK-LICENSE.txt) and [third-party notice](public/licenses/WebView2-SDK-NOTICE.txt) are shipped alongside it. The Evergreen Runtime is a system prerequisite. [Microsoft distribution guide](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution) · [SDK package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3800.47)

## Visual effects and search

Parts of the background renderer, settings, composer, search and visual preview code are Copyright (c) 2026 Leonxlnx and distributed under the [MIT License](public/licenses/Visual-effects-MIT.txt).

| Origen | Adaptación en Duovra |
| --- | --- |
| src/art/field.ts | src/lib/field/field.ts conserva FieldEngine, dither, patrones, pulsos y gobernador. Añade un cambio de apariencia de un solo fotograma mientras el host está en reposo. |
| src/art/field.worker.ts | src/lib/field/field.worker.ts: un único worker compartido que dibuja varios campos por id (conversación, vista previa y miniaturas), con textura, atlas, reposo y cierre por campo. |
| src/art/DitherField.tsx | src/lib/field/host.ts: worker compartido con recuento de usos, atlas de glifos para ASCII, calidad publicada en `<html>`. Conserva la detección de minimizado de WebView2 y los pulsos de Duovra. |
| src/art/Backdrop.tsx, shared/backdrop.ts, shared/protocol.ts (`BackdropConfig`) | src/lib/backdrop.ts y `PatternBackground` en src/components/shell/Background.tsx: patrones, tratamientos, los ocho presets, normalización, intensidad → ganancia y opacidad, celda por detalle. Duovra añade el color por agente, la quietud ámbar al esperar autorización y un velo de lectura. |
| src/features/settings/Settings.tsx, settings.css, Background.tsx, parts.tsx, background.css | src/components/settings/SettingsView.tsx (diálogo superpuesto), BackgroundSettings.tsx y BackgroundControls.tsx adaptan la estructura: navegación lateral, filas, galería de presets y controles plegados. Implementación propia sobre `<dialog>` nativo. |
| src/ui/index.tsx (Slider, Switch, Segmented), src/styles/ui.css, src/styles/tokens.css | src/components/ui/Controls.tsx, src/styles/settings.css y src/styles/tokens.css: aspecto táctil y material Liquid Glass (aro especular, borde interior, brillo, sombras, desenfoque, grano), con tokens de Duovra. |
| src/features/composer/composer.css (`.cmp-card`) | src/styles/composer.css: material del compositor, elevación con foco y degradación por calidad. No se incorpora el motor líquido de envío (liquid.ts, liquid-gl.ts). |

| src/lib/fuzzy.ts | src/lib/fuzzy.ts conserva el ranking aproximado para la paleta y las menciones del compositor. |
| src/features/session/find.ts | src/lib/conversationFind.ts adapta las coincidencias y la navegación circular a mensajes y operaciones de Duovra. |
| src/features/genui/mermaid.ts, src/features/genui/blocks.tsx | src/lib/visual/mermaid.ts y el componente Markdown de Duovra adaptan la carga diferida cerca del viewport, los renderizados secuenciales, y el retorno al código ante un error. |
| src/features/genui/WidgetFrame.tsx, src/components/CodeBlock.tsx, src/features/rail/FilePreview.tsx | Referencias para aislar contenido y ofrecer acceso a vista previa y código desde bloques y archivos. El visor estático utiliza iframe sin permisos y el lector de rutas seguras de Duovra. |
| src/features/rail/FilesTab.tsx | src/components/panel/WorkspaceViews.tsx adapta el índice de cambios por archivo y sus carpetas ascendientes. |

El SVG de marca y las mascotas proceden de Duovra y su prototipo B. El motor de fondos dibuja sobre Canvas.

## Renderizadores visuales

- Mermaid 12.3.0, MIT. Licencia en [public/licenses/Mermaid-MIT.txt](public/licenses/Mermaid-MIT.txt).
- parse5 8.1.1, MIT. Licencia en [public/licenses/parse5-MIT.txt](public/licenses/parse5-MIT.txt).
- Mermaid's ELK layout includes **elkjs 0.12.1**, distributed under EPL-2.0. The license and the source locations for the JavaScript wrapper and Eclipse Layout Kernel are included with the downloads. [ELK license](public/licenses/ELK-EPL-2.0.md) · [elkjs 0.12.1](https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317) · [Eclipse ELK 0.12.1](https://github.com/eclipse-elk/elk/tree/3aa3b9fb98d8f9a41285b3061cff5efe79ed2ba4)

## MPL-covered Rust code

Published crate sources for the MPL-2.0 components listed in the Windows dependency graph are linked in the distribution notices. [MPL-2.0](public/licenses/MPL-2.0.txt) · [Runtime notices](public/third-party-notices.txt)
