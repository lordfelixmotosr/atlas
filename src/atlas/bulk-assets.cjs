'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {safePath,hash}=require('./project-files.cjs');
function signature(file){return fs.existsSync(file)?hash(fs.readFileSync(file)):null;}
function planAssets(root,sourceRoot,paths,requirements){
 if(!Array.isArray(paths)||!paths.length||paths.length>1000)throw new Error('Select 1–1,000 assets.');
 const known=new Set(requirements.map(r=>r.path.toLowerCase())),rows=[];
 for(const relative of [...new Set(paths)]){
  if(!known.has(relative.toLowerCase())||!/^Textures\/.+\.png$|^Sounds\/.+\.ogg$|^About\/[^/]+\.png$/i.test(relative.replace(/\\/g,'/')))throw new Error('Only scanned asset paths can be replaced in bulk.');
  const target=safePath(root,relative),source=safePath(sourceRoot,relative);const exists=fs.existsSync(source);let issue=exists?'':'Missing in selected folder';
  if(exists){const stat=fs.statSync(source);if(!stat.isFile()||stat.size>32*1024*1024)issue='File must be under 32 MB';else{const b=fs.readFileSync(source);if(relative.toLowerCase().endsWith('.png')&&!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))issue='Invalid PNG';if(relative.toLowerCase().endsWith('.ogg')&&b.subarray(0,4).toString()!=='OggS')issue='Invalid OGG';}}
  rows.push({path:relative,action:fs.existsSync(target)?'Replace':'Add',references:requirements.filter(r=>r.path.toLowerCase()===relative.toLowerCase()).length,issue,targetHash:signature(target),sourceHash:exists&&!issue?signature(source):null});
 }
 return {root,sourceRoot,rows,createdAt:Date.now()};
}
function applyAssets(plan,backupRoot){
 if(Date.now()-plan.createdAt>10*60*1000)throw new Error('Preview expired. Preview this batch again.');const rows=plan.rows.filter(r=>!r.issue);if(!rows.length)throw new Error('There are no matching files to replace.');
 for(const row of rows){if(signature(safePath(plan.root,row.path))!==row.targetHash||signature(safePath(plan.sourceRoot,row.path))!==row.sourceHash)throw new Error('Files changed after the preview. Preview this batch again.');}
 const backup=path.join(backupRoot,'asset-batch-'+crypto.randomUUID());fs.mkdirSync(backup,{recursive:true});const changed=[];
 try{for(const row of rows){const target=safePath(plan.root,row.path),source=safePath(plan.sourceRoot,row.path),saved=safePath(backup,row.path);if(fs.existsSync(target)){fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(target,saved);}fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.atlas-'+crypto.randomUUID()+'.tmp';try{fs.copyFileSync(source,temp,fs.constants.COPYFILE_EXCL);changed.push(row);fs.renameSync(temp,target);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}}
 catch(error){for(const row of changed){const target=safePath(plan.root,row.path),saved=safePath(backup,row.path);if(row.targetHash===null){if(fs.existsSync(target))fs.unlinkSync(target);}else fs.copyFileSync(saved,target);}throw error;}
 fs.writeFileSync(path.join(backup,'batch.json'),JSON.stringify({paths:rows.map(r=>r.path),createdAt:new Date().toISOString()},null,2));return {count:rows.length,backup};
}
module.exports={planAssets,applyAssets};
