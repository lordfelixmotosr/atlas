import {useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {WorkspaceMod} from '../agent/workspace';
import {appConfirm} from '../components/app-dialog';
import {CodeEditor,type EditorLocation} from './code-editor';
import type {EditorState} from '@codemirror/state';
const unsavedProjects=new Set<string>();
export async function confirmProjectDrafts(folder:string){return !unsavedProjects.has(folder)||await appConfirm('Close this project and discard its unsaved file edits?',{okLabel:'Discard edits',tone:'danger'});}
type FileTab={path:string;text:string;hash:string;draft:string;location?:EditorLocation;line:number;column:number};
type TreeRow={path:string;depth:number;folder:boolean;editable?:boolean};
export function FilesView({mod,busy,active=true,filesVisible=true,onToggleFiles}: {mod:WorkspaceMod;busy:boolean;active?:boolean;filesVisible?:boolean;onToggleFiles?:()=>void}) {
 const [files,setFiles]=useState<any[]>([]),[query,setQuery]=useState(''),[mode,setMode]=useState<'files'|'contents'>('files'),[caseSensitive,setCase]=useState(false),[expanded,setExpanded]=useState(new Set<string>());
 const [tabs,setTabs]=useState<FileTab[]>([]),[selected,setSelected]=useState(''),[matches,setMatches]=useState<any[]>([]),[searching,setSearching]=useState(false);
 const [error,setError]=useState(''),[working,setWorking]=useState(false),[scanning,setScanning]=useState(false),[notice,setNotice]=useState(''),[searchNotice,setSearchNotice]=useState('');
 const refreshRef=useRef<()=>Promise<void>>(async()=>{}),list=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),states=useRef(new Map<string,EditorState>()),tabsRef=useRef(tabs);tabsRef.current=tabs;
 const current=tabs.find(tab=>tab.path===selected),dirty=!!current&&current.draft!==current.text;
 useEffect(()=>{const dirty=tabs.some(tab=>tab.draft!==tab.text);if(dirty)unsavedProjects.add(mod.folder);else unsavedProjects.delete(mod.folder);void window.modmixer.projectDraftState(mod.folder,dirty).catch(()=>{});},[tabs,mod.folder]);
 useEffect(()=>()=>{unsavedProjects.delete(mod.folder);void window.modmixer.projectDraftState(mod.folder,false).catch(()=>{});},[mod.folder]);
 useEffect(()=>{
  if(!active)return;let alive=true,pending=false,repeat=false,timer:ReturnType<typeof setTimeout>;
  const refresh=async()=>{if(pending){repeat=true;return;}pending=true;setScanning(true);try{const result=await window.modmixer.projectFiles(mod.folder);if(alive){setFiles(result.files);if(result.truncated)setNotice('File list capped at 10,000. Open the folder for the remaining files.');}}catch(e){if(alive)setError(String(e));}finally{pending=false;if(alive){setScanning(false);if(repeat){repeat=false;timer=setTimeout(()=>void refresh(),200);}}}};
  refreshRef.current=refresh;void refresh();const off=window.modmixer.onModChanged(({folder})=>{if(folder===mod.folder){clearTimeout(timer);timer=setTimeout(()=>void refresh(),200);}});
  return()=>{alive=false;clearTimeout(timer);off();refreshRef.current=async()=>{};};
 },[mod.folder,active]);
 useEffect(()=>{
  if(mode!=='contents'||!active||!filesVisible||query.trim().length<2){setMatches([]);setSearching(false);return;}
  let alive=true;const token=crypto.randomUUID();setSearching(true);setMatches([]);setSearchNotice('');
  const timer=setTimeout(()=>{window.modmixer.projectSearch(mod.folder,query,{caseSensitive,token}).then(result=>{if(alive){setMatches(result.matches);setSearchNotice(`${result.scanned} text files searched${result.truncated?' · Results capped; narrow your search':''}${result.skipped?' · '+result.skipped+' files skipped':''}`);}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setSearching(false);});},300);
  return()=>{alive=false;clearTimeout(timer);void window.modmixer.projectSearchCancel(mod.folder,token).catch(()=>{});};
 },[mode,query,caseSensitive,mod.folder,active,filesVisible]);
 const open=async(file:string,location?:EditorLocation,reload=false)=>{
  if(working)return;const existing=tabsRef.current.find(tab=>tab.path===file);
  if(existing&&!reload){setSelected(file);if(location)setTabs(old=>old.map(tab=>tab.path===file?{...tab,location}:tab));return;}
  if(existing&&existing.text!==existing.draft&&!await appConfirm('Reload this file and discard its unsaved edits?',{okLabel:'Reload',tone:'danger'}))return;
  setWorking(true);setError('');try{const result=await window.modmixer.projectRead(mod.folder,file);states.current.delete(file);const tab={...result,draft:result.text,line:1,column:1,location};setTabs(old=>existing?old.map(t=>t.path===file?tab:t):[...old,tab]);setSelected(file);}catch(e){setError(String(e));}finally{setWorking(false);}
 };
 const save=async()=>{if(!current||working||busy||!dirty)return;const captured=current;setWorking(true);setError('');try{const result=await window.modmixer.projectSave(mod.folder,captured.path,captured.draft,captured.hash);setTabs(old=>old.map(tab=>tab.path===captured.path?{...tab,text:result.text,hash:result.hash}:tab));setNotice('Saved '+result.path);}catch(e){setError(String(e));}finally{setWorking(false);}};
 const close=async(file:string)=>{const tab=tabsRef.current.find(t=>t.path===file);if(!tab||working)return;if(tab.draft!==tab.text&&!await appConfirm('Discard unsaved edits to '+file+'?',{okLabel:'Discard edits',tone:'danger'}))return;const index=tabsRef.current.indexOf(tab),next=tabsRef.current.filter(t=>t.path!==file);setTabs(next);states.current.delete(file);if(selected===file)setSelected((next[index]??next[index-1])?.path??'');};
 const search=useDeferredValue(query.toLowerCase());
 const tree=useMemo(()=>{
  if(search)return files.filter(file=>file.path.toLowerCase().includes(search)).map(file=>({...file,folder:false,depth:0}));
  const folders=new Map<string,TreeRow>(),fileRows:TreeRow[]=[];
  for(const file of files){const parts=file.path.split('/');for(let i=1;i<parts.length;i++){const folder=parts.slice(0,i).join('/');folders.set(folder,{path:folder,depth:i-1,folder:true});}fileRows.push({...file,depth:parts.length-1,folder:false});}
  const visible=(row:TreeRow)=>{const parts=row.path.split('/');for(let i=1;i<parts.length;i++)if(!expanded.has(parts.slice(0,i).join('/')))return false;return true;};
  return [...folders.values(),...fileRows].filter(visible).sort((a,b)=>{const aa=a.path.split('/'),bb=b.path.split('/');for(let i=0;i<Math.min(aa.length,bb.length);i++){if(aa[i]===bb[i])continue;const af=i<aa.length-1||a.folder,bf=i<bb.length-1||b.folder;if(af!==bf)return af?-1:1;return aa[i].localeCompare(bb[i]);}return aa.length-bb.length;});
 },[files,search,expanded]);
 const rows=useVirtualizer({count:tree.length,getScrollElement:()=>list.current,estimateSize:()=>34,overscan:8,enabled:active&&filesVisible&&mode==='files'});
 useEffect(()=>{if(list.current)list.current.scrollTop=0;},[search,mode,mod.folder]);
 return <section className="atlas-files" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='f'){e.preventDefault();if(!filesVisible)onToggleFiles?.();setMode('contents');setTimeout(()=>input.current?.focus(),0);}}}>
  <aside className={filesVisible?'atlas-file-tree':'hidden'}>
   <div className="atlas-pane-heading"><strong>Project files</strong><button className="atlas-icon-button" disabled={scanning} onClick={()=>void refreshRef.current()} title="Refresh files" aria-label="Refresh files">↻</button></div>
   <div className="atlas-search-modes"><button aria-pressed={mode==='files'} onClick={()=>setMode('files')}>Files</button><button aria-pressed={mode==='contents'} onClick={()=>setMode('contents')}>Contents</button></div>
   <input ref={input} maxLength={300} value={query} onChange={e=>setQuery(e.target.value)} aria-label={mode==='files'?'Find project file':'Search project contents'} placeholder={mode==='files'?'Find a file…':'Search text (2+ characters)…'}/>
   {mode==='contents'&&<label className="atlas-case-search"><input type="checkbox" checked={caseSensitive} onChange={e=>setCase(e.target.checked)}/>Match case</label>}
   <div className="atlas-file-list" ref={list} aria-label="Project file list" tabIndex={0}>
    {mode==='files'?<><div style={{height:rows.getTotalSize(),position:'relative'}}>{rows.getVirtualItems().map(row=>{const file=tree[row.index];return <button key={file.path} title={file.path} aria-expanded={file.folder?expanded.has(file.path):undefined} className={selected===file.path?'active':''} style={{position:'absolute',top:0,left:0,height:row.size,paddingLeft:8+file.depth*12,transform:`translateY(${row.start}px)`}} onClick={()=>file.folder?setExpanded(old=>{const next=new Set(old);next.has(file.path)?next.delete(file.path):next.add(file.path);return next;}):file.editable?void open(file.path):void window.modmixer.projectReveal(mod.folder,file.path)}><span>{file.folder?(expanded.has(file.path)?'▾':'▸'):file.editable?'▤':'◇'}</span><span>{search?file.path:file.path.split('/').pop()}</span></button>;})}</div>{!tree.length&&<p>{scanning?'Loading files…':'No matching files.'}</p>}</>:<>{searching&&<p role="status">Searching…</p>}{matches.map((match,index)=><button className="atlas-search-result" key={match.path+':'+match.line+':'+index} onClick={()=>void open(match.path,{line:match.line,column:match.column,key:Date.now()})} title={match.path+':'+match.line}><strong>{match.path.split('/').pop()}:{match.line}</strong><small>{match.path}</small><code>{match.excerpt}</code></button>)}{!searching&&!matches.length&&<p>{query.trim().length<2?'Enter at least two characters.':'No matching text.'}</p>}</>}
   </div>
   <div className="atlas-file-count">{mode==='files'?`${files.length.toLocaleString()} project files`:searchNotice}</div><button className="atlas-button" onClick={()=>void window.modmixer.projectReveal(mod.folder)}>Open project folder</button>
  </aside>
  <div className="atlas-editor">
   <div className="atlas-editor-tabs" role="tablist" aria-label="Open files">{tabs.map(tab=><div key={tab.path} className={selected===tab.path?'selected':''}><button role="tab" aria-selected={selected===tab.path} title={tab.path} onClick={()=>setSelected(tab.path)}>{tab.path.split('/').pop()}{tab.text!==tab.draft?' •':''}</button><button aria-label={'Close '+tab.path} disabled={working} onClick={()=>void close(tab.path)}>×</button></div>)}</div>
   <div className="atlas-pane-heading atlas-editor-heading"><span title={current?.path}>{current?.path||'File editor'}</span><div className="atlas-actions">{onToggleFiles&&<button className="atlas-button" onClick={onToggleFiles}>{filesVisible?'Hide files':'Show files'}</button>}<button className="atlas-button" disabled={!current||working} onClick={()=>current&&void open(current.path,undefined,true)}>Reload</button><button className="atlas-button atlas-primary" disabled={!dirty||busy||working} onClick={()=>void save()} title={busy?'Finish active work before saving':'Save (Ctrl+S)'}>{working?'Working…':'Save'}</button></div></div>
   {error&&<p role="alert" className="atlas-warning">{error}</p>}{notice&&<p className="atlas-inline-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={()=>setNotice('')}>×</button></p>}
   {current?<><CodeEditor path={current.path} text={current.draft} lineSeparator={current.text.includes('\r\n')?'\r\n':'\n'} states={states.current} location={current.location} onChange={draft=>setTabs(old=>old.map(tab=>tab.path===selected?{...tab,draft}:tab))} onCursor={(line,column)=>setTabs(old=>old.map(tab=>tab.path===selected?{...tab,line,column}:tab))} onSave={()=>void save()}/><div className="atlas-editor-status"><span>Ln {current.line}, Col {current.column}{dirty?' · Unsaved':''}</span><span>Ctrl+F Find · Ctrl+Shift+F Search project</span></div></>:<div className="atlas-empty"><span>▤</span><h2>Your project, in view</h2><p>Browse folders or search file contents. Open several files without losing your drafts.</p><p>Images and binary files open in their file location.</p></div>}
  </div>
 </section>;
}
