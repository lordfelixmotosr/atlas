// @ts-nocheck
// Isolated UI exercise: no profile, provider credentials, or model calls.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ThinkingPicker} from '../src/components/thinking-picker';

const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const make = (provider, id, levels, fallbacks = {}) => ({
  key: `${provider}/${id}`, provider, modelId: id,
  thinking: {levels, effectiveLevels: {...Object.fromEntries(efforts.map(x => [x, x])), ...fallbacks}},
});
const gpt = make('openai-codex', 'gpt-6-sol', ['off', 'low', 'medium', 'high', 'xhigh', 'max'], {minimal:'low'});
const claude = make('anthropic', 'claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max'], {off:'low', minimal:'low'});
const old = make('anthropic', 'old-budget-model', ['off', 'minimal', 'low', 'medium', 'high'], {xhigh:'high', max:'high'});
const models = [gpt, claude];
let saves = [], current = 'xhigh', selected = gpt;
window.modmixer = {listModels: async () => [...models, old]};
const root = createRoot(document.getElementById('root'));
function render() {
  root.render(<div className="felix-toolbar"><ThinkingPicker current={current} models={models} model={selected} onChange={level=>{saves.push(level);current=level;render();}} /></div>);
}
render();
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const picker = () => document.querySelector('select');
const assert = (value, message) => {if(!value)throw Error(message);};
window.runThinkingFixture = async () => {
  await settle();
  assert(picker().value==='xhigh' && saves.length===0, 'Initial preference changed');
  assert(![...picker().options].some(x=>x.value==='minimal'), 'Duplicate Minimal alias shown');
  picker().value='max';picker().dispatchEvent(new Event('change',{bubbles:true}));await settle();
  assert(current==='max' && saves.length===1, 'Max selection was not saved exactly once');
  selected=claude;render();await settle();
  assert(current==='max' && picker().value==='max' && saves.length===1, 'Claude switch altered saved preference');
  assert(![...picker().options].some(x=>x.value==='off'), 'Unsupported Off shown for Claude');
  selected=old;render();await settle();await settle();
  assert(picker().selectedOptions[0].textContent.includes('Max (uses High)'), 'Older model fallback not explained');
  assert(current==='max' && saves.length===1, 'Fallback overwrote saved preference');
  selected=gpt;render();await settle();
  assert(picker().selectedOptions[0].textContent==='Thinking: Max' && saves.length===1, 'Return to GPT failed to restore native Max');
  selected={provider:'missing',modelId:'offline'};render();await settle();
  assert(picker().disabled && current==='max' && saves.length===1, 'Missing model changed settings or allowed unknown efforts');
  selected=old;render();await settle();await settle();
  assert(picker().getBoundingClientRect().right <= innerWidth, 'Fallback control overflows the window');
  return {initialExtraHighPreserved:true,oneExplicitSave:true,nativeMax:true,olderModelLookup:true,fallbackExplained:true,modelSwitchKeepsPreference:true,missingModelDisabled:true,narrowLayout:true};
};
