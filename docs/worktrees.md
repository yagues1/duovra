# Worktrees (1.0.9)

Duovra permite trabajar en varias funcionalidades de un mismo repositorio mediante **Git worktrees reales** (`git worktree`). No es un cliente de Git: fusionar, rebasar, hacer commit o push lo hace el usuario o el agente que elija.

## Modelo

- Tabla `worktrees` (SQLite, migración aditiva): `id`, `project_id`, `path`, `branch`, `label`, `managed` (creado por Duovra o importado), `base_ref`, `retired`.
- Columna `conversations.worktree_id`. `NULL` = directorio principal del proyecto: todas las conversaciones anteriores a la 1.0.9 quedan ahí.
- Una conversación pertenece a un único espacio para siempre. `Db::conversation_root` devuelve su directorio y **nunca recae en otro**: si el worktree se retiró o ya no existe, el envío falla con un motivo claro.
- «Espacio» en el frontend: id del worktree o, en el principal, id del proyecto (`spaceOf`). Workbench y las menciones `@archivo` usan ese id; el backend lo resuelve con `Db::space_root`.

## Ejecución de los agentes

- Claude Code (`current_dir`) y Codex (`cwd` de `thread/start` y `thread/resume`) se lanzan en `conversation_root`.
- Las sesiones de proveedor son por conversación, así que nunca se comparten entre worktrees.
- Los adjuntos y referencias se resuelven contra el mismo directorio; los encargos de la cola se ejecutan en el espacio de su conversación aunque el usuario cambie de proyecto o worktree.
- Los permisos siguen siendo los del agente en esa conversación.

## Operaciones (`src-tauri/src/worktrees.rs`)

| Acción | Git |
|---|---|
| Crear | `git worktree add [-b rama] <ruta> <base>` (sin cambiar la rama del principal) |
| Detectar / importar | `git worktree list --porcelain` |
| Estado | `git status --porcelain=v2 --branch` (bajo demanda) |
| Eliminar carpeta | `git worktree remove <ruta>` **sin** `--force` |
| Eliminar rama | `git branch -d` (nunca `-D`) |
| Reparar | `git worktree repair <nueva ruta>` |
| Integración | `rev-list --left-right --count` y `merge-tree --write-tree` (simulación, sin tocar ramas) |

Antes de crear se comprueban: Git, repositorio, nombre y existencia de la rama, ramas en uso por otro worktree, carpeta de destino, permisos de escritura y espacio libre frente al tamaño de la referencia.

## Ubicación

Por defecto, junto al repositorio y fuera de su árbol: `<padre>/<repo>.worktrees/<nombre>`. Ajustes → Conversaciones → Worktrees permite una carpeta propia (`<carpeta>/<repo>/<nombre>`), y el diálogo de creación deja cambiarla en cada caso.

Los worktrees comparten los objetos de Git. Duovra no ejecuta instaladores, no copia `.env` ni secretos y no compila. El espacio ocupado se calcula solo cuando el usuario lo pide.

## Eliminación segura

Tres acciones distintas: **retirar de Duovra** (no toca el disco), **eliminar la carpeta** y **eliminar la rama**.

La carpeta solo se puede eliminar si no hay: cambios sin commit, archivos sin seguimiento, archivos ignorados no regenerables (p. ej. `.env`, claves, bases de datos; `node_modules`, `target`, `dist`… solo avisan), ejecuciones activas, mensajes en cola ni bloqueo de Git. Esta comprobación es necesaria: `git worktree remove` sin `--force` **borra los archivos ignorados**.

La rama solo se puede borrar si no tiene commits exclusivos (que no estén en otra rama ni en un remoto).

Retirar un worktree con conversaciones lo deja como referencia retirada: el historial se conserva y la conversación indica que su directorio ya no está disponible.

## Fases posteriores

La revisión interactiva, los checkpoints y Live Preview pueden colgar del mismo «espacio» (`spaceOf` / `space_root`) sin cambiar este modelo.
