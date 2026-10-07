// @ts-nocheck
// Runs real progress and chat components locally; no account or model access.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentActivity, TaskActivityDisplay} from '../src/atlas/activity';
import {activityPresentation} from '../src/atlas/activity-state';
import {ChatPanel} from '../src/components/chat-panel';
import {seedConversation, seedPanelState, handleAgentEvent} from '../src/conversations-store';

const root=createRoot(document.getElementById('root'));
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));
function assert(value,message){if(!value)throw Error(message);}
const now=Date.now(),stream={state:'connecting',phase:'Connecting to model',requestStartedAt:now,lastEventAt:null,lastContentAt:null};
let activity={startedAt:now,lastEventAt:now,phase:stream.phase,stream};
const events=new Set();let status={exists:true,busy:true,compacting:false,activity};
window.modmixer=new Proxy({onEvent:fn=>{events.add(fn);return()=>events.delete(fn)},getAgentStatus:async()=>status,getContextUsage:async()=>null},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>null});
const display=(value,at=Date.now())=>root.render(<TaskActivityDisplay {...activityPresentation(value,at)}/>);
const snapshot=()=>({phase:document.querySelector('[role=status]')?.textContent,text:document.body.innerText,progress:document.querySelector('[role=progressbar]')});
const assistant=content=>({role:'assistant',content,model:'gpt-6.1-sol',provider:'openai-codex',api:'openai-codex-responses',timestamp:now,stopReason:'stop'});
window.__atlasConnectionTest={async run(){
 const report={};
 display(activity);await settle();assert(snapshot().phase==='Connecting to model','Initial wait mislabeled');assert(snapshot().text.includes('Waiting for first response'),'First response status missing');assert(!snapshot().progress.hasAttribute('aria-valuenow'),'AI activity pretends to be a completion percentage');report.connecting=true;
 const reasoning={...activity,phase:'Receiving reasoning',stream:{...stream,state:'thinking',phase:'Receiving reasoning',lastEventAt:now,lastContentAt:now}};
 display(reasoning,now+1000);await settle();assert(snapshot().phase==='Receiving reasoning','Real reasoning state missing');report.reasoning=true;
 display(reasoning,now+70000);await settle();assert(snapshot().phase==='Waiting for response data','Silence state missing');assert(snapshot().text.includes('does not mean the connection is lost'),'Silence warning overstates failure');report.silence=true;
 display({...activity,phase:'Running build_mod',stream:null},now+70000);await settle();assert(snapshot().phase==='Running build_mod','Long tool incorrectly treated as network wait');report.tools=true;
 for(const width of [360,650,1100]){document.getElementById('root').style.width=width+'px';display(reasoning,now+70000);await settle();const section=document.querySelector('.atlas-activity');assert(section.scrollWidth<=section.clientWidth+2,'Status overflows narrow panel');}report.responsive=true;
 // A completed status poll reconciles the existing conversation store and removes activity.
 root.render(<AgentActivity conversationId="connection-fixture" busy={true} compacting={false}/>);await settle();assert(snapshot().phase==='Connecting to model','Polled stream status missing');
 status={...status,busy:false,activity:{...activity,phase:'Finished',stream:null},messages:[]};root.render(<AgentActivity conversationId="connection-fixture" busy={false} compacting={false}/>);await settle();assert(!document.querySelector('.atlas-activity'),'Finished task kept spinning');report.settled=true;
 const conversation={id:'connection-fixture',scope:{type:'new'},title:'Connection fixture',createdAt:1,updatedAt:1,sessionFile:'',model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},thinkingLevel:'xhigh'};
 seedPanelState(conversation);seedConversation(conversation.id,[{role:'user',content:[{type:'text',text:'Local fixture'}],timestamp:now}]);
 root.render(<ChatPanel conversation={conversation} activeMod={null} hasAi={false} availableModels={[]} onConnect={()=>{}}/>);await settle();
 status={...status,busy:true,activity};handleAgentEvent({conversationId:conversation.id,event:{type:'agent_start'}});handleAgentEvent({conversationId:conversation.id,event:{type:'message_start',message:assistant([])}});await settle();assert(document.body.textContent.includes('Waiting for response…'),'Initial waiting indicator is missing');report.firstReplyLabel=true;
 const failed={...assistant([{type:'text',text:'Preserved partial reply'}]),stopReason:'error',errorMessage:'Connection interrupted: terminated. Any received text has been kept in chat history. Use Retry to continue when ready.'};
 status={...status,busy:false,activity:{...activity,phase:'Request failed',stream:null},messages:[{role:'user',content:[{type:'text',text:'Local fixture'}],timestamp:now},failed]};
 handleAgentEvent({conversationId:conversation.id,event:{type:'message_end',message:failed}});handleAgentEvent({conversationId:conversation.id,event:{type:'agent_end'}});await settle();assert(document.body.innerText.includes('Preserved partial reply'),'Partial response disappeared on failure');assert(document.body.innerText.includes('Connection interrupted'),'Connection error missing');assert([...document.querySelectorAll('button')].some(button=>button.textContent==='Retry'),'Explicit Retry missing');assert(!document.querySelector('.atlas-activity'),'Failed task kept spinning');report.partialErrorAndRetry=true;
 return report;
},async show(){document.getElementById('root').style.width='650px';display({...activity,phase:'Receiving reasoning',stream:{...stream,state:'thinking',phase:'Receiving reasoning',lastEventAt:now,lastContentAt:now}},now+70000);await settle();},close(){root.unmount()}};
