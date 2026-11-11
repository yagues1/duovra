import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
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
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.initial ?? '');
    requestAnimationFrame(() => (req.kind === 'prompt' ? inputRef.current?.select() : confirmRef.current?.focus()));
  }, [req]);

  const close = (v: string | boolean | null) => {
    req?.resolve(v);
    set(null);
  };

  return createPortal(
    <AnimatePresence>
      {req && (
        <motion.div
          className="fixed inset-0 z-[60] grid place-items-center"
          style={{ background: 'rgba(2, 6, 16, 0.55)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onPointerDown={(e) => e.target === e.currentTarget && close(null)}
          onKeyDown={(e) => e.key === 'Escape' && close(null)}
        >
          <motion.form
            role="dialog"
            aria-modal="true"
            aria-label={req.title}
            className="mat-float w-[420px] max-w-[calc(100vw-32px)] rounded-[22px] p-5"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ type: 'spring', stiffness: 460, damping: 32 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (req.kind === 'prompt') {
                if (value.trim()) close(value.trim());
              } else close(true);
            }}
          >
            <h2 className="m-0 text-[16px] font-semibold" style={{ color: 'var(--text-strong)' }}>
              {req.title}
            </h2>
            {req.body && <p className="mb-0 mt-2 text-[13px] leading-relaxed muted">{req.body}</p>}
            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
                className="input mt-4"
                value={value}
                placeholder={req.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => close(null)}>
                Cancelar
              </button>
              <button
                ref={confirmRef}
                type="submit"
                className={req.danger ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={req.kind === 'prompt' && !value.trim()}
              >
                {req.confirmLabel}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
