'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
const {Tasks}=require('../src/atlas/tasks.cjs');
function fixture(){
 let now=1000;class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({console,process,Buffer,setTimeout,clearTimeout,AbortController,AbortSignal,Date:Clock});
 function load(file){const filename=path.resolve(__dirname,'../src',file),module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:filename}).outputText;
  const localRequire=id=>id.startsWith('node:')?require(id):id==='./account-label'?load('atlas/account-label.ts'):id==='electron'?{BrowserWindow:{getAllWindows:()=>[]}}:{};
  vm.runInContext('(function(require,module,exports){'+code+'\n})',context,{filename})(localRequire,module,module.exports);return module.exports;
 }
 return {...load('atlas/agent-features.ts'),...load('atlas/activity-state.ts'),advance:ms=>{now+=ms},now:()=>now};
}
const model={id:'gpt-6.1-sol',provider:'openai-codex',api:'openai-codex-responses'};
const assistant=content=>({role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:1000});
const collect=async stream=>{const events=[];for await(const event of stream)events.push(event);return {events,result:await stream.result()};};
function controlled(){let next,stopped=false;const queue=[];return {
 push(event){if(next){const resolve=next;next=null;resolve({done:false,value:event});}else queue.push(event)},
 [Symbol.asyncIterator](){return {next:()=>queue.length?Promise.resolve({done:false,value:queue.shift()}):stopped?Promise.resolve({done:true}):new Promise(resolve=>{next=resolve}),return:async()=>{stopped=true;if(next)next({done:true});return {done:true}}};}
};}

test('Fast and Standard keep reasoning/context options and choose HTTP streaming for Codex',()=>{
 const api=fixture(),calls=[],context={messages:[]},abort=new AbortController();
 const options={reasoning:'max',transport:'auto',signal:abort.signal,sessionId:'fixture',cacheRetention:'long',maxTokens:90000};
 for(const mode of ['fast','standard']){api.felixWithSpeed((...args)=>calls.push(args),()=>({openaiSpeed:mode}))(model,context,options);const [m,c,o]=calls.at(-1);assert.equal(m,model);assert.equal(c,context);assert.equal(o.transport,'sse');assert.equal(o.serviceTier,mode==='fast'?'priority':'default');for(const key of ['reasoning','signal','sessionId','cacheRetention','maxTokens'])assert.equal(o[key],options[key]);}
 assert.equal(options.transport,'auto');assert.equal(options.serviceTier,undefined);
 api.felixWithSpeed((...args)=>calls.push(args),()=>{throw Error('No settings access for Claude')})({...model,provider:'anthropic'},context,options);assert.equal(calls.at(-1)[2],options);
 api.felixWithSpeed((...args)=>calls.push(args),()=>({openaiSpeed:'fast'}))(model,context,{transport:'websocket'});assert.equal(calls.at(-1)[2].transport,'websocket');
});

test('status separates connecting, waiting, reasoning, reply and tool arguments without inventing output',async()=>{
 const api=fixture(),states=[],source=controlled();const stream=api.felixGuardStream(()=>source,600000,state=>states.push(state))(model,{}),reading=collect(stream);
 assert.equal(states[0].state,'connecting');assert.equal(states[0].lastEventAt,null);assert.equal(states[0].lastContentAt,null);
 const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));};
 api.advance(100);source.push({type:'start',partial:assistant([])});await tick();assert.equal(states.at(-1).state,'waiting');assert.equal(states.at(-1).lastContentAt,null);
 api.advance(100);source.push({type:'thinking_start',partial:assistant([])});await tick();assert.equal(states.at(-1).state,'waiting');
 api.advance(100);source.push({type:'thinking_delta',delta:'Planning',partial:assistant([{type:'thinking',thinking:'Planning'}])});await tick();assert.equal(states.at(-1).state,'thinking');assert.equal(states.at(-1).lastContentAt,1300);
 api.advance(100);source.push({type:'text_delta',delta:'Result',partial:assistant([{type:'text',text:'Result'}])});await tick();assert.equal(states.at(-1).state,'reply');
 source.push({type:'toolcall_start',partial:assistant([])});await tick();assert.equal(states.at(-1).state,'tool');
 const final=assistant([{type:'text',text:'Result'}]);source.push({type:'done',message:final});const done=await reading;assert.equal(done.result,final);assert.equal(states.at(-1).state,'done');assert.equal(done.events.filter(x=>['done','error'].includes(x.type)).length,1);
});

