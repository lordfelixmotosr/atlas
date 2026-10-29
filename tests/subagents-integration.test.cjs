const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const ts=require('../build-tools/native/node_modules/typescript');
const root=path.resolve(__dirname,'..');
let sdk,ai,typebox;
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
test.before(async()=>{
  sdk=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  ai=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
  typebox=await import(pathToFileURL(require.resolve('typebox')).href);
});
const seed=JSON.parse(fs.readFileSync(path.join(root,'scripts/atlas/inputs/default-models.json'),'utf8'));
const mainModel={...seed.providers['openai-codex'].models[0],provider:'openai-codex'};
function assistant(model,content=[{type:'text',text:'Inspected Source/Main.cs. Validation belongs to the lead.'}],stopReason='stop'){
 return {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason,timestamp:Date.now(),usage:{input:5,output:7,cacheRead:0,cacheWrite:0,totalTokens:12,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
}
function fixture(t,options={}){
 const base=path.join(root,'build-check/fixtures');fs.mkdirSync(base,{recursive:true});
 const directory=fs.mkdtempSync(path.join(base,'subagent-sdk-')),mod=path.join(directory,'mod'),agentDir=path.join(directory,'agent');
 fs.mkdirSync(path.join(mod,'Source'),{recursive:true});fs.writeFileSync(path.join(mod,'Source/Main.cs'),'class Before {}');
 let settings={subagents:{enabled:true,mode:'efficient',maxHelpers:4},openaiSpeed:'standard',thinkingLevel:'max'};
 const events=[],sessions=[],requests=[],changed=[],cleanup=defer();
 const models=options.models??[mainModel];
 const runtime={
  getModel:(provider,id)=>models.find(model=>model.provider===provider&&model.id===id),
  getAvailable:()=>models,hasConfiguredAuth:()=>true,checkAuth:async()=>({apiKey:'fixture-only'}),isUsingOAuth:()=>false,
  getAuth:async()=>({auth:{apiKey:'fixture-only'}}),
  streamSimple(model,context,streamOptions){
   const request={model,context,options:streamOptions,index:requests.length};requests.push(request);
   let result;
   return {async *[Symbol.asyncIterator](){
    yield {type:'start',partial:assistant(model,[])};
    result=options.response?await options.response(request):assistant(model);
    if(result.stopReason==='error'||result.stopReason==='aborted')yield {type:'error',reason:result.stopReason,error:result};
    else yield {type:'done',reason:result.stopReason,message:result};
   },result:async()=>result};
  },
 };
 const wrappedSdk={...sdk,createAgentSession:async creation=>{
  const result=await sdk.createAgentSession(creation),record={creation,session:result.session,disposed:0,aborts:0};sessions.push(record);
  const dispose=result.session.dispose.bind(result.session);result.session.dispose=()=>{record.disposed++;dispose();};
  const abort=result.session.abort.bind(result.session);result.session.abort=async()=>{record.aborts++;await abort();if(options.holdCleanup)await cleanup.promise;};
  return result;
 }};
 const host={sessions:new Map(),constructing:new Set(),busyConversations:new Set(),emitOAuth:event=>events.push(event),credentials:{openAIAccounts:()=>({accounts:[],activeId:null})}};
 const researchNames=['search_defs','search_source','read_symbol','read_csharp_symbol','read_lore','bash','publish_mod','spawn_helper'];
 const researchTools=researchNames.map(name=>({name,label:name,description:name,parameters:typebox.Type.Object({}),execute:async()=>({content:[{type:'text',text:name}],details:{}})}));
 const mocks={
  'electron':{BrowserWindow:{getAllWindows:()=>[]}},
  '@earendil-works/pi-coding-agent':wrappedSdk,'@earendil-works/pi-ai':ai,typebox,
  '../agent/settings':{loadSettings:()=>settings,saveSettings:patch=>(settings={...settings,...patch})},
  '../agent/adapters':{getAdapter:()=>({researchTools:()=>researchTools})},
  '../agent/mod-events':{emitModChanged:folder=>changed.push(folder)},
  '../agent/conversations':{getConversation:()=>undefined},
  '../agent/agent-host':{},
 };
 const cache=new Map();
 const context=vm.createContext({console,process,Buffer,setTimeout,clearTimeout,AbortController,AbortSignal,Error,TextDecoder});
 function load(relative){
  const filename=path.resolve(root,'src',relative);if(cache.has(filename))return cache.get(filename).exports;
  const module={exports:{}};cache.set(filename,module);
  const output=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:filename}).outputText;
  const localRequire=id=>{
   if(id in mocks)return mocks[id];
   if(id.startsWith('node:'))return require(id);
   if(id.startsWith('.'))return load(path.relative(path.join(root,'src'),path.resolve(path.dirname(filename),id.replace(/\.js$/,'')+'.ts')));
   throw Error('Unexpected fixture dependency: '+id);
  };
  vm.runInContext('(function(require,module,exports){'+output+'\n})',context,{filename})(localRequire,module,module.exports);
  return module.exports;
 }
 const {AtlasSubagents}=load('atlas/subagents.ts'),features=load('atlas/agent-features.ts');
 const parent={cwd:mod,modFolder:mod,game:'rimworld',model:models[0],thinkingLevel:'max',systemPrompt:'Fixture project instructions.'};
 const controllerOptions={agentDir,host,runtime:()=>runtime,parent:()=>parent,available:()=>models,send:snapshot=>events.push(snapshot)};
 let controller=new AtlasSubagents(controllerOptions);
 host.subagentsBusy=id=>controller.isBusy(id);host.subagentsProviderBusy=provider=>controller.isProviderBusy(provider);
 const invoke=async(name,args={},chat='chat-a')=>{
  const found=controller.tools(chat).find(tool=>tool.name===name);assert(found,name);
  const result=await found.execute('fixture-call',args,new AbortController().signal);
  const value=result.content.find(item=>item.type==='text').text;
  try{return JSON.parse(value)}catch{return value}
 };
 t.after(async()=>{cleanup.resolve();for(const record of sessions){record.session.clearQueue();await record.session.abort();}await controller.dispose();assert(directory.startsWith(base+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
 return {get controller(){return controller;},reopen:async beforeOpen=>{await controller.dispose();beforeOpen?.({agentDir});controller=new AtlasSubagents(controllerOptions);return controller;},invoke,features,parent,host,events,sessions,requests,mod,changed,cleanup,settings:()=>settings};
}
const task=(extra={})=>({title:'Inspect source',task:'Inspect Source/Main.cs and report evidence.',kind:'research',complexity:'routine',...extra});
const waitTerminal=async(controller,id)=>{for(let i=0;i<10;i++){const [item]=await controller.manager.wait([id],500);if(!['running','queued'].includes(item.status))return item;}throw Error('Helper failed to settle');};

test('an empty failed patch cannot be marked applied and keeps its saved workspace open',async t=>{
 const h=fixture(t,{response:({model})=>({...assistant(model,[],'error'),errorMessage:'Fixture connection failure'})});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'failed');
 const review=await h.controller.reviewPatch('chat-a',child.id);assert.equal(review.changes.length,0);
 assert.throws(()=>h.controller.applyPatch('chat-a',child.id,true),/no saved file changes/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(done.stagingPath,'metadata.json'),'utf8')).state,'open');
 assert.equal(h.controller.manager.get(child.id).applied,undefined);
});

test('real SDK child keeps requested Max thinking and activates only the restricted read-only allowlist',async t=>{
 const h=fixture(t),child=await h.invoke('spawn_helper',task());
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'completed',done.error);
 assert.equal(h.sessions.length,1);assert.equal(h.sessions[0].disposed,1);
 assert.equal(h.sessions[0].creation.thinkingLevel,'max');assert.equal(h.parent.thinkingLevel,'max');
 const names=h.sessions[0].session.agent.state.tools.map(tool=>tool.name).sort();
 assert.deepEqual(names,['find','grep','ls','read','read_csharp_symbol','read_lore','read_symbol','search_defs','search_source'].sort());
 assert.equal(h.sessions[0].creation.settingsManager.getRetrySettings().enabled,false);
 assert.equal(h.sessions[0].creation.settingsManager.getProviderRetrySettings().maxRetries,0);
 assert.match(h.requests[0].context.systemPrompt,/Fixture project instructions/);
 assert.equal(h.requests[0].options.reasoning,'max');
 assert.equal(h.requests[0].options.maxRetries,0);
 assert.deepEqual(plain(done.usage),{input:5,output:7});
});

