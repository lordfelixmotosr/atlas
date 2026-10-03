// Real workspace components with synthetic files. No user profile or model calls.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {build} from '../../build-tools/native/node_modules/vite/dist/node/index.js';
import react from '../../build-tools/native/node_modules/@vitejs/plugin-react/dist/index.js';
import tailwind from '../../build-tools/native/node_modules/@tailwindcss/vite/dist/index.mjs';
const root=path.resolve('.'),version=JSON.parse(fs.readFileSync('package.json')).version;
const dir=path.join(root,'build-check/compact-preview'),output=path.join(root,'build-check/compact-preview-static');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html data-theme="dark"><head><meta charset="UTF-8"><title>Atlas compact workspace preview</title></head><body><div id="root"></div><script>
const counters={files:0,status:0},listeners=new Set(),modListeners=new Set();
const mod={folder:'AtlasDemo',about:{name:'Silvaran equipment',packageId:'felix.silvaran',author:'Felix',description:'Synthetic workspace preview with 1,200 files.',supportedVersions:['1.6']},prefs:{game:'rimworld'},hasCSharp:true};
const api={
scanAssets:async()=>({requirements:[],counts:{present:0,missing:0,invalid:0}}),listSaves:async()=>[],
getSettings:async()=>({openaiSpeed:'standard',sentenceShortcut:{label:'Review changes',text:'Review my mod changes.'},theme:'dark'}),
getOpenAIAccounts:async()=>({activeId:null,accounts:[],busy:false}),getOpenAIUsage:async()=>({status:'disconnected',buckets:[]}),
getContextUsage:async()=>({tokens:200000,contextWindow:1050000}),isRimWorldRunning:async()=>false,
projectFiles:async()=>{counters.files++;return{files:Array.from({length:1200},(_,i)=>({path:'Defs/Armor'+String(i).padStart(4,'0')+'.xml',editable:true}))}},
projectRead:async(_folder,file)=>({path:file,text:'<Defs>\\n  <ThingDef>\\n    <defName>SilvaranArmor</defName>\\n    <label>Silvaran armor</label>\\n  </ThingDef>\\n</Defs>\\n',hash:'fixture'}),
projectSave:async(_folder,file,text)=>({path:file,text,hash:'fixture2'}),
getAgentStatus:async()=>{counters.status++;return{exists:true,busy:false,compacting:false,steering:[]}},
onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},onModChanged:fn=>{modListeners.add(fn);return()=>modListeners.delete(fn)},
listConversationsForMod:async()=>[],getSnapshotUsage:async()=>({totalBytes:0}),modChanges:async()=>({status:'clean',label:'No unpublished changes',files:[]})};
window.modmixer=new Proxy(api,{get:(target,p)=>p in target?target[p]:p.startsWith('on')?()=>()=>{}:async()=>[]});
window.atlasFixture={mod,counters,emitChanges:()=>{for(let i=0;i<20;i++)for(const listener of modListeners)listener({folder:mod.folder})}};
</script><script type="module" src="./fixture.tsx"></script></body></html>`);
fs.writeFileSync(path.join(dir,'fixture.tsx'),`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {BuildView} from '../../src/components/build-view';import {seedConversation,seedPanelState} from '../../src/conversations-store';import {AppDialog} from '../../src/components/app-dialog';import '../../src/styles.css';import logo from '../../assets/atlas/logo-source.png';
const conversation:any={id:'fixture-chat',title:'Equipment polish',game:'rimworld',scope:{type:'mod',modFolder:'AtlasDemo'},model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},thinkingLevel:'high'};
seedConversation(conversation.id,[{role:'user',content:[{type:'text',text:'Check the armor variants and keep their colors consistent.'}],timestamp:Date.now()},{role:'assistant',provider:'openai-codex',model:'gpt-6.1-sol',api:'openai-codex-responses',stopReason:'stop',content:[{type:'text',text:'I can review the XML and directional sprites. Use Compact editor to give our conversation more room, or hide the editor while we plan.'}],timestamp:Date.now(),usage:{input:1,output:1,cost:{total:0}}}] as any);seedPanelState(conversation);
function Fixture(){const [panel,setPanel]=useState<any>('files'),[counts,setCounts]=useState({files:0,status:0});useEffect(()=>{const timer=setInterval(()=>setCounts({...((window as any).atlasFixture.counters)}),500);return()=>clearInterval(timer)},[]);return <main className="flex flex-col h-full"><header className="atlas-pane-heading"><div className="flex items-center gap-3"><img className="atlas-logo" src={logo}/><strong>Atlas ${version}</strong><span>Synthetic workspace preview</span></div><div className="atlas-actions"><small>File scans: {counts.files} · Activity checks: {counts.status}</small><button className="atlas-button" onClick={()=>(window as any).atlasFixture.emitChanges()}>Simulate 20 file changes</button></div></header><BuildView activeMod={(window as any).atlasFixture.mod} activeConvo={conversation} panel={panel} onSelectPanel={setPanel} onBack={()=>{}} onTest={()=>{}} onGeneratePreview={()=>{}} onNewChat={()=>{}} onSavesRestored={()=>{}} busy={false} hasAi={true} availableModels={[{key:'gpt',provider:'openai-codex',providerLabel:'OpenAI',modelId:'gpt-6.1-sol',label:'GPT-6.1 Sol',vision:true}]} onConnect={()=>{}} multiChat={false} chatListRev={0} onSelectChat={()=>{}} onNewChatMulti={()=>{}} onArchiveChat={()=>{}} onUnarchiveChat={()=>{}}/><AppDialog/></main>};createRoot(document.getElementById('root')!).render(<Fixture/>);`);
await build({configFile:false,root,base:'./',plugins:[react(),tailwind()],resolve:{alias:{'@':path.join(root,'src')}},build:{outDir:output,emptyOutDir:true,rollupOptions:{input:path.join(dir,'index.html')}}});
http.createServer((request,response)=>{
  const file=path.resolve(output,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(!file.startsWith(output+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
  response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(response);
}).listen(51941,'127.0.0.1',()=>console.log('Compact workspace preview: http://127.0.0.1:51941/build-check/compact-preview/index.html'));
