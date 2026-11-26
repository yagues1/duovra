import { useId, useState } from 'react';
import { GitCompare } from 'lucide-react';
import type { AgentId, ReviewTarget } from '../../lib/types';
import { AGENT_NAME } from '../../lib/format';
import { tr } from '../../i18n';

export type ReviewKind = ReviewTarget['type'];

/** Etiqueta que guarda el historial para una revisión de Codex (el App Server no recibe este texto). */
export function reviewLabel(target: ReviewTarget): string {
  switch (target.type) {
    case 'uncommittedChanges': return tr('/review · cambios sin commit');
    case 'baseBranch': return tr('/review · comparación con {branch}', { branch: target.branch });
    case 'commit': return tr('/review · commit {sha}', { sha: target.sha.slice(0, 12) });
    case 'custom': return tr('/review · {instructions}', { instructions: target.instructions });
  }
}

/**
 * Destino de la revisión (1.0.11, fase 5), según las opciones reales de cada proveedor:
 * - Codex: `review/start` con `uncommittedChanges`, `baseBranch`, `commit` o `custom` (esquema 0.172.0).
 * - Claude Code: su comando `/code-review` admite un destino opcional (rama, PR o ruta), no un commit ni
 *   instrucciones libres. Duovra lo prepara en el compositor como comando del proveedor; nunca añade
 *   `--fix` ni `--comment`, que modificarían archivos o publicarían comentarios.
 * Ninguna opción modifica archivos al iniciarse.
 */
export function ReviewForm({ agent, onStart, onCancel }: {
  agent: AgentId;
  onStart: (target: ReviewTarget) => void;
  onCancel: () => void;
}) {
  const kinds: ReviewKind[] = agent === 'codex' ? ['uncommittedChanges', 'baseBranch', 'commit', 'custom'] : ['uncommittedChanges', 'baseBranch'];
  const [kind, setKind] = useState<ReviewKind>('uncommittedChanges');
  const [value, setValue] = useState('');
  const name = useId();
  const field = useId();
  const needsValue = kind !== 'uncommittedChanges';
  const target = (): ReviewTarget | null => {
    const v = value.trim();
    if (needsValue && !v) return null;
    switch (kind) {
      case 'uncommittedChanges': return { type: 'uncommittedChanges' };
      case 'baseBranch': return { type: 'baseBranch', branch: v };
      case 'commit': return { type: 'commit', sha: v };
      case 'custom': return { type: 'custom', instructions: v };
    }
  };
  const label: Record<ReviewKind, string> = {
    uncommittedChanges: tr('Cambios sin commit'),
    baseBranch: tr('Comparar con una rama'),
    commit: tr('Un commit concreto'),
    custom: tr('Instrucciones personalizadas'),
  };
  const submit = () => { const t = target(); if (t) onStart(t); };
  return (
    <form className="review-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="goal-title"><GitCompare size={13} aria-hidden />{tr('Revisión de código · {agent}', { agent: AGENT_NAME[agent] })}</div>
      <div role="radiogroup" aria-label={tr('Qué revisar')} className="review-kinds">
        {kinds.map((k, i) => (
          <label key={k} className="review-kind">
            <input type="radio" name={name} checked={kind === k} onChange={() => { setKind(k); setValue(''); }} data-popover-focus={i === 0 || undefined} />
            {label[k]}
          </label>
        ))}
      </div>
      {needsValue && (kind === 'custom'
        ? <textarea id={field} className="goal-field selectable" rows={3} value={value} onChange={(e) => setValue(e.target.value)}
            aria-label={label.custom} placeholder={tr('Qué debe comprobar la revisión…')} />
        : <input id={field} className="field review-input selectable" value={value} onChange={(e) => setValue(e.target.value)}
            aria-label={kind === 'baseBranch' ? tr('Rama base') : tr('Commit (SHA)')}
            placeholder={kind === 'baseBranch' ? 'main' : 'a1b2c3d'} spellCheck={false} autoComplete="off" />)}
      <p className="goal-note">
        {agent === 'codex'
          ? tr('Codex revisa con su método nativo en este hilo y muestra el resultado en el chat. Consume uso de tu cuenta y no modifica archivos.')
          : tr('Se prepara /code-review en el compositor para que lo envíes. Claude Code consume uso de tu cuenta; Duovra no añade --fix.')}
      </p>
      <div className="goal-actions">
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onCancel}>{tr('Cancelar')}</button>
        <button type="submit" className="btn btn-primary" disabled={!target()}>
          {agent === 'codex' ? tr('Iniciar revisión') : tr('Preparar /code-review')}
        </button>
      </div>
    </form>
  );
}