test('real SDK implementation tools stage assigned text and only a reviewed lead patch can apply it',async t=>{
 const h=fixture(t,{response:({model,index})=>index===0?assistant(model,[{type:'toolCall',id:'write-source',name:'write',arguments:{path:'Source/Main.cs',content:'class After {}'}}],'toolUse'):assistant(model)});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'completed',done.error);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
 const names=h.sessions[0].session.agent.state.tools.map(tool=>tool.name);
 assert(names.includes('write'));assert(!names.includes('bash'));assert(!names.includes('apply_helper_patch'));assert(!names.includes('spawn_helper'));
 await assert.rejects(h.invoke('apply_helper_patch',{id:child.id}),/Review/);
 await assert.rejects(h.invoke('review_helper_patch',{id:child.id},'other-chat'),/does not belong/);
 const review=await h.invoke('review_helper_patch',{id:child.id});assert.match(review.diff,/class After/);
 const applied=await h.invoke('apply_helper_patch',{id:child.id});assert.deepEqual(applied.files,['Source/Main.cs']);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class After {}');
 assert.equal(h.controller.manager.get(child.id).applied,true);assert.deepEqual(h.changed,[h.mod]);
});

test('provider failure runs once, disposes its session, and never retries automatically',async t=>{
 const h=fixture(t,{response:({model})=>({...assistant(model,[],'error'),errorMessage:'Fixture provider unavailable'})});
 const child=await h.invoke('spawn_helper',task());
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'failed');assert.match(done.error,/provider unavailable/);
 await tick();assert.equal(h.requests.length,1);assert.equal(h.sessions[0].disposed,1);assert.equal(h.controller.isBusy(),false);
});

