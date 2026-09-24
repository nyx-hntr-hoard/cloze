/**
 * A thin wrapper over the native `<dialog>` element.
 *
 * Native dialog gives focus trapping, Escape-to-close, inertness of the rest of
 * the page and the `::backdrop` pseudo-element for free — all things a
 * hand-rolled modal gets wrong.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Fires for Escape as well as programmatic close, so state stays in sync.
    const handler = () => onClose();
    el.addEventListener('close', handler);
    return () => el.removeEventListener('close', handler);
  }, [onClose]);

  return (
    <dialog ref={ref} aria-label={title}>
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div className="dialog__body">
          <h2>{title}</h2>
          {children}
        </div>
        {footer ? <div className="dialog__actions">{footer}</div> : null}
      </form>
    </dialog>
  );
}
