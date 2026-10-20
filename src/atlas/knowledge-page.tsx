import {useEffect, useRef, useState} from 'react';
import {ActionsMenu} from '../components/actions-menu';

type Pack = {id:string;name:string;category:string;version:string;description:string;gameVersions:string[];license:string;source:string;previous?:string;pending?:string};
type LibraryState = {
  config:{source:string;autoUpdate:boolean;lastSuccessAt?:string;lastError?:string};
  packs:Pack[];available:unknown[];changes:{id:string;from?:string;to:string;notes:string}[];
  working:boolean;busy:boolean;
};
type Reference = {id:string;path:string;excerpt:string};

export function AtlasKnowledgePage() {
  const [status,setStatus]=useState<LibraryState|null>(null);
  const [error,setError]=useState(''),[pending,setPending]=useState(''),[notice,setNotice]=useState('');
  const [query,setQuery]=useState(''),[results,setResults]=useState<Reference[]>([]),[source,setSource]=useState('');
  const alive=useRef(true),inFlight=useRef(false);
  useEffect(()=>{
    alive.current=true;
    window.modmixer.atlasLibraryStatus().then(value=>{
      if(alive.current){setStatus(value);setSource(value.config.source);}
    }).catch(error=>{if(alive.current)setError(String(error));});
    const off=window.modmixer.onAtlasLibraryState((value:LibraryState)=>{if(alive.current)setStatus(value);});
    return()=>{alive.current=false;off();};
  },[]);
  async function run(label:string,fn:()=>Promise<any>,message?:string|((value:any)=>string)){
    if(inFlight.current)return;
    inFlight.current=true;setPending(label);setError('');setNotice('');
    try{
      const value=await fn();
      if(alive.current){
        if(value?.packs)setStatus(value);
        if(message)setNotice(typeof message==='function'?message(value):message);
      }
    }catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error));}
    finally{inFlight.current=false;if(alive.current)setPending('');}
  }
  const disabled=!!pending||!!status?.working;
  return <main className="atlas-page atlas-knowledge-page">
    <div className="atlas-page-inner">
      <header className="atlas-page-heading">
        <div><h1>Knowledge</h1><p>References and skills for building your mods.</p></div>
        <div className="atlas-actions">
          <button className="atlas-button" disabled={disabled} onClick={()=>void run('Opening',()=>window.modmixer.atlasLibraryCustom())}>My custom skills</button>
          <ActionsMenu label="Manage">
            <button disabled={disabled} onClick={()=>void run('Opening',()=>window.modmixer.atlasLibraryReveal())}>Open library folder</button>
            <button disabled={disabled||status?.busy} onClick={()=>void run('Rebuilding',()=>window.modmixer.atlasLibraryRebuild(),'Game index rebuild started. Follow progress in Activity.')}>Rebuild game index</button>
          </ActionsMenu>
        </div>
      </header>
      {error&&<p role="alert" className="atlas-error">{error}</p>}
      {notice&&<p role="status" className="atlas-notice">{notice}</p>}
      <section className="atlas-reference-search" aria-label="Reference search">
        <h2>Find a reference</h2>
        <form className="atlas-source-row" onSubmit={event=>{
          event.preventDefault();
          void run('Searching',async()=>{
            const found=await window.modmixer.atlasLibrarySearch(query);
            if(alive.current)setResults(found);
            return found;
          },found=>found.length?`${found.length} reference files found.`:'No matching references.');
        }}>
          <input aria-label="Search references" placeholder="Search code, apparel directions, Harmony…" value={query} onChange={event=>setQuery(event.target.value)}/>
          <button className="atlas-button" disabled={disabled||!query.trim()} type="submit">{pending==='Searching'?'Searching…':'Search'}</button>
        </form>
        <div className="atlas-search-results">{results.map(result=><article className="atlas-search-result" key={result.id+result.path}>
          <strong>{result.path}</strong><small>{result.id}</small><p>{result.excerpt}</p>
          <button className="atlas-button" disabled={disabled} onClick={()=>void run('Opening',()=>window.modmixer.atlasLibraryOpenReference(result.id,result.path))}>Open reference</button>
        </article>)}</div>
      </section>
      {!status?<p>Loading knowledge packs…</p>:<>
        <section className="atlas-pack-section">
          <div className="atlas-section-heading">
            <div><h2>Installed packs <span className="atlas-count">{status.packs.length}</span></h2>
              <p>{status.config.lastSuccessAt?`Last checked ${new Date(status.config.lastSuccessAt).toLocaleString()}`:'Not checked yet'}</p></div>
            <div className="atlas-actions">
              <button className="atlas-button" disabled={disabled} onClick={()=>void run('Checking',()=>window.modmixer.atlasLibraryCheck(),value=>value.available.length?`${value.available.length} verified updates available.`:'Your library is up to date.')}>{pending==='Checking'?'Checking…':'Check updates'}</button>
              {(status.available.length>0||pending==='Updating')&&<button className="atlas-button atlas-primary" disabled={disabled} onClick={()=>void run('Updating',()=>window.modmixer.atlasLibraryUpdate(),'Verified packs installed. New chats use the updated library.')}>{pending==='Updating'?'Updating…':'Update packs'}</button>}
            </div>
          </div>
          {status.config.lastError&&<p className="atlas-warning">{status.config.lastError} Current packs remain available.</p>}
          <div className="atlas-pack-grid">{status.packs.map(pack=><article className="atlas-pack" key={pack.id}>
            <div className="atlas-pack-title"><h3>{pack.name}</h3><span className="atlas-tag">{pack.version}</span></div>
            <p>{pack.description}</p>
            <div className="atlas-pack-meta"><span>{pack.category}</span><span>RimWorld {pack.gameVersions.join(', ')}</span><span>{pack.license}</span></div>
            {pack.pending&&<p className="atlas-warning">{pack.pending} activates when current work finishes.</p>}
            <div className="atlas-actions">
              <button className="atlas-button" disabled={disabled} onClick={()=>void run('Opening',()=>window.modmixer.atlasLibraryReveal(pack.id))}>Browse files</button>
              <ActionsMenu label="Pack options">
                <button disabled={disabled} onClick={()=>void run('Opening',()=>window.modmixer.openExternal(pack.source))}>View source</button>
                <button disabled={disabled||status.busy||!pack.previous} onClick={()=>void run('Reverting',()=>window.modmixer.atlasLibraryRevert(pack.id),'Previous pack restored for new chats.')}>Restore previous pack</button>
              </ActionsMenu>
            </div>
          </article>)}</div>
        </section>
        <details className="atlas-source-settings">
          <summary>Knowledge update settings</summary>
          <label className="atlas-auto"><input type="checkbox" checked={status.config.autoUpdate} disabled={disabled} onChange={event=>void run('Saving',()=>window.modmixer.atlasLibraryConfigure({autoUpdate:event.target.checked}))}/> Check for updates daily</label>
          <p>Use a signed Atlas release folder or HTTPS feed. Your custom skills and notes remain private.</p>
          <div className="atlas-source-row">
            <input aria-label="Update source" value={source} onChange={event=>setSource(event.target.value)}/>
            <button className="atlas-button" disabled={disabled} onClick={()=>void run('Saving',()=>window.modmixer.atlasLibraryConfigure({source}),'Update source saved.')}>Save source</button>
            <button className="atlas-button" disabled={disabled} onClick={()=>void run('Choosing',async()=>{const value=await window.modmixer.atlasLibraryChooseSource();if(value&&alive.current)setSource(value.config.source);return value;})}>Choose folder</button>
          </div>
        </details>
        {status.changes.length>0&&<details className="atlas-source-settings"><summary>Latest pack changes</summary><ul>{status.changes.map(change=><li key={change.id}>{change.id}: {change.from??'new'} → {change.to} — {change.notes}</li>)}</ul></details>}
        <p className="atlas-footnote">Packs provide instructions and references; they do not retrain models.</p>
      </>}
    </div>
  </main>;
}
