// One-time migration of the tested Felix additions into readable source modules.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),work=path.resolve(root,'../work');
const read=n=>require(path.join(work,'felix-'+n+'-source.cjs'));
function edit(file,fn){const p=path.join(root,file),s=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');fs.writeFileSync(p,fn(s));}
function one(s,a,b){if(!s.includes(a))throw new Error('Missing source anchor: '+a.slice(0,100));return s.replace(a,b);}
const rename=s=>s.replace(/\byTe\b/g,'buildAttachedPrompt').replace(/\bXe\b/g,'getConversation').replace(/\b_l\b/g,'toPiThinking').replace(/\bZ\b/g,'loadSettings').replace(/\bge\b/g,'saveSettings').replace(/\bnn\b/g,'crypto').replace(/\by\b(?=\.join)/g,'path').replace(/\bOe\b/g,'pi');
let feature=rename([read('speed').requestCode,read('usage').mainCode,read('recovery').mainCode,read('steer').mainCode,read('accounts').mainCode,read('compact').mainCode].join('\n'));
feature=feature.replace('!session.isIdle||','!!session.felixManualCompacting||!session.isIdle||').replace('busy=!session.isIdle||compacting','busy=felixAgentWorking(session)').replace('exists:true,busy,compacting,activity:','exists:true,busy,compacting,steering:felixSteeringPreview(session),activity:');
feature=feature.replace('const compacting=!!session.isCompacting','const compacting=!!session.felixManualCompacting||!!session.isCompacting').replace('Promise.race([entry.session.abort(),','Promise.race([Promise.all([entry.session.abort(),entry.session.agent.waitForIdle()]),');
feature=feature.replace('async function felixGetUsage(host, force = false) {','async function felixGetUsage(host, force = false) {const accountEpoch=felixOpenAIAccountEpoch;if(host.felixAccountOperation)return {status:"loading",buckets:[],credits:null};').replace('const resolution = await host.modelRuntime.getAuth("openai-codex");','const resolution = await host.modelRuntime.getAuth("openai-codex");if(accountEpoch!==felixOpenAIAccountEpoch||host.felixAccountOperation)return {status:"loading",buckets:[],credits:null};');
feature=feature.replace('session._isAgentRunActive=true;','felixAssertAccountReady(session.felixAccountHost??{},session);session._isAgentRunActive=true;').replace('session.prompt=(...args)=>{felixAssertAccountReady','session.prompt=(...args)=>{felixCheckCompacting(session);felixAssertAccountReady');
fs.writeFileSync(path.join(root,'src/atlas/agent-features.ts'),`// @ts-nocheck\n// Ported from the tested Felix additions; compatibility keys intentionally retained.\nimport * as k from 'electron';\nimport * as crypto from 'node:crypto';\nimport path from 'node:path';\nimport * as pi from '@earendil-works/pi-coding-agent';\nimport {loadSettings,saveSettings} from '../agent/settings';\nimport {getConversation} from '../agent/conversations';\nimport {toPiThinking} from '../lib/thinking-levels';\nimport {buildAttachedPrompt} from '../agent/agent-host';\n${feature}\nexport {felixWithSpeed,felixSetSpeed,felixNormalizeShortcut,felixSetShortcut,felixGuardStream,felixObserveSession,felixSessionStatus,felixInterrupt,felixAgentWorking,felixContinueSession,felixCheckIdleSteering,felixSteer,felixAccountsInfo,felixChangeOpenAIAccount,felixLoginOpenAIAccount,felixAccountEvent,felixSendWithAccount,felixAssertAccountReady,felixGateAccountSession,felixRefreshIdleModels,felixGetUsage,felixClearUsage,felixCompactContext,felixCheckCompacting,felixContextUsage};\n`);
let creds=read('accounts').credentialCode.replace('class gme','export class SafeStorageCredentialStore').replace(/\bnp\b/g,'parseCredentials').replace(/k\.app/g,'app').replace('new(require("node:async_hooks").AsyncLocalStorage)','new AsyncLocalStorage()');
edit('src/agent/security/secure-auth-storage.ts',s=>'// @ts-nocheck\nimport {AsyncLocalStorage} from "node:async_hooks";\n'+s.slice(0,s.indexOf('export class SafeStorageCredentialStore implements'))+creds);
edit('src/agent/agent-host.ts',s=>{
 const imports='import {felixWithSpeed,felixGuardStream,felixGateAccountSession,felixObserveSession,felixAccountEvent,felixInterrupt,felixAgentWorking,felixCheckCompacting,felixCheckIdleSteering,felixSendWithAccount,felixContinueSession,felixLoginOpenAIAccount,felixChangeOpenAIAccount,felixRefreshIdleModels,felixClearUsage,felixContextUsage,felixAssertAccountReady} from "../atlas/agent-features";\n';
 s=imports+s;
 s=one(s,'async function buildAttachedPrompt(','export async function buildAttachedPrompt(');
 s=one(s,'this.credentials.reload();','this.credentials.reload();\n      await this.credentials.initializeOpenAIAccounts();');
 s=one(s,'sessionRef = session;','sessionRef = session;\n    session.agent.streamFunction = felixGuardStream(felixWithSpeed(session.agent.streamFunction, loadSettings));\n    felixGateAccountSession(this,session);');
 s=one(s,'const entry = this.sessions.get(conversationId);\n    if (!entry) {\n      throw new Error(`No open session for conversation: ${conversationId}`);\n    }\n    // Re-warm','const entry = this.sessions.get(conversationId);\n    if (!entry) throw new Error(`No open session for conversation: ${conversationId}`);\n    felixCheckCompacting(entry.session);\n    felixCheckIdleSteering(this,conversationId);\n    return felixSendWithAccount(this,entry,async()=>{\n    // Re-warm');
 s=one(s,"      images,\n    });\n  }\n\n  /**\n   * Cancel", "      images,\n    });\n    });\n  }\n\n  /**\n   * Cancel");
 s=one(s,'    await entry.session.abort();','    await felixInterrupt(this,conversationId);');
 s=one(s,'    if (agent.signal) return;','    felixCheckCompacting(entry.session);felixAssertAccountReady(this,entry.session);\n    if (felixAgentWorking(entry.session)) return;');
 s=s.replace("last.stopReason !== 'error' && last.stopReason !== 'toolUse'","last.stopReason !== 'error' && last.stopReason !== 'toolUse' && last.stopReason !== 'aborted'");
 s=one(s,'    await agent.continue();','    await felixSendWithAccount(this,entry,()=>felixContinueSession(entry.session));');
 s=one(s,'  async loginOAuth(providerId: string): Promise<void> {','  async loginOAuth(providerId: string): Promise<void> {\n    if(providerId!=="openai-codex")return this.felixLoginOAuthOriginal(providerId);\n    await felixLoginOpenAIAccount(this);\n  }\n  async felixLoginOAuthOriginal(providerId: string): Promise<void> {');
 s=one(s,"      await this.modelRuntime.login(providerId, 'oauth', {",'      if(providerId==="openai-codex")this.credentials.felixLoginContext.getStore().signal=abort.signal;\n      await this.modelRuntime.login(providerId, \'oauth\', {');
 s=s.replace('await this.refreshActiveModel();','await felixRefreshIdleModels(this);');
 s=one(s,'  async logoutOAuth(providerId: string): Promise<void> {','  async logoutOAuth(providerId: string): Promise<void> {\n    if(providerId==="openai-codex"){const id=this.credentials.openAIAccounts().activeId;if(id)await felixChangeOpenAIAccount(this,"remove",id);return;}');
 s=one(s,'  private emitOAuth(event: OAuthEvent): void {','  private emitOAuth(event: OAuthEvent): void {\n    if(event.type==="links-changed"||event.providerId==="openai-codex")felixClearUsage();');
 s=s.replace(/return \(\n      this.sessions.get\(conversationId\)\?\.session.getContextUsage\(\) \?\? null\n    \);/,'return felixContextUsage(this,conversationId);');
 const p=s.indexOf('  private onSessionEvent('),end=s.indexOf('    if (',p);s=s.slice(0,end)+'    felixObserveSession(conversationId,event);\n    if(event.type==="agent_start"||event.type==="agent_end")felixAccountEvent(this);\n'+s.slice(end);
 return s;
});
edit('src/agent/settings.ts',s=>{
 s=one(s,'  model: ModelSelection | null;','  model: ModelSelection | null;\n  openaiSpeed: "standard" | "fast";\n  sentenceShortcut: {label:string;text:string};');
 s=one(s,'    model: null,','    model: null,\n    openaiSpeed:"standard",\n    sentenceShortcut:{label:"Insert shortcut",text:""},');
 s=one(s,'    analyticsOptIn: true,','    analyticsOptIn: false,');s=s.replace('useCommunityLore: true','useCommunityLore: false');
 const p=s.indexOf('const raw ='),q=s.indexOf('\n',p); // normalize alongside parsed values below
 s=s.replace('const defaults = defaultSettings();','const defaults = defaultSettings();');
 const at=s.indexOf('return settings;',s.indexOf('export function loadSettings')); // use actual anchors inspected after migration
 return s;
});
edit('src/preload.ts',s=>one(s,'const api = {',`const api = {
  atlasLibraryStatus:()=>ipcRenderer.invoke('atlas:library:status'),
  atlasLibraryConfigure:(patch:any)=>ipcRenderer.invoke('atlas:library:configure',patch),
  atlasLibraryCheck:()=>ipcRenderer.invoke('atlas:library:check'),atlasLibraryUpdate:()=>ipcRenderer.invoke('atlas:library:update'),
  atlasLibraryRevert:(id:string)=>ipcRenderer.invoke('atlas:library:revert',id),atlasLibrarySearch:(query:any)=>ipcRenderer.invoke('atlas:library:search',query),
  atlasLibraryOpenReference:(id:string,file:string)=>ipcRenderer.invoke('atlas:library:open-reference',id,file),atlasLibraryReveal:(id?:string)=>ipcRenderer.invoke('atlas:library:reveal',id),
  atlasLibraryOpenCustom:()=>ipcRenderer.invoke('atlas:library:custom'),atlasLibraryChooseSource:()=>ipcRenderer.invoke('atlas:library:choose-source'),atlasLibraryRebuild:()=>ipcRenderer.invoke('atlas:library:rebuild'),
  onAtlasLibraryState:(fn:any)=>{const cb=(_e:any,x:any)=>fn(x);ipcRenderer.on('atlas:library:state',cb);return()=>ipcRenderer.removeListener('atlas:library:state',cb)},
  atlasAppStatus:()=>ipcRenderer.invoke('atlas:app:status'),atlasAppCheck:()=>ipcRenderer.invoke('atlas:app:check'),atlasAppDownload:()=>ipcRenderer.invoke('atlas:app:download'),atlasAppInstall:()=>ipcRenderer.invoke('atlas:app:install'),
  onAtlasAppState:(fn:any)=>{const cb=(_e:any,x:any)=>fn(x);ipcRenderer.on('atlas:app:state',cb);return()=>ipcRenderer.removeListener('atlas:app:state',cb)},
  setOpenAISpeed:(mode:string)=>ipcRenderer.invoke('modmixer:settings:set-openai-speed',mode),
  onOpenAISpeedChanged:(fn:any)=>{const cb=(_e:any,x:any)=>fn(x);ipcRenderer.on('modmixer:settings:speed',cb);return()=>ipcRenderer.removeListener('modmixer:settings:speed',cb)},
  setSentenceShortcut:(value:any)=>ipcRenderer.invoke('modmixer:settings:set-sentence-shortcut',value),
  onSentenceShortcutChanged:(fn:any)=>{const cb=(_e:any,x:any)=>fn(x);ipcRenderer.on('modmixer:settings:sentence-shortcut',cb);return()=>ipcRenderer.removeListener('modmixer:settings:sentence-shortcut',cb)},
  getOpenAIUsage:(force=false)=>ipcRenderer.invoke('modmixer:usage:openai',force),
  getOpenAIAccounts:()=>ipcRenderer.invoke('modmixer:accounts:openai:list'),switchOpenAIAccount:(id:string)=>ipcRenderer.invoke('modmixer:accounts:openai:switch',id),renameOpenAIAccount:(id:string,label:string)=>ipcRenderer.invoke('modmixer:accounts:openai:rename',id,label),removeOpenAIAccount:(id:string)=>ipcRenderer.invoke('modmixer:accounts:openai:remove',id),loginOpenAIAccount:(id?:string,label?:string)=>ipcRenderer.invoke('modmixer:accounts:openai:login',id,label),
  steer:(id:string,text:string,files?:any[])=>ipcRenderer.invoke('modmixer:agent:steer',id,text,files),compactContext:(id:string)=>ipcRenderer.invoke('modmixer:agent:compact',id),getAgentStatus:(id:string,includeMessages=false)=>ipcRenderer.invoke('modmixer:agent:status',id,includeMessages),
  revealAsset:(folder:string,file:string)=>ipcRenderer.invoke('atlas:assets:reveal',folder,file),
  projectFiles:(folder:string)=>ipcRenderer.invoke('atlas:files:list',folder),projectRead:(folder:string,file:string)=>ipcRenderer.invoke('atlas:files:read',folder,file),projectSave:(folder:string,file:string,text:string,hash:string)=>ipcRenderer.invoke('atlas:files:save',folder,file,text,hash),projectReveal:(folder:string,file?:string)=>ipcRenderer.invoke('atlas:files:reveal',folder,file),
  assetBulkPlan:(folder:string,paths:string[])=>ipcRenderer.invoke('atlas:assets:bulk-plan',folder,paths),assetBulkApply:(token:string)=>ipcRenderer.invoke('atlas:assets:bulk-apply',token),
  adapterStatus:()=>ipcRenderer.invoke('atlas:adapters:status'),adapterReveal:()=>ipcRenderer.invoke('atlas:adapters:reveal'),
`));
