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
