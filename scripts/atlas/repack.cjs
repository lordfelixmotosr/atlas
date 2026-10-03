'use strict';
// Refresh Atlas overlay code without recopying the verified public runtimes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const asar=require('./asar.cjs');
const branding=require('./branding.cjs');
const root=path.resolve(__dirname,'../..'),output=path.resolve(process.argv[2]??path.join(root,'dist/Atlas'));
assert(output.startsWith(root+path.sep));
const archivePath=path.join(output,'resources/app.asar'),exePath=path.join(output,'Atlas.exe');
const original=fs.readFileSync(archivePath),parsed=asar.read(original);
branding.apply(parsed);branding.bridge(output);
for(const name of ['bootstrap.cjs','runtime.cjs','library.cjs','application-update.cjs','reference-view.cjs']){
 const id='.vite/build/atlas/'+name,bytes=fs.readFileSync(path.join(root,'src/atlas',name)),entry=parsed.files.find(file=>file.name===id);
 if(entry)entry.bytes=bytes;else asar.add(parsed,id,bytes);
}
const main=parsed.files.find(file=>file.name==='.vite/build/main-DYnxlxoB.js');
const verifyId='.vite/build/atlas/verify.cjs',prefix='require("./atlas/verify.cjs").init();';
main.bytes=Buffer.from(main.bytes.toString().replace(prefix,''));
const oldVerify=parsed.files.find(file=>file.name===verifyId);
if(oldVerify){parsed.files=parsed.files.filter(file=>file!==oldVerify);delete parsed.header.files['.vite'].files.build.files.atlas.files['verify.cjs'];}
if(process.argv.includes('--verify-build')){
 main.bytes=Buffer.from(prefix+main.bytes.toString().replace('sae(),nB()','process.argv.includes("--atlas-verify")?void 0:(sae(),nB())'));
 asar.add(parsed,verifyId,fs.readFileSync(path.join(__dirname,'verify.cjs')));
}else{
 main.bytes=Buffer.from(main.bytes.toString().replace('process.argv.includes("--atlas-verify")?void 0:(sae(),nB())','sae(),nB()'));
}
cp.execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'set-icon.ps1'),'-ExePath',exePath,'-IconPath',path.join(output,'resources/atlas/Atlas.ico')],{stdio:'inherit',windowsHide:true});
const archive=asar.write(parsed),exe=asar.patchExe(fs.readFileSync(exePath),asar.sha(asar.read(original).raw),asar.sha(asar.read(archive).raw));
fs.writeFileSync(archivePath,archive);fs.writeFileSync(exePath,exe);
fs.copyFileSync(path.join(root,'src/atlas/apply-update.ps1'),path.join(output,'resources/atlas/apply-update.ps1'));
fs.copyFileSync(path.join(root,'README-ATLAS.md'),path.join(output,'README-ATLAS.md'));
const metadata=JSON.parse(fs.readFileSync(path.join(output,'atlas-build.json')));metadata.version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;metadata.archiveSha256=asar.sha(archive);metadata.exeSha256=asar.sha(exe);fs.writeFileSync(path.join(output,'atlas-build.json'),JSON.stringify(metadata,null,2)+'\n');
console.log('Atlas overlay repacked; ASAR integrity retained.');
