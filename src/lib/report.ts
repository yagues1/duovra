export const CATEGORIES = {
  funcional: 'Funcional',
  visual: 'Visual',
  rendimiento: 'Rendimiento',
  agente: 'Agente',
  archivos: 'Archivos',
  otro: 'Otro',
} as const;

export type Category = keyof typeof CATEGORIES;
export const REPORT_LIMITS = { title: 120, description: 4000, steps: 4000, expected: 2000 };
export const MAX_CAPTURE_BYTES = 1_000_000;
export const MAX_REPORT_BYTES = 1_500_000;

export type ReportDraft = {
  title: string;
  description: string;
  steps: string;
  expected: string;
  category: Category;
  consent: boolean;
};
export type Report = ReportDraft & {
  id: string;
  version: string;
  platform: string;
  capture?: string;
};

export function sanitizeReportText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, '[clave privada oculta]')
    .replace(/\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/gi, '[token oculto]')
    .replace(/\bBearer[ \t]+[a-z0-9._~+/=-]+/gi, 'Bearer [oculto]')
    .replace(/\b((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|secret|password|contraseña)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[oculto]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[correo oculto]')
    .replace(/(?:[a-z]:[\\/](?:users|documents and settings)[\\/]|\/(?:home|Users)\/)[^\\/\r\n"'<>|]+/gi, '[perfil local]')
    .trim();
}

export function normalizeDraft(draft: ReportDraft): ReportDraft {
  return {
    title: sanitizeReportText(draft.title).replace(/[\n\t]+/g, ' ').replaceAll('@', '＠'),
    description: sanitizeReportText(draft.description),
    steps: sanitizeReportText(draft.steps),
    expected: sanitizeReportText(draft.expected),
    category: draft.category,
    consent: draft.consent,
  };
}

export function invalidField(draft: ReportDraft): keyof ReportDraft | undefined {
  for (const [field, limit] of Object.entries(REPORT_LIMITS) as [keyof typeof REPORT_LIMITS, number][]) {
    if (typeof draft[field] !== 'string' || draft[field].length > limit || (field !== 'expected' && !draft[field].trim())) return field;
  }
  if (!Object.hasOwn(CATEGORIES, draft.category)) return 'category';
  if (draft.consent !== true) return 'consent';
}

export function issueBody(report: Report, date: string, captureStored = false) {
  const section = (label: string, value: string) =>
    `### ${label}\n\n${value.split('\n').map((line) => `    ${line}`).join('\n')}`;
  return [
    section('Descripción', report.description),
    section('Pasos para reproducir', report.steps),
    ...(report.expected ? [section('Resultado esperado', report.expected)] : []),
    section('Datos del reporte', [
      `Versión: ${report.version}`, `Plataforma: ${report.platform}`,
      `Categoría: ${CATEGORIES[report.category]}`, `ID: ${report.id}`, `Fecha (UTC): ${date}`,
      ...(captureStored ? [`Captura privada: reports/${report.id}.jpg`] : []),
    ].join('\n')),
  ].join('\n\n');
}

export function confirmedReport(result: unknown, id: string): result is { id: string; issueNumber: number } {
  if (!result || typeof result !== 'object') return false;
  const data = result as Record<string, unknown>;
  return data.id === id && typeof data.issueNumber === 'number' && Number.isSafeInteger(data.issueNumber) && data.issueNumber > 0;
}