test('efficient research uses a lighter real SDK session while review retains the main model and Max',async t=>{
 const luna={...mainModel,id:'gpt-6-luna',name:'GPT 6 Luna'};
 const h=fixture(t,{models:[mainModel,luna]});
 const research=await h.invoke('spawn_helper',task());
 assert.equal((await waitTerminal(h.controller,research.id)).status,'completed');
 const review=await h.invoke('spawn_helper',task({kind:'review'}));
 assert.equal((await waitTerminal(h.controller,review.id)).status,'completed');
 assert.equal(h.sessions[0].creation.model.id,'gpt-6-luna');assert.equal(h.sessions[0].creation.thinkingLevel,'medium');
 assert.equal(h.sessions[1].creation.model.id,mainModel.id);assert.equal(h.sessions[1].creation.thinkingLevel,'max');
 assert.equal(h.parent.model.id,mainModel.id);assert.equal(h.parent.thinkingLevel,'max');assert.equal(h.settings().thinkingLevel,'max');
});

test('efficient ChatGPT research does not send the rejected GPT-5.4 mini route',async t=>{
 const mini={...mainModel,id:'gpt-5.4-mini',name:'GPT-5.4 mini'};
 const h=fixture(t,{models:[mainModel,mini]});
 const child=await h.invoke('spawn_helper',task());
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'completed',done.error);
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].model.id,mainModel.id);
 assert.equal(h.sessions[0].creation.thinkingLevel,'max');
 assert.equal(done.model.key,'openai-codex/'+mainModel.id);assert.equal(done.model.thinkingLevel,'max');
 assert.equal(h.parent.thinkingLevel,'max');assert.equal(h.settings().thinkingLevel,'max');
});

test('a rejected lighter model stays failed without retry and explicit Retry uses the main model after restart',async t=>{
 const luna={...mainModel,id:'gpt-6-luna',name:'GPT 6 Luna'};
 const h=fixture(t,{models:[mainModel,luna],response:({model})=>model.id===luna.id
  ?{...assistant(model,[],'error'),errorMessage:"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."}
  :assistant(model)});
 const child=await h.invoke('spawn_helper',task());
 const failed=await waitTerminal(h.controller,child.id);assert.equal(failed.status,'failed');assert.match(failed.error,/not supported/);
 await tick();assert.equal(h.requests.length,1);assert.equal(h.controller.isBusy(),false);
 await h.reopen();assert.equal(h.requests.length,1,'Reopening must not resume a failed helper.');
 const retried=h.controller.retry('chat-a',child.id);
 const done=await waitTerminal(h.controller,retried.id);assert.equal(done.status,'completed',done.error);
 assert.equal(h.requests.length,2);assert.equal(h.requests[1].model.id,mainModel.id);
 assert.equal(done.model.key,'openai-codex/'+mainModel.id);assert.equal(done.model.thinkingLevel,'max');
 assert.equal(h.sessions[1].creation.thinkingLevel,'max');assert.equal(h.parent.thinkingLevel,'max');
});

test('queued research rechecks a lighter model rejected by the preceding helper before sending a request',async t=>{
 const luna={...mainModel,id:'gpt-6-luna',name:'GPT 6 Luna'},gate=defer();
 t.after(()=>gate.resolve());
 const h=fixture(t,{models:[mainModel,luna],response:async({model})=>{
  if(model.id!==luna.id)return assistant(model);
  await gate.promise;
  return {...assistant(model,[],'error'),errorMessage:"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."};
 }});
 await h.controller.settings({maxHelpers:1});
 const first=await h.invoke('spawn_helper',task());
 while(!h.requests.length)await tick();
 const second=await h.invoke('spawn_helper',task({title:'Queued research'}));
 assert.equal(h.controller.manager.get(second.id).status,'queued');
 gate.resolve();
 assert.equal((await waitTerminal(h.controller,first.id)).status,'failed');
 const done=await waitTerminal(h.controller,second.id);assert.equal(done.status,'completed',done.error);
 assert.deepEqual(h.requests.map(request=>request.model.id),[luna.id,mainModel.id]);
 assert.equal(done.model.key,'openai-codex/'+mainModel.id);assert.equal(done.model.thinkingLevel,'max');
});

