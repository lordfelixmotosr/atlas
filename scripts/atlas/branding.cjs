'use strict';
// Change product text, never serialized IPC channels, sidecars or bridge IDs.
const fs=require('node:fs'),path=require('node:path');
const acorn=require('../../build-tools/node_modules/acorn');
const product=()=>JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../package.json')));
function brandText(text){
 text=text.replaceAll('Atlas supports more than one game. Set one up now — you can add the others any time, and they’ll also set themselves up the first time you make a mod for them.','Choose RimWorld to set it up now. More games can be added to Atlas later.');
 return text.replace(/\bmodmixer\b/gi,(word,at,full)=>{
  const before=full[at-1]??'',after=full.slice(at+word.length);
  if(/[\w./:<@-]/.test(before)||/^(?:[:./@][\w]|-(?:asset|bridge|live|attachments|publish|user|tmp|backups|neoforge)\b)/i.test(after))return word;
  return 'Atlas';
 });
}
function transform(code,type='script'){
 const tree=acorn.parse(code,{ecmaVersion:'latest',sourceType:type}),edits=[];
 function walk(node){
  if(!node||typeof node!=='object')return;
  if(node.type==='CallExpression'&&type==='module'){
   const fragment=code.slice(node.start,node.end);
   if(fragment.startsWith('s.jsxs("p",')&&fragment.includes('https://modmixer.com/docs/choosing-a-provider')){
    edits.push({start:node.start,end:node.end,text:'s.jsx("p",{className:"text-xs text-muted",children:"Connect your preferred provider above. Account and model settings are available in Settings."})'});return;
   }
   if(fragment.startsWith('s.jsxs("label",')&&fragment.includes('https://modmixer.com/leaderboard')){edits.push({start:node.start,end:node.end,text:'null'});return;}
  }
  if(node.type==='Literal'&&typeof node.value==='string'){
   const text=brandText(node.value);if(text!==node.value)edits.push({start:node.start,end:node.end,text:JSON.stringify(text)});
  }else if(node.type==='TemplateElement'){
   const text=brandText(node.value.raw);if(text!==node.value.raw)edits.push({start:node.start,end:node.end,text});
  }
  for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'&&value.type)walk(value);}
 }
 walk(tree);for(const edit of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,edit.start)+edit.text+code.slice(edit.end);
 if(type==='script'){
  code=code.replace('"HTTP-Referer":"https://modmixer.com",','');
  // The fork has no upstream leaderboard registration service.
  const parsed=acorn.parse(code,{ecmaVersion:'latest',sourceType:type});
  const registration=parsed.body.find(n=>n.type==='FunctionDeclaration'&&code.slice(n.start,n.end).includes('fetch(qTe,'));
  if(registration)code=code.slice(0,registration.body.start)+'{return;}'+code.slice(registration.body.end);
  code=code.replace(/\(\)=>"0\.1\.\d+ Atlas portable"/,'()=>'+JSON.stringify(product().version+' Atlas portable'));
 }
 acorn.parse(code,{ecmaVersion:'latest',sourceType:type});return code;
}
function apply(parsed){
 for(const file of parsed.files){
  if(file.name==='.vite/build/main-DYnxlxoB.js')file.bytes=Buffer.from(transform(file.bytes.toString()));
  else if(/\.vite\/renderer\/.*\/assets\/index-.*\.js$/.test(file.name))file.bytes=Buffer.from(transform(file.bytes.toString(),'module'));
  else if(file.name==='package.json'){
   const info=JSON.parse(file.bytes),source=product();
   for(const key of ['name','productName','version','description','author','scripts'])info[key]=source[key];
   file.bytes=Buffer.from(JSON.stringify(info,null,2));
  }
 }
}
function bridge(root){
 const file=path.join(root,'resources/modmixer-bridge/About/About.xml');
 if(fs.existsSync(file)){
  let text=fs.readFileSync(file,'utf8');
  text=text.replace(/<name>.*?<\/name>/,'<name>Atlas Diagnostics Bridge</name>').replace(/<author>.*?<\/author>/,'<author>Felix</author>').replace(/(<description>)([\s\S]*?)(<\/description>)/,(_all,open,body,close)=>open+brandText(body)+close);
  fs.writeFileSync(file,text);
 }
 const callback=path.join(root,'resources/node_modules/@earendil-works/pi-ai/dist/auth/oauth/oauth-page.js');
 if(fs.existsSync(callback))fs.copyFileSync(path.resolve(__dirname,'../../src/atlas/oauth-page.mjs'),callback);
}
module.exports={apply,transform,brandText,bridge};
