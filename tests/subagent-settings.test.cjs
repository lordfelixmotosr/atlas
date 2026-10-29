'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
const root=path.resolve(__dirname,'..');
function moduleFrom(relative,mocks={}){const file=path.join(root,relative),exports={};const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext(js,{exports,require:name=>name in mocks?mocks[name]:require(name),process,console,Buffer},{filename:file});return exports;}
const helpers=moduleFrom('src/atlas/subagents-types.ts');
const thinking=moduleFrom('src/lib/thinking-levels.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
test('helpers default to Efficient and four, with a strict one-to-eight ceiling',()=>{
 assert.deepEqual(plain(helpers.normalizeSubagentSettings(null)),{enabled:true,mode:'efficient',maxHelpers:4});
 assert.equal(helpers.normalizeSubagentSettings({maxHelpers:999}).maxHelpers,8);
 assert.equal(helpers.normalizeSubagentSettings({maxHelpers:0}).maxHelpers,1);
 assert.equal(helpers.normalizeSubagentSettings({maxHelpers:NaN}).maxHelpers,4);
 assert.deepEqual(plain(helpers.normalizeSubagentSettings({enabled:false,mode:'match',maxHelpers:6})),{enabled:false,mode:'match',maxHelpers:6});
});
test('loading legacy settings and saving helper preferences preserves main model, thinking and speed',t=>{
 const base=path.join(root,'build-check');fs.mkdirSync(base,{recursive:true});const folder=fs.mkdtempSync(path.join(base,'helper-settings-'));t.after(()=>{assert.equal(path.dirname(folder),base);fs.rmSync(folder,{recursive:true,force:true});});
 const saved={distinctId:'fixture',model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},thinkingLevel:'max',openaiSpeed:'standard',defaultAuthor:'Felix',selectedGameId:'rimworld'};
 const file=path.join(folder,'settings.json');fs.writeFileSync(file,JSON.stringify(saved));const before=fs.readFileSync(file,'utf8');
 const settings=moduleFrom('src/agent/settings.ts',{'electron':{app:{getPath:()=>folder}},'../atlas/subagents-types':helpers,'../lib/thinking-levels.js':thinking,'../lib/identifiers.js':{sanitizeAuthorHandle:v=>v},'./games/registry.js':{resolveGameId:v=>v??'rimworld'},'./licenses.js':{DEFAULT_LICENSE_ID:'MIT'}});
 assert.equal(settings.loadSettings().thinkingLevel,'max');assert.equal(fs.readFileSync(file,'utf8'),before,'Reading defaults should not rewrite an existing profile');
 assert.equal(settings.loadSettings().subagents.maxHelpers,4);
 settings.saveSettings({subagents:helpers.normalizeSubagentSettings({enabled:true,mode:'efficient',maxHelpers:8})});
 const after=JSON.parse(fs.readFileSync(file));assert.equal(after.thinkingLevel,saved.thinkingLevel);assert.equal(after.openaiSpeed,saved.openaiSpeed);assert.deepEqual(after.model,saved.model);assert.equal(after.subagents.maxHelpers,8);
});
