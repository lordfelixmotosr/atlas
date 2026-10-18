const {fs,fsp,path,load,release}=require('./runtime-fixture.cjs');
const [source,target,state,events,mode]=process.argv.slice(2);
if(mode==='crash') {
  const proxy=Object.create(fsp);
  proxy.rename=async(a,b)=>{await fsp.rename(a,b);if(path.basename(b)==='previous')process.exit(23);};
  const crash=load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release,'node:fs/promises':proxy});
  crash.refreshRuntimeMirror(source,target,state).catch(e=>{console.error(e);process.exit(1)});
} else {
const mirror=load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release});
mirror.withRuntimeSync(path.dirname(target),async()=>{
  fs.appendFileSync(events,`start ${process.pid}\n`);
  await new Promise(r=>setTimeout(r,200));
  await mirror.refreshRuntimeMirror(source,target,state);
  fs.appendFileSync(events,`end ${process.pid}\n`);
}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
}
