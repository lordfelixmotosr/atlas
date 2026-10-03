import {useEffect,useRef,useState} from 'react';
import {reconcileAgent} from '../conversations-store';
export function TaskActivityDisplay({phase,elapsed,since,error=''}:{phase:string;elapsed:number;since:number;error?:string}){
 const waiting=phase==='Waiting to retry'||!!error;
 return <section className="atlas-activity" aria-label="Agent progress"><span className="atlas-status-dot"/><div className="atlas-activity-content"><strong role="status">{phase}</strong><p>{error||`${elapsed>=60?Math.floor(elapsed/60)+'m ':''}${elapsed%60}s elapsed · ${since<3?'Activity just now':'Last activity '+since+'s ago'}`}</p><div className="atlas-task-progress" role="progressbar" aria-label="Task progress" aria-valuetext={error||phase} data-state={waiting?'waiting':'working'} title="The task has no known total. This bar shows activity, not a completion percentage."><span/></div>{since>=30&&<p>{phase.startsWith('Running ')?'The tool is still running. You can steer the next step or stop it.':phase==='Waiting to retry'?'The provider asked Atlas to wait before retrying.':'Waiting for the model. High thinking levels and large context can take longer.'}</p>}</div></section>
}
export function AgentActivity({conversationId,busy,compacting}:{conversationId:string;busy:boolean;compacting:boolean}){
 const [status,setStatus]=useState<any>(null),[now,setNow]=useState(Date.now()),[error,setError]=useState('');const revision=useRef(0);
 useEffect(()=>{let alive=true,pending=false;setStatus(null);const off=window.modmixer.onEvent(env=>{if(env.conversationId===conversationId)revision.current++});const check=async()=>{if(pending||document.hidden)return;pending=true;const before=revision.current;try{const value=await window.modmixer.getAgentStatus(conversationId,true);if(alive&&before===revision.current){setStatus(value);reconcileAgent(conversationId,value);setError('')}}catch{if(alive)setError('Activity status unavailable.')}finally{pending=false}};void check();const timer=setInterval(()=>{setNow(Date.now());void check()},3000);return()=>{alive=false;clearInterval(timer);off()}},[conversationId]);
 if(!busy&&!compacting)return null;const a=status?.activity;const elapsed=a?Math.max(0,Math.floor((now-a.startedAt)/1000)):0;const since=a?Math.max(0,Math.floor((now-a.lastEventAt)/1000)):0;
 const phase=compacting?'Compacting context':a?.phase||'Starting request';
 return <TaskActivityDisplay phase={phase} elapsed={elapsed} since={since} error={error}/>
}
