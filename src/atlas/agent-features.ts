// @ts-nocheck
// Ported from the tested Felix additions; compatibility keys intentionally retained.
import * as k from 'electron';
import * as crypto from 'node:crypto';
import path from 'node:path';
import * as pi from '@earendil-works/pi-coding-agent';
import {loadSettings,saveSettings} from '../agent/settings';
import {getConversation} from '../agent/conversations';
import {toPiThinking} from '../lib/thinking-levels';
import {buildAttachedPrompt} from '../agent/agent-host';
import {felixAccountLabel} from './account-label';
function felixSupportsFast(model) {
  return model?.provider === "openai-codex" && ["gpt-6-astra","gpt-6-sol","gpt-6-luna","gpt-6.1-sol","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.4"].includes(model.id ?? model.modelId);
}
function felixWithSpeed(stream, getSettings) {
  return (model, context, options) => stream(model, context,
    felixSupportsFast(model) && model.api === "openai-codex-responses"
      ? {...options, serviceTier: getSettings().openaiSpeed === "fast" ? "priority" : "default"}
      : options);
}
function felixSetSpeed(mode) {
  if (mode !== "standard" && mode !== "fast") throw new Error("Invalid speed setting");
  const settings = saveSettings({openaiSpeed: mode});
  for (const win of k.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("modmixer:settings:speed", mode);
  }
  return settings;
}


let felixUsageCache = null;
function felixClearUsage() { felixUsageCache = null; }
function felixParseUsage(payload, now = Date.now()) {
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  function windowValue(value) {
    if (!value || typeof value !== "object") return null;
    const used = number(value.used_percent);
    if (used === null) return null;
    const seconds = number(value.limit_window_seconds);
    const reset = number(value.reset_at);
    const after = number(value.reset_after_seconds);
    return {usedPercent:Math.max(0, Math.min(100, used)),windowMinutes:seconds !== null && seconds > 0 ? seconds / 60 : null,
      resetsAt:reset !== null && reset > 0 ? reset : after !== null && after >= 0 ? now / 1000 + after : null};
  }
  const buckets = [];
  function add(id, name, value) {
    if (!value || typeof value !== "object") return;
    const primary = windowValue(value.primary_window), secondary = windowValue(value.secondary_window);
    if (primary || secondary) buckets.push({id,name,primary,secondary});
  }
  add("codex", "ChatGPT plan", payload?.rate_limit);
  if (Array.isArray(payload?.additional_rate_limits)) for (const entry of payload.additional_rate_limits) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.metered_feature === "string" ? entry.metered_feature.slice(0,100) : "additional";
    const name = typeof entry.limit_name === "string" ? entry.limit_name.slice(0,100) : id;
    add(id,name,entry.rate_limit);
  }
  let credits = null;
  if (payload?.credits && typeof payload.credits === "object") {
    const raw = payload.credits.balance;
    const balance = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (payload.credits.unlimited === true) credits = {unlimited:true,balance:null};
    else if (Number.isFinite(balance) && balance >= 0) credits = {unlimited:false,balance};
  }
  return {status:buckets.length || credits ? "ready" : "unavailable",buckets,credits,updatedAt:now};
}
async function felixGetUsage(host, force = false) {const accountEpoch=felixOpenAIAccountEpoch;if(host.felixAccountOperation)return {status:"loading",buckets:[],credits:null};
  if (!host.modelRuntime) return {status:"loading",buckets:[],credits:null};
  let token, key, accountId;
  try {
    const resolution = await host.modelRuntime.getAuth("openai-codex");if(accountEpoch!==felixOpenAIAccountEpoch||host.felixAccountOperation)return {status:"loading",buckets:[],credits:null};
    token = resolution?.auth?.apiKey;
    if (!token) { felixClearUsage(); return {status:"disconnected",buckets:[],credits:null}; }
    const claims = JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString("utf8"));
    accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("Missing account identity");
    key = crypto.createHash("sha256").update(token).digest("hex");
  } catch { felixClearUsage(); return {status:"unavailable",buckets:[],credits:null}; }
  if (!felixUsageCache || felixUsageCache.key !== key) felixUsageCache = {key,value:null,checkedAt:0,inflight:null};
  const cache = felixUsageCache;
  if (cache.inflight) return cache.inflight;
  const age = Date.now() - cache.checkedAt;
  if (cache.value && age < (force === true ? 5000 : 60000)) return cache.value;
  cache.inflight = (async () => {
    let value;
    try {
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
        headers:{Authorization:"Bearer " + token,"ChatGPT-Account-Id":accountId,Accept:"application/json"},
      });
      if (!response.ok) throw new Error("Usage request failed");
      value = felixParseUsage(await response.json());
    } catch {
      value = cache.value?.updatedAt ? {...cache.value,status:"stale"} : {status:"unavailable",buckets:[],credits:null};
    }
    if (felixUsageCache !== cache) return {status:"loading",buckets:[],credits:null};
    cache.value = value; cache.checkedAt = Date.now(); return value;
  })();
  try { return await cache.inflight; } finally { cache.inflight = null; }
}


