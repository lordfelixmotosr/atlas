// @ts-nocheck
// All desktop APIs are mocked: no profile reads, launches, writes or network.
const handlers = new Map();
window.fixtureErrors=[];
window.addEventListener('error',event=>window.fixtureErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
window.fixtureCalls=[];
const model={key:'openai-codex/gpt-6.1-sol',provider:'openai-codex',modelId:'gpt-6.1-sol',label:'ChatGPT — GPT-6.1 Sol',contextWindow:272000,thinking:{levels:['low','medium','high','xhigh','max'],effectiveLevels:{low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}}};
const settings={defaultAuthor:'Felix',defaultModLicense:'MIT',analyticsOptIn:false,theme:'dark',model,thinkingLevel:'xhigh',multiChat:false,useCommunityLore:false,autoLaunch:false,dangerouslySkipPermissions:false,selectedGameId:'rimworld',openaiSpeed:'standard',sentenceShortcut:{label:'My shortcut',text:'Check the result in game.'}};
const mods=['Silvaran Order','One-Piece Uniform','A Rim of Ice and Fire','The Long Night'].map((name,i)=>({folder:`fixture-${i}`,prefs:{game:'rimworld',pinned:i===0,archived:false},about:{name,packageId:'felix.fixture'+i,description:['Build a mercenary order with new uniforms, weapons and missions.','A lightweight uniform with independent material and dye colors.','A world of great houses, unique factions and detailed landscapes.','Survive a winter campaign with new events and threats.'][i]},createdAt:Date.now()-86400000,updatedAt:Date.now()-3600000,publishedFileId:i===1?'123':null,changes:{status:'changed',label:'Unpublished changes',count:i+1}}));
const library={config:{source:'https://example.invalid/index.atlas.json',autoUpdate:true,lastSuccessAt:new Date().toISOString()},packs:['RimWorld Core','C# & Harmony','RimWorld Forge','Art References'].map((name,i)=>({id:'pack'+i,name,category:i===3?'Art':'Code',version:'1.0.0',description:['Game structures, XML definitions and release conventions.','C# examples, Harmony patches and runtime compatibility.','Mod planning, validation and reusable coding references.','Directional assets, texture formats and style guidance.'][i],gameVersions:['1.6','1.7'],license:'MIT',source:'https://example.invalid',previous:'0.9.0'})),available:[],changes:[],working:false,busy:false};
const conversation=folder=>({id:'chat-'+folder,title:mods.find(m=>m.folder===folder)?.about.name,scope:{type:'mod',modFolder:folder},game:'rimworld',model,thinkingLevel:'xhigh',createdAt:Date.now(),updatedAt:Date.now()});
const task={id:'task',kind:'download',title:'Atlas application update',status:'running',phase:'Downloading update',fraction:.42,startedAt:Date.now()-60000,updatedAt:Date.now(),logs:[{at:Date.now(),text:'Verified update found. Downloading the application package.'}]};
const api={
  getAppVersion:()=> '0.3.0', getSettings:()=>settings, listModels:()=>[model],
  listWorkspaceMods:()=>mods, getRegistry:()=>({snapshot:{mods:[],activeOrder:[]},analysis:{byPackageId:{},issues:[]}}),getActiveSession:()=>null,
  getSnapshotUsage:()=>({totalBytes:0,mods:[]}),readAssetDataUrl:()=>null,
  getGameSetupSnapshot:()=>({status:{state:'fresh',detail:'Ready'}}),checkGameRequirements:()=>({satisfied:true,checks:[]}),
  atlasTasksStatus:()=>[task],atlasTasksClear:()=>{},atlasTaskAction:()=>{},
  atlasLibraryStatus:()=>library,atlasLibraryCheck:()=>library,atlasLibrarySearch:()=>[{id:'pack0',path:'references/apparel.md',excerpt:'Directional textures use south, east and north views.'}],
  atlasLibraryOpenReference:()=>{},atlasLibraryCustom:()=>{},atlasLibraryReveal:()=>{},
  atlasAppStatus:()=>({version:'0.3.0',available:null,ready:null,working:false,source:'signed feed',lastCheckedAt:new Date().toISOString()}),
  atlasAppCheck:()=>({version:'0.3.0',working:false,progress:{stage:'idle'},source:'signed feed'}),
  adapterStatus:()=>({candidates:[]}),
  resolveConversationForMod:folder=>conversation(folder),
  openConversationSession:()=>({messages:[{role:'assistant',content:[{type:'text',text:'Tell me what you want to change. I can inspect files, make edits and run a test when you are ready.'}],model:model.modelId,provider:model.provider,timestamp:Date.now(),stopReason:'stop'}]}),
  closeConversation:()=>{},listSnapshots:()=>[],scanAssets:()=>({counts:{missing:0,invalid:0},assets:[]}),
  isRimWorldRunning:()=>false,dllUpdateState:()=>({running:false,pending:false,previous:null,mods:[]}),
  getAgentStatus:()=>({busy:false,compacting:false}),
  getContextUsage:()=>({tokens:14000,contextWindow:272000}),
  getOpenAIAccounts:()=>({activeId:'pro',busy:false,accounts:[{id:'pro',label:'GPT Pro',active:true}]}),
  getOpenAIUsage:()=>({status:'ready',buckets:[],credits:{hasCredits:true,balance:25}}), getClaudeUsage:()=>({status:'unavailable'}), listOAuthLinks:()=>[],listProviders:()=>[],
  getOpenRouterConfig:()=>null,listLocalProviders:()=>[],
  projectFiles:()=>({files:[{path:'About.xml',editable:true},{path:'Main.cs',editable:true}],truncated:false}),
  projectRead:(_folder,path)=>({path,text:path==='About.xml'?'<ModMetaData>\n  <name>Fixture</name>\n</ModMetaData>':'class Fixture {}',hash:'initial'}),
  projectSave:(_folder,path,text)=>({path,text,hash:'saved'}),projectDraftState:()=>{},
  getMonitorState:()=>({kind:'listening',port:13371}),getMonitorSnapshot:()=>null,
  send:()=>{},setDefaultAuthor:()=>{},setAnalyticsOptIn:()=>{},
};
window.modmixer=new Proxy({}, {get(_target,key) {
  if(String(key).startsWith('on')) return handler=>{
    const list=handlers.get(key)??new Set();list.add(handler);handlers.set(key,list);
    return ()=>list.delete(handler);
  };
  return async(...args)=>{
    window.fixtureCalls.push({method:key,args});
    if(key in api)return api[key](...args);
    window.fixtureErrors.push('Unmocked API: '+key);
    return null;
  };
}});
window.emitFixture=(name,value)=>handlers.get(name)?.forEach(handler=>handler(value));
