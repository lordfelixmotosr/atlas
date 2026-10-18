import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {app, shell} from 'electron';
import {getWorkspacePaths,getMirrorStateDir,getRimWorldModsDir,listWorkspaceMods} from '../../agent/workspace.js';
import {getConversation} from '../../agent/conversations.js';
import {getRegistry} from '../../agent/registry/index.js';
import {isRimWorldRunning,quitRimWorld} from '../../agent/rimworld/game.js';
import {syncModToGame} from '../../agent/workspace.js';
import {withRuntimeSync} from '../../agent/rimworld/runtime-mirror.js';
import {planRelease} from '../../agent/rimworld/release-package.js';
import {isBuildInProgress} from '../../agent/rimworld/build-state.js';
import {dllTestFolders,inspectDllUpdate,type DllUpdateOverview,type DllInstallResult} from '../../agent/rimworld/dll-update.js';
import {readTestOptions} from '../../agent/rimworld/test-history.js';
import {refreshModShortcuts} from '../../atlas/mod-folder-shortcuts.js';
import type {RouteContext} from './context.js';

export function registerDllUpdateRoutes(ctx: RouteContext): void {
  let applying=false;
  let confirmation: {token:string;folder:string;signature:string;running:boolean;expires:number}|undefined;
  const cache=new Map<string,{at:number;task:Promise<DllUpdateOverview>}>();
  const validate=(folder:string,conversationId:string)=>{
    if(!folder||folder==='.'||folder==='..'||/[\\/\x00]/.test(folder))throw new Error('Invalid mod folder.');
    const convo=getConversation(conversationId);
    if(!convo||convo.scope.type!=='mod'||convo.scope.modFolder!==folder||(convo.game&&convo.game!=='rimworld'))throw new Error('This chat does not belong to the RimWorld mod.');
  };
  const state=async(folder:string,conversationId:string,force=false):Promise<DllUpdateOverview>=>{
    validate(folder,conversationId);
    const previous=cache.get(folder);if(!force&&previous&&Date.now()-previous.at<2000)return previous.task;
    const task=(async()=>{
      const registry=getRegistry();await registry.start();const snapshot=registry.getSnapshot();
      const options=await readTestOptions(folder),folders=dllTestFolders(snapshot,folder,options.companionMods),mods=[];
      const root=getWorkspacePaths().workspaceDir,game=getRimWorldModsDir();
      for(const name of folders){
        try{const changes=await inspectDllUpdate(path.join(root,name),path.join(game,name),getMirrorStateDir());if(changes.length)mods.push({folder:name,name:snapshot.mods.find(m=>m.source==='workspace'&&m.folder===name)?.about.name||name,changes});}
        catch(error){mods.push({folder:name,name,changes:[],error:String(error)});}
      }
      return {running:await isRimWorldRunning(),pending:mods.some(m=>m.changes.length>0),mods,error:mods.find(m=>m.error)?.error};
    })();cache.set(folder,{at:Date.now(),task});return task;
  };
  ctx.ipc.handle('atlas:mods:dll-update-state',(_evt,folder:string,conversationId:string)=>state(folder,conversationId));
  ctx.ipc.handle('atlas:mods:apply-dll-update',async(_evt,folder:string,conversationId:string,token?:string):Promise<DllInstallResult>=>{
    ctx.requireConsent();validate(folder,conversationId);
    if(applying)throw new Error('A DLL update is already being applied.');
    if(ctx.host.hasActiveWork())throw new Error('Wait for active agent work to finish before applying DLLs.');
    applying=true;
    try{
      const pending=await state(folder,conversationId,true);
      if(pending.error)throw new Error(pending.error);
      if(!pending.pending)return {status:'current' as const};
      const folders=[...new Set([folder,...pending.mods.filter(m=>m.changes.length).map(m=>m.folder)])];
      const workspace=getWorkspacePaths().workspaceDir;
      const plans=[],warnings:string[]=[];
      for(const name of folders){
        if(isBuildInProgress(path.join(workspace,name)))throw new Error('Wait for the C# build to finish before installing.');
        const plan=await planRelease(path.join(workspace,name));if(!plan.valid)throw new Error(plan.errors.join('\n'));
        plans.push({folder:name,files:plan.files,directories:plan.directories,warnings:plan.warnings});
        warnings.push(...plan.warnings.map(w=>`${name}: ${w}`));
      }
      const signature=createHash('sha256').update(JSON.stringify(plans)).digest('hex');
      const accepted=confirmation&&token===confirmation.token&&folder===confirmation.folder&&signature===confirmation.signature&&pending.running===confirmation.running&&Date.now()<confirmation.expires;
      if((pending.running||warnings.length)&&!accepted){
        confirmation={token:randomUUID(),folder,signature,running:pending.running,expires:Date.now()+120000};
        return {status:'confirmation',token:confirmation.token,running:pending.running,message:(pending.running?'Save your game first. Atlas will close RimWorld and install the complete runtime update. The game will stay closed.':'Install the complete runtime update?')+'\n\nObsolete runtime files will be removed. Your workspace files stay in place.'+(warnings.length?'\n\nReview omitted content before installing:\n'+warnings.join('\n'):'')};
      }
      confirmation=undefined;
      if(ctx.host.hasActiveWork())throw new Error('Agent work started. Finish it before applying DLLs.');
      if(await isRimWorldRunning()){
        if(!pending.running)throw new Error('RimWorld started during preparation. Try Install update again.');
        const quit=await quitRimWorld();if(!quit.killed||!quit.exited)throw new Error('RimWorld did not close. No runtime update was installed.');
        ctx.host.stopMonitoring();
      }
      const installed:string[]=[];
      await withRuntimeSync(getRimWorldModsDir(),async()=>{
        for(const name of folders){
          if(ctx.host.hasActiveWork()||isBuildInProgress(path.join(workspace,name)))throw new Error(`Work started during installation. Installed so far: ${installed.join(', ')||'none'}. Finish active work, then retry.`);
          try{const result=await syncModToGame(name);installed.push(name);warnings.push(...result.assetWarnings.map(w=>`${name}: ${w}`));}
          catch(error){throw new Error(`Installation stopped. Installed so far: ${installed.join(', ')||'none'}. ${String(error)}`,{cause:error});}
        }
      });
      return {status:'installed' as const,installed,warnings:[...new Set(warnings)]};
    }finally{cache.clear();applying=false;}
  });
  ctx.ipc.handle('atlas:mods:open-named-folders',async()=>{
    if(process.platform!=='win32')throw new Error('Named folder shortcuts require Windows.');
    const result=await refreshModShortcuts(app.getPath('userData'),getWorkspacePaths().workspaceDir,await listWorkspaceMods(),shell);
    const error=await shell.openPath(result.directory);if(error)throw new Error(error);return result;
  });
}
