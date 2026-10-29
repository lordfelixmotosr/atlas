const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),git=require('isomorphic-git');
const ts=require('../build-tools/native/node_modules/typescript');
const full=path.resolve(__dirname,'../src/atlas/change-note-history.ts'),moduleFixture={exports:{}};
const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Buffer,Date,Map,console})(require,moduleFixture,moduleFixture.exports);
const {recoverChangeNoteHistory:recover}=moduleFixture.exports;
const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const request=(filename,text)=>({path:filename,hash:digest(Buffer.from(text)),size:Buffer.byteLength(text)});
function fixture(t){const area=fs.mkdtempSync(path.join(base,'notes-history-')),snap=path.join(area,'snapshot'),repo=path.join(snap,'repo.git');fs.mkdirSync(repo,{recursive:true});t.after(()=>{assert(area.startsWith(base+path.sep));fs.rmSync(area,{recursive:true,force:true});});return{area,snap,repo};}
async function save(repo,files,timestamp){
 await git.init({fs,gitdir:repo,bare:true});const tree={};
 for(const [filename,bytes] of Object.entries(files)){const parts=('mod/'+filename).split('/');let dir=tree;for(const part of parts.slice(0,-1))dir=dir[part]??={};dir[parts.at(-1)]=Buffer.from(bytes);}
 async function writeTree(dir){const entries=[];for(const [name,value] of Object.entries(dir).sort((a,b)=>a[0].localeCompare(b[0]))){if(Buffer.isBuffer(value))entries.push({path:name,mode:'100644',type:'blob',oid:await git.writeBlob({fs,gitdir:repo,blob:value})});else entries.push({path:name,mode:'040000',type:'tree',oid:await writeTree(value)});}return git.writeTree({fs,gitdir:repo,tree:entries});}
 const author={name:'Fixture',email:'fixture@example.invalid',timestamp:Math.floor(timestamp/1000),timezoneOffset:0};return {sha:await git.writeCommit({fs,gitdir:repo,commit:{tree:await writeTree(tree),parent:[],author,committer:author,message:'Fixture snapshot'}}),timestamp};
}
function index(snap,saves){fs.writeFileSync(path.join(snap,'index.json'),JSON.stringify({version:2,saves}));}
function inventory(dir,prefix=''){const files=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const relative=prefix+entry.name,full=path.join(dir,entry.name);if(entry.isDirectory())files.push(...inventory(full,relative+'/'));else files.push([relative,digest(fs.readFileSync(full))]);}return JSON.stringify(files.sort((a,b)=>a[0].localeCompare(b[0])));}

test('historical text must match the full baseline hash, not the nearest snapshot date',async t=>{
 const {snap,repo}=fixture(t),before='class Old {}',wrong='class New {}';
 index(snap,[await save(repo,{'Source/Main.cs':wrong},1000),await save(repo,{'Source/Main.cs':before},800)]);
 const untouched=inventory(snap),result=await recover(snap,[request('Source/Main.cs',before)],1000);
 assert.equal(result.get('Source/Main.cs'),before);assert.equal(inventory(snap),untouched);
});

test('nearby snapshots never substitute unmatched bytes and absent history stays absent',async t=>{
 const {snap,repo}=fixture(t);index(snap,[await save(repo,{'Source/Main.cs':'class Wrong {}'},1000)]);
 const result=await recover(snap,[request('Source/Main.cs','class Missing {}'),request('Source/Gone.cs','gone')],1000);
 assert.equal(result.size,0);assert.equal((await recover(path.join(snap,'absent'),[request('Source/Main.cs','none')],1000)).size,0);
});

test('different files may recover from different pinned saves only when each baseline identity matches',async t=>{
 const {snap,repo}=fixture(t);index(snap,[await save(repo,{'Source/A.cs':'A','Source/B.cs':'new B'},2000),await save(repo,{'Source/A.cs':'old A','Source/B.cs':'B'},1000)]);
 const result=await recover(snap,[request('Source/A.cs','A'),request('Source/B.cs','B')],2000);assert.equal(result.get('Source/A.cs'),'A');assert.equal(result.get('Source/B.cs'),'B');
});

test('unlisted commits, malformed indices and missing objects cannot become release-note evidence',async t=>{
 const {snap,repo}=fixture(t);const hidden=await save(repo,{'Source/Main.cs':'hidden'},1000);index(snap,[]);assert.equal((await recover(snap,[request('Source/Main.cs','hidden')],1000)).size,0);
 fs.writeFileSync(path.join(snap,'index.json'),'{broken');assert.equal((await recover(snap,[request('Source/Main.cs','hidden')],1000)).size,0);
 fs.writeFileSync(path.join(snap,'index.json'),'null');assert.equal((await recover(snap,[request('Source/Main.cs','hidden')],1000)).size,0);
 index(snap,[{...hidden,sha:'a'.repeat(40)}]);assert.equal((await recover(snap,[request('Source/Main.cs','hidden')],1000)).size,0);
});

test('private paths, traversal, non-text assignments and oversized identities are rejected before reading',async t=>{
 const {snap}=fixture(t);for(const filename of ['../private.cs','/Source/Main.cs','C:/outside.cs','Source//Main.cs','Source/./Main.cs','Source/auth.json','secrets/data.xml','Source/Main.dll'])await assert.rejects(recover(snap,[request(filename,'x')],1000),/historical change-note path/);
 await assert.rejects(recover(snap,[{...request('Source/Main.cs','x'),size:3*1024*1024}],1000),/file identity/);
 await assert.rejects(recover(snap,Array.from({length:65},()=>request('Source/Main.cs','x')),1000),/too large/);
});

test('UTF-8 and binary checks apply after matching a baseline blob',async t=>{
 const {snap,repo}=fixture(t),invalid=Buffer.from([0xff,0x00]),binary=Buffer.from([65,0,66]);index(snap,[await save(repo,{'Source/Bad.cs':invalid,'Source/Binary.cs':binary},1000)]);
 const result=await recover(snap,[{path:'Source/Bad.cs',hash:digest(invalid),size:invalid.length},{path:'Source/Binary.cs',hash:digest(binary),size:binary.length}],1000);assert.equal(result.size,0);
});

test('linked snapshot roots and repositories are refused without changing their targets',async t=>{
 const {area,snap,repo}=fixture(t),linked=path.join(area,'linked');index(snap,[await save(repo,{'Source/Main.cs':'old'},1000)]);const original=inventory(snap);
 fs.symlinkSync(snap,linked,'junction');await assert.rejects(recover(linked,[request('Source/Main.cs','old')],1000),/Linked snapshot/);fs.unlinkSync(linked);
 const other=path.join(area,'other');fs.mkdirSync(other);fs.symlinkSync(repo,path.join(other,'repo.git'),'junction');fs.copyFileSync(path.join(snap,'index.json'),path.join(other,'index.json'));await assert.rejects(recover(other,[request('Source/Main.cs','old')],1000),/Linked snapshot/);assert.equal(inventory(snap),original);
});

test('repository object links are rejected by the read-only filesystem adapter',async t=>{
 const {area,snap,repo}=fixture(t),record=await save(repo,{'Source/Main.cs':'old'},1000);index(snap,[record]);
 const objectDir=path.join(repo,'objects',record.sha.slice(0,2)),parked=path.join(area,'parked-objects');fs.renameSync(objectDir,parked);fs.symlinkSync(parked,objectDir,'junction');
 await assert.rejects(recover(snap,[request('Source/Main.cs','old')],1000),/Linked snapshot/);
});