test('ordinary provider connection failures do not blacklist an otherwise selected lighter model',async t=>{
 const luna={...mainModel,id:'gpt-6-luna',name:'GPT 6 Luna'};
 const h=fixture(t,{models:[mainModel,luna],response:({model,index})=>index===0
  ?{...assistant(model,[],'error'),errorMessage:'Connection failed: ECONNRESET'}:assistant(model)});
 const child=await h.invoke('spawn_helper',task());assert.equal((await waitTerminal(h.controller,child.id)).status,'failed');
 const retried=h.controller.retry('chat-a',child.id);assert.equal((await waitTerminal(h.controller,retried.id)).status,'completed');
 assert.deepEqual(h.requests.map(request=>request.model.id),[luna.id,luna.id]);
});

test('an unsupported model parameter does not become a model-access rejection',async t=>{
 const luna={...mainModel,id:'gpt-6-luna',name:'GPT 6 Luna'};
 const h=fixture(t,{models:[mainModel,luna],response:({model,index})=>index===0
  ?{...assistant(model,[],'error'),errorMessage:"The model requested parameter 'temperature', which is not supported."}:assistant(model)});
 const child=await h.invoke('spawn_helper',task());assert.equal((await waitTerminal(h.controller,child.id)).status,'failed');
 const retried=h.controller.retry('chat-a',child.id);assert.equal((await waitTerminal(h.controller,retried.id)).status,'completed');
 assert.deepEqual(h.requests.map(request=>request.model.id),[luna.id,luna.id]);
});

test('the real SDK can stage both reported PowerShell import scripts while the original files remain untouched until reviewed apply',async t=>{
 const files=['Tools/Import-WesterosTunic.ps1','Tools/Validate-TexturePack.ps1'];
 const before=['param([string]$Source)\nWrite-Output $Source\n','param([string]$Pack)\nWrite-Output $Pack\n'];
 const after=['param([string]$Source, [switch]$Headwear)\nWrite-Output $Source\n','param([string]$Pack, [int]$Canvas = 1024)\nWrite-Output $Pack\n'];
 const h=fixture(t,{response:({model,index})=>index===0
  ?assistant(model,files.map((file,i)=>({type:'toolCall',id:'write-script-'+i,name:'write',arguments:{path:file,content:after[i]}})),'toolUse')
  :assistant(model,[{type:'text',text:'Staged the two import scripts. The lead must run validation.'}])});
 fs.mkdirSync(path.join(h.mod,'Tools'));files.forEach((file,i)=>fs.writeFileSync(path.join(h.mod,file),before[i]));
 const child=await h.invoke('spawn_helper',task({title:'Support headwear and HD canvases in import tools',kind:'implement',ownedFiles:files}));
 const done=await waitTerminal(h.controller,child.id);assert.equal(done.status,'completed',done.error);
 assert.deepEqual(plain(done.changes.map(change=>change.path)),files);
 files.forEach((file,i)=>assert.equal(fs.readFileSync(path.join(h.mod,file),'utf8'),before[i]));
 await assert.rejects(h.invoke('apply_helper_patch',{id:child.id}),/Review/);
 const review=await h.invoke('review_helper_patch',{id:child.id});assert.match(review.diff,/Headwear/);assert.match(review.diff,/Canvas/);
 await h.invoke('apply_helper_patch',{id:child.id});
 files.forEach((file,i)=>assert.equal(fs.readFileSync(path.join(h.mod,file),'utf8'),after[i]));
 assert.equal(h.sessions[0].creation.thinkingLevel,'max');
 assert(!h.sessions[0].session.agent.state.tools.some(tool=>tool.name==='bash'));
});

test('unsupported binary assignments fail before a helper task or provider request and a corrected assignment can start',async t=>{
 const h=fixture(t);fs.mkdirSync(path.join(h.mod,'Textures'));fs.writeFileSync(path.join(h.mod,'Textures/Sprite.png'),Buffer.from([137,80,78,71,0,255]));
 await assert.rejects(h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Textures/Sprite.png']})),/Sprite\.png/);
 assert.equal(h.controller.manager.list().length,0);assert.equal(h.sessions.length,0);assert.equal(h.requests.length,0);
 const corrected=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 assert.equal((await waitTerminal(h.controller,corrected.id)).status,'completed');
 assert.equal(h.requests.length,1);assert.equal(h.parent.thinkingLevel,'max');
});

test('a research helper cannot activate the SDK builtin write tool by requesting it',async t=>{
 const h=fixture(t,{response:({model,index})=>index===0?assistant(model,[{type:'toolCall',id:'forbidden-write',name:'write',arguments:{path:'Source/Main.cs',content:'Unauthorized'}}],'toolUse'):assistant(model)});
 const child=await h.invoke('spawn_helper',task());const done=await waitTerminal(h.controller,child.id);
 assert.equal(done.status,'completed',done.error);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
 const rejected=h.sessions[0].session.agent.state.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='forbidden-write');
 assert.equal(rejected.isError,true);
});

