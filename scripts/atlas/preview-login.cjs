'use strict';
// Static visual check only; no credentials, authentication or model requests.
const path=require('node:path'),http=require('node:http');
process.env.ATLAS_ROOT=path.resolve(__dirname,'../../dist/Atlas-0.1.0-release');
(async()=>{
 const {oauthSuccessHtml}=await import('../../src/atlas/oauth-page.mjs');
 const pages={'/openai':oauthSuccessHtml('OpenAI authentication completed. You can close this window.'),'/claude':oauthSuccessHtml('Anthropic authentication completed. You can close this window.')};
 http.createServer((req,res)=>{const page=pages[req.url];if(req.method!=='GET'||!page){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);}).listen(38769,'127.0.0.1',()=>console.log('Static Atlas login page preview: http://127.0.0.1:38769/openai'));
})();
