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
  async function refresh() {
    const current = ++revision.current; setLoading(true); setError('');
    try { const next = await window.modmixer.modChanges(mod.folder, comparison); if (alive.current && current === revision.current) setReport(next); }
    catch (e) { if (alive.current && current === revision.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current && current === revision.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; previousFocus.current?.focus(); }; }, []);
  useEffect(() => { void refresh(); }, [comparison, mod.folder]);
  async function markUpdated() {
    setSaving(true); setError(''); revision.current++;
    try { const next = await window.modmixer.markModUpdated(mod.folder, note); if (alive.current) { setReport(next); setNote(''); setComparison('latest'); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="atlas-modal atlas-import-dialog atlas-changes-dialog" aria-labelledby="atlas-changes-title" onCancel={e => { e.preventDefault(); if (!saving) onClose(); }}>
    <header className="atlas-import-heading"><div><h2 id="atlas-changes-title">Mod changes</h2><p>{mod.about.name || mod.folder}</p></div><button className="atlas-icon-button" aria-label="Close mod changes" disabled={saving} onClick={onClose}>×</button></header>
    <div className="atlas-import-body">
      <div className="atlas-changes-tools"><label>Compare with <select value={comparison} disabled={saving} onChange={e => setComparison(e.target.value as typeof comparison)}><option value="latest">Latest publication or update</option><option value="published">Last Workshop publication</option><option value="updated">Last marked update</option></select></label><button className="atlas-button" disabled={loading || saving} onClick={() => void refresh()}>{loading ? 'Checking…' : 'Refresh'}</button></div>
      {error && <p className="atlas-warning" role="alert">{error}</p>}
      {!report ? <p className="atlas-inline-notice">Comparing mod files…</p> : <>
        <div className="atlas-changes-summary" data-status={report.status}><h3>{report.label}</h3><p>{report.description}</p></div>
        <dl className="atlas-changes-dates"><div><dt>Last content change detected</dt><dd title={date(report.lastModifiedAt)}>{report.lastModifiedAt ? formatRelative(report.lastModifiedAt) + ' · ' + date(report.lastModifiedAt) : 'Unknown'}</dd></div><div><dt>Last published</dt><dd>{date(report.lastPublishedAt)}</dd></div><div><dt>Last marked updated</dt><dd>{date(report.lastUpdatedAt)}</dd></div><div><dt>Compared from</dt><dd>{date(report.baselineAt)}</dd></div></dl>
        {report.note && <p className="atlas-changes-note">Saved release note: {report.note}</p>}
        <div className="atlas-change-files">{report.files.map(file => <article key={file.path}><header><span data-action={file.action}>{file.action}</span><code>{file.path}</code><button className="atlas-button" onClick={() => void window.modmixer.projectReveal(mod.folder, file.path).catch(e => setError(e.message))}>{file.action === 'removed' ? 'Open folder' : 'File location'}</button></header><p>{file.description}</p></article>)}</div>
      </>}
      <details className="atlas-mark-update"><summary>Mark this version updated</summary><p>Save the current files as an update comparison. This does not upload to Steam. The last published comparison is kept separately.</p><label>Update note (optional)<textarea value={note} maxLength={4000} disabled={saving} onChange={e => setNote(e.target.value)} placeholder="For example: added new armor variants and fixed the crafting recipe." /></label><button className="atlas-button" disabled={busy || saving || loading || report?.status === 'unavailable'} onClick={() => void markUpdated()}>{saving ? 'Saving…' : 'Mark updated'}</button>{busy && <p>Finish active agent work before marking an update.</p>}</details>
      <p className="atlas-import-hint">Descriptions come from file and definition comparisons. Changes made before the first saved comparison cannot be reconstructed. Cache files and Atlas preferences are excluded.</p>
    </div>
    <footer className="atlas-actions atlas-import-footer"><button className="atlas-button" disabled={saving} onClick={onClose}>Done</button></footer>
  </dialog>;
}
