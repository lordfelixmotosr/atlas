import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {app, shell} from 'electron';
import {getWorkspacePaths,getMirrorStateDir,getRimWorldModsDir,listWorkspaceMods} from '../../agent/workspace.js';
import {getConversation} from '../../agent/conversations.js';
import {getRegistry} from '../../agent/registry/index.js';
import {isRimWorldRunning,quitRimWorld} from '../../agent/rimworld/game.js';
import {syncModToGame} from '../../agent/workspace.js';
import {withRuntimeSync,previousRuntimeInfo,restoreRuntimeMirror,ownedMirror,isLegacyWorkspaceLink} from '../../agent/rimworld/runtime-mirror.js';
import {previewRuntimeMod} from '../../agent/rimworld/install-preview.js';
import {runtimeSignature} from '../../agent/rimworld/release-package.js';
import {getBuildState,isBuildInProgress} from '../../agent/rimworld/build-state.js';
import {dllTestFolders,inspectRuntimeUpdate,type DllUpdateOverview,type DllInstallResult,type ModDllUpdate,type RuntimeInstallMode,type RuntimeInstallPreview} from '../../agent/rimworld/dll-update.js';
import {readTestOptions} from '../../agent/rimworld/test-history.js';
import {refreshModShortcuts} from '../../atlas/mod-folder-shortcuts.js';
import type {RouteContext} from './context.js';

const GAME_IN_USE='RimWorld is being used by an active agent test or live session. Finish that game session before installing; other agent work can continue.';

/**
 * Install update copies a mod's project folder into RimWorld's Mods folder the same
 * way Test in RimWorld does, without launching the game. Any runtime file change
 * counts. Only the mods being installed must be idle; a companion or dependency that
 * cannot be prepared keeps its current game copy and is reported instead of blocking.
 */
