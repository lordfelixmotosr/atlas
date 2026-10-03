const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function loadSource(file,cache=new Map(),overrides={}){
 const full=path.resolve(__dirname,'../src',file);if(cache.has(full))return cache.get(full).exports;
 const module={exports:{}};cache.set(full,module);
 const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const localRequire=id=>id in overrides?overrides[id]:id.startsWith('.')?loadSource(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(full),id+'.ts')),cache,overrides):require(id);
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Buffer,console,process,Set,Map,Date})(localRequire,module,module.exports);return module.exports;
}
const api=loadSource('atlas/modmixer-import.ts');
function fixture(t){
 const root=fs.mkdtempSync(path.join(base,'modmixer-import-'));t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true})});
 const source=path.join(root,'roaming/Modmixer/workspace/Mods'),destination=path.join(root,'Atlas/data/profile/workspace/Mods');fs.mkdirSync(source,{recursive:true});fs.mkdirSync(destination,{recursive:true});return {root,source,destination};
}
function write(root,relative,bytes){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
function mod(source,folder,options={}){
 const root=path.join(source,folder);fs.mkdirSync(root,{recursive:true});
 write(root,'About/About.xml',`<ModMetaData><name>${options.name||folder}</name><packageId>felix.${options.id||folder}</packageId><author>Felix</author><supportedVersions><li>1.6</li></supportedVersions></ModMetaData>`);
 write(root,'.modmixer/prefs.json',JSON.stringify({game:options.game||'rimworld',pinned:true,archived:!!options.archived,license:'MIT'}));
 return root;
}
function bytes(root){const result={};function walk(current){for(const entry of fs.readdirSync(current,{withFileTypes:true})){const full=path.join(current,entry.name),relative=path.relative(root,full);if(entry.isDirectory())walk(full);else if(entry.isFile())result[relative]=fs.readFileSync(full).toString('base64');else result[relative]='link';}}walk(root);return result;}
async function apply(source,destination,rows,extra={}){return api.importModMixerBatch({source,destination,rows,token:'test',selected:rows.filter(row=>row.status==='ready').map(row=>row.folder),cancelled:()=>false,progress:()=>{},...extra});}

test('finds the ModMixer profile and accepts profile, workspace, Mods and portable folder choices',async t=>{
 const {root,source,destination}=fixture(t);mod(source,'one');
 const detected=await api.detectModMixerWorkspaces(path.join(root,'roaming'),destination);assert.equal(detected.length,1);assert.equal(detected[0],fs.realpathSync(source));
 for(const selected of [source,path.dirname(source),path.dirname(path.dirname(source))])assert.equal(await api.resolveModMixerWorkspace(selected,destination),fs.realpathSync(source));
 const portable=path.join(root,'Portable ModMixer');fs.mkdirSync(path.join(portable,'data/profile/workspace/Mods'),{recursive:true});assert.equal(await api.resolveModMixerWorkspace(portable,destination),fs.realpathSync(path.join(portable,'data/profile/workspace/Mods')));
 await assert.rejects(api.resolveModMixerWorkspace(destination,destination),/outside the Atlas workspace/);
 await assert.rejects(api.resolveModMixerWorkspace(path.join(root,'Atlas'),destination),/outside the Atlas workspace/);
});

test('preview includes archived mods, excludes Minecraft and diagnoses invalid or linked folders',async t=>{
 const {root,source,destination}=fixture(t);mod(source,'active',{name:'Active'});mod(source,'archive',{name:'Archived',archived:true});mod(source,'minecraft',{game:'minecraft'});
 fs.mkdirSync(path.join(source,'unfinished'));fs.mkdirSync(path.join(source,'.modmixer'));fs.mkdirSync(path.join(source,'node_modules'));
 fs.symlinkSync(path.join(source,'active'),path.join(source,'linked'),'junction');
 const rows=await api.scanModMixerWorkspace(source,destination);assert.equal(rows.length,5);
 assert.equal(rows.find(row=>row.folder==='archive').status,'ready');assert.match(rows.find(row=>row.folder==='archive').detail,/Archived/);
 assert.equal(rows.find(row=>row.folder==='minecraft').status,'unsupported');assert.equal(rows.find(row=>row.folder==='linked').status,'invalid');assert.equal(rows.find(row=>row.folder==='unfinished').status,'invalid');
});

test('copies binary assets, code, Workshop IDs and metadata without changing any original bytes',async t=>{
 const {source,destination}=fixture(t),original=mod(source,'one',{archived:true});
 write(original,'Textures/Body/east.png',Buffer.from([0,255,71,1,2,3]));write(original,'Sounds/effect.ogg',Buffer.from([255,0,16]));write(original,'Assemblies/Mod.dll',Buffer.from([77,90,0,255]));write(original,'Source/Main.cs','class Mod {}');write(original,'About/PublishedFileId.txt','123456789012345678');
 write(original,'.modmixer/schematic.json',JSON.stringify({shortDescription:'A saved spec',body:'Build plan'}));write(original,'.modmixer/cs-assets.json','{"textures":["Body/east"],"audio":[]}');write(original,'.modmixer/stubs.json','{"version":1}');write(original,'.modmixer/notes/custom.txt','Private mod notes');write(original,'Source/obj/temporary.cache','Excluded');
 const before=bytes(source),rows=await api.scanModMixerWorkspace(source,destination),events=[];
 const result=await apply(source,destination,rows,{progress:state=>events.push(state)});assert.equal(result.imported.length,1);assert.equal(result.failed.length,0);
 const target=path.join(destination,result.imported[0].folder);
 for(const relative of ['Textures/Body/east.png','Sounds/effect.ogg','Assemblies/Mod.dll','Source/Main.cs','About/About.xml','About/PublishedFileId.txt'])assert.deepEqual(fs.readFileSync(path.join(target,relative)),fs.readFileSync(path.join(original,relative)));
 for(const relative of ['prefs.json','schematic.json','cs-assets.json','stubs.json','notes/custom.txt'])assert.deepEqual(fs.readFileSync(path.join(target,'.atlas',relative)),fs.readFileSync(path.join(original,'.modmixer',relative)));
 assert.equal(fs.existsSync(path.join(target,'.modmixer')),false);assert.equal(fs.existsSync(path.join(target,'Source/obj')),false);assert.deepEqual(bytes(source),before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,'.atlas/prefs.json'))).archived,true);assert.equal(events.at(-1).completed,1);assert(events.at(-1).copiedFiles>0);
});

