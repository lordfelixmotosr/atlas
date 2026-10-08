// @ts-nocheck
// Runs the real ChatPanel and account/usage controls in an owned Electron window.
// The mock is installed before mounting; it never touches saved accounts or a model.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPanel} from '../src/components/chat-panel';
import {seedConversation, seedPanelState} from '../src/conversations-store';

const conversation={id:'toolbar-fixture',scope:{type:'new'},title:'Toolbar fixture',createdAt:1,updatedAt:1,sessionFile:'',model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},thinkingLevel:'max'};
const model={key:'openai-codex/gpt-6.1-sol',provider:'openai-codex',modelId:'gpt-6.1-sol',providerLabel:'ChatGPT',label:'GPT-6.1 Sol',supportsImages:true};
const olderModel={key:'openai-codex/gpt-6-sol',provider:'openai-codex',modelId:'gpt-6-sol',providerLabel:'ChatGPT',label:'GPT-6 Sol',older:true,supportsImages:true};
const future=Math.floor(Date.now()/1000)+86400;
const ready=(balance=1250.5)=>({status:'ready',buckets:[{id:'codex',name:'Codex',primary:{usedPercent:20,windowMinutes:300,resetsAt:future},secondary:{usedPercent:60,windowMinutes:10080,resetsAt:future+604800}}],credits:{balance,unlimited:false,hasCredits:true},updatedAt:Date.now()});
const oauth=new Set(),eventHandlers=new Set();
let usage=ready(),accountId='pro',forceRefreshes=0,pendingUsage=null,nextUsage=null;
const accountInfo=()=>({activeId:accountId,busy:false,accounts:[{id:'pro',label:'GPT Pro',active:accountId==='pro'},{id:'second',label:'Second account',active:accountId==='second'}]});
const emitOAuth=event=>oauth.forEach(handler=>handler(event));
const subscribe=handlers=>handler=>{handlers.add(handler);return()=>handlers.delete(handler);};
window.modmixer=new Proxy({
  onEvent:subscribe(eventHandlers),onOAuthEvent:subscribe(oauth),
  onOpenAISpeedChanged:()=>()=>{},getSettings:async()=>({openaiSpeed:'fast'}),
  getAgentStatus:async()=>({busy:false,compacting:false}),
  getContextUsage:async()=>({tokens:398000,contextWindow:1050000}),
  getOpenAIAccounts:async()=>accountInfo(),
  listModels:async includeOlder=>includeOlder?[model,olderModel]:[model],
  getOpenAIUsage:async force=>{if(force)forceRefreshes++;if(nextUsage)return nextUsage;return usage;},
  switchOpenAIAccount:async id=>{accountId=id;emitOAuth({type:'accounts-changed',providerId:'openai-codex'});emitOAuth({type:'links-changed',providerId:'openai-codex'});return accountInfo();},
},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
seedPanelState(conversation);
seedConversation(conversation.id,[{role:'assistant',content:[{type:'text',text:'Review the draft before continuing. No task is running in this fixture.'}],model:'gpt-6.1-sol',provider:'openai-codex',timestamp:1,stopReason:'stop'}]);
const fixtureRoot=document.getElementById('root');
Object.assign(fixtureRoot.style,{width:'1100px',height:'650px',display:'flex'});
const reactRoot=createRoot(fixtureRoot);
reactRoot.render(<ChatPanel conversation={conversation} activeMod={null} hasAi={true} availableModels={[model]} onConnect={()=>{}}/>);
const settle=(ms=120)=>new Promise(resolve=>setTimeout(resolve,ms));
function assert(value,message){if(!value)throw new Error(message);}
const toolbar=()=>document.querySelector('[data-atlas-composer-toolbar]')??document.querySelector('.atlas-composer');
const usageArea=()=>document.querySelector('[data-atlas-usage]')??[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??'').startsWith('ChatGPT usage'));
const usageText=()=>usageArea()?.innerText??'';
const refreshButton=()=>usageArea()?.matches('button')?usageArea():usageArea()?.querySelector('button')??[...document.querySelectorAll('button')].find(button=>/refresh.*usage/i.test(button.getAttribute('aria-label')??''));
function controls(){const bar=toolbar();return [...bar.querySelectorAll('select,button')].filter(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0;});}
function checkLayout(width){
  const bar=toolbar();assert(bar,'Composer toolbar is missing');
  const bounds=bar.getBoundingClientRect(),elements=controls();
  assert(elements.length>=6,`Composer controls missing at ${width}px`);
  assert(bar.scrollWidth<=bar.clientWidth+1,`Composer toolbar overflows at ${width}px`);
  assert(fixtureRoot.scrollWidth<=fixtureRoot.clientWidth+1,`Chat panel overflows at ${width}px`);
  for(const element of elements){
    const r=element.getBoundingClientRect();
    assert(r.left>=bounds.left-1&&r.right<=bounds.right+1,`Control escapes toolbar at ${width}px: ${element.textContent}`);
    assert(r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1,`Control escapes vertically at ${width}px: ${element.textContent}`);
  }
  for(let i=0;i<elements.length;i++)for(let j=i+1;j<elements.length;j++){
    const a=elements[i].getBoundingClientRect(),b=elements[j].getBoundingClientRect();
    const overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    assert(overlapX<=1||overlapY<=1,`Composer controls overlap at ${width}px: ${elements[i].textContent} and ${elements[j].textContent}`);
  }
  const controlsRow=document.querySelector('[data-atlas-composer-controls]'),statusRow=document.querySelector('[data-atlas-composer-status]');
  if(controlsRow&&statusRow)assert(statusRow.getBoundingClientRect().top>=controlsRow.getBoundingClientRect().bottom-1,`Usage overlaps model controls at ${width}px`);
  if(statusRow){const regions=[...statusRow.children].filter(element=>element.getBoundingClientRect().width>0);for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++){const a=regions[i].getBoundingClientRect(),b=regions[j].getBoundingClientRect();assert(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`Usage and context regions overlap at ${width}px`);}}
  const picks=[...bar.querySelectorAll('select')];
  const heights=picks.map(element=>element.getBoundingClientRect().height);
  assert(Math.max(...heights)-Math.min(...heights)<=2,`Control sizes are inconsistent at ${width}px`);
  return {width,controls:elements.length,toolbarHeight:Math.round(bounds.height)};
}
function assertWindowsAndCredits(balance){
  const text=usageText();
  assert(/5h/i.test(text)&&/80\s*%/.test(text),`Session usage is missing: ${text}`);
  assert(/week/i.test(text)&&/40\s*%/.test(text),`Weekly usage is missing: ${text}`);
  assert(/credits/i.test(text),`Credit balance is missing: ${text}`);
  const amount=text.match(/credits\s*:?\s*(?:balance\s*:?\s*)?([\d,]+(?:\.\d+)?)/i);
  assert(amount&&Number(amount[1].replace(/,/g,''))===balance,`Incorrect credit balance (${balance}): ${text}`);
}
async function refresh(value){usage=value;const button=refreshButton();assert(button,'Usage refresh is missing');assert(!button.disabled,'Usage refresh stayed disabled');button.click();await settle();}

