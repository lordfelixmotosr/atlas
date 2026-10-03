import { useEffect, useRef, useState } from 'react';
import type { ModMixerImportPlan, ModMixerImportProgress, ModMixerImportResult } from './modmixer-import';

export function ModMixerImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const launchFocus = useRef(document.activeElement as HTMLElement | null);
  const alive = useRef(true);
  const token = useRef('');
  const [plan, setPlan] = useState<ModMixerImportPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ModMixerImportProgress | null>(null);
  const [result, setResult] = useState<ModMixerImportResult | null>(null);

  async function preview(choose = false) {
    setLoading(true); setError('');
    try {
      const next = await window.modmixer.modMixerImportPlan(choose);
      if (!alive.current || !next) return;
      token.current = next.token;
      setPlan(next); setResult(null); setProgress(null); setQuery('');
      setSelected(new Set(next.rows.filter(row => row.status === 'ready').map(row => row.folder)));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void preview();
    const off = window.modmixer.onModMixerImportProgress(state => {
      if (alive.current && state.token === token.current) setProgress(state);
    });
    return () => { alive.current = false; off(); launchFocus.current?.focus(); };
  }, []);

  async function apply() {
    if (!plan || copying || !selected.size) return;
    setCopying(true); setStopping(false); setError('');
    setProgress({ token: plan.token, completed: 0, total: selected.size, current: '', copiedFiles: 0 });
    try {
      const imported = await window.modmixer.modMixerImportApply(plan.token, [...selected]);
      if (!alive.current) return;
      setResult(imported);
      if (imported.imported.length) await onImported();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) setCopying(false); }
  }
  async function stop() {
    setStopping(true);
    try { await window.modmixer.modMixerImportCancel(token.current); }
    catch (e) { setStopping(false); setError(e instanceof Error ? e.message : String(e)); }
  }
  const eligible = plan?.rows.filter(row => row.status === 'ready') ?? [];
  const rows = plan?.rows.filter(row => (row.name + ' ' + row.packageId + ' ' + row.folder).toLowerCase().includes(query.toLowerCase())) ?? [];
  const already = plan?.rows.filter(row => row.status === 'imported').length ?? 0;
  const unavailable = (plan?.rows.length ?? 0) - eligible.length - already;
  const toggle = (folder: string) => setSelected(previous => {
    const next = new Set(previous); if (next.has(folder)) next.delete(folder); else next.add(folder); return next;
  });

  return <dialog ref={dialog} className="atlas-modal atlas-import-dialog" aria-labelledby="atlas-import-title" onCancel={event => { event.preventDefault(); if (!copying) onClose(); }}>
    <header className="atlas-import-heading">
      <div><h2 id="atlas-import-title">Import ModMixer mods</h2><p>Bring your RimWorld projects into Atlas.</p></div>
      <button className="atlas-icon-button" aria-label="Close import" disabled={copying} onClick={onClose}>×</button>
    </header>
    <div className="atlas-import-body">
    <p className="atlas-import-explanation">Copies mod files, assets, Workshop IDs, schematics and preferences. Your original ModMixer projects stay in place. Chats, save history and account sign-ins are separate.</p>
    {error && <p role="alert" className="atlas-warning">{error}</p>}
    {!copying && !result && <>
      <div className="atlas-import-source">
        <div><strong>ModMixer workspace</strong><p title={plan?.source ?? ''}>{plan?.source ?? 'No workspace detected. Choose its folder below.'}</p></div>
        <div className="atlas-actions"><button className="atlas-button" disabled={loading} onClick={() => void preview(true)}>Choose folder…</button><button className="atlas-button" disabled={loading} onClick={() => void preview()}>Scan again</button></div>
      </div>
      {loading ? <p role="status" className="atlas-inline-notice">Scanning project folders…</p> : plan?.source && <>
        <div className="atlas-import-summary"><span>{eligible.length} ready · {already} already imported{unavailable ? ` · ${unavailable} skipped` : ''}</span><span>{selected.size} selected</span></div>
        {!!plan.rows.length && <div className="atlas-import-tools">
          <label><input type="checkbox" aria-label="Select all eligible mods" disabled={!eligible.length} checked={!!eligible.length && selected.size === eligible.length} onChange={e => setSelected(new Set(e.target.checked ? eligible.map(row => row.folder) : []))} />Select all</label>
          <input aria-label="Search mods to import" type="search" placeholder="Search names or package IDs" value={query} onChange={e => setQuery(e.target.value)} />
        </div>}
        <div className="atlas-import-list">
          {rows.map(row => <label key={row.folder} className={'atlas-import-row ' + (row.status !== 'ready' ? 'atlas-import-disabled' : '')}>
            <input type="checkbox" aria-label={'Import ' + row.name} disabled={row.status !== 'ready'} checked={selected.has(row.folder)} onChange={() => toggle(row.folder)} />
            <span><strong>{row.name}</strong><small>{row.packageId || row.folder}</small><small>{row.detail}</small></span>
            <span className="atlas-import-badge">{row.status === 'ready' ? 'Ready' : row.status === 'imported' ? 'Imported' : 'Skipped'}</span>
          </label>)}
          {!rows.length && <p>{plan.rows.length ? 'No matching mods.' : 'No mod folders found in this workspace.'}</p>}
        </div>
      </>}
      <p className="atlas-import-hint">Close ModMixer before importing so its files stay consistent. Copied metadata uses <code>.atlas</code>. Repeating an import skips completed copies.</p>
    </>}
    {copying && <div className="atlas-import-progress" role="status" aria-live="polite">
      <h3>{stopping ? 'Stopping import…' : 'Importing your mods…'}</h3>
      <progress aria-label="Import progress" value={progress?.completed ?? 0} max={progress?.total || selected.size} />
      <p>{progress?.completed ?? 0} of {progress?.total ?? selected.size} mods processed · {progress?.copiedFiles ?? 0} files copied</p>
      <p className="atlas-import-current">{progress?.current ? 'Copying ' + progress.current : 'Preparing…'}</p>
      <small>You can stop at any time. Complete mods stay imported; the incomplete copy is discarded.</small>
    </div>}
    {result && <div className="atlas-import-result" role="status">
      <h3>{result.cancelled ? 'Import stopped' : 'Import complete'}</h3>
      <p>{result.imported.length} imported · {result.skipped.length} skipped · {result.failed.length} failed</p>
      {!!result.imported.length && <p>Your mods are now on Home. Archived mods remain in Archive.</p>}
      {!!result.imported.length && <details><summary>Imported mods</summary><ul>{result.imported.map(mod => <li key={mod.folder}>{mod.name}</li>)}</ul></details>}
      {[...result.skipped, ...result.failed].map((row, index) => <p className="atlas-warning" key={index}><strong>{row.name}:</strong> {row.reason}</p>)}
      {!!result.failed.length && <p>Fix the listed issue, then scan again to retry. Completed imports will be skipped.</p>}
    </div>}
    </div>
    <footer className="atlas-actions atlas-import-footer">
      {copying ? <button className="atlas-button" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop import'}</button> : <>
        {result && <button className="atlas-button" onClick={() => void preview()}>Scan again</button>}
        <button className="atlas-button" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
        {!result && <button className="atlas-button atlas-primary" disabled={loading || !selected.size} onClick={() => void apply()}>{selected.size === eligible.length ? `Import all ${selected.size} mods` : `Import ${selected.size} mods`}</button>}
      </>}
    </footer>
  </dialog>;
}
