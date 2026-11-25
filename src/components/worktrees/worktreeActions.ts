import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errorText } from '../../lib/ipc';
import type { Integration, Worktree } from '../../lib/worktrees';
import { useStore } from '../../state/store';
import { promptDialog } from '../ui/Dialog';
import { tr } from '../../i18n';

export async function renameWorktreeFlow(worktree: Worktree) {
  const label = await promptDialog({ title: tr('Renombrar worktree'), body: tr('Solo cambia el nombre que ves en Duovra; la carpeta y la rama no cambian.'), confirmLabel: tr('Renombrar'), initial: worktree.label });
  if (!label) return;
  const state = useStore.getState();
  try {
    await api.worktreeRename(worktree.id, label);
    state.upsertWorktree({ ...worktree, label });
  } catch (err) {
    state.toast(errorText(err), 'error');
  }
}

export async function copyWorktreePath(worktree: Worktree) {
  await navigator.clipboard.writeText(worktree.path);
  useStore.getState().toast(tr('Ruta copiada'));
}

/** Vuelve a enlazar un worktree movido fuera de Duovra (`git worktree repair`). */
export async function repairWorktreeFlow(worktree: Worktree) {
  const picked = await openDialog({ directory: true, multiple: false, title: tr('Nueva ubicación de «{name}»', { name: worktree.label }) });
  if (!picked || Array.isArray(picked)) return;
  const state = useStore.getState();
  try {
    state.upsertWorktree(await api.worktreeRepair(worktree.id, picked));
    state.toast(tr('Worktree reparado'));
  } catch (err) {
    state.toast(errorText(err), 'error');
  }
}

export function integrationPrompt(worktree: Worktree, info: Integration): string {
  const source = info.source ?? worktree.branch ?? tr('(sin rama)');
  const target = info.target ?? tr('(la rama del directorio principal)');
  const files = info.files.length ? `\n  ${info.files.slice(0, 15).map((f) => `- ${f}`).join('\n  ')}` : '';
  const conflicts = !info.conflictsChecked ? tr('no se pudieron comprobar')
    : info.conflicts.length ? info.conflicts.slice(0, 15).join(', ') : tr('ninguno previsto');
  return [
    tr('Prepara la integración de los cambios del worktree «{label}» ({path}).', { label: worktree.label, path: worktree.path }),
    '',
    `- ${tr('Rama de origen')}: ${source}`,
    `- ${tr('Rama de destino')}: ${target}`,
    `- ${tr('Estado')}: ${tr('{ahead} commit(s) por delante y {behind} por detrás de la rama de destino.', { ahead: info.ahead, behind: info.behind })}`,
    `- ${tr('Cambios sin commit')}: ${tr('{changed} archivo(s) modificados y {untracked} sin seguimiento.', { changed: info.changed, untracked: info.untracked })}${files}`,
    `- ${tr('Conflictos conocidos')}: ${conflicts}`,
    '',
    tr('Revisa el estado y propón los pasos (commits pendientes, rebase o merge). Espera mi confirmación antes de ejecutar cualquier comando que cambie ramas o el historial, y no hagas push.'),
  ].join('\n');
}

/**
 * Prepara la instrucción de integración en una conversación del worktree. No ejecuta nada: el
 * usuario la revisa, elige el agente y la envía.
 */
export async function prepareIntegrationFlow(worktree: Worktree) {
  const state = useStore.getState();
  let info: Integration;
  try {
    info = await api.worktreeIntegration(worktree.id);
  } catch (err) {
    state.toast(errorText(err), 'error');
    return;
  }
  const active = state.conversations.find((c) => c.id === state.activeConversationId);
  if (!active || active.worktreeId !== worktree.id || state.runs[active.id]) {
    await state.newConversation(worktree.projectId, worktree.id);
  }
  const id = useStore.getState().activeConversationId;
  if (id) useStore.getState().injectDraft(id, integrationPrompt(worktree, info));
}
