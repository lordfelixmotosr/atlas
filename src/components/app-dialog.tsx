import { useEffect, useState } from 'react';

// Drop-in async replacements for window.alert/window.confirm. Native dialogs
// in Electron leave the WebContents in a bad focus state, so all keyboard
// input into <input>/<textarea> stops working until something refocuses the
// frame (e.g. opening DevTools).

type AlertRequest = {
  kind: 'alert';
  id: number;
  message: string;
  title?: string;
  details?: string[];
  resolve: () => void;
};

type ConfirmRequest = {
  kind: 'confirm';
  id: number;
  message: string;
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  resolve: (ok: boolean) => void;
};

type DialogRequest = AlertRequest | ConfirmRequest;

let nextId = 1;
let listener: ((req: DialogRequest) => void) | null = null;
const queue: DialogRequest[] = [];

function dispatch(req: DialogRequest) {
  if (listener) listener(req);
  else queue.push(req);
}

export function appAlert(message: string, opts?: { title?: string; details?: string[] }): Promise<void> {
  return new Promise((resolve) => {
    dispatch({ kind: 'alert', id: nextId++, message, title: opts?.title, details: opts?.details, resolve });
  });
}

export function appConfirm(
  message: string,
  opts?: {
    title?: string;
    okLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    dispatch({
      kind: 'confirm',
      id: nextId++,
      message,
      title: opts?.title,
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
      tone: opts?.tone,
      resolve,
    });
  });
}

export function AppDialog() {
  const [active, setActive] = useState<DialogRequest | null>(null);
  const [pending, setPending] = useState<DialogRequest[]>([]);

  useEffect(() => {
    listener = (req) => {
      setActive((cur) => {
        if (!cur) return req;
        setPending((p) => [...p, req]);
        return cur;
      });
    };
    if (queue.length > 0) {
      const [first, ...rest] = queue.splice(0, queue.length);
      setActive(first);
      if (rest.length) setPending(rest);
    }
    return () => {
      listener = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (active.kind === 'confirm') active.resolve(false);
        else active.resolve();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const advance = () => {
    setPending((p) => {
      if (p.length === 0) {
        setActive(null);
        return p;
      }
      const [next, ...rest] = p;
      setActive(next);
      return rest;
    });
  };

  if (!active) return null;

  const isConfirm = active.kind === 'confirm';
  const okLabel = isConfirm ? active.okLabel ?? 'Confirm' : 'OK';
  const cancelLabel = isConfirm ? active.cancelLabel ?? 'Cancel' : null;
  const danger = isConfirm && active.tone === 'danger';

  const onOk = () => {
    if (active.kind === 'confirm') active.resolve(true);
    else active.resolve();
    advance();
  };
  const onCancel = () => {
    if (active.kind === 'confirm') active.resolve(false);
    else active.resolve();
    advance();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="atlas-app-dialog-title" aria-describedby="atlas-app-dialog-message" data-atlas-app-dialog className="flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-md flex-col overflow-hidden rounded-md border border-line bg-paper shadow-lg">
        <div className="shrink-0 border-b border-line px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Atlas
          </div>
          <div id="atlas-app-dialog-title" className="mt-1 text-sm font-medium text-ink">{active.title ?? (isConfirm ? 'Confirm action' : 'Notice')}</div>
        </div>
        <div data-atlas-dialog-body className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3 text-sm text-ink [overflow-wrap:anywhere]">
          <p id="atlas-app-dialog-message" className="whitespace-pre-wrap">{active.message}</p>
          {active.kind === 'alert' && !!active.details?.length && <details key={active.id} className="mt-3 rounded-md border border-line">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">View details · {active.details.length}</summary>
            <ul className="list-disc space-y-2 border-t border-line py-3 pr-3 pl-7 text-xs leading-5 text-muted">{active.details.map((detail, i) => <li key={i} className="whitespace-pre-wrap">{detail}</li>)}</ul>
          </details>}
        </div>
        <div data-atlas-dialog-actions className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          {cancelLabel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onOk}
            autoFocus
            className={
              danger
                ? 'rounded-md bg-failed px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper shadow-sm transition-opacity hover:opacity-90'
                : 'rounded-md bg-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-opacity hover:bg-accent-soft'
            }
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