test('steer targets a live SDK session and stop retains account busy until child cleanup completes',async t=>{
 const h=fixture(t,{holdCleanup:true,response:({model,options})=>new Promise(resolve=>{
  const abort=()=>resolve(assistant(model,[],'aborted'));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
 })});
 const child=await h.invoke('spawn_helper',task());
 while(!h.requests.length)await tick();
 await h.controller.steer('chat-a',child.id,'Focus on the constructor.');
 assert(h.sessions[0].session.getSteeringMessages().some(text=>text.includes('constructor')));
 assert.equal(h.features.felixAccountsInfo(h.host).busy,true);
 await assert.rejects(h.features.felixChangeOpenAIAccount(h.host,'switch','account-1'),/Wait for OpenAI work/);
 let stopped=false;const stopping=h.controller.cancel('chat-a',child.id).then(()=>{stopped=true});
 await tick();assert.equal(stopped,false);assert.equal(h.controller.isBusy(),true);assert.equal(h.sessions[0].disposed,0);
 assert.equal(h.requests.length,1,'Stop must clear queued steering before aborting, preventing a second provider request.');
 h.cleanup.resolve();await stopping;
 assert.equal(h.sessions[0].disposed,1);assert.equal(h.controller.isBusy(),false);assert.equal(h.features.felixAccountsInfo(h.host).busy,false);
 assert.equal(h.controller.manager.get(child.id).status,'cancelled');
});

test('turning helpers off stops active SDK children and cancels queued children across chats',async t=>{
 const h=fixture(t,{response:({model,options})=>new Promise(resolve=>{
  const abort=()=>resolve(assistant(model,[],'aborted'));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
 })});
 await h.controller.settings({maxHelpers:1});
 await h.invoke('spawn_helper',task());await h.invoke('spawn_helper',task(),'other-chat');
 while(!h.requests.length)await tick();
 await h.controller.settings({enabled:false});
 assert.equal(h.controller.isBusy(),false);assert.equal(h.sessions.length,1);assert.equal(h.sessions[0].disposed,1);
 assert(h.controller.manager.list().every(item=>item.status==='cancelled'));
 await assert.rejects(h.invoke('spawn_helper',task()),/Helpers are off/);
 assert.equal(h.settings().subagents.enabled,false);
});

test('retry rechecks implementation ownership instead of bypassing a new file owner',async t=>{
 const h=fixture(t,{response:({model,index,options})=>index===0
  ?{...assistant(model,[],'error'),errorMessage:'Fixture failure'}
  :new Promise(resolve=>{const abort=()=>resolve(assistant(model,[],'aborted'));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});})});
 const first=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 assert.equal((await waitTerminal(h.controller,first.id)).status,'failed');
 await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 assert.throws(()=>h.controller.retry('chat-a',first.id),/Another helper owns/);
 assert.equal(h.controller.manager.list().length,2);
});

test('the real SDK helper stops after thirty tool turns without another provider request',async t=>{
 const h=fixture(t,{response:({model,index})=>assistant(model,[{type:'toolCall',id:'list-'+index,name:'ls',arguments:{}}],'toolUse')});
 const child=await h.invoke('spawn_helper',task());
 const done=await waitTerminal(h.controller,child.id);
 assert.equal(done.status,'failed');assert.match(done.error,/30-turn limit/);
 assert.equal(h.requests.length,30);assert.equal(h.sessions[0].disposed,1);
});

// Execute the production lifecycle method bodies without loading Electron or
// constructing the application host, which would open the user's profile.
function lifecycleHost(interrupt){
 const filename=path.join(root,'src/agent/agent-host.ts'),text=fs.readFileSync(filename,'utf8');
 const parsed=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const declaration=parsed.statements.find(item=>ts.isClassDeclaration(item)&&item.name.text==='AgentHost');
 const names=new Set(['hasActiveWork','subagentsBusy','subagentsProviderBusy','disposeSession','releaseIdleSession','interrupt','shutdown']);
 const members=declaration.members.filter(item=>item.name&&names.has(item.name.getText(parsed))).map(item=>item.getText(parsed));
 assert.equal(members.length,names.size);
 const code=ts.transpileModule('export class LifecycleHost {\n'+members.join('\n')+'\n}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};vm.runInNewContext('(function(module,exports,felixInterrupt){'+code+'\n})',{console})(module,module.exports,interrupt);
 return new module.exports.LifecycleHost();
}

test('host keeps an idle parent session and global busy state while its child works, then Stop awaits cleanup',async t=>{
 const h=fixture(t,{holdCleanup:true,response:({model,options})=>new Promise(resolve=>{const abort=()=>resolve(assistant(model,[],'aborted'));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});})});
 const child=await h.invoke('spawn_helper',task());while(!h.requests.length)await tick();
 let parentStops=0,disposed=0;
 const host=lifecycleHost(async()=>{parentStops++});
 Object.assign(host,{helperTeamInstance:h.controller,sessions:new Map([['chat-a',{unsubscribe(){},session:{dispose(){disposed++}}}]]),busyConversations:new Set()});
 assert.equal(host.hasActiveWork(),true);assert.equal(host.subagentsProviderBusy('openai-codex'),true);
 await host.releaseIdleSession('chat-a');assert.equal(disposed,0);assert.equal(host.sessions.has('chat-a'),true);
 let stopped=false;const stopping=host.interrupt('chat-a').then(()=>{stopped=true});await tick();assert.equal(stopped,false);assert.equal(parentStops,1);
 h.cleanup.resolve();await stopping;assert.equal(host.hasActiveWork(),false);
 await host.releaseIdleSession('chat-a');assert.equal(disposed,1);assert.equal(host.sessions.has('chat-a'),false);
 assert.equal(h.controller.manager.get(child.id).status,'cancelled');
});

