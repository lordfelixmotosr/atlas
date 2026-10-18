import {useEffect,useRef} from 'react';
import type {DllInstallResult} from '../agent/rimworld/dll-update';
type Review=Extract<DllInstallResult,{status:'confirmation'}>;
export function runtimeBytes(bytes:number):string {if(bytes<1024)return `${bytes} B`;if(bytes<1024**2)return `${(bytes/1024).toFixed(1)} KB`;return `${(bytes/1024**2).toFixed(1)} MB`;}
export function RuntimeInstallDialog({review,working,error,onClose,onConfirm}:{review:Review;working:boolean;error:string;onClose:()=>void;onConfirm:()=>void}){
  const panel=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),preview=review.preview,restore=preview.mode==='restore';
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;panel.current?.showModal();cancel.current?.focus();return()=>previous?.focus();},[]);
  return <dialog ref={panel} data-atlas-install-preview aria-labelledby="atlas-install-title" aria-busy={working} className="atlas-modal atlas-runtime-install-dialog shadow-xl" onCancel={event=>{event.preventDefault();if(!working)onClose();}}>
    <div className="atlas-runtime-install-layout">
      <div className="shrink-0 border-b border-line px-5 py-4">
        <h2 id="atlas-install-title" className="text-base font-medium text-ink">{restore?'Restore previous version':'Review installation'}</h2>
        <p className="mt-2 text-xs leading-5 text-muted">{review.message}</p>
        <p className="mt-3 text-sm text-ink" role="status">{preview.added} added · {preview.modified} changed · {preview.removed} removed <span className="text-muted">· {runtimeBytes(preview.runtimeBytes)} installed</span></p>
      </div>
      <div data-atlas-install-body className="min-h-0 overflow-y-auto overscroll-contain px-5 py-3 [overflow-wrap:anywhere]">
        {preview.mods.map(mod=><details key={mod.folder} open={preview.mods.length===1} className="mb-3 rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">{mod.name} <span className="text-xs font-normal text-muted">· {mod.changes.length} changes · {mod.unchanged} unchanged</span></summary>
          {mod.previousSavedAt&&<p className="px-3 pb-2 text-xs text-muted">Previous copy saved {new Date(mod.previousSavedAt).toLocaleString()}</p>}
          {mod.changes.length?<table className="w-full table-fixed text-left text-xs"><thead className="text-muted"><tr><th className="w-20 px-3 py-2 font-normal">Action</th><th className="py-2 font-normal">File</th><th className="w-28 px-3 py-2 text-right font-normal">Size</th></tr></thead><tbody>{mod.changes.map(change=><tr key={change.path} className="border-t border-line">
            <td className="px-3 py-2 align-top text-muted">{change.action==='modified'?'Changed':change.action==='added'?'Added':'Removed'}</td><td className="break-all py-2 font-mono text-ink">{change.path}</td><td className="px-3 py-2 text-right align-top text-muted">{runtimeBytes(change.action==='removed'?change.beforeBytes:change.afterBytes)}</td>
          </tr>)}</tbody></table>:<p className="px-3 pb-3 text-xs text-muted">No file-content changes for this mod.</p>}
        </details>)}
        {review.warnings.length>0&&<details className="rounded-md border border-line p-3 text-xs leading-5 text-ink"><summary className="cursor-pointer font-medium">Review warnings · {review.warnings.length}</summary><ul className="mt-2 list-disc space-y-2 pl-4">{review.warnings.map((warning,i)=><li key={i} className="break-words">{warning}</li>)}</ul></details>}
        {error&&<p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs text-failed">{error}</p>}
      </div>
      <div data-atlas-install-actions className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {working&&<span role="status" className="mr-auto text-xs text-muted">{restore?'Restoring runtime files…':'Installing runtime files…'}</span>}
        <button ref={cancel} type="button" className="atlas-button" disabled={working} onClick={onClose}>Cancel</button>
        <button type="button" className="atlas-button atlas-primary" disabled={working} onClick={onConfirm}>{working?'Working…':review.running?(restore?'Close and restore':'Close and install'):restore?'Restore version':'Install update'}</button>
      </div>
    </div>
  </dialog>;
}
