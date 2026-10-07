'use strict';
const clean=value=>String(value??'').replace(/\b(Bearer\s+|sk-)[A-Za-z0-9_.-]+/g,'[redacted]').slice(0,12000);
class Tasks {
 constructor(onState=()=>{},now=Date.now){this.items=new Map();this.onState=onState;this.now=now;this.timer=null;this.outcomes=new Map();this.runningChats=new Set();}
 status(){return [...this.items.values()].sort((a,b)=>b.updatedAt-a.updatedAt).map(item=>({...item,logs:item.logs.map(log=>({...log}))}));}
 notify(){if(this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.onState(this.status());},150);this.timer.unref?.();}
 update(id,patch,log){const now=this.now(),old=this.items.get(id);const fresh=patch.restart||!old;const item={...(fresh?{id,startedAt:now,logs:[],status:'running'}:old),...patch,updatedAt:now};delete item.restart;
  if(log){item.logs=[...item.logs,{at:now,text:clean(log)}].slice(-80);}if(item.status==='running')delete item.endedAt;else item.endedAt??=now;
  this.items.set(id,item);const finished=[...this.items.values()].filter(x=>x.status!=='running').sort((a,b)=>b.updatedAt-a.updatedAt);for(const row of finished.slice(40))this.items.delete(row.id);this.notify();return item;
 }
 clear(){for(const[id,item]of this.items)if(item.status!=='running')this.items.delete(id);this.notify();}
 observeAgent(id,event,title){const key='chat:'+id,old=this.items.get(key),common={kind:'chat',title:title||old?.title||'AI task',conversationId:id,canRetry:event.type==='agent_start'?true:event.type==='compaction_start'&&!this.runningChats.has(id)?false:old?.canRetry??true};
  if(event.type==='agent_start'){this.runningChats.add(id);this.outcomes.delete(id);this.update(key,{...common,status:'running',phase:'Starting request',fraction:null,restart:true},'Task started');return;}
  if(event.type==='message_end'&&event.message?.role==='assistant'&&['error','aborted'].includes(event.message.stopReason))this.outcomes.set(id,{status:event.message.stopReason==='aborted'?'cancelled':'failed',error:event.message.errorMessage});
  if(event.type==='agent_end'){this.runningChats.delete(id);for(const row of this.items.values())if(row.kind==='build'&&row.conversationId===id&&row.status==='running')this.update(row.id,{status:'cancelled',phase:'Build stopped'},'Chat ended before the build settled');const result=this.outcomes.get(id);this.update(key,{...common,status:result?.status??'completed',phase:result?.status==='failed'?'Needs attention':result?.status==='cancelled'?'Stopped':'Finished',fraction:null},result?.error||'Task '+(result?.status??'completed'));this.outcomes.delete(id);return;}
  if(event.type==='auto_retry_start'||event.type==='message_end'&&event.message?.stopReason==='stop')this.outcomes.delete(id);
  if(event.type==='compaction_end'&&!this.runningChats.has(id)){this.update(key,{...common,status:event.aborted?'cancelled':event.error?'failed':'completed',phase:event.error?'Compaction failed':event.aborted?'Compaction stopped':'Context compacted',fraction:null},event.error||'Compaction finished');return;}
  const delta=event.assistantMessageEvent;
  const phase=event.type==='tool_execution_start'?'Running '+event.toolName:event.type==='tool_execution_end'?'Waiting for next response':event.type==='compaction_start'?'Compacting context':event.type==='auto_retry_start'?'Waiting to retry':event.type==='message_update'&&delta?.delta?(delta.type==='text_delta'?'Receiving reply':delta.type==='thinking_delta'?'Receiving reasoning':delta.type.startsWith('toolcall_')?'Preparing tool':null):null;
  if(phase)this.update(key,{...common,status:'running',phase,fraction:null},old?.phase!==phase?phase:null);
  if(event.toolName==='build_mod'&&['tool_execution_start','tool_execution_end'].includes(event.type)){
   const build='build:'+id+':'+event.toolCallId;const done=event.type==='tool_execution_end';const text=done?(event.result?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n'):null;
   this.update(build,{kind:'build',title:'Build mod',conversationId:id,status:done?(event.isError?'failed':'completed'):'running',phase:done?(event.isError?'Build failed':'Build finished'):'Compiler running',fraction:null},text||'Build started');
  }
 }
 observeStream(id,activity){const key='chat:'+id,old=this.items.get(key);if(!old||old.status!=='running'||['done','error','cancelled'].includes(activity.state)||old.phase===activity.phase)return;this.update(key,{phase:activity.phase,fraction:null},activity.phase);}
 observeIndex(event){const old=this.items.get('index:rimworld');if(event.type==='starting')this.update('index:rimworld',{kind:'index',title:'RimWorld reference index',status:'running',phase:'Starting',fraction:null,restart:true,cancelRequested:false},'Index started');
  else if(event.type==='phase')this.update('index:rimworld',{kind:'index',title:'RimWorld reference index',status:'running',phase:event.message,fraction:Number.isFinite(event.fraction)?Math.max(0,Math.min(1,event.fraction)):null},old?.phase!==event.message?event.message:null);
  else if(event.type==='done'||event.type==='error'){const cancelled=old?.cancelRequested;this.update('index:rimworld',{kind:'index',title:'RimWorld reference index',status:cancelled?'cancelled':event.type==='done'?'completed':'failed',phase:cancelled?'Stopped':event.type==='done'?'Index ready':'Index failed',fraction:event.type==='done'?1:null},cancelled?'Index cancelled':event.message||'Index completed');}
 }
 observeDownload(state){const p=state.progress;if(!p)return;if(p.stage==='idle'){if(this.items.has('download:app'))this.update('download:app',{status:'completed',phase:state.available?'Update available':'Up to date',fraction:null},state.available?'Update available':'Up to date');return;}const phase={checking:'Checking update feed',downloading:'Downloading update',resuming:'Preparing resume',verifying:'Verifying download',ready:'Ready to install',error:state.error||'Update failed',paused:'Download paused',cancelled:'Download cancelled',installing:'Preparing installation'}[p.stage]||p.stage;
  const old=this.items.get('download:app');this.update('download:app',{kind:'download',title:'Atlas application update',status:state.working?'running':p.stage==='error'?'failed':p.stage==='paused'?'paused':p.stage==='cancelled'?'cancelled':'completed',phase,fraction:p.totalBytes>0?Math.min(1,p.receivedBytes/p.totalBytes):null,restart:!!old&&p.stage==='checking'&&old.status==='completed'},old?.phase!==phase?phase:null);
 }
 dispose(){clearTimeout(this.timer);}
}
module.exports={Tasks};
