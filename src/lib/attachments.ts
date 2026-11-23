// Tratamiento real de los adjuntos (AUD-005). Refleja lo que hace el backend, sin prometer más:
// - Imágenes png/jpg/jpeg/gif/webp: Claude Code las recibe incrustadas en base64 si ocupan
//   ≤ 5 MB (src-tauri/src/agents/claude.rs); Codex las recibe como `localImage`, que la CLI
//   carga y adjunta (src-tauri/src/agents/codex.rs).
// - Cualquier otro archivo o carpeta: solo se envía su ruta en el texto del mensaje
//   (`with_attachment_note`). El agente tiene que abrirlo con sus herramientas, lo que puede
//   requerir permiso según el modo configurado.
import type { AgentId, ModelInfo } from './types';
import { basename } from './format';
import { tr } from '../i18n';

export const CLAUDE_IMAGE_MAX = 5 * 1024 * 1024;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
/** Formatos que no son texto: el agente recibe la ruta, pero puede no ser capaz de leerlos. */
const BINARY_RE = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|zip|7z|rar|tar|gz|exe|dll|msi|bin|iso|mp3|mp4|mov|wav|avi|mkv|psd|bmp|tiff?|ico|heic|sqlite3?|db)$/i;

export interface AttachmentMeta {
  path: string;
  exists: boolean;
  isDir: boolean;
  size: number;
}

export type Treatment = 'inline' | 'reference' | 'binary' | 'unsupported';

export interface Classified {
  path: string;
  name: string;
  treatment: Treatment;
  /** Etiqueta breve (chip). */
  short: string;
  /** Explicación completa (tooltip). */
  detail: string;
}

export function isImagePath(p: string) {
  return IMAGE_RE.test(p);
}

function mb(n: number) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function classifyAttachment(meta: AttachmentMeta | undefined, path: string, agent: AgentId, model?: ModelInfo): Classified {
  const name = basename(path);
  const base = { path, name };
  const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
  if (meta && !meta.exists)
    return { ...base, treatment: 'unsupported', short: tr('No encontrado'), detail: tr('No existe {path}. Si lo envías, el agente solo recibirá una ruta que no puede abrir.', { path }) };
  if (meta?.isDir)
    return { ...base, treatment: 'reference', short: tr('Carpeta por ruta'), detail: tr('Se envía la ruta de la carpeta. {agent} puede explorarla con sus herramientas si lo necesita.', { agent: agentName }) };
  if (isImagePath(path)) {
    if (agent === 'codex' && model?.inputModalities && !model.inputModalities.includes('image'))
      return { ...base, treatment: 'unsupported', short: tr('Imagen no admitida'), detail: tr('El modelo {model} no declara entrada de imágenes en su catálogo.', { model: model.label }) };
    if (agent === 'claude' && meta && meta.size > CLAUDE_IMAGE_MAX)
      return { ...base, treatment: 'reference', short: tr('Imagen por ruta'), detail: tr('Ocupa {size}: supera los 5 MB que se incrustan para Claude Code, así que solo se envía su ruta.', { size: mb(meta.size) }) };
    return { ...base, treatment: 'inline', short: tr('Imagen incluida'), detail: tr('{agent} recibe la imagen dentro del mensaje: puede verla sin abrir el archivo.', { agent: agentName }) };
  }
  if (BINARY_RE.test(path))
    return { ...base, treatment: 'binary', short: tr('Por ruta · binario'), detail: tr('Solo se envía la ruta. Es un formato binario: {agent} necesitará una herramienta capaz de leerlo y puede no conseguirlo.', { agent: agentName }) };
  return { ...base, treatment: 'reference', short: tr('Por ruta'), detail: tr('No se copia su contenido: se envía la ruta y {agent} lo abre con sus herramientas si lo necesita (puede pedir permiso).', { agent: agentName }) };
}

/** Resumen de una línea para el compositor. */
export function summarize(list: Classified[]): string {
  const n = (t: Treatment) => list.filter((c) => c.treatment === t).length;
  const parts: string[] = [];
  const inline = n('inline');
  const refs = n('reference') + n('binary');
  const bad = n('unsupported');
  if (inline) parts.push(inline === 1 ? tr('1 imagen incluida en el mensaje') : tr('{n} imágenes incluidas en el mensaje', { n: inline }));
  if (refs) parts.push(refs === 1 ? tr('1 como ruta: el agente lo lee con herramientas') : tr('{n} como ruta: el agente los lee con herramientas', { n: refs }));
  if (bad) parts.push(tr('{n} sin poder usarse', { n: bad }));
  return parts.join(' · ');
}