test('host disposal also awaits orphaned children when the parent session is absent',async()=>{
 const gate=defer(),host=lifecycleHost(async()=>{});let stopped=false,done=false;
 Object.assign(host,{sessions:new Map(),helperTeamInstance:{cancelConversation:async id=>{assert.equal(id,'orphan');stopped=true;await gate.promise;}}});
 const disposing=host.disposeSession('orphan').then(()=>{done=true});await tick();assert.equal(stopped,true);assert.equal(done,false);
 gate.resolve();await disposing;assert.equal(done,true);
});

test('a completed patch reopens after controller restart and still requires fresh review before apply',async t=>{
 const h=fixture(t,{response:({model,index})=>index===0?assistant(model,[{type:'toolCall',id:'write-source',name:'write',arguments:{path:'Source/Main.cs',content:'class Persisted {}'}}],'toolUse'):assistant(model)});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const finished=await waitTerminal(h.controller,child.id);assert.equal(finished.status,'completed');assert(finished.stagingPath);
 await h.invoke('review_helper_patch',{id:child.id});
 await h.reopen();
 assert.equal(h.controller.manager.get(child.id).status,'completed');assert.equal(h.requests.length,2);
 await assert.rejects(h.invoke('apply_helper_patch',{id:child.id}),/Review/);
 const review=await h.invoke('review_helper_patch',{id:child.id});assert.match(review.diff,/class Persisted/);
 await h.invoke('apply_helper_patch',{id:child.id});
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Persisted {}');
 assert.equal(h.controller.manager.get(child.id).applied,true);
});

test('discarding a stale patch preserves its staged evidence and releases ownership for another assignment',async t=>{
 const h=fixture(t,{response:({model,index})=>index===0?assistant(model,[{type:'toolCall',id:'write-source',name:'write',arguments:{path:'Source/Main.cs',content:'class Staged {}'}}],'toolUse'):assistant(model)});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const finished=await waitTerminal(h.controller,child.id);assert.equal(finished.status,'completed');
 fs.writeFileSync(path.join(h.mod,'Source/Main.cs'),'class UserChange {}');
 const retired=await h.controller.cancel('chat-a',child.id);
 assert.equal(retired.status,'cancelled');assert.match(retired.error,/Retained at/);assert.equal(retired.stagingPath,finished.stagingPath);
 assert.equal(fs.existsSync(retired.stagingPath),true);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class UserChange {}');
 const next=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 assert.notEqual(next.id,child.id);assert.equal((await waitTerminal(h.controller,next.id)).status,'completed');
});

test('reopening rejects staging metadata for a different helper assignment',async t=>{
 const h=fixture(t,{response:({model,index})=>index===0?assistant(model,[{type:'toolCall',id:'write-source',name:'write',arguments:{path:'Source/Main.cs',content:'class Staged {}'}}],'toolUse'):assistant(model)});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const finished=await waitTerminal(h.controller,child.id);assert.equal(finished.status,'completed');
 const metadataPath=path.join(finished.stagingPath,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
 metadata.taskId='different-helper';fs.writeFileSync(metadataPath,JSON.stringify(metadata));
 await assert.rejects(h.invoke('review_helper_patch',{id:child.id}),/different helper assignment/);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
 assert.equal(fs.existsSync(finished.stagingPath),true);
});

test('main Stop clears real SDK steering before abort so it cannot restart provider work',async t=>{
 const h=fixture(t,{holdCleanup:true,response:({model,options})=>new Promise(resolve=>{const abort=()=>resolve(assistant(model,[],'aborted'));if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});})});
 const child=await h.invoke('spawn_helper',task());while(!h.requests.length)await tick();
 const session=h.sessions[0].session;
 h.host.sessions.set('main-session',{session});
 await session.steer('Queued before the main Stop.');
 assert.equal(h.features.felixAccountsInfo(h.host).busy,true);
 const stopping=h.features.felixInterrupt(h.host,'main-session');await tick();
 assert.equal(h.requests.length,1);assert.equal(session.getSteeringMessages().length,0);
 h.cleanup.resolve();await stopping;await waitTerminal(h.controller,child.id);
 assert.equal(h.requests.length,1);assert.equal(h.features.felixAccountsInfo(h.host).busy,false);
});

