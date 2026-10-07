const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/atlas/bootstrap.cjs'),'utf8');
const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(t,value){
 const root=fs.mkdtempSync(path.join(base,'bootstrap-lock-')),file=path.join(root,'data/profile/pi-agent/settings.json'),shell=path.join(root,'tools/git/bin/bash.exe');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(path.dirname(shell),{recursive:true});fs.writeFileSync(shell,'fixture, never executable');
 if(value!==undefined)fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));
 t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true})});return {root,file,shell};
}
function run(f,overrides={}){
 const module={exports:{}},warnings=[],waits=[],env={PATH:'original-path'};
 vm.runInNewContext(source,{module,__dirname:path.resolve(__dirname,'../src/atlas'),require:name=>name==='node:fs'?{...fs,...overrides}:require(name),process:{pid:process.pid,execPath:process.execPath,env},console:{warn:message=>warnings.push(message)},SharedArrayBuffer,Int32Array,Atomics:{wait:(_a,_i,_v,time)=>waits.push(time)},Date});
 module.exports.bootstrap({setName(){},setPath(){},setAppLogsPath(){}},f.root);return {env,warnings,waits};
}
const locked=code=>Object.assign(new Error('fixture lock'),{code});
const temps=f=>fs.readdirSync(path.dirname(f.file)).filter(name=>name.endsWith('.tmp'));
test('unchanged portable shell settings are not rewritten on repeated launches',t=>{
 const f=fixture(t,{}),value=JSON.stringify({shellPath:f.shell,retry:{enabled:false},customPreference:'keep'});fs.writeFileSync(f.file,value);
 let replacements=0;const overrides={renameSync(){replacements++;throw locked('EPERM')}};
 run(f,overrides);run(f,overrides);assert.equal(replacements,0);assert.equal(fs.readFileSync(f.file,'utf8'),value);assert.deepEqual(temps(f),[]);
});
test('temporary Windows locks retry and retain unrelated settings',t=>{
 const f=fixture(t,{shellPath:'C:/old/Atlas/bash.exe',customPreference:'keep'});let attempts=0;
 const result=run(f,{renameSync(from,to){if(++attempts<3)throw locked(attempts===1?'EPERM':'EBUSY');fs.renameSync(from,to)}});
 assert.equal(attempts,3);assert.deepEqual(result.waits,[40,80]);assert.deepEqual(result.warnings,[]);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),{shellPath:f.shell,customPreference:'keep'});assert.equal(result.env.ATLAS_SHELL_PATH,f.shell);assert.deepEqual(temps(f),[]);
});
test('persistent settings replacement lock preserves file and uses runtime shell',t=>{
 const f=fixture(t,{shellPath:'C:/old/Atlas/bash.exe',customPreference:'keep'}),before=fs.readFileSync(f.file);let attempts=0;
 const result=run(f,{renameSync(){attempts++;throw locked('EPERM')}});
 assert.equal(attempts,4);assert(fs.readFileSync(f.file).equals(before));assert.equal(result.env.ATLAS_SHELL_PATH,f.shell);assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/EPERM.*bundled shell/);
 assert.match(fs.readFileSync(path.join(f.root,'data/logs/startup.log'),'utf8'),/EPERM/);assert.deepEqual(temps(f),[]);
});
test('settings staging access errors do not crash startup or discard settings',t=>{
 const f=fixture(t,{shellPath:'C:/old/Atlas/bash.exe',customPreference:'keep'}),before=fs.readFileSync(f.file);
 const result=run(f,{writeFileSync(file,...args){if(String(file).startsWith(f.file+'.'))throw locked('EACCES');return fs.writeFileSync(file,...args)}});
 assert(fs.readFileSync(f.file).equals(before));assert.equal(result.env.ATLAS_SHELL_PATH,f.shell);assert.equal(result.warnings.length,1);assert.deepEqual(temps(f),[]);
});
test('unreadable or malformed settings stay intact while startup selects runtime shell',t=>{
 const f=fixture(t,'{invalid settings');const result=run(f);
 assert.equal(fs.readFileSync(f.file,'utf8'),'{invalid settings');assert.equal(result.env.ATLAS_SHELL_PATH,f.shell);assert.equal(result.warnings.length,1);assert.deepEqual(temps(f),[]);
});
