// Diffs unificados para el panel de consulta.
// Codex entrega el diff ya calculado; Claude Code entrega texto anterior y nuevo (Edit),
// así que aquí se calcula un diff por líneas (LCS) con contexto.

export type DiffLine =
  | { type: 'hunk'; text: string }
  | { type: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }
  | { type: 'meta'; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(oldText: string, newText: string, context = 3): DiffLine[] {
  // Un texto vacío no tiene líneas (archivo nuevo o eliminado).
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [
      { type: 'meta', text: 'El cambio es demasiado grande para calcular el diff en la interfaz.' },
      ...a.map((t, i) => ({ type: 'del' as const, text: t, oldNo: i + 1, newNo: null })),
      ...b.map((t, i) => ({ type: 'add' as const, text: t, oldNo: null, newNo: i + 1 })),
    ];
  }
  // Tabla LCS compacta (de abajo arriba).
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const ops: Array<{ type: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) {
      ops.push({ type: 'add', text: b[j], oldNo: null, newNo: j + 1 });
      j++;
    } else {
      ops.push({ type: 'del', text: a[i], oldNo: i + 1, newNo: null });
      i++;
    }
  }
  // Agrupa en bloques con `context` líneas alrededor de cada cambio.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.type !== 'ctx') for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true;
  });
  const out: DiffLine[] = [];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && keep[k]) k++;
    const block = ops.slice(start, k);
    const o = block.find((x) => x.oldNo != null)?.oldNo ?? 0;
    const nn = block.find((x) => x.newNo != null)?.newNo ?? 0;
    const oc = block.filter((x) => x.type !== 'add').length;
    const nc = block.filter((x) => x.type !== 'del').length;
    out.push({ type: 'hunk', text: `@@ -${o},${oc} +${nn},${nc} @@` });
    out.push(...block);
  }
  return out;
}

/** Interpreta un diff unificado de texto (el que produce Codex o git). */
export function parseUnified(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      out.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      out.push({ type: 'meta', text: line });
    } else if (line.startsWith('+')) {
      out.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith('\\')) {
      out.push({ type: 'meta', text: line });
    } else if (out.length) {
      out.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  while (out.length && out[out.length - 1].type === 'ctx' && (out[out.length - 1] as { text: string }).text === '') out.pop();
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Primera línea nueva modificada: se usa para resaltar y desplazar la vista previa. */
export function firstChangedLine(lines: DiffLine[]): number | null {
  for (const l of lines) if (l.type === 'add' && l.newNo != null) return l.newNo;
  return null;
}