const pendingUntilAborted=({model,options})=>new Promise(resolve=>{
 const abort=()=>resolve(assistant(model,[],'aborted'));
 if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
});
const waitRequests=async(h,count)=>{
 const deadline=Date.now()+10000;
 while(h.requests.length<count&&Date.now()<deadline)await tick();
 assert(h.requests.length>=count,`Expected ${count} simulated requests, received ${h.requests.length}.`);
};
const stagedFailureResponse=request=>request.index===0
 ?assistant(request.model,[{type:'toolCall',id:'stage-partial-source',name:'write',arguments:{path:'Source/Main.cs',content:'class Partial {}'}}],'toolUse')
 :{...assistant(request.model,[],'error'),errorMessage:'Fixture provider disconnected after staging.'};

for(const stop of ['provider failure','cancellation','task timeout']){
 test(`a real SDK implementation preserves its partial patch after ${stop}, requiring fresh review and explicit partial acceptance after restart`,async t=>{
  const h=fixture(t,{response:request=>request.index===0?stagedFailureResponse(request)
   :stop==='provider failure'?stagedFailureResponse(request):pendingUntilAborted(request)});
  const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
  await waitRequests(h,2);
  if(stop==='cancellation')await h.controller.cancel('chat-a',child.id);
  if(stop==='task timeout'){
   // Exercise the real runner's timeout cleanup without waiting thirty minutes.
   // Timer scheduling and budget limits are covered by manager tests.
   const entry=h.controller.manager.entries.get(child.id);
   h.controller.manager.requestStop(entry,'failed','Helper reached its task time limit. Review any staged work before retrying.');
  }
  const stopped=await waitTerminal(h.controller,child.id);
  assert.equal(stopped.status,stop==='cancellation'?'cancelled':'failed');
  if(stop==='task timeout')assert.equal(stopped.stopReason,'time_limit');
  assert.equal(stopped.partialPatch,true);assert.deepEqual(plain(stopped.changes.map(change=>change.path)),['Source/Main.cs']);
  assert(fs.existsSync(path.join(stopped.stagingPath,'metadata.json')));
  assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
  assert.equal(h.requests.length,2);assert.equal(h.sessions[0].disposed,1);assert.equal(h.controller.isBusy(),false);
  const originalReview=await h.invoke('review_helper_patch',{id:child.id});assert.equal(originalReview.partial,true);
  await h.reopen();assert.equal(h.requests.length,2,'Restart must not resume the stopped provider request.');
  await assert.rejects(h.invoke('apply_helper_patch',{id:child.id,allowPartial:true}),/Review/);
  const review=await h.invoke('review_helper_patch',{id:child.id});assert.equal(review.partial,true);assert.match(review.warning,/Unfinished/);assert.match(review.diff,/class Partial/);
  await assert.rejects(h.invoke('apply_helper_patch',{id:child.id}),/incomplete|partial work/i);
  assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
  const result=await h.invoke('apply_helper_patch',{id:child.id,allowPartial:true});assert.deepEqual(result.files,['Source/Main.cs']);
  assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Partial {}');
  const applied=h.controller.manager.get(child.id);assert.equal(applied.applied,true);assert.equal(applied.status,stopped.status,'Applying partial work must not mark the original assignment completed.');
  assert.equal(h.parent.thinkingLevel,'max');assert.equal(h.settings().thinkingLevel,'max');assert.equal(h.requests.length,2);
 });
}

test('a reviewed partial patch cannot overwrite source changed after the helper stopped',async t=>{
 const h=fixture(t,{response:stagedFailureResponse});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const stopped=await waitTerminal(h.controller,child.id);assert.equal(stopped.partialPatch,true);
 await h.invoke('review_helper_patch',{id:child.id});
 fs.writeFileSync(path.join(h.mod,'Source/Main.cs'),'class UserChange {}');
 await assert.rejects(h.invoke('apply_helper_patch',{id:child.id,allowPartial:true}),/Conflict/);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class UserChange {}');
 assert.equal(h.controller.manager.get(child.id).applied,undefined);assert(fs.existsSync(stopped.stagingPath));
});

for(const competingStatus of ['running','completed']){
 test(`a partial patch cannot apply over another ${competingStatus} helper's owned files`,async t=>{
  const h=fixture(t,{response:request=>{
   if(request.index<2)return stagedFailureResponse(request);
   if(competingStatus==='running')return pendingUntilAborted(request);
   if(request.index===2)return assistant(request.model,[{type:'toolCall',id:'stage-competing-source',name:'write',arguments:{path:'Source/Main.cs',content:'class Competing {}'}}],'toolUse');
   return assistant(request.model);
  }});
  const first=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
  assert.equal((await waitTerminal(h.controller,first.id)).partialPatch,true);
  await h.invoke('review_helper_patch',{id:first.id});
  const second=await h.invoke('spawn_helper',task({title:'Follow-up implementation',kind:'implement',ownedFiles:['Source/Main.cs']}));
  if(competingStatus==='running')await waitRequests(h,3);else await waitTerminal(h.controller,second.id);
  assert.equal(h.controller.manager.get(second.id).status,competingStatus);
  await assert.rejects(h.invoke('apply_helper_patch',{id:first.id,allowPartial:true}),/Another helper owns/);
  assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Before {}');
  assert.equal(h.controller.manager.get(first.id).applied,undefined);
  await h.controller.cancel('chat-a',second.id);
 });
}

