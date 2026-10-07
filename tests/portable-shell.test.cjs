const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {transformSync}=createRequire(require.resolve('vite'))('esbuild');
test('guarded shell commands use the bundled executable without a persisted shell setting',{skip:process.platform!=='win32'},async t=>{
 const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'portable-shell-'));
 t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true})});
 const shell=path.resolve(__dirname,'../dist/Atlas-0.1.0-release/tools/git/bin/bash.exe');assert(fs.existsSync(shell),'The public portable runtime is missing');
 const {createBashTool}=await import('@earendil-works/pi-coding-agent');
 const source=transformSync(fs.readFileSync(path.join(__dirname,'../src/agent/tools/bash.ts'),'utf8'),{loader:'ts',format:'cjs'}).code;
 function tool(shellPath){const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,process:{env:{ATLAS_SHELL_PATH:shellPath}},require:name=>name==='@earendil-works/pi-coding-agent'?{createBashTool}:name==='../security/path-policy.js'?{assertCommandAllowed:command=>assert.equal(command,'printf atlas-portable-shell')}:require(name)});return module.exports.createGuardedBashTool(root);}
 await assert.rejects(()=>tool(path.join(root,'missing-bash.exe')).execute('missing',{command:'printf atlas-portable-shell',timeout:10}),/Custom shell path not found/);
 const result=await tool(shell).execute('bundled',{command:'printf atlas-portable-shell',timeout:10});
 assert.match(result.content.map(part=>part.text||'').join('\n'),/atlas-portable-shell/);
});
