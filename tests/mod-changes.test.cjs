const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
function load(file,cache=new Map()){
 const full=path.resolve(__dirname,'../src',file);if(cache.has(full))return cache.get(full).exports;
 const module={exports:{}};cache.set(full,module);
 const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const localRequire=id=>id.startsWith('.')?load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(full),id+'.ts')),cache):require(id);
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Buffer,console,process,Set,Map,Date})(localRequire,module,module.exports);return module.exports;
}
const api=load('atlas/mod-changes.ts'),base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(t){const area=fs.mkdtempSync(path.join(base,'changes-')),root=path.join(area,'Mods/project');fs.mkdirSync(root,{recursive:true});t.after(()=>{assert(area.startsWith(base+path.sep));fs.rmSync(area,{recursive:true,force:true})});return{area,root,state:path.join(area,'Mods/.atlas/mod-changes/project/state.json')};}
function write(root,file,text){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);}
const xml=(name,label)=>`<Defs><ThingDef><defName>${name}</defName><label>${label}</label></ThingDef></Defs>`;

test('starts tracking without inventing past publication history and stores state outside the mod',async t=>{
 const {root,state}=fixture(t);write(root,'About/About.xml','<ModMetaData/>');
 const report=await api.readModChanges(root,100);assert.equal(report.status,'tracking');assert.equal(report.lastPublishedAt,100);assert.equal(report.count,0);assert(fs.existsSync(state));assert(!fs.existsSync(path.join(root,'.atlas')));
 const published=await api.readModChanges(root,100,'published');assert.equal(published.status,'unavailable');assert.match(published.description,/No file snapshot/);
});
test('reports added definitions, edited code and removed assets since publication',async t=>{
 const {root}=fixture(t);write(root,'Defs/Items.xml',xml('Armor','old armor'));write(root,'Source/Mod.cs','class Old {}');write(root,'Textures/old.png',Buffer.from([0,255,1]));
 const at=Date.now();await api.recordModBaseline(root,'published','First Workshop release',undefined,at);
 write(root,'Defs/Items.xml',xml('Armor','new armor').replace('</Defs>','<ThingDef><defName>Helmet</defName><label>helmet</label></ThingDef></Defs>'));write(root,'Source/Mod.cs','class New {}');fs.unlinkSync(path.join(root,'Textures/old.png'));write(root,'Sounds/new.ogg',Buffer.from([7,8,9]));
 const report=await api.readModChanges(root,at);assert.equal(report.status,'modified');assert.equal(report.count,4);assert.equal(report.note,'First Workshop release');assert.match(report.description,/Edited 1 C# source/);assert.match(report.files.find(f=>f.path==='Defs/Items.xml').description,/Edited ThingDef Armor.*Added ThingDef Helmet/);assert.equal(report.files.find(f=>f.path==='Textures/old.png').action,'removed');
});
test('mtime-only and excluded metadata/cache changes stay clean; actual content changes are detected',async t=>{
 const {root}=fixture(t);write(root,'Source/Main.cs','original');await api.recordModBaseline(root,'updated');
 const before=await api.readModChanges(root);const future=new Date(Date.now()+10000);fs.utimesSync(path.join(root,'Source/Main.cs'),future,future);write(root,'.atlas/prefs.json','changed');write(root,'.modmixer/old.json','changed');write(root,'obj/cache','changed');write(root,'bin/compiler','changed');
 const clean=await api.readModChanges(root);assert.equal(clean.status,'clean');assert.equal(clean.lastModifiedAt,before.lastModifiedAt);
 write(root,'Source/Main.cs','different');const edited=await api.readModChanges(root);assert.equal(edited.count,1);write(root,'Source/Main.cs','original');assert.equal((await api.readModChanges(root)).status,'clean');
});
test('keeps published and marked-update comparisons separate and chooses the latest',async t=>{
 const {root}=fixture(t);write(root,'file.txt','published');await api.recordModBaseline(root,'published','public',undefined,100);
 write(root,'file.txt','updated');await api.recordModBaseline(root,'updated','private update',undefined,200);
 const latest=await api.readModChanges(root,100);assert.equal(latest.status,'clean');assert.equal(latest.baselineKind,'updated');assert.equal(latest.lastPublishedAt,100);assert.equal(latest.lastUpdatedAt,200);
 assert.equal((await api.readModChanges(root,100,'published')).status,'modified');write(root,'file.txt','third');assert.equal((await api.readModChanges(root,100,'updated')).count,1);
});
test('records uploaded staging inventory so concurrent live edits remain unpublished',async t=>{
 const {root,area}=fixture(t);write(root,'file.txt','upload');const stage=path.join(area,'staged');fs.mkdirSync(stage);write(stage,'file.txt','upload');const captured=await api.collectModInventory(stage);
 write(root,'file.txt','edited during upload');await api.recordModBaseline(root,'published','upload',captured,100);
 const report=await api.readModChanges(root,100);assert.equal(report.status,'modified');assert.equal(report.files[0].action,'edited');
});
test('a missing latest publication baseline is reported instead of comparing an older upload',async t=>{
 const {root}=fixture(t);write(root,'file.txt','one');await api.recordModBaseline(root,'published','',undefined,100);
 const report=await api.readModChanges(root,200,'published');assert.equal(report.status,'unavailable');assert.equal(report.lastPublishedAt,200);assert.match(report.description,/latest publication/);
});
test('rejects linked content and linked baseline destinations without touching their targets',async t=>{
 const {root,area}=fixture(t);const outside=path.join(area,'outside');fs.mkdirSync(outside);write(outside,'secret.txt','unchanged');fs.symlinkSync(outside,path.join(root,'linked'),'junction');
 assert.equal((await api.readModChanges(root)).status,'unavailable');await assert.rejects(api.recordModBaseline(root,'updated'),/Linked path/);fs.unlinkSync(path.join(root,'linked'));
 fs.symlinkSync(outside,path.join(area,'Mods/.atlas'),'junction');await assert.rejects(api.recordModBaseline(root,'updated'),/link|escape|directory/i);assert.equal(fs.readdirSync(outside).length,1);
});
test('persists deletion detection across restarts and preserves the publication record across mod restore',async t=>{
 const {root,state}=fixture(t);write(root,'file.txt','release');await api.recordModBaseline(root,'published','',undefined,100);fs.unlinkSync(path.join(root,'file.txt'));
 const deleted=await api.readModChanges(root,100);const restarted=load('atlas/mod-changes.ts');assert.equal((await restarted.readModChanges(root,100)).lastModifiedAt,deleted.lastModifiedAt);
 write(root,'file.txt','restored earlier content');const report=await restarted.readModChanges(root,100);assert.equal(report.lastPublishedAt,100);assert.equal(report.status,'modified');assert.equal(JSON.parse(fs.readFileSync(state)).published.at,100);
});
