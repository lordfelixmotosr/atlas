import {useEffect,useState} from 'react';
import type {DllUpdateOverview} from '../agent/rimworld/dll-update';
import {appAlert,appConfirm} from '../components/app-dialog';

export function ManualInstallControl({folder,conversationId,busy,onInstalling}:{folder:string;conversationId:string;busy:boolean;onInstalling:(value:boolean)=>void}) {
  const [state,setState]=useState<DllUpdateOverview|null>(null),[installing,setInstalling]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{
    let cancelled=false,inFlight=false;
    const refresh=async()=>{if(inFlight)return;inFlight=true;try{const next=await window.modmixer.dllUpdateState(folder,conversationId);if(!cancelled)setState(next);}catch{/* ordinary launch remains available */}finally{inFlight=false;}};
    void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},6000);
    const changed=()=>void refresh();const off=window.modmixer.onModChanged(changed),offAssets=window.modmixer.onAssetsChanged(changed);
    return()=>{cancelled=true;window.clearInterval(timer);off();offAssets();};
  },[folder,conversationId]);
  const install=async()=>{
    if(installing)return;setInstalling(true);onInstalling(true);setNotice('');
    try{
      let result=await window.modmixer.applyDllUpdate(folder,conversationId);
      while(result.status==='confirmation'){
        if(!await appConfirm(result.message,{title:'Install mod update?',okLabel:result.running?'Close and install':'Install update'}))return;
        result=await window.modmixer.applyDllUpdate(folder,conversationId,result.token);
      }
      if(result.status==='installed')setNotice('Update installed');
      if(result.status==='installed'&&result.warnings.length)await appAlert(result.warnings.join('\n'),{title:'Installed with warnings'});
      if(result.status==='current')setNotice('Already installed');
      setState(await window.modmixer.dllUpdateState(folder,conversationId));
    }catch(error){await appAlert(error instanceof Error?error.message:String(error),{title:'Update not installed'});}
    finally{setInstalling(false);onInstalling(false);}
  };
  const changes=state?.mods.flatMap(mod=>mod.changes.map(change=>`${mod.name}: ${change.action} ${change.path}`))??[];
  if(!state?.pending&&!installing)return notice?<span className="text-xs text-muted" role="status">{notice}</span>:null;
  return <button type="button" data-atlas-manual-install className="atlas-button atlas-install-update" disabled={busy||installing||!!state?.error} onClick={()=>void install()}
    title={state?.error||`Compiled DLL update ready. Installs the complete runtime package and removes obsolete files. ${state?.running?'RimWorld must close. ':''}\n${changes.join('\n')}`}
    aria-label={installing?'Installing mod update':'Install mod update'}>
    <span aria-hidden>{installing?'◌':'↓'}</span> {installing?'Installing…':'Install update'}
    {!installing&&state&&state.mods.length>1&&<span className="text-[10px] opacity-75">{state.mods.length} mods</span>}
  </button>;
}
