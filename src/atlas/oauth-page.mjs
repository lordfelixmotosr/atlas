// Atlas's local browser callback page. OAuth clients, URLs and state checks
// continue to be supplied by the provider library.
import fs from 'node:fs';
import path from 'node:path';
function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
function logo(){
 try{
  if(!process.env.ATLAS_ROOT)return '';
  const png=fs.readFileSync(path.join(process.env.ATLAS_ROOT,'resources/atlas/icon.png'));
  return '<img class="logo" src="data:image/png;base64,'+png.toString('base64')+'" alt="Atlas stag logo">';
 }catch{return '';}
}
function render(message,details,success){
 const heading=success?'Sign-in complete':'Sign-in could not finish';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Atlas — ${heading}</title><style>
 :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#151517;color:#e8e8ec}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,520px);text-align:center;padding:36px;border:1px solid #33333a;border-radius:18px;background:#1c1c1f}.logo{width:104px;height:104px;object-fit:contain}.name{margin:12px 0 24px;letter-spacing:.12em;font-size:14px;color:#aebbee}h1{font-size:26px;margin:0 0 14px}p{color:#a8a8b0;font-size:15px;line-height:1.6}.details{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;text-align:left;color:#c8afa6}.return{color:#e8e8ec;margin-top:24px}
 </style></head><body><main class="card">${logo()}<div class="name">ATLAS</div><h1>${heading}</h1><p>${escapeHtml(message)}</p>${details?'<pre class="details">'+escapeHtml(details)+'</pre>':''}<p class="return">${success?'Return to Atlas. You can close this browser tab.':'Return to Atlas to retry or choose another sign-in method.'}</p></main></body></html>`;
}
export function oauthSuccessHtml(message){return render(message,undefined,true);}
export function oauthErrorHtml(message,details){return render(message,details,false);}
