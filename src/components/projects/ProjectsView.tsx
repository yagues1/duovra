import { motion } from 'motion/react';
import { FolderOpen, FolderPlus, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useStore } from '../../state/store';
import { fmtRelative, AGENT_NAME } from '../../lib/format';
import { deleteConversationFlow, deleteProjectFlow, renameConversationFlow, renameProjectFlow } from '../sidebar/Sidebar';
import { AgentGlyph } from '../ui/AgentGlyph';

/** Gestión de proyectos y conversaciones. */
export function ProjectsView() {
  const projects = useStore((s) => s.projects);
  const conversations = useStore((s) => s.conversations);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const addProject = useStore((s) => s.addProject);
  const newConversation = useStore((s) => s.newConversation);
  const selectConversation = useStore((s) => s.selectConversation);
  const runs = useStore((s) => s.runs);
  const [selected, setSelected] = useState<string | null>(activeProjectId);
  const current = projects.find((p) => p.id === selected) ?? projects[0];
  const convs = useMemo(
    () => conversations.filter((c) => c.projectId === current?.id).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, current],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of conversations) m.set(c.projectId, (m.get(c.projectId) ?? 0) + 1);
    return m;
  }, [conversations]);

  return (
    <section className="projects-view" aria-label="Proyectos y conversaciones">
      <div className="projects-layout">
      <div className="projects-list">
        <div className="flex items-center justify-between px-1 pb-3 pt-2">
          <h1 className="m-0 text-[18px] font-semibold" style={{ color: 'var(--text-strong)' }}>
            Proyectos
          </h1>
          <button className="btn btn-primary" onClick={() => void addProject()}>
            <FolderPlus size={15} /> Añadir carpeta
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {projects.length === 0 && <p className="px-1 text-[13px] muted">Todavía no hay proyectos. Añade una carpeta para empezar.</p>}
          {projects.map((p) => (
            <motion.button
              key={p.id}
              layout
              className="project-card"
              data-on={p.id === current?.id || undefined}
              onClick={() => setSelected(p.id)}
            >
              {p.id === current?.id && <motion.span layoutId="project-card-on" className="project-card-on" transition={{ type: 'spring', stiffness: 480, damping: 40 }} />}
              <span className="relative block truncate text-[14px] font-medium" style={{ color: 'var(--text-strong)' }}>
                {p.name}
              </span>
              <span className="relative mt-0.5 block truncate font-mono text-[11.5px] faint" data-tip={p.path} data-tip-truncated>
                {p.path}
              </span>
              <span className="relative mt-2 block text-[12px] muted">
                {counts.get(p.id) ?? 0} {(counts.get(p.id) ?? 0) === 1 ? 'conversación' : 'conversaciones'}
              </span>
            </motion.button>
          ))}
        </div>
      </div>

      <div className="projects-detail mat-primary flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b px-5 py-4" style={{ borderColor: 'var(--hairline)' }}>
              <div className="min-w-0 flex-1">
                <h2 className="m-0 truncate text-[17px] font-semibold" style={{ color: 'var(--text-strong)' }} data-tip={current.name} data-tip-truncated>
                  {current.name}
                </h2>
                <div className="truncate font-mono text-[12px] faint" data-tip={current.path} data-tip-truncated>{current.path}</div>
              </div>
              <button className="btn" aria-label="Renombrar proyecto" data-tip="Renombrar proyecto" onClick={() => void renameProjectFlow(current)}>
                <Pencil size={14} /> <span className="btn-label">Renombrar</span>
              </button>
              <button className="btn" aria-label="Abrir carpeta" data-tip="Abrir la carpeta en el Explorador" onClick={() => void revealItemInDir(current.path)}>
                <FolderOpen size={14} /> <span className="btn-label">Abrir carpeta</span>
              </button>
              <button className="btn btn-danger" aria-label="Quitar proyecto" data-tip="Quitar de la aplicación (no borra la carpeta)" onClick={() => void deleteProjectFlow(current)}>
                <X size={14} /> <span className="btn-label">Quitar</span>
              </button>
            </div>
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <span className="text-[13px] muted">Conversaciones</span>
              <button className="btn" aria-label="Nueva conversación" data-tip="Nueva conversación" onClick={() => void newConversation(current.id)}>
                <MessageSquarePlus size={14} /> <span className="btn-label">Nueva conversación</span>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {convs.length === 0 && <p className="px-2 text-[13px] muted">Este proyecto no tiene conversaciones.</p>}
              {convs.map((c) => {
                const run = runs[c.id];
                const agent = run?.agent ?? c.lastAgent;
                return (
                <div key={c.id} className="conv-row" onDoubleClick={() => void selectConversation(c.id)}>
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void selectConversation(c.id)}>
                    {agent ? <AgentGlyph agent={agent} size={22} active={!!run} /> : <span className="w-[22px]" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px]" style={{ color: 'var(--text-primary)' }} data-tip={c.title} data-tip-truncated>
                        {c.title}
                      </span>
                      <span className="block truncate text-[12px] faint">
                        {agent ? `${AGENT_NAME[agent]} ${run?.model ?? c.lastModel ?? ''}` : 'Sin mensajes'}
                        {c.draft ? ' · borrador guardado' : ''}
                      </span>
                    </span>
                    <span className="text-[12px] faint">{fmtRelative(c.updatedAt)}</span>
                  </button>
                  <button className="btn-icon" aria-label={`Renombrar ${c.title}`} onClick={() => void renameConversationFlow(c)}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn-icon" aria-label={`Eliminar ${c.title}`} onClick={() => void deleteConversationFlow(c)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-[13px] muted">Selecciona o añade un proyecto.</div>
        )}
      </div>
      </div>
    </section>
  );
}
