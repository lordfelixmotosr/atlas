// @ts-nocheck
// Runs the real ChatPanel, virtualizer and store in an isolated Electron window.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPanel} from '../src/components/chat-panel';
import {seedConversation, seedPanelState, handleAgentEvent} from '../src/conversations-store';

const conversation={id:'layout-fixture',scope:{type:'new'},title:'Layout fixture',createdAt:1,updatedAt:1,sessionFile:'',model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},thinkingLevel:'high'};
const assistant=(text,content=[],timestamp=1)=>({role:'assistant',content:[{type:'text',text},...content],model:'gpt-6.1-sol',provider:'openai-codex',timestamp,stopReason:'stop'});
const messages=[];
for(let turn=0;turn<24;turn++){
 const calls=Array.from({length:5},(_,i)=>({type:'toolCall',id:`read-${turn}-${i}`,name:'read',arguments:{path:`Source/LongFolderName/Graphics/WhiteFabric-${turn}-${i}.cs`}}));
 messages.push(assistant('Reviewing the material colors while preserving the existing masks.',calls,turn*10+1));
 for(let i=0;i<5;i++)messages.push({role:'toolResult',toolName:'read',toolCallId:calls[i].id,content:[{type:'text',text:Array.from({length:80},(_,n)=>`Source line ${n}: preserve texture masks and material colors.`).join('\n')}],timestamp:turn*10+i+2,isError:false});
 messages.push(assistant('Changes for this turn\n\n'+Array.from({length:8},(_,i)=>`- Feature ${i}: preserve source textures and shading.`).join('\n'),[],turn*10+8));
}
seedPanelState(conversation);seedConversation(conversation.id,messages);
const root=createRoot(document.getElementById('root'));
root.render(<ChatPanel conversation={conversation} activeMod={null} hasAi={false} availableModels={[]} onConnect={()=>{}}/>);
const settle=()=>new Promise(resolve=>setTimeout(resolve,200));
const scroll=()=>document.querySelector('[data-atlas-chat-scroll]');
const jump=()=>document.querySelector('button[aria-label="Jump to latest message"]');
function assert(value,message){if(!value)throw new Error(message);}
function noOverlap(){const rows=[...document.querySelectorAll('[data-atlas-chat-row]')];assert(rows.length>1,'Chat rows missing');for(let i=1;i<rows.length;i++){const prev=rows[i-1].getBoundingClientRect(),next=rows[i].getBoundingClientRect();assert(next.top>=prev.bottom-1,`Chat rows overlap at ${i}`);}assert(rows.length<messages.length/2,'Long chat lost virtualization');return rows.length;}
async function atTop(){scroll().scrollTop=0;scroll().dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));scroll().dispatchEvent(new Event('scroll'));await settle();assert(!!jump(),'Jump button missing at top of an idle transcript');}
window.__atlasChatLayoutTest={async run(){
 await settle();await settle();
 const readingOffset=scroll().scrollTop-150;scroll().scrollTop=readingOffset;scroll().dispatchEvent(new Event('scroll'));await settle();
 assert(Math.abs(scroll().scrollTop-readingOffset)<2,'Scrolling up was pulled back to the latest message');assert(!!jump(),'Jump button missing after scrolling up');
 await atTop();const wideRows=noOverlap();
 const firstResult=document.querySelector('[data-atlas-chat-row] button:not([aria-label])');
 assert(firstResult,'Expandable tool result missing');firstResult.click();await settle();noOverlap();
 firstResult.click();await settle();
 document.getElementById('root').style.width='360px';await settle();await atTop();noOverlap();
 const topBefore=scroll().scrollTop;
 const streaming=assistant('Streaming response',[],999);
 handleAgentEvent({conversationId:conversation.id,event:{type:'message_start',message:streaming}});await settle();
 handleAgentEvent({conversationId:conversation.id,event:{type:'message_update',message:assistant('Streaming response\n\n'+Array(40).fill('Growing reply with tool details.').join('\n'),[],999)}});await settle();
 assert(scroll().scrollTop<=topBefore+1,'Incoming reply pulled the reader away from history');assert(!!jump(),'Jump button disappeared during streaming');noOverlap();
 jump().click();await settle();await settle();
 assert(scroll().scrollHeight-scroll().clientHeight-scroll().scrollTop<70,'Jump did not reach the latest response');assert(!jump(),'Jump button stayed visible at latest message');noOverlap();
 await atTop();noOverlap();
 root.unmount();
 return {manualScrollPreserved:true,idleHistoryButton:true,expandedToolRows:true,narrowPanel:true,streamingPreservesHistory:true,jumpReachesLatest:true,virtualized:true,wideRows};
}};
