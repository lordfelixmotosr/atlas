import {useEffect,useRef,useState} from 'react';
import type {DllInstallResult,DllUpdateOverview,RuntimeInstallMode} from '../agent/rimworld/dll-update';
import {appAlert} from '../components/app-dialog';
import {RuntimeInstallDialog} from './runtime-install-dialog';

type Review=Extract<DllInstallResult,{status:'confirmation'}>;
export function ManualInstallControl({enabled=true,folder,conversationId,busy,onInstalling,restoreRequest=0,onRestoreAvailable}:{enabled?:boolean;folder:string;conversationId:string;busy:boolean;onInstalling:(value:boolean)=>void;restoreRequest?:number;onRestoreAvailable?:(available:boolean)=>void}) {
  const [state,setState]=useState<DllUpdateOverview|null>(null),[working,setWorking]=useState(false),[notice,setNotice]=useState(''),[review,setReview]=useState<Review|null>(null),[error,setError]=useState('');
  const lastRestore=useRef(restoreRequest),active=useRef(false);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(''),6000);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{
    if(!enabled)return;
    let cancelled=false,inFlight=false;
    const refresh=async()=>{if(inFlight||active.current)return;inFlight=true;try{const next=await window.modmixer.dllUpdateState(folder,conversationId);if(!cancelled){setState(next);onRestoreAvailable?.(!!next.previous);}}catch{/* ordinary launch remains available */}finally{inFlight=false;}};
    void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},6000);
    const changed=()=>void refresh();const off=window.modmixer.onModChanged(changed),offAssets=window.modmixer.onAssetsChanged(changed);
    return()=>{cancelled=true;window.clearInterval(timer);off();offAssets();};
  },[folder,conversationId,onRestoreAvailable,enabled]);
  const run=async(mode:RuntimeInstallMode,token?:string)=>{
    if(active.current)return;active.current=true;setWorking(true);onInstalling(true);setNotice('');setError('');
    try{
      const result=await window.modmixer.applyDllUpdate(folder,conversationId,token,mode);
      if(result.status==='confirmation'){setReview(result);return;}
      setReview(null);setNotice(result.status==='current'?'Already installed':mode==='restore'?'Previous version restored':'Update installed');
      const next=await window.modmixer.dllUpdateState(folder,conversationId);setState(next);onRestoreAvailable?.(!!next.previous);
      if(result.status==='installed'&&result.warnings.length){
        const warnings=[...new Set(result.warnings)];
        void appAlert(`${mode==='restore'?'The previous runtime was restored':'The runtime update was installed'} for ${result.installed.length} ${result.installed.length===1?'mod':'mods'}.\n\n${warnings.length} ${warnings.length===1?'warning needs':'warnings need'} review. These are asset or package checks; installation has completed.`,{title:mode==='restore'?'Restored with warnings':'Installed with warnings',details:warnings});
      }
    }catch(cause){const message=cause instanceof Error?cause.message:String(cause);if(token)setError(message);else await appAlert(message,{title:mode==='restore'?'Restore unavailable':'Update not installed'});}
    finally{active.current=false;setWorking(false);onInstalling(false);}
  };
  useEffect(()=>{if(restoreRequest!==lastRestore.current){lastRestore.current=restoreRequest;void run('restore');}},[restoreRequest]);
  const changes=state?.mods.flatMap(mod=>mod.changes.map(change=>`${mod.name}: ${change.action} ${change.path}`))??[];
  return <>
    {(state?.pending||working)&&<button type="button" data-atlas-manual-install className="atlas-button atlas-install-update" disabled={busy||working||!!state?.error} onClick={()=>void run('install')}
      title={state?.error||`Review the complete runtime update before installing. Removes obsolete files.\n${changes.join('\n')}`} aria-label={working?'Preparing mod installation':'Install mod update'}>
      <span aria-hidden>{working?'◌':'↓'}</span> {working?'Working…':'Install update'}
      {!working&&state&&state.mods.length>1&&<span className="text-[10px] opacity-75">{state.mods.length} mods</span>}
    </button>}
    {!working&&notice&&<span className="text-xs text-muted" role="status">{notice}</span>}
    {review&&<RuntimeInstallDialog review={review} working={working} error={error} onClose={()=>{if(!working){setReview(null);setError('');}}} onConfirm={()=>void run(review.preview.mode,review.token)}/>}
  </>;
}