export function registerDllUpdateRoutes(ctx: RouteContext): void {
  let applying=false;
  let confirmation: {token:string;folder:string;signature:string;running:boolean;mode:RuntimeInstallMode;expires:number}|undefined;
  const cache=new Map<string,{at:number;task:Promise<DllUpdateOverview>}>();
  const validate=(folder:string,conversationId:string)=>{
    if(!folder||folder==='.'||folder==='..'||/[\\/\x00]/.test(folder))throw new Error('Invalid mod folder.');
    const convo=getConversation(conversationId);
    if(!convo||convo.scope.type!=='mod'||convo.scope.modFolder!==folder||(convo.game&&convo.game!=='rimworld'))throw new Error('This chat does not belong to the RimWorld mod.');
  };
  const workspaceDir=()=>getWorkspacePaths().workspaceDir;
  const editing=(name:string)=>ctx.host.modWorkBusy(name)||isBuildInProgress(path.join(workspaceDir(),name));
  const nameOf=(name:string)=>getRegistry().getSnapshot().mods.find(m=>m.source==='workspace'&&m.folder===name)?.about.name||name;
  const stillWorking=(name:string)=>`The assistant or a C# build is still working on ${name}. Wait for that work to finish, then choose Install update again.`;
  const state=async(folder:string,conversationId:string,force=false):Promise<DllUpdateOverview>=>{
    validate(folder,conversationId);
    const previous=cache.get(folder);if(!force&&previous&&Date.now()-previous.at<2000)return previous.task;
    const task=(async()=>{
      const registry=getRegistry();await registry.start();const snapshot=registry.getSnapshot();
      const options=await readTestOptions(folder),folders=dllTestFolders(snapshot,folder,options.companionMods),mods:ModDllUpdate[]=[],skipped:ModDllUpdate[]=[];
      const root=workspaceDir(),game=getRimWorldModsDir();
      for(const name of folders){
        const label=snapshot.mods.find(m=>m.source==='workspace'&&m.folder===name)?.about.name||name;
        try{const changes=await inspectRuntimeUpdate(path.join(root,name),path.join(game,name),getMirrorStateDir());if(changes.length)mods.push({folder:name,name:label,changes});}
        catch(error){(name===folder?mods:skipped).push({folder:name,name:label,changes:[],error:typeof (error as Error)?.message==='string'?(error as Error).message:String(error)});}
      }
      let previous=null;try{previous=await previousRuntimeInfo(path.join(root,folder),path.join(game,folder),getMirrorStateDir());}catch{/* invalid history is reported when explicitly opened */}
      const installed=await ownedMirror(path.join(root,folder),path.join(game,folder),getMirrorStateDir())||await isLegacyWorkspaceLink(path.join(root,folder),path.join(game,folder));
      return {running:await isRimWorldRunning(),pending:mods.some(m=>m.changes.length>0),installed,mods,error:mods.find(m=>m.error)?.error,previous,skipped};
    })();cache.set(folder,{at:Date.now(),task});return task;
  };
  ctx.ipc.handle('atlas:mods:dll-update-state',(_evt,folder:string,conversationId:string)=>state(folder,conversationId));
  ctx.ipc.handle('atlas:mods:apply-dll-update',async(_evt,folder:string,conversationId:string,token?:string,mode:RuntimeInstallMode='install'):Promise<DllInstallResult>=>{
    ctx.requireConsent();validate(folder,conversationId);
    if(mode!=='install'&&mode!=='restore')throw new Error('Invalid installation action.');
    if(applying)throw new Error('An installation is already in progress.');
    if(mode==='restore'&&ctx.host.hasActiveWork())throw new Error('Wait for active agent work to finish before restoring a previous runtime.');
    if(mode==='install'&&editing(folder))throw new Error(stillWorking(nameOf(folder)));
    applying=true;
    try{
      const pending=await state(folder,conversationId,true);
      if(mode==='install'&&pending.error)throw new Error(pending.error);
      if(mode==='install'&&!pending.pending)return {status:'current' as const};
      const skipped=[...(mode==='install'?pending.skipped??[]:[])];
      const folders:string[]=[];
      for(const name of mode==='restore'?[folder]:[...new Set([folder,...pending.mods.filter(m=>m.changes.length).map(m=>m.folder)])]){
        if(mode==='install'&&name!==folder&&editing(name)){skipped.push({folder:name,name:nameOf(name),changes:[],error:'The assistant or a C# build is still working on it.'});continue;}
        folders.push(name);
      }
      const workspace=workspaceDir();
      const plans:{folder:string;signature:Awaited<ReturnType<typeof previewRuntimeMod>>['signature']}[]=[],warnings:string[]=skipped.map(m=>`${m.name}: not updated, its current game copy is kept. ${m.error}`),preview:RuntimeInstallPreview={mode,mods:[],added:0,modified:0,removed:0,runtimeBytes:0};
      for(const name of folders){
        if(mode==='restore'&&isBuildInProgress(path.join(workspace,name)))throw new Error('Wait for the C# build to finish before restoring.');
        const result=await previewRuntimeMod(path.join(workspace,name),path.join(getRimWorldModsDir(),name),getMirrorStateDir(),mode);
        result.preview.name=pending.mods.find(m=>m.folder===name)?.name??nameOf(name);
        preview.mods.push(result.preview);preview.runtimeBytes+=result.preview.runtimeBytes;
        for(const change of result.preview.changes)preview[change.action]++;
        plans.push({folder:name,signature:result.signature});warnings.push(...result.warnings.map(w=>`${name}: ${w}`));
        if(mode==='install'&&result.preview.changes.length&&(await getBuildState(path.join(workspace,name))).status==='needs-rebuild')warnings.push(`${result.preview.name}: C# code changed since its last build, so the game gets the last compiled DLL. Use Rebuild C# to include the code changes.`);
      }
      const signature=createHash('sha256').update(JSON.stringify(plans)).digest('hex');
      const accepted=confirmation&&token===confirmation.token&&folder===confirmation.folder&&signature===confirmation.signature&&pending.running===confirmation.running&&mode===confirmation.mode&&Date.now()<confirmation.expires;
      if(!accepted){
        confirmation={token:randomUUID(),folder,signature,running:pending.running,mode,expires:Date.now()+300000};
        return {status:'confirmation',token:confirmation.token,running:pending.running,preview,warnings,message:(token?'The preview changed or expired. Review the updated file list. ':'')+(pending.running?'Save your game first. Atlas will close RimWorld. ':'')+(mode==='restore'?'Restore this mod’s previous installed runtime. Source edits stay in your workspace. Atlas testing keeps the restored copy until runtime files change or you choose Install update.':'Install the files shown here from your Atlas project, the same way Test in RimWorld does, without launching the game. Obsolete files will be removed.')};
      }
      confirmation=undefined;
      if(mode==='restore'&&ctx.host.hasActiveWork())throw new Error('Agent work started. Finish it before restoring.');
      if(ctx.host.gameInUseByAgent())throw new Error(GAME_IN_USE);
      if(await isRimWorldRunning()){
        if(!pending.running)throw new Error('RimWorld started during preparation. Try Install update again.');
        const quit=await quitRimWorld();if(!quit.killed||!quit.exited)throw new Error('RimWorld did not close. No runtime update was installed.');
        if(ctx.host.gameInUseByAgent())throw new Error('Agent game work started while RimWorld was closing. No runtime update was installed.');
        ctx.host.stopMonitoring();
      }
      const installed:string[]=[];
      await withRuntimeSync(getRimWorldModsDir(),async()=>{
        for(const name of folders){
          if(mode==='restore'?ctx.host.hasActiveWork()||isBuildInProgress(path.join(workspace,name)):editing(name))throw new Error(`Work started during installation. Installed so far: ${installed.join(', ')||'none'}. Finish active work, then retry.`);
          try{
            const reviewed=plans.find(p=>p.folder===name)!.signature,options={forceWorkspace:true,expectedRuntime:runtimeSignature(reviewed.plan),expectedInstalled:runtimeSignature(reviewed.installed)};
            const result=mode==='restore'?{assetWarnings:(await restoreRuntimeMirror(path.join(workspace,name),path.join(getRimWorldModsDir(),name),getMirrorStateDir(),options)).warnings}:await syncModToGame(name,options);
            installed.push(name);warnings.push(...result.assetWarnings.map(w=>`${name}: ${w}`));
          }
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
