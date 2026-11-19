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
  /** `null`: the action is not possible as things stand; the dialog explains why and only closes (resolves false). */
  confirmLabel: string | null;
  danger?: boolean;
  /**
   * For actions that change who is admitted while the doors are open: the confirm button stays disabled
   * until this statement is ticked, so the consequence cannot be confirmed by a reflexive Enter.
   */
  acknowledge?: string;
}

/** Confirmation body: a lead sentence, the concrete consequences as a list, and an optional closing note. */
export function Consequences({ lead, items, children }: { lead: ReactNode; items: string[]; children?: ReactNode }) {
  return (
    <div className="stack-sm">
      <p>{lead}</p>
      {items.length ? (
        <ul className="consequences">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {children ? <p>{children}</p> : null}
    </div>
  );
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

  const dialog = request ? <ConfirmDialog key={request.options.title} options={request.options} onSettle={settle} /> : null;

  return [confirm, dialog];
}

function ConfirmDialog({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { confirmLabel, acknowledge } = options;
  return (
    <Modal title={options.title} onClose={() => onSettle(false)}>
      <div className="dialog-body">{options.body}</div>
      {confirmLabel && acknowledge ? (
        <label className="check dialog-ack">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          {acknowledge}
        </label>
      ) : null}
      <div className="dialog-actions">
        {confirmLabel ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => onSettle(false)}>
              Cancel
            </button>
            <button type="button" className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onSettle(true)} disabled={Boolean(acknowledge) && !acknowledged}>
              {confirmLabel}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => onSettle(false)}>
            OK
          </button>
        )}
      </div>
    </Modal>
  );
}
