'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
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
function listFiles(root){const files=[];function walk(dir,depth=0){if(depth>24||files.length>10000)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||['bin','obj','node_modules'].includes(entry.name)||entry.isSymbolicLink())continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full,depth+1);else if(entry.isFile())files.push({path:path.relative(root,full).replace(/\\/g,'/'),size:fs.statSync(full).size,editable:textExtensions.has(path.extname(full).toLowerCase())});}}walk(root);return {files,truncated:files.length>10000};}
function readText(root,relative){const full=safePath(root,relative);if(!textExtensions.has(path.extname(full).toLowerCase()))throw new Error('This file is available in its external editor.');if(fs.statSync(full).size>2*1024*1024)throw new Error('Files over 2 MB should be opened in an external editor.');const bytes=fs.readFileSync(full);if(bytes.includes(0))throw new Error('This file contains binary data.');return {path:relative,text:bytes.toString('utf8'),hash:hash(bytes)};}
function saveText(root,relative,text,previousHash){if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw new Error('Text is too large.');const current=readText(root,relative);if(current.hash!==previousHash)throw new Error('This file changed since you opened it. Reload it before saving. Your draft is preserved.');const full=safePath(root,relative),temp=full+'.atlas-'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,text,{flag:'wx'});fs.renameSync(temp,full);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}return readText(root,relative);}
function revealTarget(root,relative=''){let full=safePath(root,relative,true);while(!fs.existsSync(full)&&full!==root)full=path.dirname(full);return {path:full,file:fs.statSync(full).isFile()};}
module.exports={hash,safePath,projectRoot,listFiles,readText,saveText,revealTarget};
