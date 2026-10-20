import {useEffect, useId, useRef, useState} from 'react';

/** Small action disclosure. Items use normal Tab navigation, with Escape dismissal. */
export function ActionsMenu({label, children}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return <div className="atlas-actions-menu" ref={root}>
    <button ref={trigger} type="button" className="atlas-button" aria-expanded={open}
      aria-controls={id} onClick={() => setOpen(value => !value)}>{label} <span aria-hidden>⌄</span></button>
    {open && <div id={id} className="atlas-actions-popover" aria-label={label}
      onClick={event => {
        if ((event.target as Element).closest('button:not(:disabled)')) setOpen(false);
      }}>{children}</div>}
  </div>;
}
