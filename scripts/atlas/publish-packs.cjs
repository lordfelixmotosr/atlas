'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validatePack,sha}=require('../../src/atlas/library.cjs');
function sign(value,key,keyId='atlas-local-1'){const payload=Buffer.from(JSON.stringify(value));return Buffer.from(JSON.stringify({format:'atlas-signed-v1',keyId,payload:payload.toString('base64'),signature:crypto.sign(null,payload,key).toString('base64')})+'\n');}
function publish(source,out,keyPath,application){const key=fs.readFileSync(keyPath,'utf8'),issuedAt=Date.now(),expiresAt=issuedAt+90*86400000;fs.mkdirSync(out,{recursive:true});const entries=[];
 for(const id of fs.readdirSync(source).sort()){const dir=path.join(source,id);if(!fs.statSync(dir).isDirectory())continue;const meta=JSON.parse(fs.readFileSync(path.join(dir,'pack.meta.json'),'utf8')),files=[];
 function walk(folder,prefix=''){for(const name of fs.readdirSync(folder).sort()){if(!prefix&&name==='pack.meta.json')continue;const file=path.join(folder,name),rel=prefix+name;if(fs.lstatSync(file).isSymbolicLink())throw new Error('Source pack contains a link.');if(fs.statSync(file).isDirectory())walk(file,rel+'/');else{const bytes=fs.readFileSync(file),binary=/\.(png|jpg|jpeg|webp)$/.test(name);files.push({path:rel,encoding:binary?'base64':'utf8',content:bytes.toString(binary?'base64':'utf8'),sha256:sha(bytes)});}}}walk(dir);
 const pack=validatePack({...meta,type:'pack',issuedAt,expiresAt,files});const bytes=sign(pack,key),file=id+'-'+pack.version+'.atlas.json';fs.writeFileSync(path.join(out,file),bytes);entries.push({id:pack.id,version:pack.version,file,sha256:sha(bytes)});
 }
 const feed={type:'feed',sequence:Date.now(),issuedAt,expiresAt,packs:entries};if(application)feed.application=application;fs.writeFileSync(path.join(out,'index.atlas.json'),sign(feed,key));return feed;
}
if(require.main===module){const[source,out,keyPath,applicationJson]=process.argv.slice(2);if(!source||!out||!keyPath)throw new Error('Usage: node publish-packs.cjs <pack source> <feed output> <private signing key> [application JSON]');const feed=publish(path.resolve(source),path.resolve(out),path.resolve(keyPath),applicationJson?JSON.parse(fs.readFileSync(applicationJson)):undefined);console.log(JSON.stringify({packs:feed.packs.length,sequence:feed.sequence,expiresAt:new Date(feed.expiresAt).toISOString()}));}
module.exports={publish,sign};