function felixNormalizeShortcut(value) {
  if (!value || typeof value !== "object" || typeof value.label !== "string" || typeof value.text !== "string") return {label:"Insert shortcut",text:""};
  return {label:value.label.trim().slice(0,40)||"Insert shortcut",text:value.text.slice(0,10000)};
}
function felixSetShortcut(value) {
  if (!value || typeof value !== "object" || typeof value.label !== "string" || typeof value.text !== "string" || value.label.length>40 || value.text.length>10000) throw new Error("Use a label of up to 40 characters and a sentence of up to 10,000 characters.");
  const shortcut=felixNormalizeShortcut(value), settings=saveSettings({sentenceShortcut:shortcut});
  for(const win of k.BrowserWindow.getAllWindows()) if(!win.isDestroyed()&&!win.webContents.isDestroyed()) win.webContents.send("modmixer:settings:sentence-shortcut",shortcut);
  return settings;
}
// Bound only provider streams, never the execution time of file-editing tools.
function felixGuardStream(stream, idleMs=600000) {
  return (model,context,options={})=>{
    const controller=new AbortController(),queue=[],waiting=[];
    let done=false,partial=null,timer,iterator,resolveResult;
    const result=new Promise(resolve=>{resolveResult=resolve;});
    const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener("abort",onAbort);};
    const push=event=>{
      if(done)return;
      if(event.partial)partial=event.partial;
      if(event.type==="done"||event.type==="error"){
        done=true;resolveResult(event.type==="done"?event.message:event.error);cleanup();
      }
      const next=waiting.shift();if(next)next({value:event,done:false});else queue.push(event);
      if(done)while(waiting.length)waiting.shift()({done:true});
    };
    const fail=(message,reason="aborted")=>{
      if(done)return;
      const original=partial??{};
      const final={...original,role:"assistant",content:(original.content??[]).filter(block=>block.type==="text"||block.type==="thinking").map(block=>({...block})),api:model.api,provider:model.provider,model:model.id,
        usage:original.usage??{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:original.timestamp??Date.now(),stopReason:reason,errorMessage:message};
      push({type:"error",reason,error:final});controller.abort();
      if(iterator?.return)Promise.resolve(iterator.return()).catch(()=>{});
    };
    const onAbort=()=>fail("Stopped. You can resume this request when ready.");
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>fail("No model activity for 10 minutes. The request was stopped. Use Resume to try again."),idleMs);timer.unref?.();};
    const output={result:()=>result,async *[Symbol.asyncIterator](){try{while(true){if(queue.length)yield queue.shift();else if(done)return;else{const event=await new Promise(resolve=>waiting.push(resolve));if(event.done)return;yield event.value;}}}finally{if(!done)fail("Stopped reading the model response.");}}};
    options.signal?.addEventListener("abort",onAbort,{once:true});
    if(options.signal?.aborted)onAbort();else{
      arm();
      (async()=>{
        try{
          const source=await stream(model,context,{...options,signal:controller.signal});
          if(done)return;
          iterator=source[Symbol.asyncIterator]();
          while(!done){
            const next=await iterator.next();if(done)return;
            if(next.done){fail("The model response ended without a completion message. Use Resume to continue.");return;}
            arm();push(next.value);
          }
        }catch(error){if(!done)fail(error instanceof Error?error.message:String(error),"error");}
      })();
    }
    return output;
  };
}
const felixSessionActivity=new Map();
function felixObserveSession(id,event){
  const now=Date.now(),old=felixSessionActivity.get(id)??{startedAt:now,phase:"Thinking",lastEventAt:now};
  let phase=old.phase;
  if(event.type==="agent_start")phase="Thinking";
  else if(event.type==="tool_execution_start")phase="Running "+event.toolName;
  else if(event.type==="tool_execution_end")phase="Thinking";
  else if(event.type==="compaction_start")phase="Compacting context";
  else if(event.type==="auto_retry_start")phase="Waiting to retry";
  else if(event.type==="message_update")phase=event.assistantMessageEvent?.type?.startsWith("text_")?"Receiving reply":"Thinking";
  felixSessionActivity.set(id,{startedAt:event.type==="agent_start"?now:old.startedAt,lastEventAt:now,phase});
}
function felixSessionStatus(host,id,includeMessages=false){
  const entry=host.sessions.get(id),session=entry?.session;
  if(!session)return{exists:false,busy:host.constructing.has(id),compacting:false};
  const compacting=!!session.felixManualCompacting||!!session.isCompacting,busy=!!session.felixManualCompacting||!session.isIdle||compacting;
  if(!busy)host.busyConversations.delete(id);
  return{exists:true,busy,compacting,steering:felixSteeringPreview(session),steeringItems:felixSteeringItems(session),activity:felixSessionActivity.get(id)??null,...(!busy&&includeMessages===true?{messages:session.agent.state.messages}:{})};
}
async function felixInterrupt(host,id,waitMs=15000){
  const entry=host.sessions.get(id);if(!entry)return;
  entry.session.abortCompaction();entry.session.abortBranchSummary();
  let timer;
  try{await Promise.race([Promise.all([entry.session.abort(),entry.session.agent.waitForIdle()]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Cancellation is still in progress. The activity indicator will update when the current operation finishes.")),waitMs);})]);}
  finally{clearTimeout(timer);}
}


function felixAgentWorking(session){
  return !!session&&(!session.isIdle||!!session.agent.signal||!!session.agent.state.isStreaming||!!session.isCompacting||!!session.isRetrying);
}
async function felixContinueSession(session){
  // Keep the same session lifecycle as _runAgentPrompt, with continue() as the first operation.
  felixAssertAccountReady(session.felixAccountHost??{},session);session._isAgentRunActive=true;
  try{await session.agent.continue();while(await session._handlePostAgentRun())await session.agent.continue();}
  finally{session._systemPromptOverride=undefined;session._flushPendingBashMessages();await session._emitAgentSettled();}
}
function felixSteeringPreview(session){
  return session.getSteeringMessages().map(text=>text.length>500?text.slice(0,500)+"…":text);
}
const felixSteeringIds=new WeakMap();
function felixSteeringText(message){return (message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');}
function felixSteeringItems(session){
  const messages=session?.agent?.steeringQueue?.messages;
  if(!Array.isArray(messages))return [];
  return messages.map(message=>{
    if(!felixSteeringIds.has(message))felixSteeringIds.set(message,crypto.randomUUID());
    const text=felixSteeringText(message);
    return {id:felixSteeringIds.get(message),text:text.length>500?text.slice(0,500)+'…':text};
  });
}
function felixCancelSteering(host,id,ids){
  if(typeof id!=='string'||!Array.isArray(ids)||!ids.length||ids.some(value=>typeof value!=='string'))throw new Error('Choose queued instructions to cancel.');
  const session=host.sessions.get(id)?.session;
  if(!session)throw new Error('This chat is not open. Reopen it and try again.');
  const messages=session.agent?.steeringQueue?.messages,visible=session.getSteeringMessages();
  if(!Array.isArray(messages)||!Array.isArray(visible)||typeof session._emitQueueUpdate!=='function')throw new Error('Queued cancellation is unavailable for this session.');
  // The connector drains its queue before message_start. Only messages still in
  // that queue can be withdrawn; never remove an instruction already in use.
  const wanted=new Set(ids),remove=[],visibleIndices=[];
  let before=visible.length;
  for(let index=messages.length-1;index>=0;index--){
    const message=messages[index],text=felixSteeringText(message);
    let visibleIndex=-1;
    for(let at=before-1;at>=0;at--)if(visible[at]===text){visibleIndex=at;before=at;break;}
    if(wanted.has(felixSteeringIds.get(message))){
      if(visibleIndex<0)throw new Error('The steering queue changed. Try again after it refreshes.');
      remove.push(index);visibleIndices.push(visibleIndex);
    }
  }
  // No await between checking and removing: consumption and cancellation cannot
  // interleave, and unrelated steering/images/follow-up messages stay intact.
  for(const index of remove)messages.splice(index,1);
  for(const index of visibleIndices)visible.splice(index,1);
  session._emitQueueUpdate();
  return {cancelled:remove.length,steering:felixSteeringPreview(session),steeringItems:felixSteeringItems(session),reason:remove.length?'Queued instruction'+(remove.length===1?'':'s')+' cancelled.':'These instructions are already being applied or are no longer queued.'};
}
function felixCheckIdleSteering(host,id){
  const session=host.sessions.get(id)?.session;
  if(session&&!felixAgentWorking(session)&&session.getSteeringMessages().length)throw new Error("You have queued steering instructions. Resume or cancel them before sending a new request.");
}
async function felixSteer(host,id,text,attachments){
  if(typeof id!=="string"||typeof text!=="string"||(!text.trim()&&!attachments?.length))throw new Error("Enter instructions to steer the agent.");
  const entry=host.sessions.get(id);
  if(!entry)throw new Error("This chat is not open. Reopen it and try again.");felixCheckCompacting(entry.session);
  if(!felixAgentWorking(entry.session))return{queued:false,reason:"The request has finished. Your draft is ready to send normally."};
  const prepared=await buildAttachedPrompt(entry,text,attachments);
  if(host.sessions.get(id)!==entry||!felixAgentWorking(entry.session))return{queued:false,reason:"The request has finished. Your draft is ready to send normally."};
  // steer() queues synchronously before its first await; it cannot start a new run.
  await entry.session.steer(prepared.promptText,prepared.images);
  entry.session._emitQueueUpdate();
  return{queued:true,steering:felixSteeringPreview(entry.session),steeringItems:felixSteeringItems(entry.session)};
}


let felixOpenAIAccountEpoch=0;
function felixOpenAIWorkBusy(host){
  if(host.atlasChangeDescriptionsOpenAI>0)return true;
  if(host.felixOpenAIStarting>0)return true;
  for(const {session} of host.sessions.values())if(session.model?.provider==="openai-codex"&&felixAgentWorking(session))return true;
  return false;
}
function felixAccountsInfo(host){return {...host.credentials.openAIAccounts(),busy:!!host.felixAccountOperation||felixOpenAIWorkBusy(host),pendingLogin:host.pendingOAuth?.providerId==="openai-codex"};}
function felixAccountEvent(host,message=undefined,usageChanged=false){host.emitOAuth({type:"accounts-changed",providerId:"openai-codex",message,usageChanged});}
function felixBeginAccountChange(host){
  if(host.felixAccountOperation||host.pendingOAuth)throw new Error("Finish or cancel the current sign-in before changing OpenAI accounts.");
  if(felixOpenAIWorkBusy(host))throw new Error("Wait for OpenAI work to finish, or press Stop, before changing accounts.");
  host.felixAccountOperation=true;felixAccountEvent(host);
}
function felixAssertAccountReady(host,session){if(session?.model?.provider==="openai-codex"&&host.felixAccountOperation)throw new Error("Finish or cancel the OpenAI account change before starting work.");}
async function felixCloseOpenAIConnections(){
  const location=path.join(process.resourcesPath,"node_modules","@earendil-works","pi-ai","dist","api","openai-codex-responses.js");
  const connector=await import(require("node:url").pathToFileURL(location).href);
  connector.closeOpenAICodexWebSocketSessions();connector.resetOpenAICodexWebSocketDebugStats();
}
async function felixRefreshIdleModels(host){
  for(const entry of host.sessions.values()){
    if(felixAgentWorking(entry.session))continue;
    const conversation=getConversation(entry.conversationId),model=host.resolveModel(conversation?.model);
    if(model){const choice=toPiThinking(model,conversation?.thinkingLevel??loadSettings().thinkingLevel);await entry.session.setModel(choice.model??model);entry.session.setThinkingLevel(choice.level);}
  }
}
async function felixFinishAccountChange(host,message){
  felixOpenAIAccountEpoch++;felixClearUsage();
  try{await host.modelRuntime.refresh({allowNetwork:false});await felixRefreshIdleModels(host);}
  finally{host.emitOAuth({type:"links-changed"});felixAccountEvent(host,message);}
}
async function felixChangeOpenAIAccount(host,action,id,label=undefined){
  if(!["account-1","account-2"].includes(id))throw new Error("Choose a saved OpenAI account.");
  if(action==="rename"){
    await host.credentials.renameOpenAIAccount(id,label);felixAccountEvent(host);return felixAccountsInfo(host);
  }
  felixBeginAccountChange(host);
  try{
    await felixCloseOpenAIConnections();
    if(action==="switch")await host.credentials.selectOpenAIAccount(id);
    else if(action==="remove")await host.credentials.removeOpenAIAccount(id);
    else throw new Error("Unknown account action.");
    await felixFinishAccountChange(host);
  }finally{host.felixAccountOperation=false;felixAccountEvent(host,undefined,true);}
  return felixAccountsInfo(host);
}
async function felixLoginOpenAIAccount(host,id=undefined,label=undefined){
  if(id!==undefined&&!["account-1","account-2"].includes(id))throw new Error("Choose an account slot.");
  const view=host.credentials.openAIAccounts();
  if(!id&&view.accounts.length>=2)throw new Error("Both account slots are filled. Remove one before adding another account.");
  const target=id?view.accounts.find(item=>item.id===id):null;
  label=felixAccountLabel(label,target?.label??(view.accounts.length?"Account 2":"Account 1"));
  felixBeginAccountChange(host);
  const context={id,label,committed:false,duplicate:false};
  try{
    await felixCloseOpenAIConnections();
    await host.credentials.felixLoginContext.run(context,()=>host.felixLoginOAuthOriginal("openai-codex"));
    if(context.committed)await felixFinishAccountChange(host,context.duplicate?"This account was already saved. Its sign-in was refreshed. Choose a different account in your browser to add another.":"OpenAI account saved.");
  }finally{host.felixAccountOperation=false;felixAccountEvent(host,undefined,true);}
  return felixAccountsInfo(host);
}
async function felixSendWithAccount(host,entry,operation){
  felixAssertAccountReady(host,entry.session);
  const openAI=entry.session.model?.provider==="openai-codex";
  if(openAI)host.felixOpenAIStarting=(host.felixOpenAIStarting??0)+1;
  try{return await operation();}finally{if(openAI){host.felixOpenAIStarting--;felixAccountEvent(host);}}
}
function felixGateAccountSession(host,session){
  session.felixAccountHost=host;
  const prompt=session.prompt.bind(session);session.prompt=(...args)=>{felixCheckCompacting(session);felixAssertAccountReady(host,session);return prompt(...args).finally(()=>felixAccountEvent(host));};
  const compact=session.compact.bind(session);session.compact=(...args)=>{felixAssertAccountReady(host,session);return compact(...args).finally(()=>felixAccountEvent(host));};
  const stream=session.agent.streamFunction;session.agent.streamFunction=(model,...args)=>{if(model.provider==="openai-codex")felixAssertAccountReady(host,{model});return stream(model,...args);};
}


function felixContextUsage(host,id){
  const session=host.sessions.get(id)?.session,value=session?.getContextUsage();
  if(!value||value.tokens!==null)return value??null;
  const tokens=session.agent.state.messages.reduce((sum,message)=>sum+pi.estimateTokens(message),0);
  return {...value,tokens,percent:value.contextWindow>0?tokens/value.contextWindow*100:null,estimated:true};
}
function felixCheckCompacting(session){if(session?.felixManualCompacting||session?.isCompacting)throw new Error("Wait for context compaction to finish, or press Stop, before starting another request.");}
function felixProtectCompactionStream(session,original){
  return async(...args)=>{
    const stream=await original(...args),result=stream.result.bind(stream);
    stream.result=async()=>{
      const message=await result();
      if(message.stopReason==="aborted"){
        if(session._compactionAbortController?.signal.aborted)throw new Error("Compaction cancelled");
        throw new Error("Compaction stopped before a complete summary was received. Your previous context is unchanged.");
      }
      if(message.stopReason!=="error"&&(message.stopReason!=="stop"||!message.content?.some(part=>part.type==="text"&&part.text?.trim())))throw new Error("Compaction did not produce a complete summary. Your previous context is unchanged.");
      return message;
    };
    return stream;
  };
}
async function felixCompactContext(host,id){
  if(typeof id!=="string"||!id)throw new Error("Choose an open chat to compact.");
  const entry=host.sessions.get(id),session=entry?.session;
  if(!session)throw new Error("This chat is not open. Reopen it before compacting.");
  if(felixAgentWorking(session))throw new Error("Finish or stop the current request before compacting context.");
  felixAssertAccountReady(host,session);
  // Reserve the session before the SDK's first await, so Send and account changes cannot race it.
  session.felixManualCompacting=true;
  const originalStream=session.agent.streamFunction;
  session.agent.streamFunction=felixProtectCompactionStream(session,originalStream);
  try{
    return await felixSendWithAccount(host,entry,async()=>{
      const result=await session.compact();
      return {context:felixContextUsage(host,id),tokensBefore:result.tokensBefore,estimatedTokensAfter:result.estimatedTokensAfter,messages:session.agent.state.messages,steering:felixSteeringPreview(session)};
    });
  }catch(error){
    const message=typeof error?.message==="string"?error.message:String(error);
    if(message==="Compaction cancelled"||error?.name==="AbortError")throw new Error("Context compaction stopped. Your previous context is unchanged.");
    if(message==="Already compacted")throw new Error("This context is already compacted. Continue chatting before compacting again.");
    if(message.includes("Nothing to compact"))throw new Error("There is not enough conversation history to compact yet.");
    throw error;
  }finally{session.agent.streamFunction=originalStream;session.felixManualCompacting=false;felixAccountEvent(host);}
}

export {felixWithSpeed,felixSetSpeed,felixNormalizeShortcut,felixSetShortcut,felixGuardStream,felixObserveSession,felixSessionStatus,felixInterrupt,felixAgentWorking,felixContinueSession,felixCheckIdleSteering,felixSteer,felixSteeringItems,felixCancelSteering,felixAccountsInfo,felixChangeOpenAIAccount,felixLoginOpenAIAccount,felixAccountEvent,felixSendWithAccount,felixAssertAccountReady,felixGateAccountSession,felixRefreshIdleModels,felixGetUsage,felixClearUsage,felixCompactContext,felixCheckCompacting,felixContextUsage};
