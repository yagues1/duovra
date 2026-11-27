import { useEffect, type ReactNode } from 'react';
import { BookMarked } from 'lucide-react';
import { useStore } from '../../state/store';
import { useContextStore } from '../../state/context';
import { modeHint, modeLabel, prefsOf, type TransferMode } from '../../lib/context';
import { displayTitle } from '../../lib/format';
import { Badge, Card, Field, Segmented, Select, Switch } from '../ui/Controls';
import { tr } from '../../i18n';

type GlobalMode = Extract<TransferMode, 'auto' | 'economy' | 'full'>;
const GLOBAL_MODES: GlobalMode[] = ['auto', 'economy', 'full'];

function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useStore((s) => s.settings[key] as T | undefined);
  const set = useStore((s) => s.setSetting);
  return [v ?? fallback, (x: T) => void set(key, x)];
}

/**
 * Ajustes → Contexto y memoria (1.0.11). Valores globales para todas las conversaciones; la
 * conversación abierta puede conservar su propio modo (las elecciones anteriores no se pierden).
 * El motor decide el resto automáticamente.
 */
export function ContextSettings({ header }: { header: ReactNode }) {
  const [enabled, setEnabled] = useSetting('context.enabled', true);
  const [mode, setMode] = useSetting<GlobalMode>('context.mode', 'auto');
  const [resend, setResend] = useSetting('context.resendAfterCompaction', true);
  const globalMode: GlobalMode = GLOBAL_MODES.includes(mode) ? mode : 'auto';
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId && c.started));
  const memories = useContextStore((s) => (conv ? s.memories[conv.id] : undefined));
  const load = useContextStore((s) => s.loadMemories);
  const setPrefs = useContextStore((s) => s.setPrefs);
  const openDialog = useContextStore((s) => s.open);

  useEffect(() => { if (conv) void load(conv.id).catch(() => undefined); }, [conv?.id, load]);

  const own = conv?.contextPrefs?.mode ? prefsOf(conv.contextPrefs).mode : null;
  const active = (memories ?? []).filter((m) => !m.archived).length;
  const globalLabel = enabled ? modeLabel(globalMode) : modeLabel('off');
  const convOptions = [
    { value: 'global', label: tr('Ajuste global ({mode})', { mode: globalLabel }) },
    ...(['auto', 'economy', 'full', 'off'] as TransferMode[]).map((m) => ({ value: m, label: modeLabel(m) })),
    // Elección de versiones anteriores: se conserva y se muestra, pero no se ofrece.
    ...(own === 'custom' ? [{ value: 'custom', label: modeLabel('custom') }] : []),
  ];

  return (
    <>
      {header}
      <Card title={tr('Contexto compartido')}>
        <Field label={tr('Compartir contexto entre agentes')} hint={enabled
          ? tr('Cuando cambias de agente, Duovra le pasa automáticamente las instrucciones, los recuerdos y los mensajes que todavía no conoce.')
          : tr('Cada agente solo conoce su propia sesión. Puede desconocer el trabajo del otro.')}>
          <Switch label={tr('Compartir contexto entre agentes')} checked={enabled} onChange={setEnabled} />
        </Field>
        <Field label={tr('Modo de transferencia')} hint={modeHint(globalMode)}>
          <Segmented id="context-mode" value={globalMode} onChange={(v) => setMode(v)}
            options={GLOBAL_MODES.map((m) => ({ value: m, label: modeLabel(m) }))} />
        </Field>
      </Card>
      <Card title={tr('Compactación')}>
        <Field label={tr('Compactación automática')} hint={tr('Claude Code y Codex compactan su propio contexto cuando lo necesitan. Duovra no lanza compactaciones por su cuenta; puedes pedir una desde el indicador del compositor.')}>
          <Badge tone="neutral">{tr('La gestiona cada proveedor')}</Badge>
        </Field>
        <Field label={tr('Recordar la memoria tras compactar')} hint={tr('Después de una compactación, vuelve a enviar las instrucciones y los recuerdos con el siguiente mensaje para que no se pierdan en el resumen.')}>
          <Switch label={tr('Recordar la memoria tras compactar')} checked={resend} onChange={setResend} />
        </Field>
      </Card>
      {conv && (
        <Card title={tr('Conversación actual')} description={displayTitle(conv.title)}>
          <Field label={tr('Modo de esta conversación')} hint={own ? tr('Esta conversación usa su propio modo.') : tr('Sigue el ajuste global.')}>
            <Select label={tr('Modo de esta conversación')} value={own ?? 'global'} options={convOptions}
              onChange={(v) => void setPrefs(conv.id, { mode: v === 'global' ? null : (v as TransferMode) })} />
          </Field>
          <Field label={tr('Memoria compartida')} hint={memories
            ? active === 1 ? tr('1 recuerdo. Solo se usa en esta conversación.') : tr('{n} recuerdos. Solo se usan en esta conversación.', { n: active })
            : tr('Solo se usa en esta conversación.')}>
            <button type="button" className="btn" onClick={() => openDialog({ kind: 'memory', conversationId: conv.id })}>
              <BookMarked size={14} aria-hidden />{tr('Gestionar memoria')}
            </button>
          </Field>
        </Card>
      )}
    </>
  );
}
