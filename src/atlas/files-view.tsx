import {useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {WorkspaceMod} from '../agent/workspace';
import {appConfirm} from '../components/app-dialog';
export function FilesView({mod,busy,active=true,filesVisible=true,onToggleFiles}: {
  mod:WorkspaceMod;busy:boolean;active?:boolean;filesVisible?:boolean;onToggleFiles?:()=>void;
}) {
  const [files,setFiles]=useState<any[]>([]),[query,setQuery]=useState('');
  const [current,setCurrent]=useState<any>(null),[draft,setDraft]=useState('');
  const [error,setError]=useState(''),[working,setWorking]=useState(false),[scanning,setScanning]=useState(false),[notice,setNotice]=useState('');
  const refreshRef=useRef<()=>Promise<void>>(async()=>{}),list=useRef<HTMLDivElement>(null);
  const dirty=!!current&&draft!==current.text;
  useEffect(()=>{
    if(!active)return;
    let alive=true,pending=false,repeat=false,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      if(pending){repeat=true;return;}
      pending=true;setScanning(true);
      try {
        const result=await window.modmixer.projectFiles(mod.folder);
        if(alive){setFiles(result.files);if(result.truncated)setNotice('File list capped at 10,000. Open the folder for the remaining files.');}
      } catch(e){if(alive)setError(String(e));}
      finally {pending=false;if(alive){setScanning(false);if(repeat){repeat=false;timer=setTimeout(()=>void refresh(),200);}}}
    };
    refreshRef.current=refresh;void refresh();
    const off=window.modmixer.onModChanged(({folder})=>{if(folder===mod.folder){clearTimeout(timer);timer=setTimeout(()=>void refresh(),200);}});
    return()=>{alive=false;clearTimeout(timer);off();refreshRef.current=async()=>{};};
  },[mod.folder,active]);
  const open=async(file:string)=>{
    if(working)return;
    if(dirty&&!await appConfirm('Discard your unsaved edits to open another file?',{okLabel:'Discard edits',tone:'danger'}))return;
    setWorking(true);setError('');
    try{const result=await window.modmixer.projectRead(mod.folder,file);setCurrent(result);setDraft(result.text);}
    catch(e){setError(String(e));}finally{setWorking(false);}
  };
  const save=async()=>{
    if(!current||working||busy)return;
    setWorking(true);setError('');
    try{const result=await window.modmixer.projectSave(mod.folder,current.path,draft,current.hash);setCurrent(result);setNotice('Saved '+result.path);}
    catch(e){setError(String(e));}finally{setWorking(false);}
  };
  const indexed=useMemo(()=>files.map(file=>({...file,search:file.path.toLowerCase()})),[files]);
  const search=useDeferredValue(query.toLowerCase());
  const filtered=useMemo(()=>indexed.filter(file=>file.search.includes(search)),[indexed,search]);
  const rows=useVirtualizer({count:filtered.length,getScrollElement:()=>list.current,estimateSize:()=>36,overscan:8,enabled:active&&filesVisible});
  useEffect(()=>{if(list.current)list.current.scrollTop=0;},[search,mod.folder]);
  return <section className="atlas-files">
    <aside className={filesVisible?'atlas-file-tree':'hidden'}>
      <div className="atlas-pane-heading"><strong>Project files</strong><button className="atlas-icon-button" disabled={scanning} onClick={()=>void refreshRef.current()} title="Refresh files" aria-label="Refresh files">↻</button></div>
      <input value={query} onChange={e=>setQuery(e.target.value)} aria-label="Find project file" placeholder="Find a file…"/>
      <div className="atlas-file-list" ref={list} aria-label="Project file list" tabIndex={0}>
        <div style={{height:rows.getTotalSize(),position:'relative'}}>
          {rows.getVirtualItems().map(row=>{const file=filtered[row.index];return <button key={file.path} title={file.path} className={current?.path===file.path?'active':''} style={{position:'absolute',top:0,left:0,height:row.size,transform:`translateY(${row.start}px)`}} onClick={()=>file.editable?void open(file.path):void window.modmixer.projectReveal(mod.folder,file.path)}><span>{file.editable?'▤':'◇'}</span><span>{file.path}</span></button>;})}
        </div>
        {!filtered.length&&<p>{scanning?'Loading files…':'No files match your search.'}</p>}
      </div>
      <div className="atlas-file-count">{filtered.length.toLocaleString()} {search?'matching':'project'} files</div>
      <button className="atlas-button" onClick={()=>void window.modmixer.projectReveal(mod.folder)}>Open project folder</button>
    </aside>
    <div className="atlas-editor">
      <div className="atlas-pane-heading atlas-editor-heading"><span title={current?.path}>{current?.path||'File editor'}{dirty?' • Unsaved':''}</span><div className="atlas-actions">{onToggleFiles&&<button className="atlas-button" onClick={onToggleFiles}>{filesVisible?'Hide files':'Show files'}</button>}<button className="atlas-button" disabled={!current||working} onClick={()=>void open(current.path)}>Reload</button><button className="atlas-button atlas-primary" disabled={!dirty||busy||working} onClick={()=>void save()} title={busy?'Finish active work before saving':'Save this file'}>{working?'Working…':'Save'}</button></div></div>
      {error&&<p role="alert" className="atlas-warning">{error}</p>}
      {notice&&<p className="atlas-inline-notice" role="status">{notice}</p>}
      {current?<textarea spellCheck={false} aria-label={'Edit '+current.path} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();if(dirty&&!busy&&!working)void save();}}}/>:<div className="atlas-empty"><span>▤</span><h2>Your project, in view</h2><p>Choose an XML, C#, or text file to edit. Keep your conversation open alongside it.</p><p>Images and binary files open in their file location.</p></div>}
    </div>
  </section>;
}