test('mixed legacy and Atlas metadata preserves both conflicting versions under Atlas',async t=>{
 const {source,destination}=fixture(t),original=mod(source,'mixed');write(original,'.atlas/prefs.json','{"game":"rimworld","pinned":false}');write(original,'.atlas/notes.txt','Atlas note');write(original,'.modmixer/notes.txt','Legacy note');write(original,'.modmixer/extra.txt','Kept extra');
 const result=await apply(source,destination,await api.scanModMixerWorkspace(source,destination));assert.equal(result.imported.length,1);const target=path.join(destination,result.imported[0].folder);
 assert.equal(fs.existsSync(path.join(target,'.modmixer')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'.atlas/prefs.json'))).pinned,false);assert.equal(fs.readFileSync(path.join(target,'.atlas/extra.txt'),'utf8'),'Kept extra');
 const conflict=fs.readdirSync(path.join(target,'.atlas')).find(x=>x.startsWith('imported-legacy-'));assert(conflict);assert.equal(fs.readFileSync(path.join(target,'.atlas',conflict,'notes.txt'),'utf8'),'Legacy note');assert.equal(JSON.parse(fs.readFileSync(path.join(target,'.atlas',conflict,'prefs.json'))).pinned,true);
});

test('repeat and stale previews skip completed imports while distinct same-name mods survive',async t=>{
 const {source,destination}=fixture(t);mod(source,'first',{name:'Same name',id:'same'});mod(source,'second',{name:'Same name',id:'same'});
 const originalRows=await api.scanModMixerWorkspace(source,destination);const first=await apply(source,destination,originalRows);assert.equal(first.imported.length,2);assert.notEqual(first.imported[0].folder,first.imported[1].folder);
 assert((await api.scanModMixerWorkspace(source,destination)).every(row=>row.status==='imported'));
 const repeat=await apply(source,destination,originalRows);assert.equal(repeat.imported.length,0);assert.equal(repeat.skipped.length,2);assert.equal(fs.readdirSync(destination).length,2);
});

test('stopping mid-copy keeps completed mods and discards only the unfinished staged mod',async t=>{
 const {source,destination}=fixture(t);mod(source,'first',{name:'A first'});const second=mod(source,'second',{name:'B second'});write(second,'Textures/a.png','A');write(second,'Textures/b.png','B');
 let secondStarted=false,checks=0;
 const result=await apply(source,destination,await api.scanModMixerWorkspace(source,destination),{cancelled:()=>secondStarted && ++checks>=4,progress:state=>{if(state.current==='B second')secondStarted=true;}});
 assert.equal(result.cancelled,true);assert.equal(result.imported.length,1);assert.equal(result.imported[0].sourceFolder,'first');assert.equal(fs.readdirSync(destination).length,1);assert.equal(fs.readdirSync(path.join(path.dirname(destination),'.atlas-imports')).length,0);assert.equal(fs.readFileSync(path.join(second,'Textures/b.png'),'utf8'),'B');
});

