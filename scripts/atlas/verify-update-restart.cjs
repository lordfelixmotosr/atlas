'use strict';
// Owns a fresh public-runtime fixture. Never runs against the user's profile.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),asar=require('./asar.cjs');
const repository=path.resolve(__dirname,'../..'),base=path.resolve(process.argv[2]||''),zip=path.resolve(process.argv[3]||''),version=process.argv[4];
if(!/^\d+\.\d+\.\d+$/.test(version||'')||!fs.existsSync(path.join(base,'atlas-build.json'))||!fs.existsSync(zip))throw new Error('Usage: node verify-update-restart.cjs public-runtime update.zip target-version');
const fixtures=path.join(repository,'build-check/fixtures'),root=path.join(fixtures,'native-update-'+crypto.randomUUID()),exe=path.join(root,'Atlas.exe');
fs.mkdirSync(root,{recursive:true});
async function main(){
 try{cp.execFileSync('robocopy.exe',[base,root,'/E','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XJ','/MT:16','/XD',...['data','custom','library','backups'].map(name=>path.join(base,name))],{stdio:'ignore',windowsHide:true});}catch(error){if(error.status>7||error.status===null)throw error;}
 fs.mkdirSync(path.join(root,'data/updates'),{recursive:true});const archive=path.join(root,'data/updates/release.zip');fs.copyFileSync(zip,archive);
 const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(archive))hash.update(bytes);const sha256=hash.digest('hex');
 const original=fs.readFileSync(path.join(root,'resources/app.asar')),parsed=asar.read(original),main=parsed.files.find(file=>file.name==='.vite/build/main.js');
 main.bytes=Buffer.from('require("./atlas/verify-install.cjs").init();'+main.bytes.toString());
 parsed.files.find(file=>file.name.endsWith('/application-update.cjs')).bytes=fs.readFileSync(path.join(repository,'src/atlas/application-update.cjs'));
 asar.add(parsed,'.vite/build/atlas/verify-install.cjs',Buffer.from(`const fs=require('node:fs'),path=require('node:path'),{app}=require('electron');exports.init=()=>{app.on('browser-window-created',(_event,window)=>{window.webContents.once('did-finish-load',()=>{setTimeout(async()=>{const root=path.dirname(process.execPath);try{const runtime=globalThis.__atlasRuntime;await runtime.ready;runtime.application.ready={version:${JSON.stringify(version)},path:path.join(root,'data/updates/release.zip'),sha256:${JSON.stringify(sha256)}};fs.writeFileSync(path.join(root,'data/install-called.json'),JSON.stringify({pid:process.pid,at:Date.now()}));await runtime.application.install();}catch(error){fs.writeFileSync(path.join(root,'data/install-error.json'),JSON.stringify({error:error.stack}));}},2000)});});};`));
 const updated=asar.write(parsed);fs.writeFileSync(path.join(root,'resources/app.asar'),updated);fs.writeFileSync(exe,asar.patchExe(fs.readFileSync(exe),asar.sha(asar.read(original).raw),asar.sha(asar.read(updated).raw)));
 for(const name of ['launch-update.ps1','apply-update.ps1','watch-update.ps1'])fs.copyFileSync(path.join(repository,'src/atlas',name),path.join(root,'resources/atlas',name));
 fs.writeFileSync(path.join(root,'data/atlas-library.json'),JSON.stringify({source:'updates',autoUpdate:false,feedRevision:1}));
 fs.writeFileSync(path.join(root,'data/private-marker.txt'),'Preserve user data');
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath ${quote(exe)} -WorkingDirectory ${quote(root)} -WindowStyle Hidden`],{stdio:'ignore',windowsHide:true});
 const deadline=Date.now()+90000;let result;
 while(Date.now()<deadline){
  const error=path.join(root,'data/install-error.json');if(fs.existsSync(error))throw new Error(JSON.parse(fs.readFileSync(error)).error);
  try{const recovery=JSON.parse(fs.readFileSync(path.join(root,'data/updates/recovery-status.json'))),healthy=JSON.parse(fs.readFileSync(path.join(root,'data/updates/startup-healthy.json'))),called=JSON.parse(fs.readFileSync(path.join(root,'data/install-called.json'))),receipt=JSON.parse(fs.readFileSync(path.join(root,'atlas-build.json')));
   if(recovery.status==='healthy'&&healthy.version===version&&receipt.version===version&&healthy.pid!==called.pid){
    if(asar.sha(fs.readFileSync(path.join(root,'resources/app.asar')))!==receipt.archiveSha256||asar.sha(fs.readFileSync(exe))!==receipt.exeSha256)throw new Error('Installed files do not match the production receipt.');
    if(fs.readFileSync(path.join(root,'data/private-marker.txt'),'utf8')!=='Preserve user data')throw new Error('Private fixture data was changed.');
    result={version,previousPid:called.pid,newPid:healthy.pid,status:'healthy',realElectronInstall:true,productionHashesMatch:true,privateDataPreserved:true,root};break;
   }
   if(recovery.status==='install-failed'||recovery.status==='rolled-back')throw new Error(recovery.reason);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!result)throw new Error('Native install/restart did not confirm startup. See '+root);
 fs.writeFileSync(path.join(repository,'build-check/native-update-'+version+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>{
 const owned="'"+exe.replaceAll("'","''")+"'";
 cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "Name = 'Atlas.exe'" | Where-Object {$_.ExecutablePath -eq ${owned}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`],{stdio:'ignore',windowsHide:true});
});
