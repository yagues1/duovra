// Tratamiento real de los adjuntos (AUD-005). Refleja lo que hace el backend, sin prometer más:
// - Imágenes png/jpg/jpeg/gif/webp: Claude Code las recibe incrustadas en base64 si ocupan
//   ≤ 5 MB (src-tauri/src/agents/claude.rs); Codex las recibe como `localImage`, que la CLI
//   carga y adjunta (src-tauri/src/agents/codex.rs).
// - Cualquier otro archivo o carpeta: solo se envía su ruta en el texto del mensaje
//   (`with_attachment_note`). El agente tiene que abrirlo con sus herramientas, lo que puede
//   requerir permiso según el modo configurado.
import type { AgentId, ModelInfo } from './types';
import { basename } from './format';

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
    return { ...base, treatment: 'unsupported', short: 'No encontrado', detail: `No existe ${path}. Si lo envías, el agente solo recibirá una ruta que no puede abrir.` };
  if (meta?.isDir)
    return { ...base, treatment: 'reference', short: 'Carpeta por ruta', detail: `Se envía la ruta de la carpeta. ${agentName} puede explorarla con sus herramientas si lo necesita.` };
  if (isImagePath(path)) {
    if (agent === 'codex' && model?.inputModalities && !model.inputModalities.includes('image'))
      return { ...base, treatment: 'unsupported', short: 'Imagen no admitida', detail: `El modelo ${model.label} no declara entrada de imágenes en su catálogo.` };
    if (agent === 'claude' && meta && meta.size > CLAUDE_IMAGE_MAX)
      return { ...base, treatment: 'reference', short: 'Imagen por ruta', detail: `Ocupa ${mb(meta.size)}: supera los 5 MB que se incrustan para Claude Code, así que solo se envía su ruta.` };
    return { ...base, treatment: 'inline', short: 'Imagen incluida', detail: `${agentName} recibe la imagen dentro del mensaje: puede verla sin abrir el archivo.` };
  }
  if (BINARY_RE.test(path))
    return { ...base, treatment: 'binary', short: 'Por ruta · binario', detail: `Solo se envía la ruta. Es un formato binario: ${agentName} necesitará una herramienta capaz de leerlo y puede no conseguirlo.` };
  return { ...base, treatment: 'reference', short: 'Por ruta', detail: `No se copia su contenido: se envía la ruta y ${agentName} lo abre con sus herramientas si lo necesita (puede pedir permiso).` };
}

/** Resumen de una línea para el compositor. */
export function summarize(list: Classified[]): string {
  const n = (t: Treatment) => list.filter((c) => c.treatment === t).length;
  const parts: string[] = [];
  const inline = n('inline');
  const refs = n('reference') + n('binary');
  const bad = n('unsupported');
  if (inline) parts.push(`${inline} ${inline === 1 ? 'imagen incluida' : 'imágenes incluidas'} en el mensaje`);
  if (refs) parts.push(`${refs} como ruta: el agente ${refs === 1 ? 'lo' : 'los'} lee con herramientas`);
  if (bad) parts.push(`${bad} sin poder usarse`);
  return parts.join(' · ');
}
