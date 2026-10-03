const fs=require('node:fs'),path=require('node:path');const root=path.resolve(__dirname,'../..'),work=path.resolve(root,'../work');const read=n=>require(path.join(work,'felix-'+n+'-source.cjs'));
const write=(f,s)=>fs.writeFileSync(path.join(root,f),s);
function edit(file,fn){write(file,fn(fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n')))}
let renderer=[read('speed').rendererCode,read('usage').rendererCode,read('accounts').rendererCode,read('recovery').rendererCode.split('function felixReconcileSession')[0],read('steer').rendererCode.split('function felixRestoreSteerDraft')[0],read('steer').rendererCode.slice(read('steer').rendererCode.indexOf('function FelixSteeringQueue'))].join('\n');
renderer=renderer.replaceAll('(Qe.get(id)??ji)','getPanelSnapshot(id)').replaceAll('lx(id,','setPanelDraft(id,');
write('src/atlas/controls.tsx',`// @ts-nocheck\nimport * as v from 'react';import * as s from 'react/jsx-runtime';import {appAlert as kn} from '../components/app-dialog';import {setPanelDraft,getPanelSnapshot} from '../conversations-store';\n${renderer}\nexport {FelixSpeedControl,FelixUsageControl,FelixAccountControl,FelixOpenAIAccounts,FelixSentenceShortcut,felixUseComposerFocus,FelixSteeringQueue};\n`);
write('src/atlas/library-ui.tsx','// @ts-nocheck\nimport * as v from "react";import * as s from "react/jsx-runtime";\n'+fs.readFileSync(path.join(root,'src/atlas/renderer.js'),'utf8')+'\nexport {AtlasKnowledgeButton,AtlasApplicationUpdates};\n');
write('src/atlas/controls.css',[read('accounts').css,read('recovery').css,read('steer').css,read('compact').css,read('toolbar').toolbarCSS].join('\n'));
edit('src/preload.ts',s=>s.replace('atlasLibraryOpenCustom:','atlasLibraryCustom:'));
edit('src/main.ts',s=>{
 s="import './atlas/portable';\nimport {registerAtlasRoutes} from './atlas/routes';\n"+s;
 s=s.replace('initUpdater(getWindow);','// Atlas uses the signed local application updater.');
 s=s.replace('registerModrinthRoutes(routeContext);','registerAtlasRoutes(routeContext);');s=s.replace('  void syncCommunityLore();','  // Shared upstream lore uploads are disabled in Atlas.');
 s=s.replace('  createWindow();\n  // Unified','  createWindow();\n  require("./atlas/startup-health.cjs").monitor(app,()=>mainWindow);\n  // Unified');
 s=s.replace('icon: undefined,','icon: path.join(process.resourcesPath,"atlas/icon.png"),\n    title: "Atlas",');
 return s;
});
edit('src/atlas/routes.ts',s=>s.replace('resources:process.resourcesPath','resources:path.join(process.resourcesPath,"atlas")').replace('ensureIndexAtStartup({force:true})','ensureIndexAtStartup()').replace('emitModChanged({folder,reason:\'atlas-editor\'})','emitModChanged(folder)').replace('emitModChanged({folder:plan.folder,reason:\'atlas-assets\'})','emitModChanged(plan.folder)'));
edit('src/agent/settings.ts',s=>s.replace('  const next: Settings = { ...defaults };','  const next: Settings = { ...defaults };\n  next.openaiSpeed=obj.openaiSpeed==="fast"?"fast":"standard";\n  if(obj.sentenceShortcut&&typeof obj.sentenceShortcut==="object"){const v=obj.sentenceShortcut as any;if(typeof v.label==="string"&&typeof v.text==="string")next.sentenceShortcut={label:v.label.trim().slice(0,40)||"Insert shortcut",text:v.text.slice(0,10000)};}'));
edit('src/conversations-store.ts',s=>{
 s=s.replace('  loading: boolean;','  loading: boolean;\n  steering?: string[];');
 s=s.replace("return { ...cur, busy: false, streaming: null };","return { ...cur, busy: !!(event as any).willRetry, streaming: null };");
 s=s.replace("    case 'compaction_start':",`    case 'queue_update': return {...cur,steering:(event as any).steering||[]};\n    case 'auto_retry_start': return {...cur,busy:true};\n    case 'auto_retry_end': return {...cur,busy:false};\n    case 'compaction_start':`);
 return s+`\nexport function getPanelSnapshot(id:string){return panels.get(id)??EMPTY_PANEL;}\nexport function reconcileAgent(id:string,status:any){const cur=runtimes.get(id);if(!cur||cur.loading)return;const messages=!status.busy&&status.messages?status.messages:cur.messages;runtimes.set(id,{...cur,messages,busy:!!status.busy,compacting:!!status.compacting,steering:status.steering??[],streaming:status.busy?cur.streaming:null,toolStates:status.busy?cur.toolStates:deriveToolStates(messages)});notify(id);}\nexport function applyCompactResult(id:string,result:any){reconcileAgent(id,{busy:false,compacting:false,messages:result.messages,steering:result.steering});}\n`;
});
edit('src/components/mod-header.tsx',s=>'import {FelixSentenceShortcut} from "../atlas/controls";\n'+s.replace('      <div className="flex items-center gap-2">','      <div className="flex items-center gap-2">\n        <FelixSentenceShortcut conversationId={conversationId} />'));
edit('src/components/chat-panel.tsx',s=>{
 s='import {AgentActivity} from "../atlas/activity";\nimport {FelixSpeedControl,FelixUsageControl,FelixAccountControl,FelixSteeringQueue,felixUseComposerFocus} from "../atlas/controls";\nimport {applyCompactResult} from "../conversations-store";\n'+s;
 s=s.replace('  const effectiveScope:',`  const composer=felixUseComposerFocus(conversation.id);\n  const steerer=useAsyncAction((text:string,files:PreparedAttachment[])=>window.modmixer.steer(conversation.id,text,files));\n  const compactor=useAsyncAction(()=>window.modmixer.compactContext(conversation.id));\n  const [notice,setNotice]=useState('');\n  const compact=async()=>{if(busy||compacting||loading||compactor.busy)return;const id=conversation.id;const result=await compactor.run();if(result){applyCompactResult(id,result);setContextUsage(result.context);setNotice('Context compacted. Recent messages are retained.');}};\n  const effectiveScope:`);
 s=s.replace('toolStates, busy, compacting, loading }','toolStates, busy, compacting, loading, steering=[] }');s=s.replace('    send.error ??','    compactor.error ?? steerer.error ?? send.error ??');
 s=s.replace("lastMessage.stopReason === 'toolUse'","(lastMessage.stopReason === 'toolUse'||lastMessage.stopReason === 'aborted')");
 s=s.replace(' || busy || loading) return;',' || loading || compacting || compactor.busy || steerer.busy || interruptAction.busy) return;');
 s=s.replace('    const result = await send.run(text, staged);',`    const wasBusy=busy;\n    const result = wasBusy?await steerer.run(text,staged):await send.run(text, staged);\n    if(wasBusy&&result?.queued===false){restorePanelDraft(conversation.id,text);addPanelAttachments(conversation.id,staged);setNotice(result.reason);}`);
 s=s.replace('      markIdle(conversation.id);','      if(!wasBusy)markIdle(conversation.id);');
 s=s.replace('    contextWindow: number;','    contextWindow: number;\n    estimated?:boolean;');
 s=s.replace('u ? { tokens: u.tokens, contextWindow: u.contextWindow } : null','u ? { tokens: u.tokens, contextWindow: u.contextWindow,estimated:(u as any).estimated===true } : null');
 s=s.replace("env.event.type === 'agent_end') {","env.event.type === 'agent_end'||env.event.type==='compaction_end') {");
 s=s.replace('      <div className="border-t border-line px-6 py-3">',`      <AgentActivity conversationId={conversation.id} busy={busy} compacting={compacting} />\n      <div className="atlas-composer border-t border-line px-6 py-3">\n        <FelixSteeringQueue lines={steering} busy={busy} resuming={retryAction.busy} onResume={()=>void retry()} />\n        {notice&&<p className="atlas-inline-notice" role="status">{notice}</p>}`);
 s=s.replace('className="flex items-center gap-1.5"','className="flex flex-wrap items-center gap-1.5"');
 s=s.replace('<ThinkingPicker current={thinkingLevel} onChange={changeThinking} />','<ThinkingPicker current={thinkingLevel} onChange={changeThinking} />\n              <FelixSpeedControl model={model} /><FelixAccountControl model={model} busy={busy||compacting} onConnect={onConnect} /><FelixUsageControl model={model} />\n              <button type="button" className="atlas-button" disabled={busy||loading||compacting||compactor.busy||!messages.length} onClick={()=>void compact()}>{compacting||compactor.busy?"Compacting…":"Compact now"}</button>');
 s=s.replace("context ={' '}","Context {contextUsage.estimated?'~':''}{' '}");
 s=s.replace('<textarea\n','<textarea\n              ref={composer}\n');s=s.replace("loading ? 'Loading chat…' : placeholderForScope(effectiveScope)","loading ? 'Loading chat…' : compacting?'Compacting context…':busy?'Give instructions to steer the agent…':placeholderForScope(effectiveScope)");
 s=s.replace('              {busy ? (','              {busy&&!compacting&&<button className="atlas-button atlas-primary" disabled={steerer.busy||!draft.trim()&&!attachments.length} onClick={()=>void submit()}>{steerer.busy?"Queuing…":"Steer"}</button>}\n              {busy ? (');
 s=s.replace('                  data-demo="chat-send"','                  data-demo="chat-send"\n                  disabled={loading||compacting||compactor.busy||steering.length>0}');
 return s;
});
edit('src/App.tsx',s=>{
 s='import logo from "../assets/atlas/logo-source.png";\nimport {AtlasKnowledgeButton} from "./atlas/library-ui";\n'+s;
 s=s.replace('<GridMark loading={busy} />','<img src={logo} alt="" className="atlas-logo" />').replace('              modmixer\n','              Atlas\n');
 const start=s.indexOf('          <button\n            onClick={() =>\n              void window.modmixer.openExternal(\n                \'https://discord.gg/');if(start<0)throw Error('Discord header anchor');const end=s.indexOf('          </button>',start)+'          </button>'.length;s=s.slice(0,start)+'          <AtlasKnowledgeButton />'+s.slice(end);
 return s;
});
// Native compilation tools are isolated from the public runtime, which is pinned to pi 0.82.1.
