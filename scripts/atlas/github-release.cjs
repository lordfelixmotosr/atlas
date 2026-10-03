'use strict';
// GitHub publishing uses an existing Git credential in memory; never prints or saves it.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const repository='lordfelixmotosr/atlas';
let credential;
function auth(){
 if(credential!==undefined)return credential;
 try{const raw=cp.execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\npath='+repository+'.git\n\n',encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'},stdio:['pipe','pipe','pipe'],windowsHide:true});credential=raw.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9)||'';}catch{credential='';}
 return credential;
}
async function api(endpoint,options={}){
 const url=new URL(endpoint.startsWith('https:')?endpoint:'https://api.github.com/repos/'+repository+endpoint);
 if(url.protocol!=='https:'||!['api.github.com','uploads.github.com'].includes(url.hostname))throw new Error('Unexpected GitHub API destination.');
 const token=auth(),headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{}),...options.headers};
 const response=await fetch(url,{...options,headers,redirect:'error',signal:AbortSignal.timeout(1800000)});
 if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error('GitHub '+response.status+': '+(error.message||'Request failed.'));}
 return response.status===204?null:response.json();
}
async function main(){
 const mode=process.argv[2],root=path.resolve(__dirname,'../..'),version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
 if(mode==='inspect'){const repo=await api('');console.log(JSON.stringify({repository:repo.full_name,private:repo.private,defaultBranch:repo.default_branch,authenticated:!!credential,push:repo.permissions?.push??null},null,2));return;}
 if(mode!=='publish')throw new Error('Use inspect or publish.');
 const repo=await api('');if(repo.private)throw new Error('The release feed requires a public repository; no visibility changes were made.');if(!auth())throw new Error('GitHub sign-in is required to publish.');
 const out=path.resolve(root,'../outputs'),checks=JSON.parse(fs.readFileSync(path.join(out,'Atlas-'+version+'-checksums.json'))),feed=path.join(out,'Atlas-update-feed');
 const body=fs.readFileSync(path.join(root,'build-check/github-release-notes.md'),'utf8');
 let release;try{release=await api('/releases/tags/v'+version);}catch(error){if(!String(error.message).includes('GitHub 404:'))throw error;}
 if(!release)release=await api('/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:'v'+version,target_commitish:repo.default_branch,name:'Atlas '+version+' — Felix',body,draft:true,prerelease:false})});
 if(!release.draft)throw new Error('This release is already public. Do not overwrite published assets.');
 const existing=await api('/releases/'+release.id+'/assets');
 const files=[path.resolve(out,checks.portable.path),path.resolve(out,checks['application-update'].path),path.join(out,'Atlas-'+version+'-checksums.json'),path.join(out,'Atlas-'+version+'-UPDATE.txt'),...fs.readdirSync(feed).filter(file=>file.endsWith('.atlas.json')).map(file=>path.join(feed,file))];
 for(const file of files){const name=path.basename(file),old=existing.find(asset=>asset.name===name);if(old){
  const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);
  if(old.digest!=='sha256:'+digest.digest('hex')||old.size!==fs.statSync(file).size)throw new Error('Draft asset differs or has no verified checksum: '+name);
  console.log('Draft asset checksum matches: '+name);continue;
 }
  const url=release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(name),stream=fs.createReadStream(file);
  await api(url,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(fs.statSync(file).size)},body:stream,duplex:'half'});console.log('Uploaded '+name);
 }
 const published=await api('/releases/'+release.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})});console.log('Published '+published.html_url);
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
