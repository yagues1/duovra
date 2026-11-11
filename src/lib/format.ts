import type { AgentId } from './types';

export const AGENT_NAME: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' };

export const EFFORT_LABEL: Record<string, string> = {
  none: 'Sin razonamiento',
  minimal: 'Mínimo',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  xhigh: 'Muy alto',
  max: 'Máximo',
  ultra: 'Ultra',
};

export function effortLabel(e: string | null | undefined): string {
  if (!e) return 'Predeterminado';
  return EFFORT_LABEL[e] ?? e;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)} k`;
  return String(n);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
export function fmtRelative(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'ahora';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

export function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

export function relativeTo(path: string, root: string | undefined): string {
  if (!root) return path;
  const a = path.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  return a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : path;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rs: 'rust', py: 'python', json: 'json', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  md: 'markdown', toml: 'ini', ini: 'ini', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash',
  ps1: 'powershell', go: 'go', java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', sql: 'sql',
};
export function langFromPath(p: string): string | undefined {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext];
}

export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Codex en Windows envuelve los comandos en PowerShell (`powershell.exe -Command '…'`).
 * Para mostrarlos se extrae el comando interior; el original sigue disponible en el panel.
 */
export function displayCommand(cmd: string | null | undefined): string {
  if (!cmd) return '';
  const c = cmd.trim().replace(/\\\\/g, '\\');
  const single = /^"?[^"]*(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+'([\s\S]*)'$/i.exec(c);
  if (single) return single[1].replace(/''/g, "'");
  const double = /^"?[^"]*(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+"([\s\S]*)"$/i.exec(c);
  if (double) return double[1].replace(/`"/g, '"').replace(/\\"/g, '"');
  return c;
}
