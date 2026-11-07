import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * Native modal `<dialog>`: the browser traps focus, makes the page inert and
 * closes on Escape. Mount it to open it; focus returns to the trigger on unmount.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [returnFocusTo] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => returnFocusTo?.focus();
  }, [returnFocusTo]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  /** States the consequence of confirming. */
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/** Promise-based confirm: `if (!(await confirm({...}))) return;`. Render `dialog` somewhere in the tree. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setRequest({ options, resolve });
    return promise;
  }, []);

  function settle(ok: boolean) {
    request?.resolve(ok);
    setRequest(null);
  }

  const dialog = request ? (
    <Modal title={request.options.title} onClose={() => settle(false)}>
      <div className="dialog-body">{request.options.body}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>
          Cancel
        </button>
        <button type="button" className={`btn ${request.options.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => settle(true)}>
          {request.options.confirmLabel}
        </button>
      </div>
    </Modal>
  ) : null;

  return [confirm, dialog];
}
