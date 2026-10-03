// @ts-nocheck
import * as v from 'react';import * as s from 'react/jsx-runtime';import {appAlert as kn} from '../components/app-dialog';import {setPanelDraft,getPanelSnapshot} from '../conversations-store';
function felixSupportsFast(model) {
  return model?.provider === "openai-codex" && ["gpt-6-astra","gpt-6-sol","gpt-6-luna","gpt-6.1-sol","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.4"].includes(model.id ?? model.modelId);
}
function FelixSpeedControl({model}) {
  const [mode, setMode] = v.useState("standard");
  const [ready, setReady] = v.useState(false);
  const [saving, setSaving] = v.useState(false);
  v.useEffect(() => {
    let active = true, receivedUpdate = false;
    const unsubscribe = window.modmixer.onOpenAISpeedChanged(value => {
      if (active) { receivedUpdate = true; setMode(value === "fast" ? "fast" : "standard"); }
    });
    window.modmixer.getSettings().then(settings => {
      if (active) { if (!receivedUpdate) setMode(settings.openaiSpeed === "fast" ? "fast" : "standard"); setReady(true); }
    }).catch(() => { if (active) kn("Could not load the GPT speed setting."); });
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!felixSupportsFast(model)) return null;
  async function change(event) {
    const value = event.target.value;
    setSaving(true);
    try {
      const settings = await window.modmixer.setOpenAISpeed(value);
      setMode(settings.openaiSpeed === "fast" ? "fast" : "standard");
    } catch (error) { kn(error instanceof Error ? error.message : "Could not save the speed setting."); }
    finally { setSaving(false); }
  }
  return s.jsxs("label", {
    className: "relative inline-flex items-center",
    title: "GPT speed for all chats. Fast uses more usage. Applies from the next request; availability depends on your account.",
    children: [
      s.jsx("span", {className:"sr-only", children:"GPT speed for all chats"}),
      s.jsxs("select", {
        "aria-label":"GPT speed for all chats",
        value:mode, onChange:change, disabled:!ready || saving,
        className:"appearance-none rounded-md border border-line bg-paper px-2.5 py-1 pr-7 font-mono text-[11px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 focus:outline-none focus:border-accent disabled:opacity-40",
        children:[
          s.jsx("option", {value:"standard", children:"Speed: Standard"}),
          s.jsx("option", {value:"fast", children:"Speed: Fast (more usage)"}),
        ],
      }),
      s.jsx("svg", {"aria-hidden":true,className:"pointer-events-none absolute right-2 h-3 w-3 text-muted",viewBox:"0 0 12 12",fill:"none",stroke:"currentColor",strokeWidth:"1.5",children:s.jsx("path",{d:"M3 5l3 3 3-3"})}),
    ],
  });
}


function felixUsageView(usage, model, now = Date.now()) {
  const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelKey = normalize(model?.modelId ?? model?.id);
  const buckets = usage?.buckets || [];
  const bucket = buckets.find(entry => normalize(entry.id) === modelKey || normalize(entry.name) === modelKey) || buckets.find(entry => entry.id === "codex") || null;
  function windowLabel(window, fallback) {
    const minutes = window.windowMinutes;
    if (minutes === 10080) return "Week";
    if (minutes === 1440) return "Day";
    if (minutes && minutes % 60 === 0 && minutes < 1440) return minutes / 60 + "h";
    if (minutes && minutes < 60) return Math.round(minutes) + "m";
    if (minutes && minutes % 1440 === 0) return minutes / 1440 + "d";
    return fallback;
  }
  const windows = bucket ? [[bucket.primary,"Session"],[bucket.secondary,"Long-term"]].filter(entry=>entry[0]).map(([window,fallback])=>({
    label:windowLabel(window,fallback),
    remaining:window.resetsAt && now >= window.resetsAt * 1000 ? null : Math.max(0,Math.min(100,100-window.usedPercent)),
    resetsAt:window.resetsAt,
  })) : [];
  let text;
  if (windows.length) text = windows.map(window=>window.label + " left " + (window.remaining === null ? "—" : Math.round(window.remaining) + "%")).join(" · ");
  else if (usage?.credits) text = usage.credits.unlimited ? "Credits: unlimited" : "Credits: " + usage.credits.balance.toLocaleString();
  else text = usage?.status === "loading" ? "Usage: loading…" : usage?.status === "disconnected" ? "Usage: sign in" : "Usage unavailable";
  if (usage?.status === "stale" && (windows.length || usage?.credits)) text += " (stale)";
  const title = [bucket?.name || "ChatGPT plan usage",...windows.map(window=>window.label + ": " + (window.remaining === null ? "reset time passed; refresh for current usage" : Math.round(window.remaining) + "% remaining") + (window.resetsAt ? "; resets " + new Date(window.resetsAt*1000).toLocaleString() : ""))];
  if (usage?.updatedAt) title.push("Last updated " + new Date(usage.updatedAt).toLocaleTimeString());
  if (usage?.status === "stale") title.push("Refresh failed. Showing the last known usage.");
  title.push("Shared with other apps using this ChatGPT account. Refreshes every minute. Click to refresh.");
  return {text,title:title.join("\n"),low:windows.some(window=>window.remaining !== null && window.remaining <= 10)};
}
function FelixUsageControl({model}) {
  const enabled = model?.provider === "openai-codex";
  const [usage,setUsage] = v.useState({status:"loading",buckets:[],credits:null});
  const [refreshing,setRefreshing] = v.useState(false);
  const refreshRef = v.useRef(()=>{});
  v.useEffect(()=>{
    if (!enabled) return;
    let active = true, requestId = 0;
    async function refresh(force=false) {
      const request = ++requestId;
      setRefreshing(true);
      try { const value = await window.modmixer.getOpenAIUsage(force); if(active && request === requestId) setUsage(value); }
      catch { if(active && request === requestId) setUsage(previous=>previous.updatedAt ? {...previous,status:"stale"} : {status:"unavailable",buckets:[],credits:null}); }
      finally { if(active && request === requestId) setRefreshing(false); }
    }
    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(()=>{if(!document.hidden) refresh();},60000);
    const visible = ()=>{if(!document.hidden) refresh();};
    document.addEventListener("visibilitychange",visible);
    const unsubscribe = window.modmixer.onOAuthEvent(event=>{
      if ((event.providerId === "openai-codex" && ["login-success","logout"].includes(event.type)) || event.type === "links-changed") {
        setUsage({status:"loading",buckets:[],credits:null});refresh(true);
      }
    });
    return ()=>{active=false;clearInterval(timer);document.removeEventListener("visibilitychange",visible);unsubscribe();refreshRef.current=()=>{};};
  },[enabled]);
  if (!enabled) return null;
  const view = felixUsageView(usage,model);
  return s.jsx("button",{type:"button",onClick:()=>refreshRef.current(true),disabled:refreshing,
    title:view.title,"aria-label":"ChatGPT usage: " + view.text,"aria-busy":refreshing,
    className:"ml-1 rounded px-1 py-1 font-mono text-[11px] transition-colors hover:text-ink disabled:opacity-60 " + (view.low ? "text-failed" : "text-subtle"),
    children:view.text});
}


function felixUseOpenAIAccounts(enabled=true){
  const [info,setInfo]=v.useState(null),[error,setError]=v.useState(""),[working,setWorking]=v.useState(false),[notice,setNotice]=v.useState("");
  const refreshRef=v.useRef(()=>{});
  v.useEffect(()=>{
    if(!enabled)return;
    let active=true,revision=0;
    async function refresh(){const request=++revision;try{const data=await window.modmixer.getOpenAIAccounts();if(active&&request===revision){setInfo(data);setError(previous=>previous==="Could not load saved OpenAI accounts."?"":previous);}}catch{if(active&&request===revision)setError("Could not load saved OpenAI accounts.");}}
    refreshRef.current=refresh;refresh();
    const unsubscribe=window.modmixer.onOAuthEvent(event=>{
      if(event.type==="accounts-changed"||event.type==="links-changed"||event.providerId==="openai-codex"&&["login-start","login-success","login-error","login-cancelled","logout"].includes(event.type)){
        if(event.type==="links-changed")setError("");
        if(event.type==="accounts-changed"&&event.message)setNotice(event.message);refresh();
      }
    });
    return ()=>{active=false;revision++;unsubscribe();refreshRef.current=()=>{};};
  },[enabled]);
  async function run(operation){setWorking(true);setError("");setNotice("");try{const data=await operation();setInfo(data);return true;}catch(reason){setError(reason instanceof Error?reason.message:String(reason));return false;}finally{setWorking(false);refreshRef.current();}}
  return {info,error,notice,working,run};
}
function FelixAccountControl({model,onConnect,busy=false}){
  const enabled=model?.provider==="openai-codex",state=felixUseOpenAIAccounts(enabled);
  if(!enabled)return null;
  const info=state.info,blocked=state.working||info?.busy||busy;
  return s.jsxs("div",{className:"felix-account-control",children:[
    s.jsx("select",{"aria-label":"OpenAI account",className:"felix-select felix-account-select",value:info?.activeId??"",disabled:blocked||!info,
      title:blocked?"Finish or stop OpenAI work before switching accounts.":"Select the OpenAI account used by all GPT chats.",
      onChange:event=>{const id=event.target.value;if(id==="manage"){onConnect?.();return;}void state.run(()=>window.modmixer.switchOpenAIAccount(id));},
      children:[!info?.accounts.length&&s.jsx("option",{value:"",children:info?"Account: sign in":"Account: loading…"}),...(info?.accounts??[]).map(item=>s.jsx("option",{value:item.id,children:"Account: "+item.label},item.id)),s.jsx("option",{value:"manage",children:"Manage accounts…"})]}),
    state.error&&s.jsx("span",{className:"felix-account-error",role:"alert",children:state.error})
  ]});
}
function FelixAccountCard({account,blocked,onSwitch,onRename,onReconnect,onRemove}){
  const [label,setLabel]=v.useState(account.label),[editing,setEditing]=v.useState(false);
  v.useEffect(()=>{setLabel(account.label);},[account.label]);
  return s.jsxs("div",{className:"felix-account-card",children:[
    s.jsxs("div",{className:"felix-account-card-heading",children:[
      editing?s.jsxs("form",{className:"felix-account-name-form",onSubmit:async event=>{event.preventDefault();if(await onRename(label))setEditing(false);},children:[
        s.jsx("input",{"aria-label":"Account name",value:label,maxLength:40,onChange:event=>setLabel(event.target.value),className:"felix-account-name",autoFocus:true}),
        s.jsx("button",{type:"submit",disabled:blocked||!label.trim(),className:"felix-account-button",children:"Save"}),
        s.jsx("button",{type:"button",onClick:()=>{setLabel(account.label);setEditing(false);},className:"felix-account-button",children:"Cancel"})
      ]}):s.jsxs("div",{className:"felix-account-label",children:[s.jsx("strong",{children:account.label}),s.jsx("button",{type:"button",disabled:blocked,onClick:()=>setEditing(true),className:"felix-account-rename",title:"Rename "+account.label,"aria-label":"Rename "+account.label,children:"Rename"})]}),
      account.active?s.jsx("span",{className:"felix-account-active",children:"Active"}):s.jsx("button",{type:"button",disabled:blocked,onClick:onSwitch,className:"felix-account-button felix-account-use","aria-label":"Use "+account.label,children:"Use account"})
    ]}),
    s.jsxs("div",{className:"felix-account-card-actions",children:[
      s.jsx("button",{type:"button",disabled:blocked,onClick:onReconnect,className:"felix-account-button","aria-label":"Sign in again to "+account.label,children:"Sign in again"}),
      s.jsx("button",{type:"button",disabled:blocked,onClick:onRemove,className:"felix-account-button","aria-label":"Remove "+account.label,title:account.active?"Sign out of this account. The other saved account becomes active.":"Remove this saved sign-in.",children:"Remove"})
    ]})
  ]});
}
function FelixOpenAIAccounts({busy,progress,prompt,onCancel}){
  const state=felixUseOpenAIAccounts(),[code,setCode]=v.useState("");
  v.useEffect(()=>{if(!prompt)setCode("");},[prompt]);
  const info=state.info,blocked=state.working||info?.busy||busy;
  const submit=()=>{if(code.trim())window.modmixer.provideOAuthCode("openai-codex",code);};
  return s.jsxs("section",{className:"felix-account-manager","aria-label":"OpenAI accounts",children:[
    s.jsxs("div",{className:"felix-account-manager-heading",children:[s.jsx("h3",{children:"OpenAI / ChatGPT"}),s.jsx("span",{children:(info?.accounts.length??0)+" of 2 accounts"})]}),
    s.jsx("p",{className:"felix-account-description",children:"Keep two sign-ins saved and choose which account all GPT chats use. Sign-ins are encrypted on this computer."}),
    state.error&&s.jsx("p",{className:"felix-account-error",role:"alert",children:state.error}),
    state.notice&&s.jsx("p",{className:"felix-account-description",role:"status",children:state.notice}),
    !info&&!state.error&&s.jsx("p",{className:"felix-account-description",children:"Loading accounts…"}),
    s.jsx("div",{className:"felix-account-cards",children:(info?.accounts??[]).map(account=>s.jsx(FelixAccountCard,{account,blocked,
      onSwitch:()=>state.run(()=>window.modmixer.switchOpenAIAccount(account.id)),
      onRename:label=>state.run(()=>window.modmixer.renameOpenAIAccount(account.id,label)),
      onReconnect:()=>state.run(()=>window.modmixer.loginOpenAIAccount(account.id)),
      onRemove:()=>state.run(()=>window.modmixer.removeOpenAIAccount(account.id))},account.id))}),
    info&&info.accounts.length<2&&s.jsx("button",{type:"button",disabled:blocked,onClick:()=>state.run(()=>window.modmixer.loginOpenAIAccount()),className:"felix-account-button felix-account-use",children:info.accounts.length?"Add second account":"Sign in to OpenAI"}),
    (busy||info?.pendingLogin)&&s.jsxs("div",{className:"felix-account-login",children:[
      s.jsx("p",{children:progress?.message??"Complete sign-in in your browser."}),
      s.jsx("p",{className:"felix-account-description",children:"To add another account, choose a different OpenAI account in the browser sign-in page."}),
      progress?.instructions&&s.jsx("p",{className:"felix-account-description",children:progress.instructions}),
      prompt&&s.jsxs("div",{className:"felix-account-code",children:[s.jsx("input",{"aria-label":"OpenAI authorization code",value:code,onChange:event=>setCode(event.target.value),onKeyDown:event=>{if(event.key==="Enter")submit();},placeholder:prompt.placeholder??"Authorization code",className:"felix-account-name"}),s.jsx("button",{type:"button",disabled:!code.trim(),onClick:submit,className:"felix-account-button",children:"Submit"})]}),
      s.jsx("button",{type:"button",onClick:onCancel,className:"felix-account-button",children:"Cancel sign-in"})
    ]}),
    info?.busy&&!info.pendingLogin&&!busy&&s.jsx("p",{className:"felix-account-description",children:"Finish or stop OpenAI work before changing sign-ins."})
  ]});
}


const felixRendererActivity=new Map();
function felixObserveRenderer(id,event){
  const old=felixRendererActivity.get(id)??{revision:0};
  felixRendererActivity.set(id,{revision:old.revision+1});
}
function felixInsertSentence(id,text,onSelectChat){
  if(!text.trim())return;
  const draft=getPanelSnapshot(id).draft;
  setPanelDraft(id,draft+(!draft||draft.endsWith("\n")?"":"\n")+text);
  onSelectChat?.();
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent("felix:focus-composer",{detail:id}))));
}
function felixUseComposerFocus(id){
  const ref=v.useRef(null);
  v.useEffect(()=>{const focus=event=>{if(event.detail===id&&ref.current){ref.current.focus();const end=ref.current.value.length;ref.current.setSelectionRange(end,end);}};window.addEventListener("felix:focus-composer",focus);return()=>window.removeEventListener("felix:focus-composer",focus);},[id]);
  return ref;
}
function FelixSentenceShortcut({conversationId,onSelectChat=undefined}){
  const [shortcut,setShortcut]=v.useState(null),[editing,setEditing]=v.useState(false),[label,setLabel]=v.useState("Insert shortcut"),[text,setText]=v.useState(""),[saving,setSaving]=v.useState(false),[error,setError]=v.useState("");
  const dialog=v.useRef(null),trigger=v.useRef(null);
  v.useEffect(()=>{let cancelled=false;const off=window.modmixer.onSentenceShortcutChanged(value=>{if(!cancelled)setShortcut(value);});window.modmixer.getSettings().then(settings=>{if(!cancelled)setShortcut(settings.sentenceShortcut??{label:"Insert shortcut",text:""});}).catch(()=>{if(!cancelled)setError("Could not load your shortcut.");});return()=>{cancelled=true;off();};},[]);
  const close=()=>{if(!saving){setEditing(false);setError("");requestAnimationFrame(()=>trigger.current?.focus());}};
  const edit=()=>{setLabel(shortcut?.label??"Insert shortcut");setText(shortcut?.text??"");setError("");setEditing(true);};
  v.useEffect(()=>{if(!editing)return;dialog.current?.showModal();return()=>dialog.current?.close();},[editing]);
  const save=async event=>{event.preventDefault();setSaving(true);setError("");try{const settings=await window.modmixer.setSentenceShortcut({label,text});setShortcut(settings.sentenceShortcut);setEditing(false);requestAnimationFrame(()=>trigger.current?.focus());}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
  return s.jsxs("div",{className:"felix-shortcut",children:[
    s.jsx("button",{ref:trigger,type:"button",disabled:!shortcut,onClick:()=>shortcut?.text.trim()?felixInsertSentence(conversationId,shortcut.text,onSelectChat):edit(),title:shortcut?.text.trim()?"Insert saved text into this chat (does not send)":"Save a sentence to insert into your chat",className:"felix-shortcut-insert",children:shortcut?.text.trim()?shortcut.label:"Add shortcut"}),
    shortcut?.text.trim()&&s.jsx("button",{type:"button",onClick:edit,"aria-label":"Edit sentence shortcut",title:"Edit sentence shortcut",className:"felix-shortcut-edit",children:s.jsx("svg",{"aria-hidden":true,width:14,height:14,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.8,children:s.jsx("path",{d:"m16 3 5 5-12 12-6 1 1-6L16 3zM14 5l5 5"})})}),
    error&&!editing&&s.jsx("span",{role:"alert",className:"felix-shortcut-error",children:error}),
    editing&&s.jsx("dialog",{ref:dialog,className:"felix-shortcut-dialog","aria-labelledby":"felix-shortcut-title",onCancel:event=>{event.preventDefault();close();},children:s.jsxs("form",{onSubmit:save,children:[
      s.jsx("h2",{id:"felix-shortcut-title",children:"Sentence shortcut"}),
      s.jsx("p",{children:"Save text you use often. The button adds it to the end of your chat draft, ready to review and send."}),
      s.jsx("label",{htmlFor:"felix-shortcut-label",children:"Button label"}),s.jsx("input",{id:"felix-shortcut-label",value:label,onChange:event=>setLabel(event.target.value),maxLength:40,autoFocus:true,disabled:saving,placeholder:"Insert shortcut"}),
      s.jsx("label",{htmlFor:"felix-shortcut-text",children:"Saved text"}),s.jsx("textarea",{id:"felix-shortcut-text",value:text,onChange:event=>setText(event.target.value),maxLength:10000,rows:6,disabled:saving,placeholder:"Enter your sentence or instructions…"}),
      s.jsx("p",{className:"felix-shortcut-note",children:"This shortcut is available in all your mod chats. Clear Saved text to remove it."}),
      error&&s.jsx("p",{role:"alert",className:"felix-shortcut-error",children:error}),
      s.jsxs("div",{className:"felix-dialog-actions",children:[s.jsx("button",{type:"button",disabled:saving,onClick:close,children:"Cancel"}),s.jsx("button",{type:"submit",disabled:saving,className:"felix-shortcut-save",children:saving?"Saving…":"Save shortcut"})]})
    ]})})
  ]});
}


function felixSteeringLines(lines){return Array.isArray(lines)?lines.filter(text=>typeof text==="string").map(text=>text.length>500?text.slice(0,500)+"…":text):[];}

function FelixSteeringQueue({lines,items,busy,resuming,cancelling,onResume,onCancel}){
  const entries=items??(lines??[]).map(text=>({text}));
  if(!entries.length)return null;
  const ids=entries.map(item=>item.id).filter(Boolean),disabled=resuming||cancelling;
  return s.jsxs("section",{className:"felix-steering-queue","aria-label":"Queued steering instructions",children:[
    s.jsxs("div",{className:"felix-steering-heading",children:[s.jsxs("strong",{children:["Queued instructions",s.jsx("span",{children:entries.length})]}),s.jsxs('div',{className:'atlas-actions',children:[ids.length>1&&s.jsx('button',{type:'button',disabled,onClick:()=>onCancel(ids),className:'atlas-button',children:cancelling?'Cancelling…':'Cancel all'}),!busy&&s.jsx("button",{type:"button",disabled,onClick:onResume,className:"felix-steer-resume",children:resuming?"Resuming…":"Resume"})]})]}),
    s.jsx("p",{className:"felix-steering-hint",children:busy?"The agent will apply these at its next step. Current operations may finish first.":"Work is paused. Resume to apply these instructions."}),
    s.jsx("ol",{children:entries.map((item,index)=>s.jsxs("li",{children:[s.jsx('span',{title:item.text,children:item.text||"Attached files"}),item.id&&s.jsx('button',{type:'button',className:'atlas-button',disabled,onClick:()=>onCancel([item.id]),'aria-label':'Cancel queued instruction '+(index+1),title:'Withdraw this instruction before the agent applies it',children:'Cancel'})]},item.id??index))})
  ]});
}

export {FelixSpeedControl,FelixUsageControl,FelixAccountControl,FelixOpenAIAccounts,FelixSentenceShortcut,felixUseComposerFocus,FelixSteeringQueue};
