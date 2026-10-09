// @ts-nocheck
import * as electron from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getWorkspacePaths} from '../agent/workspace';
import {scanAssets} from '../agent/assets/scanner';
import {emitModChanged} from '../agent/mod-events';
import {onSetupProgress} from '../agent/index/setup-progress';
import {startRebuild,cancelActiveRebuild} from '../agent/index/main-bridge';
import {registerModMixerImportRoutes} from './modmixer-import-routes';
import {readModChanges,recordModBaseline,prepareModDescription,saveModDescription} from './mod-changes';
import {readModPrefs} from '../agent/mod-prefs';
import {felixSetSpeed,felixSetShortcut,felixSessionStatus,felixSteer,felixCancelSteering,felixCompactContext,felixAccountsInfo,felixChangeOpenAIAccount,felixLoginOpenAIAccount,felixGetUsage,felixAgentWorking} from './agent-features';
import {getClaudeUsage} from './claude-usage';
export function registerAtlasRoutes(ctx){
 const {ipc,host,getWindow,requireConsent}=ctx,root=process.env.ATLAS_ROOT;
 const drafts=new Set();
 const files=require('./atlas/project-files.cjs'),bulk=require('./atlas/bulk-assets.cjs');
 const modRoot=folder=>files.projectRoot(getWorkspacePaths().workspaceDir,folder);
 const descriptions=new Map();
 const busy=()=>host.atlasModImport||host.felixAccountOperation||host.pendingOAuth||descriptions.size>0||[...host.sessions.values()].some(x=>felixAgentWorking(x.session));
 registerModMixerImportRoutes(ctx,busy);
 const runtime=require('./atlas/runtime.cjs').init({root,resources:path.join(process.resourcesPath,"atlas"),host,getWindow,electron,rebuildIndex:()=>startRebuild(),isBusy:busy,hasDrafts:()=>drafts.size>0,cancelIndex:cancelActiveRebuild,requireConsent});
 onSetupProgress((game,event)=>{if(game==='rimworld')runtime.tasks.observeIndex(event);});
 const h=(name,fn)=>ipc.handle(name,(_e,...args)=>fn(...args));
 h('atlas:mods:changes',async(folder,comparison='latest')=>{if(!['latest','published','updated'].includes(comparison))throw new Error('Choose a saved comparison.');return readModChanges(modRoot(folder),(await readModPrefs(folder)).lastPublishedAt,comparison)});
 h('atlas:mods:mark-updated',async(folder,note='')=>{if(busy())throw new Error('Finish active work before marking an update.');if(typeof note!=='string'||note.length>4000)throw new Error('Use a note of up to 4,000 characters.');await recordModBaseline(modRoot(folder),'updated',note);emitModChanged(folder);return readModChanges(modRoot(folder),(await readModPrefs(folder)).lastPublishedAt)});
 const checkDescription=(folder,comparison,key)=>{const project=modRoot(folder);if(!['latest','published','updated'].includes(comparison)||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('Refresh the saved comparison first.');return project;};
 h('atlas:mods:description-save',async(folder,comparison,key,text)=>{const project=checkDescription(folder,comparison,key);await saveModDescription(project,comparison,key,text);emitModChanged(folder);return readModChanges(project,(await readModPrefs(folder)).lastPublishedAt,comparison)});
 h('atlas:mods:description-generate',async(folder,comparison,key)=>{
  requireConsent();const project=checkDescription(folder,comparison,key);if(descriptions.has(folder))throw new Error('A description is already running for this mod.');if(host.felixAccountOperation||host.pendingOAuth)throw new Error('Finish sign-in before writing a description.');
  const controller=new AbortController();descriptions.set(folder,controller);const timer=setTimeout(()=>controller.abort(),120000),id='description:'+folder;
  runtime.tasks.update(id,{kind:'description',title:'Describe mod changes',status:'running',phase:'Writing feature description',fraction:null,restart:true},'Reading the saved change comparison');
  try{const evidence=await prepareModDescription(project,comparison,key),result=await host.describeModChanges(evidence,controller.signal);if(controller.signal.aborted)throw new Error('Description cancelled.');await saveModDescription(project,comparison,key,result.text,'ai',result.model);emitModChanged(folder);runtime.tasks.update(id,{status:'completed',phase:'Description saved'},'Saved a description for this exact comparison');return readModChanges(project,(await readModPrefs(folder)).lastPublishedAt,comparison);}
  catch(error){runtime.tasks.update(id,{status:controller.signal.aborted?'cancelled':'failed',phase:controller.signal.aborted?'Description stopped':error.message},error.message);throw error;}
  finally{clearTimeout(timer);descriptions.delete(folder);}
 });
 h('atlas:mods:description-cancel',folder=>{modRoot(folder);descriptions.get(folder)?.abort();});
 electron.app.on('before-quit',()=>{for(const controller of descriptions.values())controller.abort();});
 h('modmixer:settings:set-openai-speed',felixSetSpeed);h('modmixer:settings:set-sentence-shortcut',felixSetShortcut);h('modmixer:usage:openai',force=>felixGetUsage(host,force===true));h('atlas:usage:claude',force=>getClaudeUsage(host,force===true));
 h('modmixer:agent:status',(id,messages)=>felixSessionStatus(host,id,messages===true));h('modmixer:agent:steer',(id,text,attachments)=>{requireConsent();return felixSteer(host,id,text,attachments)});h('modmixer:agent:compact',id=>{requireConsent();return felixCompactContext(host,id)});
 h('atlas:agent:cancel-steering',(id,ids)=>felixCancelSteering(host,id,ids));
 h('modmixer:accounts:openai:list',()=>felixAccountsInfo(host));h('modmixer:accounts:openai:switch',id=>felixChangeOpenAIAccount(host,'switch',id));h('modmixer:accounts:openai:rename',(id,label)=>felixChangeOpenAIAccount(host,'rename',id,label));h('modmixer:accounts:openai:remove',id=>felixChangeOpenAIAccount(host,'remove',id));h('modmixer:accounts:openai:login',(id,label)=>felixLoginOpenAIAccount(host,id,label));
 h('atlas:files:draft-state',(folder,dirty)=>{if(typeof folder!=='string'||!folder||/[\\/:]/.test(folder)||folder==='.'||folder==='..'||typeof dirty!=='boolean')throw new Error('Invalid draft state.');if(dirty){modRoot(folder);drafts.add(folder);}else drafts.delete(folder);});
 h('atlas:files:list',folder=>files.listFiles(modRoot(folder)));h('atlas:files:read',(folder,file)=>files.readText(modRoot(folder),file));
 const searches=new Map();
 h('atlas:files:search',async(folder,query,options={})=>{
  if(typeof options.token!=='string'||options.token.length>100)throw new Error('Invalid search request.');
  const project=modRoot(folder);searches.get(folder)?.controller.abort();
  const controller=new AbortController(),job={token:options.token,controller};searches.set(folder,job);
  try{return await files.searchText(project,query,{caseSensitive:options.caseSensitive===true,signal:controller.signal});}
  finally{if(searches.get(folder)===job)searches.delete(folder);}
 });
 h('atlas:files:search-cancel',(folder,token)=>{modRoot(folder);if(searches.get(folder)?.token===token)searches.get(folder).controller.abort();});
 h('atlas:files:save',(folder,file,text,hash)=>{if(busy())throw new Error('Stop or finish active work before saving an edited file.');const result=files.saveText(modRoot(folder),file,text,hash);emitModChanged(folder);return result;});
 const reveal=(folder,file='')=>{const target=files.revealTarget(modRoot(folder),file);return target.file?electron.shell.showItemInFolder(target.path):electron.shell.openPath(target.path)};
 h('atlas:files:reveal',reveal);
 h('atlas:assets:reveal',reveal);
 const plans=new Map();
 h('atlas:assets:bulk-plan',async(folder,paths)=>{const picked=await electron.dialog.showOpenDialog(getWindow(),{title:'Choose replacement folder (matching Textures / Sounds paths)',properties:['openDirectory']});if(picked.canceled)return null;const root=modRoot(folder),scan=await scanAssets(root);const plan=bulk.planAssets(root,picked.filePaths[0],paths,scan.requirements);const token=randomUUID();plans.set(token,{...plan,folder});for(const [id,p]of plans)if(Date.now()-p.createdAt>600000)plans.delete(id);return {token,rows:plan.rows.map(({targetHash,sourceHash,...row})=>row)};});
 h('atlas:assets:bulk-apply',token=>{if(busy())throw new Error('Finish active work before replacing assets.');const plan=plans.get(token);if(!plan)throw new Error('Preview this batch again.');const result=bulk.applyAssets(plan,path.join(root,'backups'));plans.delete(token);emitModChanged(plan.folder);return result;});
 h('atlas:adapters:status',()=>require('./atlas/adapter-manifest.cjs').status(path.join(root,'custom/game-adapters')));
 h('atlas:adapters:reveal',()=>electron.shell.openPath(path.join(root,'custom/game-adapters')));
}
