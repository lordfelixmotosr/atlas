import { useEffect, useRef, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModChangeReport } from './mod-changes';
import { formatRelative } from '../lib/format-date';

const date = (time: number | null) => time ? new Date(time).toLocaleString() : 'Not recorded';
export function ModChangesButton({ mod, busy }: { mod: WorkspaceMod; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button className="atlas-button" title={mod.changes?.description ?? 'View changes since the last publication or marked update'} onClick={() => setOpen(true)}>Changes{mod.changes?.count ? ` · ${mod.changes.count}` : ''}</button>{open && <ModChangesDialog mod={mod} busy={busy} onClose={() => setOpen(false)} />}</>;
}
function ModChangesDialog({ mod, busy, onClose }: { mod: WorkspaceMod; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(true), revision = useRef(0), previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [report, setReport] = useState<ModChangeReport | null>(null), [comparison, setComparison] = useState<'latest' | 'published' | 'updated'>('latest'), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [note, setNote] = useState(''), [error, setError] = useState('');
  const [generating,setGenerating]=useState(false),[draft,setDraft]=useState(''),[descriptionSaving,setDescriptionSaving]=useState(false),[notice,setNotice]=useState('');
  const descriptionDirty=draft!==(report?.featureDescription??'');
  function accept(next:ModChangeReport){setReport(next);setDraft(next.featureDescription??'');}
  function close(){if(descriptionDirty&&!window.confirm('Discard the unsaved description?'))return;if(generating)void window.modmixer.cancelModDescription(mod.folder);onClose();}
  async function refresh() {
    const current = ++revision.current; setLoading(true); setError('');
    try { const next = await window.modmixer.modChanges(mod.folder, comparison); if (alive.current && current === revision.current) accept(next); }
    catch (e) { if (alive.current && current === revision.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current && current === revision.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; previousFocus.current?.focus(); }; }, []);
  useEffect(() => { void refresh(); }, [comparison, mod.folder]);
  async function markUpdated() {
    setSaving(true); setError(''); revision.current++;
    try { const next = await window.modmixer.markModUpdated(mod.folder, note); if (alive.current) { accept(next); setNote(''); setComparison('latest'); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setSaving(false); }
  }
  async function writeDescription(){if(!report?.descriptionKey)return;if(descriptionDirty&&!window.confirm('Replace the unsaved description with a new AI draft?'))return;setGenerating(true);setError('');setNotice('');try{const next=await window.modmixer.generateModDescription(mod.folder,comparison,report.descriptionKey);if(alive.current)accept(next);}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current)setGenerating(false);}}
  async function saveDescription(){if(!report?.descriptionKey)return;setDescriptionSaving(true);setError('');try{const next=await window.modmixer.saveModDescription(mod.folder,comparison,report.descriptionKey,draft);if(alive.current){accept(next);setNotice('Description saved.');}}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current)setDescriptionSaving(false);}}
  async function copyDescription(){const sections=Object.entries(report?.features??{}).filter(([,items])=>items.length).map(([key,items])=>({added:'Features added',changed:'Changes',removed:'Removed'}[key]??key)+'\n'+items.map(item=>'• '+item).join('\n'));try{await navigator.clipboard.writeText(draft.trim()||sections.join('\n\n'));setNotice('Description copied.');}catch{setError('Select the description text and copy it with Ctrl+C.');}}
  return <dialog ref={dialog} className="atlas-modal atlas-import-dialog atlas-changes-dialog" aria-labelledby="atlas-changes-title" onCancel={e => { e.preventDefault(); if (!saving&&!descriptionSaving) close(); }}>
    <header className="atlas-import-heading"><div><h2 id="atlas-changes-title">Mod changes</h2><p>{mod.about.name || mod.folder}</p></div><button className="atlas-icon-button" aria-label="Close mod changes" disabled={saving||descriptionSaving} onClick={close}>×</button></header>
    <div className="atlas-import-body">
      <div className="atlas-changes-tools"><label>Compare with <select value={comparison} disabled={saving||generating||descriptionSaving} onChange={e => {if(!descriptionDirty||window.confirm('Discard the unsaved description and change comparison?'))setComparison(e.target.value as typeof comparison)}}><option value="latest">Latest publication or update</option><option value="published">Last Workshop publication</option><option value="updated">Last marked update</option></select></label><button className="atlas-button" disabled={loading || saving||generating||descriptionSaving} onClick={() => {if(!descriptionDirty||window.confirm('Discard the unsaved description and refresh?'))void refresh()}}>{loading ? 'Checking…' : 'Refresh'}</button></div>
      {error && <p className="atlas-warning" role="alert">{error}</p>}
      {!report ? <p className="atlas-inline-notice">Comparing mod files…</p> : <>
        <div className="atlas-changes-summary" data-status={report.status}><h3>{report.label}</h3><p>{report.description}</p></div>
        {report.count>0&&<section className="atlas-feature-description" aria-label="Feature and change description"><h3>What changed</h3><div className="atlas-feature-overview">{(['added','changed','removed'] as const).map(key=>report.features?.[key]?.length?<section key={key}><h4>{{added:'Features added',changed:'Changes',removed:'Removed'}[key]}</h4><ul>{report.features[key].map((text,i)=><li key={i}>{text}</li>)}</ul></section>:null)}</div><div className="atlas-actions"><button className="atlas-button atlas-primary" disabled={busy||loading||generating||descriptionSaving||!report.descriptionKey} onClick={()=>void writeDescription()}>{generating?'Writing description…':'Write description with AI'}</button>{generating&&<button className="atlas-button" onClick={()=>void window.modmixer.cancelModDescription(mod.folder)}>Cancel</button>}<button className="atlas-button" disabled={generating||descriptionSaving} onClick={()=>void copyDescription()}>Copy description</button></div>{generating&&<div className="atlas-task-progress" role="status" aria-label="Writing feature description"><span/></div>}<label>Feature description / release notes<textarea value={draft} maxLength={12000} rows={6} disabled={generating||descriptionSaving} onChange={e=>setDraft(e.target.value)} placeholder="Write a description here, or let your selected AI model explain the comparison."/></label><div className="atlas-actions"><button className="atlas-button" disabled={!descriptionDirty||!draft.trim()||generating||descriptionSaving} onClick={()=>void saveDescription()}>{descriptionSaving?'Saving…':'Save description'}</button><button className="atlas-button" disabled={!draft.trim()||draft.length>4000||generating} onClick={()=>{setNote(draft);setNotice('Description added to the update note.');dialog.current?.querySelector<HTMLDetailsElement>('.atlas-mark-update')?.setAttribute('open','');}}>Use as update note</button></div>{notice&&<p role="status">{notice}</p>}<p className="atlas-import-hint">AI uses your selected default model and its normal account usage. Review the description before publishing. Saved descriptions apply to this exact comparison.</p></section>}
        <dl className="atlas-changes-dates"><div><dt>Last content change detected</dt><dd title={date(report.lastModifiedAt)}>{report.lastModifiedAt ? formatRelative(report.lastModifiedAt) + ' · ' + date(report.lastModifiedAt) : 'Unknown'}</dd></div><div><dt>Last published</dt><dd>{date(report.lastPublishedAt)}</dd></div><div><dt>Last marked updated</dt><dd>{date(report.lastUpdatedAt)}</dd></div><div><dt>Compared from</dt><dd>{date(report.baselineAt)}</dd></div></dl>
        {report.note && <p className="atlas-changes-note">Saved release note: {report.note}</p>}
        <details className="atlas-change-files"><summary>File details · {report.files.length}</summary>{report.files.map(file => <article key={file.path}><header><span data-action={file.action}>{file.action}</span><code>{file.path}</code><button className="atlas-button" onClick={() => void window.modmixer.projectReveal(mod.folder, file.path).catch(e => setError(e.message))}>{file.action === 'removed' ? 'Open folder' : 'File location'}</button></header><p>{file.description}</p></article>)}</details>
      </>}
      <details className="atlas-mark-update"><summary>Mark this version updated</summary><p>Save the current files as an update comparison. This does not upload to Steam. The last published comparison is kept separately.</p><label>Update note (optional)<textarea value={note} maxLength={4000} disabled={saving||generating} onChange={e => setNote(e.target.value)} placeholder="For example: added new armor variants and fixed the crafting recipe." /></label><button className="atlas-button" disabled={busy || saving || loading ||generating||descriptionSaving||descriptionDirty|| report?.status === 'unavailable'} onClick={() => void markUpdated()}>{saving ? 'Saving…' : 'Mark updated'}</button>{descriptionDirty&&<p>Save the description before marking this version updated.</p>}{busy && <p>Finish active agent work before marking an update.</p>}</details>
      <p className="atlas-import-hint">Descriptions come from file and definition comparisons. Changes made before the first saved comparison cannot be reconstructed. Cache files and Atlas preferences are excluded.</p>
    </div>
    <footer className="atlas-actions atlas-import-footer"><button className="atlas-button" disabled={saving||descriptionSaving} onClick={close}>Done</button></footer>
  </dialog>;
}
