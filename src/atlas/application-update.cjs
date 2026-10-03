'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {readRecovery}=require('./startup-health.cjs');
const {VERSION,compareVersions,atomicJson,verifyEnvelope,sha,safeRelative,ensureDir}=require('./library.cjs');
class ApplicationUpdate {
  constructor(library,electron,isBusy,options={}){
    this.library=library;this.electron=electron;this.isBusy=isBusy;
    this.ready=null;this.available=null;this.working=false;this.error=null;this.progress=null;
    this.onState=options.onState??(()=>{});this.now=options.now??(()=>performance.now());
    this.lastProgressAt=-Infinity;
  }
  status(){return{version:VERSION,available:this.available?.version??null,ready:this.ready?.version??null,working:this.working,error:this.error,progress:this.progress?{...this.progress}:null,source:this.library.config.source,lastCheckedAt:this.lastCheckedAt??null,recovery:readRecovery(this.library.root)};}
  notify(){this.onState(this.status());}
  stage(stage,receivedBytes=0,totalBytes=0){
    this.progress={stage,receivedBytes,totalBytes,bytesPerSecond:0};this.notify();
  }
  begin(){
    if(this.working)throw new Error('An application update is running.');
    this.working=true;this.error=null;this.lastCheckedAt=new Date().toISOString();
    this.stage('checking');
  }
  async checkInternal(source){
    const index=verifyEnvelope(await this.library.obtain(source,'index.atlas.json'),this.library.trust);
    if(index.type!=='feed'||!Number.isSafeInteger(index.sequence)||index.sequence<this.library.state.sequence)throw new Error('Invalid or outdated update feed.');
    const entry=index.application;
    if(!entry){this.available=null;this.ready=null;return;}
    if(!/^\d+\.\d+\.\d+$/.test(entry.version)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>1200*1024*1024)throw new Error('Invalid application update metadata.');
    safeRelative(entry.file);
    if(compareVersions(entry.version,VERSION)<=0){this.available=null;this.ready=null;return;}
    if(this.ready?.sha256!==entry.sha256||this.ready?.version!==entry.version||this.ready?.size!==entry.size)this.ready=null;
    this.available=entry;
  }
  failed(error){this.error=error.message;this.progress={...this.progress,stage:'error',bytesPerSecond:0};}
  async check(){
    this.begin();
    try{await this.checkInternal(this.library.config.source);this.stage(this.ready?'ready':'idle',this.ready?.size??0,this.ready?.size??0);}
    catch(error){this.failed(error);throw error;}
    finally{this.working=false;this.notify();}
    return this.status();
  }
  async download(){
    this.begin();let temporary,handle;
    try{
      const source=this.library.config.source;await this.checkInternal(source);
      if(this.available&&!this.ready){
        const entry=this.available,folder=path.join(this.library.root,'data','updates');
        ensureDir(this.library.root,folder);
        const target=path.join(folder,'Atlas-'+entry.version+'.zip');
        if(fs.existsSync(target)&&(!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()))throw new Error('Unsafe application update file.');
        temporary=path.join(folder,'download-'+crypto.randomUUID()+'.tmp');
        handle=await fs.promises.open(temporary,'wx');
        const hash=crypto.createHash('sha256');this.downloadStartedAt=this.now();this.lastProgressAt=-Infinity;
        this.stage('downloading',0,entry.size);
        const received=await this.library.obtain(source,entry.file,entry.size,{
          onChunk:async chunk=>{await handle.writeFile(chunk);hash.update(chunk);},
          onProgress:receivedBytes=>{
            const now=this.now(),elapsed=(now-this.downloadStartedAt)/1000;
            this.progress={stage:'downloading',receivedBytes,totalBytes:entry.size,bytesPerSecond:elapsed>0?receivedBytes/elapsed:0};
            if(now-this.lastProgressAt>=250||receivedBytes===entry.size){this.lastProgressAt=now;this.notify();}
          }
        });
        this.stage('verifying',received,entry.size);
        // Yield so the renderer can show verification before committing the archive.
        await new Promise(resolve=>setImmediate(resolve));
        if(received!==entry.size||hash.digest('hex')!==entry.sha256)throw new Error('Application update checksum differs from the signed feed.');
        await handle.sync();await handle.close();handle=null;
        await fs.promises.rename(temporary,target);temporary=null;
        this.ready={...entry,path:target};
      }
      this.stage(this.ready?'ready':'idle',this.ready?.size??0,this.ready?.size??0);
    }catch(error){this.failed(error);throw error;}
    finally{
      try{await handle?.close();if(temporary)await fs.promises.rm(temporary,{force:true});}
      finally{this.working=false;this.notify();}
    }
    return this.status();
  }
  install(){if(!this.ready)throw new Error('Download an application update first.');if(this.isBusy())throw new Error('Finish or stop active work before restarting Atlas.');if(sha(fs.readFileSync(this.ready.path))!==this.ready.sha256)throw new Error('Downloaded update changed since verification.');
    const request=path.join(this.library.root,'data','updates','install-request.json');atomicJson(this.library.root,request,{root:this.library.root,pid:process.pid,version:this.ready.version,zip:this.ready.path,sha256:this.ready.sha256});
    const helper=path.join(this.library.resources,'apply-update.ps1');spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-RequestPath',request],{detached:true,stdio:'ignore',windowsHide:true}).unref();this.electron.app.exit(0);
  }
}
module.exports={ApplicationUpdate};