test('a broken stream preserves received text and thinking, excludes unfinished tools and never retries',async()=>{
 const api=fixture(),partial=assistant([{type:'text',text:'Partial answer'},{type:'thinking',thinking:'Partial thought'},{type:'toolCall',id:'incomplete',name:'write',arguments:{}}]);let requests=0;
 const source=()=>{requests++;return {async *[Symbol.asyncIterator](){yield {type:'start',partial};throw Error('WebSocket closed 1000')}}};
 const {events,result}=await collect(api.felixGuardStream(source)(model,{}));assert.equal(requests,1);assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/Connection interrupted/);assert.match(result.errorMessage,/Retry/);assert.deepEqual(Array.from(result.content,x=>x.type),['text','thinking']);assert.equal(result.content[0].text,'Partial answer');assert.equal(events.at(-1).type,'error');
});

test('provider error events are actionable without losing partial output or changing quota errors',async()=>{
 const api=fixture();for(const errorMessage of ['terminated','The usage limit has been reached']){
  const error={...assistant([{type:'text',text:'Saved response'}]),stopReason:'error',errorMessage};
  const {result}=await collect(api.felixGuardStream(()=>({async *[Symbol.asyncIterator](){yield {type:'error',error}}}))(model,{}));
  assert.equal(result.content[0].text,'Saved response');assert.equal(result.errorMessage,errorMessage==='terminated'?api.felixConnectionMessage(errorMessage):errorMessage);assert.equal(error.errorMessage,errorMessage);
 }
});

test('cancellation settles even before a provider responds and observer failures cannot break requests',async()=>{
 const api=fixture(),abort=new AbortController(),source=controlled();let signal;
 const stream=api.felixGuardStream((_m,_c,o)=>{signal=o.signal;return source},600000,()=>{throw Error('UI failure')})(model,{}, {signal:abort.signal}),reading=collect(stream);
 await new Promise(resolve=>setImmediate(resolve));abort.abort();const {events,result}=await reading;
 assert.equal(signal.aborted,true);assert.equal(result.stopReason,'aborted');assert.equal(events.length,1);assert.match(result.errorMessage,/Stopped/);
 const already=new AbortController();already.abort();const done=await collect(api.felixGuardStream(()=>assert.fail('Cancelled request must not start'))(model,{}, {signal:already.signal}));assert.equal(done.result.stopReason,'aborted');
});

test('missing completion and silent streams settle exactly once and retain the partial response',async()=>{
 const api=fixture();for(const silent of [false,true]){
  const partial=assistant([{type:'text',text:'Received'}]),source=silent?controlled():{async *[Symbol.asyncIterator](){yield {type:'start',partial}}};if(silent)source.push({type:'start',partial});
  const stream=api.felixGuardStream(()=>source,15)(model,{}),reading=collect(stream);
  if(silent)await new Promise(resolve=>setTimeout(resolve,35));const {events,result}=await reading;
  assert.equal(events.filter(x=>x.type==='error').length,1);assert.equal(result.content[0].text,'Received');assert.match(result.errorMessage,silent?/No response data/:/completion/);
 }
});

function host(){return {sessions:new Map([['chat',{session:{isIdle:false,isCompacting:false,getSteeringMessages:()=>[],agent:{state:{messages:[]},steeringQueue:{messages:[]}}}}]]),constructing:new Set(),busyConversations:new Set(['chat'])};}
test('session polling cannot reset stream silence; tools, compaction and subsequent requests reset stale stream state',()=>{
 const api=fixture(),h=host(),get=()=>api.felixSessionStatus(h,'chat',true).activity;
 api.felixObserveSession('chat',{type:'agent_start'});api.advance(100);
 const state={state:'thinking',phase:'Receiving reasoning',requestStartedAt:1100,lastEventAt:1100,lastContentAt:1100};api.felixObserveModelStream('chat',state);api.advance(70000);
 api.felixObserveSession('chat',{type:'queue_update'});assert.equal(get().stream.lastEventAt,1100);const before=api.activityPresentation(get(),api.now());assert.equal(before.phase,'Waiting for response data');assert.equal(before.since,70);assert.match(before.note,/may still be reasoning/);assert.equal(api.felixSessionStatus(h,'chat',true).messages,undefined);
 api.felixObserveSession('chat',{type:'tool_execution_start',toolName:'build_mod'});assert.equal(get().stream,null);api.advance(70000);assert.equal(api.activityPresentation(get(),api.now()).phase,'Running build_mod');
 api.felixObserveSession('chat',{type:'tool_execution_end'});assert.equal(get().phase,'Waiting for next response');
 api.felixObserveModelStream('chat',{...state,state:'connecting',phase:'Connecting to model',requestStartedAt:api.now(),lastEventAt:null,lastContentAt:null});assert.equal(api.activityPresentation(get(),api.now()).phase,'Connecting to model');
 api.felixObserveSession('chat',{type:'compaction_start'});assert.equal(get().stream,null);assert.equal(api.activityPresentation(get(),api.now(),true).phase,'Compacting context');
 api.felixObserveSession('chat',{type:'agent_end'});h.sessions.get('chat').session.isIdle=true;assert.equal(api.felixSessionStatus(h,'chat',true).messages.length,0);assert.equal(h.busyConversations.has('chat'),false);
});

