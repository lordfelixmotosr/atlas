// Run after npm run build:atlas:source; isolated UI only, no user profile or Steam.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),asar=require('./asar.cjs');
process.chdir(path.resolve(__dirname,'../..'));
const version=JSON.parse(fs.readFileSync('package.json')).version;
const {buildSync}=createRequire(require.resolve('vite'))('esbuild');
const base=path.resolve('dist/Atlas-'+version),root=path.resolve('build-check/redesign-electron');
fs.mkdirSync(path.join(root,'resources'),{recursive:true});
for(const e of fs.readdirSync(base,{withFileTypes:true}))if(e.isFile()&&e.name!=='Atlas.exe')fs.copyFileSync(path.join(base,e.name),path.join(root,e.name));
fs.cpSync(path.join(base,'locales'),path.join(root,'locales'),{recursive:true});
const original=fs.readFileSync(path.join(base,'resources/app.asar')),parsed={header:{files:{}},files:[]};
asar.add(parsed,'package.json',Buffer.from(JSON.stringify({name:'atlas-redesign-fixture',version:'0.0.0',main:'main.cjs'})));
asar.add(parsed,'main.cjs',fs.readFileSync('tests/redesign-native.cjs'));
const archive=asar.write(parsed);fs.writeFileSync(path.join(root,'resources/app.asar'),archive);
fs.writeFileSync(path.join(root,'Atlas.exe'),asar.patchExe(fs.readFileSync(path.join(base,'Atlas.exe')),asar.sha(asar.read(original).raw),asar.sha(asar.read(archive).raw)));
buildSync({entryPoints:['tests/redesign-fixture.tsx'],outfile:'build-check/redesign-ui.js',bundle:true,format:'iife',platform:'browser',jsx:'automatic',loader:{'.png':'dataurl'},alias:{'@':path.resolve('src')},define:{'import.meta.env.DEV':'false','process.env.NODE_ENV':'"production"'}});
const assets='build-check/native/renderer/main_window/assets';
fs.writeFileSync('build-check/redesign-ui.css',Buffer.concat(fs.readdirSync(assets).filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(assets,n)))));
for(const n of fs.readdirSync(assets).filter(n=>/\.woff2?$/.test(n)))fs.copyFileSync(path.join(assets,n),path.join('build-check',n));
fs.writeFileSync('build-check/redesign-ui.html','<!doctype html><html data-theme="dark"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="redesign-ui.css"><title>Atlas update notes preview verification</title><div id="root"></div><script src="redesign-ui.js"></script></html>');
console.log('Built isolated native dialog fixture with production CSS.');

const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const run=require('node:child_process').spawnSync(path.join(root,'Atlas.exe'),[],{env,windowsHide:true,timeout:120000,encoding:'utf8'});
if(run.error||run.status!==0)throw new Error(run.error?.message||(fs.existsSync(path.join(root,'error.txt'))?fs.readFileSync(path.join(root,'error.txt'),'utf8'):'Fixture failed'));
console.log(fs.readFileSync(path.join(root,'result.json'),'utf8'));
