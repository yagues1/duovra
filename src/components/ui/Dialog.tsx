import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

/**
 * Diálogos de confirmación y de texto, invocables como promesa:
 *   if (await confirmDialog({...})) ...
 *   const name = await promptDialog({...})
 */
interface DialogReq {
  kind: 'confirm' | 'prompt';
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  initial?: string;
  placeholder?: string;
  resolve: (v: string | boolean | null) => void;
}

const useDialog = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

export function confirmDialog(o: { title: string; body?: string; confirmLabel: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) =>
    useDialog.getState().set({ kind: 'confirm', ...o, resolve: (v) => resolve(v === true) }),
  );
}

export function promptDialog(o: { title: string; body?: string; confirmLabel: string; initial?: string; placeholder?: string }) {
  return new Promise<string | null>((resolve) =>
    useDialog.getState().set({ kind: 'prompt', ...o, resolve: (v) => resolve(typeof v === 'string' ? v : null) }),
  );
}

export function DialogHost() {
  const { req, set } = useDialog();
  if (!req) return null;
  return createPortal(
    <RequestDialog req={req} close={(value) => {
      set(null);
      req.resolve(value);
    }} />,
    document.body,
  );
}

function RequestDialog({ req, close }: { req: DialogReq; close: DialogReq['resolve'] }) {
  const id = useId();
  const [value, setValue] = useState(req.initial ?? '');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    if (req.kind === 'prompt') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      (req.danger ? cancelRef : confirmRef).current?.focus();
    }
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [req]);

  return (
    <dialog
      ref={dialogRef}
      className="surface-popup request-dialog m-auto w-[420px] max-w-[calc(100vw-32px)] p-0"
      aria-labelledby={`${id}-title`}
      aria-describedby={req.body ? `${id}-body` : undefined}
      onCancel={(event) => {
        event.preventDefault();
        close(null);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close(null);
      }}
    >
      <form className="p-5" onSubmit={(event) => {
        event.preventDefault();
        if (req.kind === 'confirm') close(true);
        else if (value.trim()) close(value.trim());
      }}>
        <h2 id={`${id}-title`} className="m-0 text-[16px] font-semibold">{req.title}</h2>
        {req.body && <p id={`${id}-body`} className="mb-0 mt-2 text-[13px] leading-relaxed muted">{req.body}</p>}
        {req.kind === 'prompt' && (
          <label className="mt-4 block">
            <span className="sr-only">Nombre</span>
            <input
              ref={inputRef}
              className="input"
              required
              value={value}
              placeholder={req.placeholder}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn" onClick={() => close(null)}>Cancelar</button>
          <button
            ref={confirmRef}
            type="submit"
            className={req.danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={req.kind === 'prompt' && !value.trim()}
          >
            {req.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
