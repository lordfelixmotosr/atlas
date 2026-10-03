const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
const source=path.resolve(__dirname,'../src/agent'),base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(t){const root=fs.mkdtempSync(path.join(base,'atlas-metadata-'));t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true})});return root;}
function modules(workspaceDir){
 const cache=new Map();
 function load(file){
  const full=path.resolve(source,file);if(cache.has(full))return cache.get(full).exports;
  const module={exports:{}};cache.set(full,module);
  const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const localRequire=id=>id.endsWith('/workspace.js')?{getWorkspacePaths:()=>({workspaceDir})}:id.endsWith('/games/registry.js')?{DEFAULT_GAME_ID:'rimworld',resolveGameId:g=>g||'rimworld'}:id.startsWith('.')?load(path.relative(source,path.resolve(path.dirname(full),id.replace(/\.js$/,'.ts')))):require(id);
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Buffer,console,process,setTimeout,clearTimeout,Uint32Array})(localRequire,module,module.exports);
  return module.exports;
 }
 return load;
}
test('new mod preferences, schematics, assets and placeholders use Atlas metadata only',async t=>{
 const root=fixture(t),mod=path.join(root,'new');fs.mkdirSync(mod);const load=modules(root);
 await load('mod-prefs.ts').writeModPrefs('new',{pinned:true,license:'MIT'});
 await load('schematic.ts').writeSchematic('new',{shortDescription:'Test mod',body:'Kept schematic'});
 fs.writeFileSync(path.join(mod,'.atlas/cs-assets.json'),JSON.stringify({textures:['UI/Test'],audio:[]}));
 const manifest=await load('assets/cs-manifest.ts').loadCsManifest(mod);assert.equal(manifest.sourceFile,'.atlas/cs-assets.json');assert.equal(manifest.entries[0].stem,'UI/Test');
 await load('assets/stubs.ts').materializeStubs(mod,[{path:'Textures/UI/Test.png',kind:'texture',status:'missing'}]);
 assert(fs.existsSync(path.join(mod,'.atlas/stubs.json')));assert(!fs.existsSync(path.join(mod,'.modmixer')));
 assert.equal((await load('mod-prefs.ts').readModPrefs('new')).pinned,true);
 assert.equal((await load('schematic.ts').readSchematic('new')).body,'Kept schematic');
});
test('legacy mod metadata is renamed intact and remains readable',async t=>{
 const root=fixture(t),mod=path.join(root,'old'),legacy=path.join(mod,'.modmixer');fs.mkdirSync(path.join(legacy,'notes'),{recursive:true});
 fs.writeFileSync(path.join(legacy,'prefs.json'),JSON.stringify({pinned:true,license:'CC0-1.0'}));fs.writeFileSync(path.join(legacy,'schematic.json'),JSON.stringify({body:'Existing spec'}));fs.writeFileSync(path.join(legacy,'cs-assets.json'),JSON.stringify({textures:['UI/Old'],audio:[]}));fs.writeFileSync(path.join(legacy,'notes/private.txt'),'preserve every byte');
 const load=modules(root);assert.equal((await load('mod-prefs.ts').readModPrefs('old')).license,'CC0-1.0');assert.equal((await load('schematic.ts').readSchematic('old')).body,'Existing spec');
 assert.equal((await load('assets/cs-manifest.ts').loadCsManifest(mod)).entries[0].stem,'UI/Old');assert(!fs.existsSync(legacy));assert.equal(fs.readFileSync(path.join(mod,'.atlas/notes/private.txt'),'utf8'),'preserve every byte');
});
test('mixed metadata folders preserve conflicts and retain the actual legacy manifest source path',async t=>{
 const root=fixture(t),mod=path.join(root,'mixed');for(const dir of ['.atlas','.modmixer'])fs.mkdirSync(path.join(mod,dir),{recursive:true});
 fs.writeFileSync(path.join(mod,'.atlas/prefs.json'),'{}');fs.writeFileSync(path.join(mod,'.modmixer/prefs.json'),'{"pinned":true}');fs.writeFileSync(path.join(mod,'.modmixer/cs-assets.json'),'{"textures":["UI/Legacy"],"audio":[]}');
 const load=modules(root);assert.equal((await load('mod-prefs.ts').readModPrefs('mixed')).pinned,false);assert.equal((await load('assets/cs-manifest.ts').loadCsManifest(mod)).sourceFile,'.modmixer/cs-assets.json');
 assert.equal(fs.readFileSync(path.join(mod,'.modmixer/prefs.json'),'utf8'),'{"pinned":true}');
});
test('metadata migration refuses linked directories and escaping paths',t=>{
 const root=fixture(t),load=modules(root),outside=path.join(root,'outside'),mod=path.join(root,'linked');fs.mkdirSync(outside);fs.mkdirSync(mod);fs.symlinkSync(outside,path.join(mod,'.modmixer'),'junction');
 assert.throws(()=>load('mod-metadata.ts').metadataDirectory(mod),/local directory/);assert(!fs.existsSync(path.join(mod,'.atlas')));
 assert.throws(()=>load('mod-metadata.ts').metadataWritePath(root,'../outside/prefs.json'),/Invalid/);
});