test('progress warns about missing response data without claiming a lost connection or timing out a tool',()=>{
 const api=fixture(),state={startedAt:1000,lastEventAt:1000,phase:'Connecting to model',stream:{state:'connecting',phase:'Connecting to model',requestStartedAt:1000,lastEventAt:null,lastContentAt:null}};
 let display=api.activityPresentation(state,2000);assert.equal(display.phase,'Connecting to model');assert.equal(display.dataStatus,'Waiting for first response');assert.equal(display.waiting,true);
 display=api.activityPresentation(state,61000);assert.equal(display.phase,'Waiting for response data');assert.equal(display.waiting,true);assert.match(display.note,/alone does not mean/);
 display=api.activityPresentation({...state,phase:'Running bash',stream:null},900000);assert.equal(display.phase,'Running bash');assert.equal(display.waiting,false);assert.match(display.note,/tool is still running/);
 display=api.activityPresentation(state,61000,true);assert.equal(display.phase,'Compacting context');assert.match(display.note,/previous context stays/);
});

test('Activity list tracks connection phases once and leaves final outcome to the agent lifecycle',()=>{
 const tasks=new Tasks();try{tasks.observeAgent('chat',{type:'agent_start'});tasks.observeStream('chat',{state:'connecting',phase:'Connecting to model'});tasks.observeStream('chat',{state:'waiting',phase:'Waiting for model'});for(let i=0;i<100;i++)tasks.observeStream('chat',{state:'thinking',phase:'Receiving reasoning'});
  assert.equal(tasks.items.get('chat:chat').logs.length,4);assert.equal(tasks.items.get('chat:chat').phase,'Receiving reasoning');
  tasks.observeStream('chat',{state:'done',phase:'Response received'});assert.equal(tasks.items.get('chat:chat').status,'running');
  tasks.observeAgent('chat',{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'Connection interrupted'}});tasks.observeAgent('chat',{type:'agent_end'});assert.equal(tasks.items.get('chat:chat').status,'failed');
  tasks.observeStream('chat',{state:'reply',phase:'Receiving reply'});assert.equal(tasks.items.get('chat:chat').status,'failed');
 }finally{tasks.dispose()}
});

test('the bundled Codex provider uses HTTP at both speeds and receives the unchanged reasoning effort',async()=>{
 const api=fixture(),runtime=process.env.ATLAS_RUNTIME_BASE||path.resolve(__dirname,'../dist/Atlas-0.1.0-release');
 const {streamSimple}=await import(require('node:url').pathToFileURL(path.join(runtime,'resources/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href);
 const originalFetch=global.fetch,originalWebSocket=global.WebSocket;let requests=0,sockets=0;
 // Entire provider boundary stays local; this token is synthetic and grants no access.
 const apiKey='fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'atlas-fixture'}})).toString('base64url')+'.fixture';
 try{global.WebSocket=class {constructor(){sockets++;throw Error('WebSocket must not be used')}};
  for(const mode of ['fast','standard']){let body;global.fetch=async(_url,options)=>{requests++;const bytes=typeof options.body==='string'?options.body:require('node:zlib').zstdDecompressSync(options.body);body=JSON.parse(bytes.toString());return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})+'\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}})};
   const modelWithCaps={...model,baseUrl:'https://chatgpt.com/backend-api',contextWindow:1050000,maxTokens:128000,reasoning:true,thinkingLevelMap:{xhigh:'xhigh',max:'max'},input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
   const {result}=await collect(api.felixGuardStream(api.felixWithSpeed(streamSimple,()=>({openaiSpeed:mode})))(modelWithCaps,{systemPrompt:'Local fixture',messages:[]},{apiKey,reasoning:'max',transport:'auto',maxRetries:0}));
   assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(body.service_tier,mode==='fast'?'priority':'default');assert.equal(body.reasoning.effort,'max');assert.equal(body.stream,true);
  }
  assert.equal(requests,2);assert.equal(sockets,0);
 }finally{global.fetch=originalFetch;global.WebSocket=originalWebSocket}
});
