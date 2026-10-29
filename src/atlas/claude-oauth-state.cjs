'use strict';
// Shared by the bundled host and the external OAuth module. Contains only
// cooldown/diagnostic metadata: never codes, token bodies or account identity.
const fs=require('node:fs'),path=require('node:path');
const LOCAL_BACKOFF_MS=5*60_000;
const safeLabel=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value)?value:undefined;
function retryTime(value,now){
  if(typeof value!=='string'||!value.trim())return null;
  const input=value.trim();
  const time=/^\d+(?:\.\d+)?$/.test(input)?now+Number(input)*1000:Date.parse(input);
  return Number.isFinite(time)&&time>now&&time<=8.64e15?time:null;
}
function clean(value){
  const diagnostic=value?.diagnostic;
  return {
    retryAt:Number.isFinite(value?.retryAt)&&value.retryAt>0&&value.retryAt<=8.64e15?value.retryAt:0,
    retrySource:['provider','local'].includes(value?.retrySource)?value.retrySource:null,
    ...(diagnostic&&Number.isInteger(diagnostic.status)&&diagnostic.status>=100&&diagnostic.status<=599?{diagnostic:{
      status:diagnostic.status,requestId:safeLabel(diagnostic.requestId),errorType:safeLabel(diagnostic.errorType),
      responseKind:['json','html','other'].includes(diagnostic.responseKind)?diagnostic.responseKind:undefined,
      at:Number.isFinite(diagnostic.at)?diagnostic.at:undefined,
    }}:{}),
  };
}
function createOAuthState({now=Date.now,load=()=>null,persist=()=>{}}={}){
  let state;try{state=clean(load());}catch{state=clean(null);}
  const save=()=>{try{persist(clean(state));}catch{/* Keep the in-memory cooldown if disk is temporarily locked. */}};
  return {
    read:()=>clean(state),
    noteResponse(diagnostic){state={...state,diagnostic:clean({diagnostic}).diagnostic};save();},
    rateLimit(retryAfter,diagnostic){const until=retryTime(retryAfter,now());state=clean({retryAt:until??now()+LOCAL_BACKOFF_MS,retrySource:until?'provider':'local',diagnostic});save();return clean(state);},
    clear(){state={...state,retryAt:0,retrySource:null};save();},
  };
}
function cooldownMessage(state){
  const when=new Date(state.retryAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'});
  return state.retrySource==='provider'
    ?`Claude returned HTTP 429 and requested a wait until ${when}. Atlas will not send sign-in or refresh requests before then.`
    :`Claude returned HTTP 429 without a retry time. Atlas is pausing sign-in and refresh attempts until ${when}; this is a local delay, not a confirmed Claude reset time.`;
}
const symbol=Symbol.for('atlas.claude.oauth.cooldown.v1');
function shared(){
  if(!globalThis[symbol]){
    const file=process.env.ATLAS_ROOT?path.join(process.env.ATLAS_ROOT,'data/profile/claude-oauth-status.json'):null;
    globalThis[symbol]=createOAuthState({
      load:()=>file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,
      persist:state=>{
        if(!file)return;
        fs.mkdirSync(path.dirname(file),{recursive:true});
        const temporary=file+'.'+process.pid+'.tmp';
        try{fs.writeFileSync(temporary,JSON.stringify(state,null,2));fs.renameSync(temporary,file);}
        finally{try{fs.unlinkSync(temporary);}catch{}}
      },
    });
  }
  return globalThis[symbol];
}
module.exports={LOCAL_BACKOFF_MS,retryTime,createOAuthState,cooldownMessage,read:()=>shared().read(),noteResponse:value=>shared().noteResponse(value),rateLimit:(after,value)=>shared().rateLimit(after,value),clear:()=>shared().clear()};
