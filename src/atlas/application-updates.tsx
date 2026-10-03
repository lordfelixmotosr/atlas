import {useEffect,useState} from 'react';

type UpdateProgress={stage:'checking'|'idle'|'downloading'|'verifying'|'ready'|'error';receivedBytes:number;totalBytes:number;bytesPerSecond:number};
type UpdateState={version:string;available:string|null;ready:string|null;working:boolean;error:string|null;progress?:UpdateProgress|null;source:string;lastCheckedAt:string|null;recovery?:{status:string;reason?:string}|null};
const megabytes=(bytes:number)=>(bytes/1_000_000).toLocaleString(undefined,{maximumFractionDigits:1,minimumFractionDigits:1})+' MB';

export function ApplicationUpdateProgress({progress}:{progress?:UpdateProgress|null}){
  if(!progress||progress.stage==='idle')return null;
  const {stage,receivedBytes,totalBytes,bytesPerSecond}=progress;
  const determinate=totalBytes>0&&stage!=='checking';
  const percent=determinate?Math.min(100,Math.floor(receivedBytes/totalBytes*100)):0;
  const label={checking:'Checking for updates…',idle:'',downloading:'Downloading update',verifying:'Verifying download…',ready:'Ready to install',error:'Download needs attention'}[stage];
  return <section className={'atlas-update-progress atlas-update-'+stage} aria-label="Application update progress">
    <div className="atlas-update-heading"><strong role="status">{label}</strong>{determinate&&<span>{percent}%</span>}</div>
    <progress aria-label={label} max={totalBytes||1} value={determinate?receivedBytes:undefined}/>
    {totalBytes>0&&<div className="atlas-update-stats"><span>{megabytes(receivedBytes)} / {megabytes(totalBytes)}</span>{stage==='downloading'&&<span>{bytesPerSecond>0?megabytes(bytesPerSecond)+'/s':'Waiting for download…'}</span>}</div>}
    {stage==='verifying'&&<p>Checking the signed size and checksum before installation.</p>}
    {stage==='ready'&&<p>Your update is verified. Install when your current work has finished.</p>}
  </section>;
}

export function AtlasApplicationUpdates(){
  const [value,setValue]=useState<UpdateState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let alive=true;
    window.modmixer.atlasAppStatus().then(state=>alive&&setValue(state)).catch(e=>alive&&setError(e.message));
    const off=window.modmixer.onAtlasAppState((state:UpdateState)=>{if(alive){setValue(state);if(state.working)setError('');}});
    return()=>{alive=false;off();};
  },[]);
  async function action(fn:()=>Promise<UpdateState>){
    setBusy(true);setError('');
    try{setValue(await fn());}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const working=busy||!!value?.working;
  return <details className="atlas-source-settings">
    <summary>Atlas application updates</summary>
    <p>Atlas {value?.version??'…'} portable · checked daily with your library. Verified app updates download automatically; you choose when to restart.</p>
    {(error||value?.error)&&<p role="alert" className="atlas-error">{error||value?.error}</p>}
    {value?.ready?<p>Version {value.ready} is verified and ready.</p>:value?.available?<p>Version {value.available} is available.</p>:<p>Updates from {value?.source??'the selected signed feed'}.</p>}
    <ApplicationUpdateProgress progress={value?.progress}/>
    {value?.recovery&&<p className={value.recovery.status==='rolled-back'?'atlas-warning':'atlas-notice'}>{value.recovery.reason||'Last update started successfully.'}</p>}
    {value?.lastCheckedAt&&<p>Last check: {new Date(value.lastCheckedAt).toLocaleString()}</p>}
    <div className="atlas-actions">
      <button type="button" className="atlas-action" disabled={working} onClick={()=>void action(()=>window.modmixer.atlasAppCheck())}>{value?.progress?.stage==='checking'?'Checking…':'Check app updates'}</button>
      {value?.available&&!value?.ready&&<button type="button" className="atlas-action" disabled={working} onClick={()=>void action(()=>window.modmixer.atlasAppDownload())}>{value?.progress?.stage==='downloading'?'Downloading…':value?.progress?.stage==='verifying'?'Verifying…':'Download update'}</button>}
      {value?.ready&&<button type="button" className="atlas-action atlas-primary" disabled={working} onClick={()=>void action(()=>window.modmixer.atlasAppInstall())}>Install and restart</button>}
    </div>
  </details>;
}
