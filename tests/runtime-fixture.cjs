const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {spawn} = require('node:child_process');
const ts = require('../build-tools/native/node_modules/typescript');
function load(file, imports = {}) {
  const module = {exports:{}};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})', {console,process,Buffer,setTimeout,clearTimeout})(id=>{
    if(id in imports)return imports[id];
    if(id.startsWith('node:'))return require(id);
    throw Error('Unexpected dependency '+id);
  },module,module.exports);
  return module.exports;
}
const release = load('agent/rimworld/release-package.ts', {'fast-xml-parser':require('fast-xml-parser')});
const mirrors = load('agent/rimworld/runtime-mirror.ts', {'./release-package.js':release});
const base = path.resolve(__dirname,'../build-check/fixtures');
function fixture(t) {
  fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'release-')),source=path.join(root,'workspace','Example'),target=path.join(root,'Mods','Example'),state=path.join(root,'profile','runtime-mirrors');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const write=(p,data='fixture')=>{const f=path.join(source,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);};
  write('About/About.xml','<ModMetaData><name>Fixture</name><packageId>atlas.release.fixture</packageId><supportedVersions><li>1.6</li><li>1.7</li></supportedVersions></ModMetaData>');
  t.after(async()=>{assert(root.startsWith(base+path.sep));fs.unwatchFile(path.join(target,'About','PublishedFileId.txt'));await mirrors.withRuntimeSync(path.dirname(target),async()=>{});fs.rmSync(root,{recursive:true,force:true});});
  return {root,source,target,state,write};
}


module.exports={release,mirrors,load,fixture,fs,fsp,path,spawn,assert};
