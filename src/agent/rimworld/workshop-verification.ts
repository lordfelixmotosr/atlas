import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {metadataReadPath,metadataWritePath} from '../mod-metadata.js';
import {isDevelopmentPath,releaseRelative,fileSha,type ReleaseFile} from './release-package.js';

export interface WorkshopVerification {
  status:'pending'|'checking'|'verified'|'mismatch'|'unavailable'|'stopped';
  message:string;
  checkedAt?:number;
  filesChecked?:number;
  missing?:string[];
  changed?:string[];
  unexpected?:string[];
  /** The item is not subscribed; creating a Steam copy requires explicit consent. */
  downloadRequired?:boolean;
}
export interface PublishedRelease {version:1;itemId:string;uploadedAt:number;files:ReleaseFile[];verification:WorkshopVerification}
export async function savePublishedRelease(mod:string,receipt:PublishedRelease):Promise<void>{
  const file=metadataWritePath(mod,'published-runtime.json'),temp=file+'.'+randomUUID()+'.tmp';
  await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(temp,JSON.stringify(receipt),{flag:'wx'});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(()=>{});}
}
export async function readPublishedRelease(mod:string,itemId:string):Promise<PublishedRelease|null>{
  try{
    const file=metadataReadPath(mod,'published-runtime.json');if((await fs.stat(file)).size>32*1024*1024)throw new Error('Oversized upload record.');
    const r=JSON.parse(await fs.readFile(file,'utf8')) as PublishedRelease;
    if(r.version!==1||r.itemId!==itemId)return null;
    if(!Array.isArray(r.files)||!r.files.length||r.files.some(f=>releaseRelative(f.path)!==f.path||isDevelopmentPath(f.path)||!/^[a-f0-9]{64}$/i.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0))throw new Error('Invalid upload record.');
    return r;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
/** Inspect EVERY downloaded path; applying release filters here would hide leftovers. */
export async function compareWorkshopDownload(root:string,expected:ReleaseFile[]):Promise<WorkshopVerification>{
  const st=await fs.lstat(root);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Steam content is not a real directory.');
  const wanted=new Map(expected.map(f=>[f.path,f])),seen=new Set<string>(),missing:string[]=[],changed:string[]=[],unexpected:string[]=[];
  async function walk(dir:string,prefix=''){
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      const relative=prefix+e.name,full=path.join(dir,e.name);
      if(e.isSymbolicLink()||isDevelopmentPath(relative)){unexpected.push(relative+(e.isDirectory()?'/':''));continue;}
      if(e.isDirectory())await walk(full,relative+'/');
      else if(e.isFile()){
        const want=wanted.get(relative);if(!want){unexpected.push(relative);continue;}
        seen.add(relative);const before=await fs.stat(full);
        if(before.size!==want.bytes||await fileSha(full)!==want.sha256)changed.push(relative);
        const after=await fs.stat(full);if(before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error('Steam files changed while being checked. Retry after its download finishes.');
      }else unexpected.push(relative);
    }
  }
  await walk(root);for(const f of wanted.keys())if(!seen.has(f))missing.push(f);
  const ok=!missing.length&&!changed.length&&!unexpected.length;
  return{status:ok?'verified':'mismatch',checkedAt:Date.now(),filesChecked:seen.size,message:ok?`Steam copy verified: ${seen.size} files match the upload; no development files found.`:`Steam copy differs: ${missing.length} missing, ${changed.length} changed, ${unexpected.length} unexpected paths.`,missing,changed,unexpected};
}

export interface SteamDownloadApi {
  download(item:bigint,highPriority:boolean):boolean;
  state(item:bigint):number;
  installInfo(item:bigint):{folder:string;timestamp:number}|null;
  downloadInfo(item:bigint):{current:bigint;total:bigint}|null;
}
/** The binding exposes state flags rather than DownloadItemResult callbacks. */
export async function waitForSteamDownload(api:SteamDownloadApi,item:bigint,progress:(current:number,total:number)=>void,options:{timeoutMs?:number;intervalMs?:number;signal?:AbortSignal}={}):Promise<string>{
  if(!api.download(item,false))throw new Error('Steam did not accept the download. Sign in to Steam and retry verification.');
  const deadline=Date.now()+(options.timeoutMs??120000);let stable='';let count=0;
  while(Date.now()<deadline){
    if(options.signal?.aborted)throw new Error('Verification stopped. Steam may finish its queued download.');
    const state=api.state(item),info=api.downloadInfo(item);if(info)progress(Number(info.current),Number(info.total));
    // Never read while Steam says an update is needed, downloading or pending.
    if((state&4)&&!(state&(8|16|32|2))){
      const installed=api.installInfo(item),key=installed?installed.folder+'\0'+installed.timestamp:'';
      if(key&&key===stable)count++;else{stable=key;count=1;}
      if(key&&count>=2)return installed!.folder;
    }else{stable='';count=0;}
    await new Promise<void>(resolve=>setTimeout(resolve,options.intervalMs??1000));
  }
  throw new Error('Steam has not finished making the latest download available. The upload succeeded; retry verification later.');
}
