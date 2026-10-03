'use strict';
const fs=require('node:fs'),path=require('node:path');
const escape=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function referenceHtml(file){
 const bytes=fs.readFileSync(file),name=escape(path.basename(file)),extension=path.extname(file).toLowerCase();
 const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extension];
 const content=mime?'<img alt="Reference image" src="data:'+mime+';base64,'+bytes.toString('base64')+'">':'<pre>'+escape(bytes.toString('utf8'))+'</pre>';
 return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><title>'+name+' — Atlas</title><style>body{margin:0;background:#121416;color:#ecebe3;font:14px/1.65 system-ui,sans-serif}header{position:sticky;top:0;background:#121416;border-bottom:1px solid #34373c;padding:14px 24px}small{color:#a9b0b8}main{padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 Consolas,monospace}img{max-width:100%;height:auto;background:repeating-conic-gradient(#32343a 0% 25%,#22252a 0% 50%) 0/20px 20px}</style></head><body><header><strong>'+name+'</strong><br><small>Atlas reference · read-only</small></header><main>'+content+'</main></body></html>';
}
function openReference(file,electron,parent,windows){
 const viewer=new electron.BrowserWindow({width:1000,height:760,parent,autoHideMenuBar:true,title:path.basename(file)+' — Atlas',backgroundColor:'#121416',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,javascript:false}});
 windows.add(viewer);viewer.once('closed',()=>windows.delete(viewer));viewer.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 return viewer.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(referenceHtml(file)));
}
module.exports={referenceHtml,openReference};
