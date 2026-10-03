'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {readRecovery}=require('./startup-health.cjs');
const {VERSION,compareVersions,atomicJson,verifyEnvelope,sha,safeRelative}=require('./library.cjs');
class ApplicationUpdate {
  constructor(library,electron,isBusy){this.library=library;this.electron=electron;this.isBusy=isBusy;this.ready=null;this.available=null;this.working=false;this.error=null;}
  status(){return{version:VERSION,available:this.available?.version??null,ready:this.ready?.version??null,working:this.working,error:this.error,source:this.library.config.source,lastCheckedAt:this.lastCheckedAt??null,recovery:readRecovery(this.library.root)};}
  async check(){if(this.working)throw new Error('An application update is running.');this.working=true;this.error=null;this.lastCheckedAt=new Date().toISOString();try{const index=verifyEnvelope(await this.library.obtain(this.library.config.source,'index.atlas.json'),this.library.trust);if(index.type!=='feed'||!Number.isSafeInteger(index.sequence)||index.sequence<this.library.state.sequence)throw new Error('Invalid or outdated update feed.');const entry=index.application;
    if(!entry){this.available=null;this.ready=null;return this.status();}
    if(!/^\d+\.\d+\.\d+$/.test(entry.version)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>1200*1024*1024)throw new Error('Invalid application update metadata.');safeRelative(entry.file);if(compareVersions(entry.version,VERSION)<=0){this.available=null;this.ready=null;return this.status();}if(this.ready?.sha256!==entry.sha256)this.ready=null;this.available=entry;return this.status();
  }catch(error){this.error=error.message;throw error;}finally{this.working=false;}}
  async download(){await this.check();if(!this.available)return this.status();this.working=true;try{
    const entry=this.available,bytes=await this.library.obtain(this.library.config.source,entry.file,entry.size);
    if(bytes.length!==entry.size||sha(bytes)!==entry.sha256)throw new Error('Application update checksum differs from the signed feed.');
    const folder=path.join(this.library.root,'data','updates');fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,'Atlas-'+entry.version+'.zip');fs.writeFileSync(target,bytes);this.ready={...entry,path:target};return this.status();
  }catch(error){this.error=error.message;throw error;}finally{this.working=false;}}
  install(){if(!this.ready)throw new Error('Download an application update first.');if(this.isBusy())throw new Error('Finish or stop active work before restarting Atlas.');if(sha(fs.readFileSync(this.ready.path))!==this.ready.sha256)throw new Error('Downloaded update changed since verification.');
    const request=path.join(this.library.root,'data','updates','install-request.json');atomicJson(this.library.root,request,{root:this.library.root,pid:process.pid,version:this.ready.version,zip:this.ready.path,sha256:this.ready.sha256});
    const helper=path.join(this.library.resources,'apply-update.ps1');spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-RequestPath',request],{detached:true,stdio:'ignore',windowsHide:true}).unref();this.electron.app.exit(0);
  }
}
module.exports={ApplicationUpdate};
