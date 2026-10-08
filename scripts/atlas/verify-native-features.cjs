'use strict';
// Patches only a fresh isolated copy; the production archive stays unchanged.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),asar=require('./asar.cjs');
const repository=path.resolve(__dirname,'../..'),version=JSON.parse(fs.readFileSync(path.join(repository,'package.json'))).version,base=path.join(repository,'dist/Atlas-'+version),root=path.join(repository,'build-check/fixtures/native-features-'+crypto.randomUUID()),exe=path.join(root,'Atlas.exe');
async function main(){
 const receipt=JSON.parse(fs.readFileSync(path.join(base,'atlas-build.json')));if(receipt.version!==version||receipt.archiveSha256!==asar.sha(fs.readFileSync(path.join(base,'resources/app.asar'))))throw new Error('The production build is still staging; wait for its verified receipt before native verification.');
 fs.mkdirSync(root,{recursive:true});try{cp.execFileSync('robocopy.exe',[base,root,'/E','/R:1','/W:1','/NFL','/NDL','/NJH','/NJS','/NP','/XJ','/MT:16','/XD',...['data','custom','library','backups'].map(name=>path.join(base,name))],{stdio:'ignore',windowsHide:true});}catch(error){if(error.status>7||error.status===null)throw error;}
 const original=fs.readFileSync(path.join(root,'resources/app.asar')),parsed=asar.read(original),main=parsed.files.find(file=>file.name==='.vite/build/main.js');main.bytes=Buffer.from('require("./atlas/verify.cjs").init();'+main.bytes.toString());asar.add(parsed,'.vite/build/atlas/verify.cjs',fs.readFileSync(path.join(repository,'scripts/atlas/verify.cjs')));
 const updated=asar.write(parsed);fs.writeFileSync(path.join(root,'resources/app.asar'),updated);fs.writeFileSync(exe,asar.patchExe(fs.readFileSync(exe),asar.sha(asar.read(original).raw),asar.sha(asar.read(updated).raw)));
 if(process.env.ATLAS_VERIFY_BRANDING_ONLY||process.env.ATLAS_VERIFY_CONNECTION_ONLY||process.env.ATLAS_VERIFY_REMOVAL_ONLY){
  const source=fs.readFileSync(path.join(repository,'src/agent/settings.ts'),'utf8'),value=key=>{const match=source.match(new RegExp('export const '+key+" = '([^']+)';"));if(!match)throw new Error('Consent test version is missing');return match[1];},now=new Date().toISOString(),profile=path.join(root,'data/profile');
  fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({analyticsOptIn:false,theme:'dark',consent:{version:value('CURRENT_CONSENT_VERSION'),acceptedAt:now},onboarding:{version:value('CURRENT_ONBOARDING_VERSION'),completedAt:now}}));
 }
 const quote=value=>"'"+value.replaceAll("'","''")+"'";cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath ${quote(exe)} -ArgumentList '--atlas-verify' -WorkingDirectory ${quote(root)} -WindowStyle Hidden`],{stdio:'ignore',windowsHide:true});
 const deadline=Date.now()+90000,reportFile=path.join(root,'data/verify-report.json');let report;
 while(Date.now()<deadline){if(fs.existsSync(reportFile)){report=JSON.parse(fs.readFileSync(reportFile));break;}await new Promise(resolve=>setTimeout(resolve,500));}
 if(!report)throw new Error('Native verification did not finish: '+root);if(report.error)throw new Error(report.error);
 if(report.version!==version)throw new Error('Native verification version differs from production.');
 if(process.env.ATLAS_VERIFY_REMOVAL_ONLY){if(!report.nativeRemoval?.studioRoutesAbsent||Object.values(report.nativeRemoval).some(value=>value!==true))throw new Error('Native removal checks failed.');}
 else if(process.env.ATLAS_VERIFY_BRANDING_ONLY){if(!report.nativeBranding?.loaded)throw new Error('Native logo verification failed.');}
 else if(process.env.ATLAS_VERIFY_CONNECTION_ONLY){if(!report.nativeConnection?.partialErrorAndRetry||Object.values(report.nativeConnection).some(value=>value!==true))throw new Error('Native connection/status checks failed.');}
 else if(process.env.ATLAS_VERIFY_COMPOSER_ONLY){if(!report.nativeComposer?.accountSwitchLoadsNewCredits||!report.nativeChatImages?.toolImageRendered)throw new Error('Native composer or image checks failed.');}
 else if(Object.values(report.nativeFeatureDescriptions||{}).some(value=>value===false)||!report.nativeFeatureDescriptions?.descriptionSaved)throw new Error('Native feature-description checks failed.');
 fs.writeFileSync(path.join(repository,'build-check/native-features-'+version+'.json'),JSON.stringify({...report,root},null,2));console.log(JSON.stringify({version,removal:report.nativeRemoval,connection:report.nativeConnection,branding:report.nativeBranding,composer:report.nativeComposer,images:report.nativeChatImages,odyssey:report.nativeOdyssey,features:report.nativeFeatureDescriptions,productionArchiveUnchanged:true,root}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>{const owned="'"+exe.replaceAll("'","''")+"'";cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "Name='Atlas.exe'" | Where-Object {$_.ExecutablePath -eq ${owned}} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}`],{stdio:'ignore',windowsHide:true});});
