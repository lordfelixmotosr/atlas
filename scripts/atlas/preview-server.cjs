'use strict';
// Developer preview: real library engine, public seed packs, synthetic chat only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Library}=require('../../src/atlas/library.cjs');
const base=path.resolve(__dirname,'../../build-check/preview'),profile=path.join(base,'profile'),resources=path.resolve(__dirname,'../../dist/Atlas/resources/atlas');
fs.mkdirSync(profile,{recursive:true});fs.cpSync(path.join(resources,'seed'),path.join(profile,'updates'),{recursive:true});
const library=new Library(profile,resources);
let application={version:'0.1.0',available:null,ready:null,working:false,error:null};
async function api(method,args){
 const methods={atlasLibraryStatus:()=>library.status(),atlasLibraryConfigure:patch=>library.configure(patch),atlasLibraryCheck:()=>library.check(),atlasLibraryUpdate:()=>library.update(),atlasLibrarySearch:query=>library.search(query),atlasLibraryRevert:id=>library.revert(id),atlasLibraryOpenReference:(id,file)=>{library.file(id,file);return null;},atlasLibraryReveal:()=>null,atlasLibraryCustom:()=>null,atlasLibraryChooseSource:()=>null,atlasLibraryRebuild:()=>null,atlasAppStatus:()=>application,atlasAppCheck:()=>application,atlasAppDownload:()=>application,atlasAppInstall:()=>{throw Error('Preview never installs applications.');},openExternal:()=>null};
 if(!Object.hasOwn(methods,method))throw Error('Unknown preview method');return methods[method](...args);
}
(async()=>{await library.seed();const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='POST'&&req.url==='/api'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10000)throw Error('Request too large');}const {method,args}=JSON.parse(raw);const value=await api(method,args);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value,state:library.status()}));return;}
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html',file=path.resolve(base,relative);if(!file.startsWith(base+path.sep)||relative.startsWith('profile')||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'})[ext]??'application/octet-stream');fs.createReadStream(file).pipe(res);
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });server.listen(38768,'127.0.0.1',()=>console.log('Atlas developer preview: http://127.0.0.1:38768'));})();
