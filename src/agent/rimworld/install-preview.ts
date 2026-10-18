import path from 'node:path';
import {planRelease,runtimeInventory,type ReleasePlan} from './release-package.js';
import {ownedMirror,missingRecordedMirror,previousRuntimePlan} from './runtime-mirror.js';
import type {RuntimeInstallMode,RuntimeModPreview} from './dll-update.js';

/** Full hashes are read only when the user opens the installation preview. */
export async function previewRuntimeMod(source:string,target:string,stateDir:string,mode:RuntimeInstallMode){
  const owned=await ownedMirror(source,target,stateDir),missing=!owned&&await missingRecordedMirror(source,target,stateDir);
  if(!owned&&!missing)throw new Error('This mod has no managed runtime to replace. Use Sync to game or launch a test first.');
  const previous=mode==='restore'?await previousRuntimePlan(source,target,stateDir):null;
  const plan=previous?.plan??await planRelease(source);
  if(!plan.valid)throw new Error(plan.errors.join('\n'));
  const installed=missing?{files:[],directories:[]}:await runtimeInventory(target);
  const before=new Map(installed.files.map(file=>[file.path.toLowerCase(),file]));
  const changes:RuntimeModPreview['changes']=[];let unchanged=0;
  for(const file of plan.files){
    const old=before.get(file.path.toLowerCase());before.delete(file.path.toLowerCase());
    if(!old||old.sha256!==file.sha256||old.path!==file.path)changes.push({path:file.path,action:old?'modified':'added',beforeBytes:old?.bytes??0,afterBytes:file.bytes});
    else unchanged++;
  }
  for(const old of before.values())changes.push({path:old.path,action:'removed',beforeBytes:old.bytes,afterBytes:0});
  changes.sort((a,b)=>a.path.localeCompare(b.path));
  const preview:RuntimeModPreview={folder:path.basename(source),name:path.basename(source),changes,unchanged,runtimeBytes:plan.totalBytes,previousSavedAt:previous?.savedAt};
  return {preview,plan,signature:{plan,installed,previous:previous?.id},warnings:plan.warnings};
}
