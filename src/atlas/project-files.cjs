'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const textExtensions=new Set(['.xml','.cs','.json','.md','.txt','.toml','.yaml','.yml','.cfg','.ini','.props','.csproj','.sln','.shader','.hlsl']);
function safePath(root,relative='',allowRoot=false){
 if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)||relative.includes(':'))throw new Error('Choose a relative project path.');
 const parts=relative.replace(/\\/g,'/').split('/');if(parts.some(p=>p==='..'||p==='.'||p.startsWith('.git')||p.endsWith('.')||p.endsWith(' ')))throw new Error('Invalid project path.');
 const resolved=path.resolve(root,...parts),base=path.resolve(root);if((resolved===base&&!allowRoot)||!resolved.startsWith(base+path.sep)&&resolved!==base)throw new Error('Path escapes this project.');
 let current=base;if(fs.lstatSync(base).isSymbolicLink())throw new Error('Linked project roots are not supported in this editor.');
 for(const part of parts.filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('Linked paths cannot be edited.');}
 return resolved;
}
function projectRoot(workspace,folder){if(typeof folder!=='string'||!folder||/[\\/:]/.test(folder)||folder==='..'||folder==='.')throw new Error('Invalid project.');const root=safePath(workspace,folder);if(!fs.statSync(root).isDirectory())throw new Error('Project not found.');return root;}
async function listFiles(root){
 safePath(root,'',true);const files=[];let truncated=false;
 async function walk(dir,depth=0){
  if(depth>24){truncated=true;return;}
  const entries=await fsp.opendir(dir);
  for await(const entry of entries){
   if(entry.name.startsWith('.')||['bin','obj','node_modules'].includes(entry.name)||entry.isSymbolicLink())continue;
   if(files.length>=10000){truncated=true;return;}
   const full=path.join(dir,entry.name);
   if(entry.isDirectory()){await walk(full,depth+1);if(truncated&&files.length>=10000)return;}
   // The browser only needs names and editability; reads validate size on demand.
   else if(entry.isFile())files.push({path:path.relative(root,full).replace(/\\/g,'/'),editable:textExtensions.has(path.extname(full).toLowerCase())});
  }
 }
 await walk(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return {files,truncated};
}
function readText(root,relative){const full=safePath(root,relative);if(!textExtensions.has(path.extname(full).toLowerCase()))throw new Error('This file is available in its external editor.');if(fs.statSync(full).size>2*1024*1024)throw new Error('Files over 2 MB should be opened in an external editor.');const bytes=fs.readFileSync(full);if(bytes.includes(0))throw new Error('This file contains binary data.');return {path:relative,text:bytes.toString('utf8'),hash:hash(bytes)};}
function saveText(root,relative,text,previousHash){if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw new Error('Text is too large.');const current=readText(root,relative);if(current.hash!==previousHash)throw new Error('This file changed since you opened it. Reload it before saving. Your draft is preserved.');const full=safePath(root,relative),temp=full+'.atlas-'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,text,{flag:'wx'});fs.renameSync(temp,full);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}return readText(root,relative);}
function revealTarget(root,relative=''){let full=safePath(root,relative,true);while(!fs.existsSync(full)&&full!==root)full=path.dirname(full);return {path:full,file:fs.statSync(full).isFile()};}
async function searchText(root,query,options={}){
 if(typeof query!=='string'||query.length>300)throw new Error('Search text must be between 2 and 300 characters.');
 if(query.trim().length<2)return {matches:[],truncated:false,scanned:0,skipped:0};
 const needle=options.caseSensitive===true?query:query.toLowerCase(),{files,truncated:listTruncated}=await listFiles(root);
 const matches=[];let scanned=0,skipped=0,total=0,truncated=listTruncated;
 for(const file of files){
  if(options.signal?.aborted)throw new Error('Search cancelled.');
  if(!file.editable)continue;
  const full=safePath(root,file.path);
  try{
   const stat=await fsp.stat(full);if(stat.size>2*1024*1024){skipped++;continue;}
   if(total+stat.size>64*1024*1024){truncated=true;break;}
   const bytes=await fsp.readFile(full);total+=bytes.length;
   if(bytes.length>2*1024*1024||bytes.includes(0)){skipped++;continue;}
   scanned++;const lines=bytes.toString('utf8').split(/\r?\n/);
   for(let i=0;i<lines.length;i++){
    const column=(options.caseSensitive===true?lines[i]:lines[i].toLowerCase()).indexOf(needle);
    if(column<0)continue;
    const start=Math.max(0,column-55);matches.push({path:file.path,line:i+1,column:column+1,excerpt:(start?'…':'')+lines[i].slice(start,start+220)});
    if(matches.length>=200){truncated=true;break;}
   }
   if(matches.length>=200)break;
  }catch(error){if(error.code==='ENOENT'){skipped++;continue;}throw error;}
 }
 return {matches,truncated,scanned,skipped};
}
module.exports={hash,safePath,projectRoot,listFiles,readText,saveText,revealTarget,searchText};