test('legacy failed task staging remains discoverable without recorded changes and can be reviewed for partial recovery',async t=>{
 const h=fixture(t,{response:stagedFailureResponse});
 const child=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 const stopped=await waitTerminal(h.controller,child.id);assert.equal(stopped.status,'failed');
 await h.reopen(({agentDir})=>{
  const file=path.join(agentDir,'subagent-tasks.json'),history=JSON.parse(fs.readFileSync(file,'utf8'));
  const legacy=history.tasks.find(saved=>saved.id===child.id);delete legacy.changes;delete legacy.partialPatch;
  // Put the saved patch outside the twenty most-recent history entries.
  for(let i=0;i<21;i++)history.tasks.push({...legacy,id:'later-research-'+i,kind:'research',ownedFiles:undefined,stagingPath:undefined,status:'completed',phase:'Completed'});
  fs.writeFileSync(file,JSON.stringify(history));
 });
 assert.equal(h.requests.length,2);
 const beforeReview=h.controller.manager.get(child.id);assert.equal(beforeReview.changes,undefined);assert(beforeReview.stagingPath);
 assert(h.controller.snapshot('chat-a').tasks.some(item=>item.id===child.id));
 const review=h.controller.reviewPatch('chat-a',child.id);assert.equal(review.partial,true);assert.match(review.diff,/class Partial/);
 assert.equal(h.controller.manager.get(child.id).partialPatch,true);
 assert.throws(()=>h.controller.applyPatch('chat-a',child.id),/incomplete|partial work/i);
 h.controller.applyPatch('chat-a',child.id,true);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Partial {}');assert.equal(h.requests.length,2);
});

test('extending a running helper adds fifteen minutes without sending another request or changing thinking settings',async t=>{
 const h=fixture(t,{response:pendingUntilAborted}),savedSettings=plain(h.settings());
 const child=await h.invoke('spawn_helper',task());await waitRequests(h,1);
 const before=h.controller.manager.get(child.id);assert.equal(before.timeBudgetMs,20*60000);
 assert.throws(()=>h.controller.extend('other-chat',child.id),/does not belong/);
 const extended=h.controller.extend('chat-a',child.id);
 assert.equal(extended.deadlineAt-before.deadlineAt,15*60000);assert.equal(extended.timeBudgetMs,35*60000);
 await tick();assert.equal(h.requests.length,1);assert.deepEqual(plain(h.settings()),savedSettings);assert.equal(h.parent.thinkingLevel,'max');
 await h.controller.cancel('chat-a',child.id);
 assert.throws(()=>h.controller.extend('chat-a',child.id),/Only a running/);assert.equal(h.requests.length,1);
});

test('retrying an applied partial patch tells the new helper to inspect and preserve recovered source',async t=>{
 const h=fixture(t,{response:request=>request.index<2?stagedFailureResponse(request)
  :request.index===2?assistant(request.model,[{type:'toolCall',id:'inspect-recovered-source',name:'read',arguments:{path:'Source/Main.cs'}}],'toolUse')
  :assistant(request.model,[{type:'text',text:'Inspected the recovered source. The lead must finish validation.'}])});
 const first=await h.invoke('spawn_helper',task({kind:'implement',ownedFiles:['Source/Main.cs']}));
 assert.equal((await waitTerminal(h.controller,first.id)).partialPatch,true);
 await h.invoke('review_helper_patch',{id:first.id});await h.invoke('apply_helper_patch',{id:first.id,allowPartial:true});
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Partial {}');
 const retried=h.controller.retry('chat-a',first.id);assert.notEqual(retried.id,first.id);
 assert.match(retried.task,/Inspect the current source, preserve the recovered work/);assert.match(retried.task,/complete only what remains/);
 const done=await waitTerminal(h.controller,retried.id);assert.equal(done.status,'completed',done.error);
 assert.deepEqual(plain(done.changes),[]);assert.equal(h.requests.length,4);
 const read=h.sessions[1].session.agent.state.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='inspect-recovered-source');
 assert.match(read.content.find(block=>block.type==='text').text,/class Partial/);
 assert.match(h.requests[2].context.systemPrompt,/Do not repeat changes blindly/);
 assert.equal(fs.readFileSync(path.join(h.mod,'Source/Main.cs'),'utf8'),'class Partial {}');assert.equal(h.parent.thinkingLevel,'max');
});