window.__atlasToolbarTest={
  async state(name,width=1100){
    fixtureRoot.style.width=width+'px';
    if(name==='credits')await refresh(ready());
    else if(name==='zero')await refresh(ready(0));
    else if(name==='unavailable')await refresh({status:'unavailable',buckets:[],credits:null});
    else if(name==='stale')await refresh({...ready(),status:'stale'});
    await settle();return {name,width,text:usageText(),layout:checkLayout(width)};
  },
  async run(){
    await settle();await settle();
    const modelPicker=[...toolbar().querySelectorAll('select')].find(select=>[...select.options].some(option=>option.textContent.includes('GPT-6.1 Sol')));assert(modelPicker,'Model picker is missing');
    assert(![...modelPicker.options].some(option=>option.textContent.includes('GPT-6 Sol (older)')),'Older model is visible before expansion');
    const showOlder=[...modelPicker.options].find(option=>option.textContent.includes('Show older models'));assert(showOlder,'Show older models option is missing');
    modelPicker.value=showOlder.value;modelPicker.dispatchEvent(new Event('change',{bubbles:true}));await settle();
    assert([...modelPicker.options].some(option=>option.textContent.includes('GPT-6 Sol (older)')),'Older model did not appear after expansion');
    const hideOlder=[...modelPicker.options].find(option=>option.textContent.includes('Hide older models'));assert(hideOlder,'Hide older models option is missing');
    modelPicker.value=hideOlder.value;modelPicker.dispatchEvent(new Event('change',{bubbles:true}));await settle();
    assert(![...modelPicker.options].some(option=>option.textContent.includes('GPT-6 Sol (older)')),'Older model stayed visible after collapse');
    assertWindowsAndCredits(1250.5);
    const layouts=[];
    for(const width of [1100,650,360]){fixtureRoot.style.width=width+'px';await settle();layouts.push(checkLayout(width));assertWindowsAndCredits(1250.5);}
    fixtureRoot.style.width='650px';await settle();
    const before=forceRefreshes;
    await refresh(ready(0));assert(forceRefreshes>before,'Usage button did not request a fresh balance');assertWindowsAndCredits(0);
    await refresh({status:'unavailable',buckets:[],credits:null});
    assert(/credits\s*:?\s*unavailable/i.test(usageText()),`Unavailable credits are not explicit: ${usageText()}`);
    assert(!usageText().includes('1,250.5')&&!usageText().includes('1250.5'),'Old balance stayed visible after usage became unavailable');
    checkLayout(650);
    await refresh({...ready(),status:'stale'});assertWindowsAndCredits(1250.5);assert(/stale/i.test(usageText()),'Stale credit balance has no visible stale label');checkLayout(650);
    await refresh(ready());
    nextUsage=new Promise(resolve=>{pendingUsage=resolve;});
    const picker=document.querySelector('select[aria-label="OpenAI account"]');assert(picker&&!picker.disabled,'Account picker is missing or disabled');
    picker.value='second';picker.dispatchEvent(new Event('change',{bubbles:true}));await settle();
    assert(!usageText().includes('1,250.5')&&!usageText().includes('1250.5'),'Previous account credits stayed visible during account switching');
    assert(/loading|refreshing/i.test(usageText()),`Account switch lacks a pending usage state: ${usageText()}`);
    usage=ready(42);nextUsage=null;pendingUsage(usage);pendingUsage=null;await settle();
    assertWindowsAndCredits(42);assert(picker.value==='second','Account picker failed to switch');
    checkLayout(650);
    return {wideAndNarrowNoOverlap:true,consistentControlSizes:true,olderModelsToggle:true,sessionAndWeeklyUsageVisible:true,creditsWithWindowsVisible:true,zeroCreditsVisible:true,unavailableCreditsExplicit:true,staleCreditsLabelled:true,manualRefresh:true,accountSwitchClearsOldCredits:true,accountSwitchLoadsNewCredits:true,layouts};
  },
  close(){reactRoot.unmount();},
};
