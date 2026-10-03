'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {readRecovery}=require('./startup-health.cjs');
const {VERSION,compareVersions,atomicJson,verifyEnvelope,safeRelative,ensureDir}=require('./library.cjs');
const LIMIT=1200*1024*1024;
function metadata(entry){if(!entry||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>LIMIT)throw new Error('Invalid application update metadata.');safeRelative(entry.file);}
function regular(file){if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw new Error('Unsafe application update file.');}
async function digest(file,signal){regular(file);const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))hash.update(chunk);return hash.digest('hex');}
class ApplicationUpdate {
 constructor(library,electron,isBusy,options={}){
  this.library=library;this.electron=electron;this.isBusy=isBusy;this.ready=null;this.available=null;this.working=false;this.error=null;this.progress=null;this.variant='application-update';this.restartBlockReason=options.restartBlockReason??(()=>null);this.onState=options.onState??(()=>{});this.now=options.now??(()=>performance.now());this.lastProgressAt=-Infinity;
  this.folder=path.join(library.root,'data','updates');this.receipt=path.join(this.folder,'resume.json');ensureDir(library.root,this.folder);
  this.spawnInstaller=options.spawnInstaller??spawn;this.handoffTimeout=options.handoffTimeout??120000;
  try{regular(this.receipt);const info=JSON.parse(fs.readFileSync(this.receipt));metadata(info);if(!/^\d+\.\d+\.\d+$/.test(info.version))throw new Error();const part=path.join(this.folder,info.sha256+'.part');regular(part);const received=fs.statSync(part).size;if(received<=info.size){this.resumeInfo=info;this.progress={stage:'paused',receivedBytes:received,totalBytes:info.size,bytesPerSecond:0};}}catch{}
 }
 status(){return{version:VERSION,available:this.available?.version??null,ready:this.ready?.version??null,working:this.working,error:this.error,progress:this.progress?{...this.progress}:null,downloadKind:this.variant,fullAvailable:!!this.available?.full,source:this.library.config.source,lastCheckedAt:this.lastCheckedAt??null,recovery:readRecovery(this.library.root)};}
 notify(){this.onState(this.status());}
 stage(stage,receivedBytes=0,totalBytes=0){this.progress={stage,receivedBytes,totalBytes,bytesPerSecond:0};this.notify();}
 begin(){if(this.working)throw new Error('An application update is running.');this.working=true;this.error=null;this.stopReason=null;this.controller=new AbortController();this.lastCheckedAt=new Date().toISOString();this.stage('checking');}
 async checkInternal(source){
  const index=verifyEnvelope(await this.library.obtain(source,'index.atlas.json',undefined,{signal:this.controller?.signal}),this.library.trust);
  if(index.type!=='feed'||!Number.isSafeInteger(index.sequence)||index.sequence<this.library.state.sequence)throw new Error('Invalid or outdated update feed.');const entry=index.application;
  if(!entry){this.available=null;this.ready=null;return;}metadata(entry);if(!/^\d+\.\d+\.\d+$/.test(entry.version))throw new Error('Invalid application update version.');if(entry.full)metadata(entry.full);
  if(entry.minimumVersion&&!/^\d+\.\d+\.\d+$/.test(entry.minimumVersion))throw new Error('Invalid update compatibility metadata.');
  if(entry.runtimeChecks&&(!Array.isArray(entry.runtimeChecks)||entry.runtimeChecks.length>12))throw new Error('Invalid runtime compatibility metadata.');
  for(const check of entry.runtimeChecks??[]){safeRelative(check.path);if(!/^[a-f0-9]{64}$/.test(check.sha256)||/^(data|custom|library|backups|updates)\//i.test(check.path))throw new Error('Invalid runtime compatibility check.');}
  if(compareVersions(entry.version,VERSION)<=0){this.available=null;this.ready=null;return;}
  this.available=entry;if(this.ready?.version!==entry.version||![entry.sha256,entry.full?.sha256].includes(this.ready?.sha256))this.ready=null;
 }
 fail(error){this.error=error.message;this.progress={...this.progress,stage:'error',bytesPerSecond:0};}
 async check(){this.begin();try{await this.checkInternal(this.library.config.source);this.stage(this.ready?'ready':this.resumeInfo?'paused':'idle',this.ready?.size??(this.resumeInfo&&fs.existsSync(path.join(this.folder,this.resumeInfo.sha256+'.part'))?fs.statSync(path.join(this.folder,this.resumeInfo.sha256+'.part')).size:0),this.ready?.size??this.resumeInfo?.size??0);}catch(error){this.fail(error);throw error;}finally{this.working=false;this.notify();}return this.status();}
 async choose(full){const entry=this.available;let fallback=full===true||entry.minimumVersion&&compareVersions(VERSION,entry.minimumVersion)<0;
  if(!fallback)for(const check of entry.runtimeChecks??[]){try{const target=path.join(this.library.root,...check.path.split('/'));ensureDir(this.library.root,path.dirname(target));if(await digest(target,this.controller.signal)!==check.sha256){fallback=true;break;}}catch(error){this.controller.signal.throwIfAborted();fallback=true;break;}}
  if(fallback&&!entry.full)throw new Error('This update requires a full application package.');this.variant=fallback?'full-update':'application-update';return {...(fallback?entry.full:entry),version:entry.version};
 }
 remember(entry,manualPaused=false){this.resumeInfo={file:entry.file,version:entry.version,size:entry.size,sha256:entry.sha256,full:this.variant==='full-update',manualPaused};atomicJson(this.library.root,this.receipt,this.resumeInfo);}
 discard(){if(this.resumeInfo){const part=path.join(this.folder,this.resumeInfo.sha256+'.part');regular(part);fs.rmSync(part,{force:true});}regular(this.receipt);fs.rmSync(this.receipt,{force:true});this.resumeInfo=null;}
 pause(){if(!this.working||!['downloading','resuming','verifying'].includes(this.progress?.stage))throw new Error('No active download to pause.');this.stopReason='paused';this.controller.abort(new Error('Download paused'));return this.status();}
 cancel(){if(this.working){this.stopReason='cancelled';this.controller.abort(new Error('Download cancelled'));}else{this.discard();this.error=null;this.stage('cancelled');}return this.status();}
 async download(options={}){
  this.begin();let handle,entry,part,integrityFailure=false;
  try{
   const source=this.library.config.source;await this.checkInternal(source);
   if(this.available&&!this.ready){
    entry=await this.choose(options.full??(this.resumeInfo?.version===this.available.version?this.resumeInfo.full:false));ensureDir(this.library.root,this.folder);
    if(options.automatic&&this.resumeInfo?.manualPaused&&this.resumeInfo.sha256===entry.sha256){this.stage('paused',fs.existsSync(path.join(this.folder,entry.sha256+'.part'))?fs.statSync(path.join(this.folder,entry.sha256+'.part')).size:0,entry.size);return {...this.status(),working:false};}
    if(this.resumeInfo&&this.resumeInfo.sha256!==entry.sha256)this.discard();
    const target=path.join(this.folder,'Atlas-'+entry.version+'.zip');regular(target);
    if(fs.existsSync(target)&&fs.statSync(target).size===entry.size&&await digest(target,this.controller.signal)===entry.sha256){this.ready={...entry,path:target};this.discard();}
    else{
     part=path.join(this.folder,entry.sha256+'.part');regular(part);if(fs.existsSync(part)&&fs.statSync(part).size>entry.size)fs.rmSync(part);let offset=fs.existsSync(part)?fs.statSync(part).size:0,hash=crypto.createHash('sha256');
     this.remember(entry);if(offset){this.stage('resuming',offset,entry.size);for await(const chunk of fs.createReadStream(part,{signal:this.controller.signal}))hash.update(chunk);}
     handle=await fs.promises.open(part,'a');this.downloadStartedAt=this.now();this.lastProgressAt=-Infinity;this.stage('downloading',offset,entry.size);let transferred=0;
     const received=offset===entry.size?offset:await this.library.obtain(source,entry.file,entry.size,{
      signal:this.controller.signal,startByte:offset,
      onRestart:async()=>{await handle.close();handle=await fs.promises.open(part,'w');hash=crypto.createHash('sha256');offset=0;transferred=0;this.stage('downloading',0,entry.size);},
      onChunk:async chunk=>{await handle.writeFile(chunk);hash.update(chunk);transferred+=chunk.length;},
      onProgress:receivedBytes=>{const now=this.now(),elapsed=(now-this.downloadStartedAt)/1000;this.progress={stage:'downloading',receivedBytes,totalBytes:entry.size,bytesPerSecond:elapsed>0?transferred/elapsed:0};if(now-this.lastProgressAt>=250||receivedBytes===entry.size){this.lastProgressAt=now;this.notify();}}
     });
     this.stage('verifying',received,entry.size);await new Promise(resolve=>setImmediate(resolve));this.controller.signal.throwIfAborted();
     if(received!==entry.size||hash.digest('hex')!==entry.sha256){integrityFailure=true;throw new Error('Application update checksum differs from the signed feed.');}
     await handle.sync();await handle.close();handle=null;await fs.promises.rename(part,target);this.ready={...entry,path:target};this.discard();
    }
   }
   this.stage(this.ready?'ready':'idle',this.ready?.size??0,this.ready?.size??0);
  }catch(error){
   if(this.stopReason){if(entry&&this.stopReason==='paused')this.remember(entry,true);this.error=null;this.stage(this.stopReason,this.progress?.receivedBytes??0,this.progress?.totalBytes??0);}
   else {if(/size limit|resume range|partial update response/.test(error.message))integrityFailure=true;this.fail(error);throw error;}
  }finally{
   try{await handle?.close();if(integrityFailure||this.stopReason==='cancelled')this.discard();}
   finally{this.working=false;this.controller=null;this.notify();}
  }return this.status();
 }
 async install(){
  if(!this.ready)throw new Error('Download an application update first.');
  if(this.working)throw new Error('An application update is running.');
  const blocked=()=>this.restartBlockReason()||(this.isBusy()?'Finish or stop active work before restarting Atlas.':null);
  if(blocked())throw new Error(blocked());
  this.working=true;this.error=null;this.stage('installing');let child,request;
  try{
   const ready=this.ready;if(await digest(ready.path)!==ready.sha256)throw new Error('Downloaded update changed since verification.');
   if(blocked())throw new Error(blocked());
   const token=crypto.randomUUID(),runner=path.join(this.folder,'installer-'+token);ensureDir(this.library.root,runner);
   // Run an independent copy so replacing the app cannot replace a running helper.
   for(const name of ['launch-update.ps1','apply-update.ps1','watch-update.ps1'])fs.copyFileSync(path.join(this.library.resources,name),path.join(runner,name));
   request=path.join(this.folder,'install-request.json');
   const handoff=path.join(runner,'handoff.json');
   atomicJson(this.library.root,request,{root:this.library.root,pid:process.pid,version:ready.version,zip:ready.path,sha256:ready.sha256,token,handoff,watcher:path.join(runner,'watch-update.ps1')});
   const powershell=path.join(process.env.SystemRoot||process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
   const log=fs.openSync(path.join(runner,'launcher.log'),'a');
   // Windows PowerShell can exit silently without executing -File when launched
   // with DETACHED_PROCESS from a GUI app. Redirected files keep this normal
   // process independent of Atlas's stdio; unref below lets Atlas exit.
   try{child=this.spawnInstaller(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(runner,'launch-update.ps1'),'-RequestPath',request],{detached:false,stdio:['ignore',log,log],windowsHide:true,cwd:this.library.root});}finally{fs.closeSync(log);}
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   let failure;child.on('error',error=>failure=error);child.on('exit',(code)=>{if(code!==0)failure=new Error('The update launcher exited before confirming readiness (code '+code+').');});
   const deadline=Date.now()+this.handoffTimeout;
   while(true){
    let receipt;try{receipt=JSON.parse(await fs.promises.readFile(handoff,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(receipt?.token===token){if(receipt.status==='error')throw new Error(receipt.reason);if(receipt.status==='ready')break;}
    if(failure)throw failure;
    if(Date.now()>deadline)throw new Error('The update installer did not confirm readiness. Atlas stayed open. Try again.');
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   if(blocked())throw new Error(blocked());
   child.unref();this.electron.app.exit(0);
  }catch(error){
   // The helper has not received permission to replace files while this app lives.
   if(request)try{const value=JSON.parse(fs.readFileSync(request,'utf8'));atomicJson(this.library.root,request,{...value,cancelled:true});}catch{}
   this.error=error.message;this.stage('error');throw error;
  }finally{this.working=false;this.notify();}
 }
}
module.exports={ApplicationUpdate};
