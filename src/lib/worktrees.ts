// Worktrees de Git (1.0.9): tipos y utilidades del espacio de trabajo activo.
import type { Project } from './types';

export interface Worktree {
  id: string;
  projectId: string;
  path: string;
  branch: string | null;
  label: string;
  /** Creado por Duovra (`true`) o importado de un worktree existente. */
  managed: boolean;
  baseRef: string | null;
  /** Retirado de Duovra: solo se conserva por el historial de sus conversaciones. */
  retired: boolean;
  createdAt: number;
  /** El directorio existía al leerlo. */
  exists: boolean;
}

export interface WorktreeStatus {
  exists: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  conflicted: number;
  files: string[];
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeCreateRequest {
  name: string;
  path: string;
  newBranch: boolean;
  branch: string;
  base: string | null;
}

export interface WorktreePreflight {
  gitVersion: string | null;
  mainPath: string;
  mainBranch: string | null;
  localBranches: string[];
  remoteBranches: string[];
  busyBranches: string[];
  baseDir: string;
  suggestedName: string;
  suggestedBranch: string;
  suggestedPath: string;
  errors: string[];
  warnings: string[];
  freeBytes: number | null;
  estimatedBytes: number | null;
  mainDirty: boolean;
}

export interface RemovalCheck {
  exists: boolean;
  branch: string | null;
  canRemoveDir: boolean;
  blockers: string[];
  warnings: string[];
  canDeleteBranch: boolean;
  branchNote: string | null;
  exclusiveCommits: number;
  conversations: number;
}

export interface Integration {
  source: string | null;
  target: string | null;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  files: string[];
  conflicts: string[];
  conflictsChecked: boolean;
}

/**
 * Espacio de una conversación: el id de su worktree o, en el directorio principal, el del proyecto.
 * Workbench y las menciones de archivos lo usan para leer siempre del mismo directorio.
 */
export function spaceOf(conv: { projectId: string; worktreeId?: string | null }): string {
  return conv.worktreeId ?? conv.projectId;
}

/** Directorio raíz de un espacio (proyecto o worktree), si se conoce. */
export function rootOf(space: string | null | undefined, projects: Project[], worktrees: Worktree[]): string | undefined {
  if (!space) return undefined;
  return projects.find((p) => p.id === space)?.path ?? worktrees.find((w) => w.id === space && !w.retired)?.path;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