test('nested junction fails its mod without following it or losing another successful mod',async t=>{
 const {root,source,destination}=fixture(t),bad=mod(source,'bad',{name:'A bad'});mod(source,'good',{name:'B good'});const outside=path.join(root,'private');write(outside,'auth.json','Never copy this');fs.symlinkSync(outside,path.join(bad,'Linked'),'junction');
 const result=await apply(source,destination,await api.scanModMixerWorkspace(source,destination));assert.equal(result.failed.length,1);assert.match(result.failed[0].reason,/Linked/);assert.equal(result.imported.length,1);assert.equal(result.imported[0].sourceFolder,'good');assert.equal(fs.readdirSync(destination).length,1);assert(!Object.keys(bytes(destination)).some(x=>x.endsWith('auth.json')));assert.equal(fs.readFileSync(path.join(outside,'auth.json'),'utf8'),'Never copy this');
});

test('rechecks source game changes and refuses selections absent from the preview',async t=>{
 const {source,destination}=fixture(t),original=mod(source,'changed');const rows=await api.scanModMixerWorkspace(source,destination);write(original,'.modmixer/prefs.json','{"game":"minecraft"}');
 const result=await apply(source,destination,rows);assert.equal(result.imported.length,0);assert.equal(result.skipped.length,1);
 await assert.rejects(apply(source,destination,rows,{selected:['../outside']}),/fresh import preview/);await assert.rejects(apply(source,destination,rows,{selected:['changed','changed']}),/fresh import preview/);
 assert.equal(fs.readdirSync(destination).length,0);
});

test('IPC import requires consent, blocks active work, refreshes the registry and publishes progress',async t=>{
 const {root,source,destination}=fixture(t);mod(source,'one');const handlers=new Map(),events=[],host={atlasModImport:false};let allowed=false,busy=false,refreshes=0;
 const routes=loadSource('atlas/modmixer-import-routes.ts',new Map(),{
  electron:{app:{getPath:()=>path.join(root,'roaming')},dialog:{}},
  '../agent/workspace':{getWorkspacePaths:()=>({workspaceDir:destination})},
  '../agent/mod-events':{emitModChanged:folder=>events.push({folder})},
  '../agent/registry':{getRegistry:()=>({refresh:async()=>{refreshes++}})},
 });
 routes.registerModMixerImportRoutes({host,ipc:{handle:(name,fn)=>handlers.set(name,fn)},getWindow:()=>({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_channel,state)=>events.push(state)}}),requireConsent:()=>{if(!allowed)throw new Error('Consent required')}},()=>busy||host.atlasModImport);
 const plan=await handlers.get('atlas:mods:import-plan')({});assert.equal(plan.rows.length,1);
 const apply=()=>handlers.get('atlas:mods:import-apply')({},plan.token,['one']);
 await assert.rejects(apply(),/Consent required/);allowed=true;busy=true;await assert.rejects(apply(),/Finish active/);busy=false;
 const result=await apply();assert.equal(result.imported.length,1);assert.equal(refreshes,1);assert.equal(host.atlasModImport,false);assert(events.some(state=>state.completed===1));
 await assert.rejects(apply(),/Refresh the import preview/);
});

test('IPC stop targets the active token and releases the app update lock after cancellation',async t=>{
 const {root,source,destination}=fixture(t);mod(source,'one');const handlers=new Map(),host={atlasModImport:false};let sawLock=false;
 const routes=loadSource('atlas/modmixer-import-routes.ts',new Map(),{
  electron:{app:{getPath:()=>path.join(root,'roaming')},dialog:{}},
  '../agent/workspace':{getWorkspacePaths:()=>({workspaceDir:destination})},
  '../agent/mod-events':{emitModChanged:()=>{}},'../agent/registry':{getRegistry:()=>({refresh:async()=>{}})},
 });
 routes.registerModMixerImportRoutes({host,ipc:{handle:(name,fn)=>handlers.set(name,fn)},requireConsent:()=>{},getWindow:()=>({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_channel,state)=>{sawLock=host.atlasModImport;handlers.get('atlas:mods:import-cancel')({},state.token)}}})},()=>host.atlasModImport);
 const plan=await handlers.get('atlas:mods:import-plan')({});const result=await handlers.get('atlas:mods:import-apply')({},plan.token,['one']);assert.equal(sawLock,true);assert.equal(result.cancelled,true);assert.equal(result.imported.length,0);assert.equal(host.atlasModImport,false);assert.equal(fs.readdirSync(destination).length,0);
});
