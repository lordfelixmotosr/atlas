'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript'),source=path.resolve(__dirname,'../src');
function loader(stubs=new Map()){
 const cache=new Map();
 function load(file){const full=path.resolve(source,file);if(stubs.has(full))return stubs.get(full);if(cache.has(full))return cache.get(full).exports;const module={exports:{}};cache.set(full,module);const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const requireLocal=id=>id.startsWith('.')?load(path.resolve(path.dirname(full),id.replace(/\.js$/,'.ts'))):require(id);vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console,Buffer,process,Map,Set,Date,setTimeout,clearTimeout})(requireLocal,module,module.exports);return module.exports;}return load;
}
const load=loader(),{parseAboutXml}=load('agent/registry/about-xml.ts'),{computeTestSet}=load('agent/registry/test-set.ts'),{autosort}=load('agent/registry/autosort.ts');
const official=['ludeon.rimworld','ludeon.rimworld.royalty','ludeon.rimworld.ideology','ludeon.rimworld.biotech','ludeon.rimworld.anomaly','ludeon.rimworld.odyssey'];
const mod=(id,deps=[])=>({folder:id,path:'/'+id,source:id.startsWith('ludeon.')?'official':'local',about:parseAboutXml('<ModMetaData><packageId>'+id+'</packageId><modDependencies>'+deps.map(dep=>'<li><packageId>'+dep+'</packageId></li>').join('')+'</modDependencies></ModMetaData>'),hasDlls:false,publishedFileId:null,workspaceSynced:false});
const snapshot=(mods,activeOrder)=>({mods,activeOrder,active:[],missingActive:[],gameVersion:'1.6',gameVersionMajorMinor:'1.6'});
test('isolated tests preserve active installed Odyssey and omit disabled or absent DLCs',()=>{
 const mods=[...official.map(id=>mod(id)),mod('example.target')];let out=computeTestSet({snapshot:snapshot(mods,official),targetPackageId:'example.target'});assert.deepEqual(Array.from(out.reducedActive),[...official,'example.target']);
 out=computeTestSet({snapshot:snapshot(mods,official.slice(0,-1)),targetPackageId:'example.target'});assert(!out.reducedActive.includes('ludeon.rimworld.odyssey'));
 out=computeTestSet({snapshot:snapshot(mods.filter(entry=>entry.about.packageIdLc!=='ludeon.rimworld.odyssey'),official),targetPackageId:'example.target'});assert(!out.reducedActive.includes('ludeon.rimworld.odyssey'));
});

test('registry groups a matching Workshop verification copy with its workspace without deleting files or hiding other publications',async t=>{
 const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'registry-copies-')),workspaceDir=path.join(root,'workspace'),modsDir=path.join(root,'Mods'),workshopDir=path.join(root,'workshop');
 const writeMod=(parent,folder,id,published)=>{const dir=path.join(parent,folder);fs.mkdirSync(path.join(dir,'About'),{recursive:true});fs.writeFileSync(path.join(dir,'About/About.xml'),`<ModMetaData><name>${folder}</name><packageId>${id}</packageId></ModMetaData>`);if(published)fs.writeFileSync(path.join(dir,'About/PublishedFileId.txt'),published);return dir;};
 const workspace=writeMod(workspaceDir,'owned','Example.Owned','123');const local=writeMod(modsDir,'owned','example.owned','123');const steam=writeMod(workshopDir,'123','example.owned');writeMod(workshopDir,'456','example.owned');writeMod(workshopDir,'789','example.unrelated');
 fs.mkdirSync(path.join(workspace,'Source'));fs.writeFileSync(path.join(workspace,'Source/Example.cs'),'source remains private');
 t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const stubs=new Map([[path.join(source,'agent/paths.ts'),{detectRimWorldPaths:()=>({modsDir,workshopDir})}],[path.join(source,'agent/workspace.ts'),{getWorkspacePaths:()=>({workspaceDir}),isModSyncedToGame:async()=>true}],[path.join(source,'agent/registry/mods-config.ts'),{readModsConfig:async()=>({version:'1.7',activeMods:['example.owned']})}]]);
 const registry=loader(stubs)('agent/registry/registry.ts').getRegistry();const snapshot=await registry.refresh();
 assert.equal(snapshot.mods.filter(m=>m.publishedFileId==='123').length,1);assert.equal(snapshot.mods.find(m=>m.publishedFileId==='123').source,'workspace');assert(snapshot.mods.some(m=>m.folder==='456'&&m.source==='workshop'));assert(snapshot.mods.some(m=>m.folder==='789'));assert.equal(snapshot.active[0].mod.source,'workspace');
 for(const folder of [workspace,local,steam])assert(fs.existsSync(path.join(folder,'About/About.xml')));assert(fs.existsSync(path.join(workspace,'Source/Example.cs')));
 fs.unlinkSync(path.join(workspace,'About/PublishedFileId.txt'));const unlinked=await registry.refresh();assert(unlinked.mods.some(m=>m.folder==='123'&&m.source==='workshop'));registry.stop();
});
test('Odyssey dependencies and canonical DLC load order are retained ahead of ordinary mods',()=>{
 const mods=[...official.map(id=>mod(id)),mod('brrainz.harmony'),mod('example.target',['ludeon.rimworld.odyssey'])];const input=['example.target',...official.slice().reverse(),'brrainz.harmony'];const sorted=autosort({snapshot:snapshot(mods,input),activeOrder:input,rules:new Map()});assert.deepEqual(Array.from(sorted.order),['brrainz.harmony',...official,'example.target']);assert.equal(sorted.conflicts.length,0);
 const required=computeTestSet({snapshot:snapshot(mods,['ludeon.rimworld']),targetPackageId:'example.target'});assert.deepEqual(Array.from(required.reducedActive),['ludeon.rimworld','ludeon.rimworld.odyssey','example.target']);
});
test('the actual registry synthesizes Odyssey metadata and reads its installed About.xml',async t=>{
 const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'dlc-')),dataDir=path.join(root,'Data'),workspaceDir=path.join(root,'workspace');fs.mkdirSync(path.join(dataDir,'Core'),{recursive:true});fs.mkdirSync(path.join(dataDir,'Odyssey'));fs.mkdirSync(workspaceDir);t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const stubs=new Map([[path.join(source,'agent/paths.ts'),{detectRimWorldPaths:()=>({dataDir,modsDir:path.join(root,'Mods')})}],[path.join(source,'agent/workspace.ts'),{getWorkspacePaths:()=>({workspaceDir})}],[path.join(source,'agent/registry/mods-config.ts'),{readModsConfig:async()=>({version:'1.6',activeMods:official,knownExpansions:official.slice(1)})}]]);
 const registry=loader(stubs)('agent/registry/registry.ts').getRegistry();await registry.refresh();let found=registry.getSnapshot().mods.find(entry=>entry.folder==='Odyssey');assert.equal(found.about.packageIdLc,'ludeon.rimworld.odyssey');assert.equal(found.source,'official');assert.equal(found.about.name,'Odyssey');
 fs.mkdirSync(path.join(dataDir,'Odyssey/About'));fs.writeFileSync(path.join(dataDir,'Odyssey/About/About.xml'),'<ModMetaData><packageId>Ludeon.RimWorld.Odyssey</packageId><supportedVersions><li>1.6</li></supportedVersions></ModMetaData>');await registry.refresh();found=registry.getSnapshot().mods.find(entry=>entry.folder==='Odyssey');assert.equal(found.about.packageId,'Ludeon.RimWorld.Odyssey');assert.equal(found.about.packageIdLc,'ludeon.rimworld.odyssey');registry.stop();
});
