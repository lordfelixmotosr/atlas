const test=require('node:test');
const {fixture,fs,path,assert,load,mirrors}=require('./runtime-fixture.cjs');
function bridge(t){
  const f=fixture(t),resources=path.join(f.root,'resources'),source=path.join(resources,'modmixer-bridge'),target=path.join(path.dirname(f.target),'AtlasBridge');
  fs.cpSync(f.source,source,{recursive:true});fs.mkdirSync(path.join(source,'1.7/Defs'),{recursive:true});fs.writeFileSync(path.join(source,'1.7/Defs/Probe.xml'),'old');fs.writeFileSync(path.join(source,'LoadFolders.xml'),'<loadFolders><v1.6><li>/</li></v1.6><v1.7><li>1.7</li></v1.7></loadFolders>');
  const prior=process.resourcesPath;process.resourcesPath=resources;t.after(()=>{if(prior===undefined)delete process.resourcesPath;else process.resourcesPath=prior;});
  const api=load('agent/bridge-install.ts',{'electron':{app:{isPackaged:true,getAppPath:()=>f.root}},'./paths.js':{detectRimWorldPaths:()=>({modsDir:path.dirname(target)})},'./workspace.js':{getMirrorStateDir:()=>f.state},'./rimworld/runtime-mirror.js':mirrors});return {...f,source,target,api};
}
test('the bundled bridge installs as an owned runtime copy and refreshes after an app update',async t=>{
  const f=bridge(t);assert.equal((await f.api.ensureBridgeInstalled({mods:[]})).installed,true);assert(!fs.lstatSync(f.target).isSymbolicLink());assert(await mirrors.ownedMirror(f.source,f.target,f.state));
  fs.writeFileSync(path.join(f.source,'1.7/Defs/Probe.xml'),'updated');assert.equal((await f.api.ensureBridgeInstalled({mods:[]})).installed,true);assert.equal(fs.readFileSync(path.join(f.target,'1.7/Defs/Probe.xml'),'utf8'),'updated');
});
test('bridge installation preserves an unmanaged real directory and a Workshop bridge',async t=>{
  const f=bridge(t);fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'user-file.txt'),'preserve');
  assert.equal((await f.api.ensureBridgeInstalled({mods:[]})).skipReason,'local');assert.equal(fs.readFileSync(path.join(f.target,'user-file.txt'),'utf8'),'preserve');
  assert.equal((await f.api.ensureBridgeInstalled({mods:[{source:'workshop',about:{packageIdLc:'modmixer.bridge'}}]})).skipReason,'workshop');assert.equal(fs.readFileSync(path.join(f.target,'user-file.txt'),'utf8'),'preserve');
});
