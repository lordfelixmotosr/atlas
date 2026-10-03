'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const fixtureBase=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(fixtureBase,{recursive:true});
const python=path.resolve(__dirname,'../dist/Atlas/tools/python/python.exe'),helper=path.resolve(__dirname,'../src/atlas/apply-update.ps1');
function fixture(t,extra=[],version='0.2.0'){
 const root=fs.mkdtempSync(path.join(fixtureBase,'app-update-'));assert(root.startsWith(fixtureBase+path.sep));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'data/updates'),{recursive:true});fs.mkdirSync(path.join(root,'custom/skills'),{recursive:true});fs.writeFileSync(path.join(root,'Atlas.exe'),'old exe');fs.writeFileSync(path.join(root,'custom/skills/mine.txt'),'keep');
 const zip=path.join(root,'data/updates/release.zip'),entries=[['Atlas/Atlas.exe','new exe'],['Atlas/resources/app.asar','new asar'],['Atlas/atlas-build.json',JSON.stringify({version})],...extra];
 const create='import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for name,content in json.load(sys.stdin):z.writestr(name,content)';
 cp.execFileSync(python,['-I','-c',create,zip],{input:JSON.stringify(entries)});
 const request=path.join(root,'request.json');fs.writeFileSync(request,JSON.stringify({root,zip,pid:2147483647,version:'0.2.0',sha256:crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}));return{root,request};
}
const invoke=(f,flag)=>cp.execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-RequestPath',f.request,flag],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
test('app updater installs verified archive into its own fixture and preserves custom data',t=>{const f=fixture(t);invoke(f,'-NoRestart');assert.equal(fs.readFileSync(path.join(f.root,'Atlas.exe'),'utf8'),'new exe');assert.equal(fs.readFileSync(path.join(f.root,'custom/skills/mine.txt'),'utf8'),'keep');assert.equal(fs.readFileSync(path.join(f.root,'backups',fs.readdirSync(path.join(f.root,'backups'))[0],'Atlas.exe'),'utf8'),'old exe');});
test('app updater rejects escaping, private, duplicate, device and mismatched-version archives',t=>{
 for(const name of ['Atlas/../escape.txt','Atlas/data/notes.txt','Atlas/C:evil','Atlas/CON.txt','Atlas/FILE.','Atlas/ATLAS.exe']){const f=fixture(t,[[name,'bad']]);assert.throws(()=>invoke(f,'-ValidateOnly'));assert.equal(fs.readFileSync(path.join(f.root,'Atlas.exe'),'utf8'),'old exe');assert(!fs.existsSync(path.join(f.root,'escape.txt')));}
 const f=fixture(t,[],'0.3.0');assert.throws(()=>invoke(f,'-ValidateOnly'));assert.equal(fs.readFileSync(path.join(f.root,'Atlas.exe'),'utf8'),'old exe');
});
test('failed replacement rolls back earlier files and retains user skills',t=>{
 const f=fixture(t,[['Atlas/locked.txt','new locked']]);fs.writeFileSync(path.join(f.root,'locked.txt'),'old locked');
 const script=path.join(f.root,'simulate-locked.ps1');fs.writeFileSync(script,"param($Root,$Helper,$Request)\n$ErrorActionPreference='Stop'\n$lock=[IO.File]::Open((Join-Path $Root 'locked.txt'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)\ntry{& $Helper -RequestPath $Request -NoRestart}finally{$lock.Dispose()}\n");
 assert.throws(()=>cp.execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,f.root,helper,f.request],{windowsHide:true,stdio:['ignore','pipe','pipe']}));
 assert.equal(fs.readFileSync(path.join(f.root,'Atlas.exe'),'utf8'),'old exe');assert.equal(fs.readFileSync(path.join(f.root,'locked.txt'),'utf8'),'old locked');assert.equal(fs.readFileSync(path.join(f.root,'custom/skills/mine.txt'),'utf8'),'keep');assert(!fs.existsSync(path.join(f.root,'resources/app.asar')));
});

test('real runtime data folders and long resource paths are allowed without touching private roots',t=>{const relative='Atlas/resources/data/'+('nested-directory/'.repeat(12))+'catalog.json';const f=fixture(t,[[relative,'{}']]);invoke(f,'-ValidateOnly');invoke(f,'-NoRestart');assert.equal(fs.readFileSync(path.join(f.root,relative.slice(6)),'utf8'),'{}');assert.equal(fs.readFileSync(path.join(f.root,'custom/skills/mine.txt'),'utf8'),'keep');});
