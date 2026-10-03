// @ts-nocheck
import * as electron from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getWorkspacePaths} from '../agent/workspace';
import {scanAssets} from '../agent/assets/scanner';
import {emitModChanged} from '../agent/mod-events';
import {startRebuild} from '../agent/index/main-bridge';
import {registerModMixerImportRoutes} from './modmixer-import-routes';
import {readModChanges,recordModBaseline} from './mod-changes';
import {readModPrefs} from '../agent/mod-prefs';
import {felixSetSpeed,felixSetShortcut,felixSessionStatus,felixSteer,felixCancelSteering,felixCompactContext,felixAccountsInfo,felixChangeOpenAIAccount,felixLoginOpenAIAccount,felixGetUsage,felixAgentWorking} from './agent-features';
export function registerAtlasRoutes(ctx){
 const {ipc,host,getWindow,requireConsent}=ctx,root=process.env.ATLAS_ROOT;
 const files=require('./atlas/project-files.cjs'),bulk=require('./atlas/bulk-assets.cjs');
 const modRoot=folder=>files.projectRoot(getWorkspacePaths().workspaceDir,folder);
 const busy=()=>host.atlasModImport||host.felixAccountOperation||host.pendingOAuth||[...host.sessions.values()].some(x=>felixAgentWorking(x.session));
 registerModMixerImportRoutes(ctx,busy);
 require('./atlas/runtime.cjs').init({root,resources:path.join(process.resourcesPath,"atlas"),host,getWindow,electron,rebuildIndex:()=>startRebuild(),isBusy:busy});
 const h=(name,fn)=>ipc.handle(name,(_e,...args)=>fn(...args));
 h('atlas:mods:changes',async(folder,comparison='latest')=>{if(!['latest','published','updated'].includes(comparison))throw new Error('Choose a saved comparison.');return readModChanges(modRoot(folder),(await readModPrefs(folder)).lastPublishedAt,comparison)});
 h('atlas:mods:mark-updated',async(folder,note='')=>{if(busy())throw new Error('Finish active work before marking an update.');if(typeof note!=='string'||note.length>4000)throw new Error('Use a note of up to 4,000 characters.');await recordModBaseline(modRoot(folder),'updated',note);emitModChanged(folder);return readModChanges(modRoot(folder),(await readModPrefs(folder)).lastPublishedAt)});
 h('modmixer:settings:set-openai-speed',felixSetSpeed);h('modmixer:settings:set-sentence-shortcut',felixSetShortcut);h('modmixer:usage:openai',force=>felixGetUsage(host,force===true));
 h('modmixer:agent:status',(id,messages)=>felixSessionStatus(host,id,messages===true));h('modmixer:agent:steer',(id,text,attachments)=>{requireConsent();return felixSteer(host,id,text,attachments)});h('modmixer:agent:compact',id=>{requireConsent();return felixCompactContext(host,id)});
 h('atlas:agent:cancel-steering',(id,ids)=>felixCancelSteering(host,id,ids));
 h('modmixer:accounts:openai:list',()=>felixAccountsInfo(host));h('modmixer:accounts:openai:switch',id=>felixChangeOpenAIAccount(host,'switch',id));h('modmixer:accounts:openai:rename',(id,label)=>felixChangeOpenAIAccount(host,'rename',id,label));h('modmixer:accounts:openai:remove',id=>felixChangeOpenAIAccount(host,'remove',id));h('modmixer:accounts:openai:login',(id,label)=>felixLoginOpenAIAccount(host,id,label));
 h('atlas:files:list',folder=>files.listFiles(modRoot(folder)));h('atlas:files:read',(folder,file)=>files.readText(modRoot(folder),file));
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
