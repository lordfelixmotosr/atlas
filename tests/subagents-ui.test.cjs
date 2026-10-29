'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

function load(hooks = React, api = {}, timers = {setInterval, clearInterval}) {
  const cache = new Map();
  const context = vm.createContext({Date, Error, Promise, Set, setInterval: timers.setInterval, clearInterval: timers.clearInterval, window: {modmixer: api}});
  function file(name) {
    const filename = path.resolve(__dirname, '../src/atlas', name);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = {exports: {}};
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}, fileName: filename,
    }).outputText;
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context, {filename})(id => {
      if (id === 'react') return hooks;
      if (id.endsWith('.css')) return {};
      if (id === './subagents-types') return file('subagents-types.ts');
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  return file('subagents-control.tsx');
}

function harness(api, timers) {
  let current;
  const hooks = {
    useState(initial) {
      const owner = current, index = owner.cursor++;
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.slots[index], value => {owner.slots[index] = typeof value === 'function' ? value(owner.slots[index]) : value;}];
    },
    useRef(value) {
      const index = current.cursor++;
      return current.slots[index] ??= {current: value};
    },
    useEffect(effect, deps) {
      const owner = current, index = owner.cursor++, previous = owner.slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        owner.pending.push(() => {previous?.cleanup?.(); owner.slots[index] = {deps, cleanup: effect()};});
      }
    },
    useSyncExternalStore(_subscribe, snapshot) {return snapshot();},
  };
  const ui = load(hooks, api, timers);
  return {ui, mount(name, initialProps) {
    const owner = {slots: [], cursor: 0, pending: []};
    let props = initialProps;
    return {
      render(next = props) {
        props = next; current = owner; owner.cursor = 0; owner.pending = [];
        const tree = ui[name](props);
        owner.pending.forEach(effect => effect());
        return tree;
      },
      close() {owner.slots.forEach(slot => slot?.cleanup?.());},
    };
  }};
}

function nodes(tree, predicate) {
  if (tree == null || typeof tree === 'boolean') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function content(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(content).join('');
  if (typeof tree !== 'object') return String(tree);
  return content(tree.props?.children);
}
const button = (tree, label) => nodes(tree, node => node.type === 'button' && content(node).includes(label))[0];
const settings = {enabled: true, mode: 'efficient', maxHelpers: 4};
const task = (patch = {}) => ({id: 'helper-1', conversationId: 'chat-a', title: 'Inspect XML definitions', task: 'Inspect all definitions', kind: 'research', complexity: 'routine', status: 'running', phase: 'Reading project files', createdAt: 1900000000000, lastActivityAt: 1900000001000, model: {key: 'fixture/small', label: 'Light model', thinkingLevel: 'medium', routingReason: 'Routine research uses an available lighter model.'}, ...patch});

test('collapsed helpers has one control, default Efficient and four, without starting work', () => {
  const ui = load();
  const html = renderToStaticMarkup(React.createElement(ui.SubagentsControl, {conversationId: 'chat-a'}));
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Efficient/); assert.match(html, /Up to 4/);
  assert.match(html, /0 active · 0 queued · 0 completed/);
  assert.doesNotMatch(html, /<select|<textarea|progressbar|aria-valuenow|Tokens:/);
});

test('helper settings exposes bounded options, explains Off and preserves main thinking', () => {
  const ui = load();
  const render = value => renderToStaticMarkup(React.createElement(ui.SubagentSettingsFields, {settings: value, disabled: false, onChange() {}}));
  const html = render(settings);
  for (const value of ['Off', 'Efficient', 'Match main']) assert.match(html, new RegExp('>' + value + '</option>'));
  for (let i = 1; i <= 8; i++) assert.match(html, new RegExp('value="' + i + '"'));
  assert.match(html, /value="4" selected=""/);
  assert.doesNotMatch(html, /value="9"/);
  assert.match(html, /main chat’s thinking stays unchanged/);
  assert.match(html, /Turning helpers off stops active helpers/);
  assert.match(render({...settings, enabled: false}), /aria-label="Maximum helpers" disabled=""/);
  assert.match(render({...settings, mode: 'match'}), /main chat’s model and thinking level/);
});

test('task details show real route, phase and activity; usage appears only when reported', () => {
  const ui = load();
  const render = value => renderToStaticMarkup(React.createElement(ui.SubagentTaskRow, {task: value, onAction: async () => {}}));
  let html = render(task());
  for (const phrase of ['Inspect XML definitions', 'Research', 'Light model', 'medium thinking', 'Routine research uses', 'Reading project files', 'Last activity']) assert(html.includes(phrase));
  assert.match(html, /<details class="atlas-helper-task-actions">/);
  assert.match(html, /Cancel helper/); assert.match(html, /Send instruction/);
  assert.doesNotMatch(html, /Retry helper|Tokens:|progressbar|aria-valuenow/);
  html = render(task({status: 'completed', phase: 'Finished', summary: '<script>unsafe</script>\nFindings retained.', usage: {input: 1234, output: 0}, changes: [{path: 'Defs/Test.xml'}]}));
  assert.match(html, /Tokens: 1,234 in · 0 out/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, /Pending lead review and integration/);
  assert.doesNotMatch(html, /<details|Cancel helper|Retry helper/);
  assert.match(render(task({status: 'completed', changes: [{path: 'Defs/Test.xml'}], applied: true})), /Integrated/);
  assert.match(render(task({kind: 'implement', status: 'completed', changes: [{path: 'Defs/Test.xml'}]})), /Discard patch/);
  assert.match(render(task({kind: 'implement', status: 'cancelled', changes: [{path: 'Defs/Test.xml'}]})), /Not integrated/);
  assert.match(render(task({status: 'failed', error: 'Fixture failure'})), /Retry helper/);
  assert.match(render(task({status: 'interrupted'})), /Retry helper/);
  assert.doesNotMatch(render(task({status: 'cancelled'})), /<details/);
});

test('reading and expanding never generate requests; live events defeat stale snapshots and other chats stay isolated', async () => {
  const pending = deferred(), calls = [], handlers = new Set();
  const api = {
    getSettings: async () => {calls.push('settings'); return {subagents: settings};},
    getSubagents: id => {calls.push(['snapshot', id]); return pending.promise;},
    onSubagentsChanged: fn => {handlers.add(fn); return () => handlers.delete(fn);},
    setSubagentSettings: () => assert.fail('No automatic settings write'),
    cancelSubagent: () => assert.fail('No automatic cancel'), retrySubagent: () => assert.fail('No automatic retry'), steerSubagent: () => assert.fail('No automatic steer'),
  };
  const f = harness(api), view = f.mount('SubagentsControl', {conversationId: 'chat-a'});
  let tree = view.render();
  button(tree, 'Helpers').props.onClick();
  tree = view.render();
  await tick();
  for (const handler of handlers) handler({conversationId: 'chat-a', settings, tasks: [task()]});
  assert.match(content(view.render()), /1 active · 0 queued · 0 completed/);
  for (const handler of handlers) handler({conversationId: 'chat-b', settings, tasks: [task(), task({id: 'other'})]});
  assert.match(content(view.render()), /1 active · 0 queued · 0 completed/);
  pending.resolve({conversationId: 'chat-a', settings, tasks: []});
  await tick();
  assert.match(content(view.render()), /1 active · 0 queued · 0 completed/);
  assert.equal(calls.length, 2);
  tree = view.render({conversationId: 'chat-b'});
  assert.match(content(tree), /0 active · 0 queued · 0 completed/);
  view.close();
  assert.equal(handlers.size, 0);
});

test('settings changes are helper-only, shared, serialized and retain saved values on rejection', async () => {
  const save = deferred(), calls = [];
  const api = {getSettings: async () => ({subagents: settings}), setSubagentSettings: patch => {calls.push(patch); return save.promise;}};
  const f = harness(api), first = f.mount('SubagentSettingsControl', {}), second = f.mount('SubagentSettingsControl', {});
  first.render(); second.render(); await tick();
  const fields = tree => nodes(tree, node => node.type === f.ui.SubagentSettingsFields)[0];
  const initial = fields(first.render());
  initial.props.onChange({maxHelpers: 8});
  initial.props.onChange({mode: 'match'});
  assert.equal(calls.length, 1);
  assert.equal(fields(second.render()).props.disabled, true);
  save.reject(new Error('Unable to save fixture settings'));
  await tick();
  assert.equal(fields(first.render()).props.settings.maxHelpers, 4);
  assert.match(content(first.render()), /Unable to save fixture settings/);
  assert.equal(fields(second.render()).props.disabled, false);
  assert.deepEqual(Object.keys(calls[0]), ['maxHelpers']);
});

test('mode and limit handlers never modify model or main thinking settings', () => {
  const f = harness({}), patches = [];
  const fields = f.mount('SubagentSettingsFields', {settings, disabled: false, onChange: patch => patches.push({...patch})});
  const tree = fields.render(), selects = nodes(tree, node => node.type === 'select');
  selects[0].props.onChange({target: {value: 'off'}});
  selects[0].props.onChange({target: {value: 'match'}});
  selects[1].props.onChange({target: {value: '8'}});
  assert.deepEqual(patches, [{enabled: false}, {enabled: true, mode: 'match'}, {maxHelpers: 8}]);
});

test('cancel and retry need a click, duplicate clicks coalesce and failures remain actionable', async () => {
  const pending = deferred(), calls = [];
  const f = harness({}), view = f.mount('SubagentTaskRow', {task: task(), onAction: (...args) => {calls.push(args); return pending.promise;}});
  const tree = view.render();
  assert.equal(calls.length, 0);
  const cancel = button(tree, 'Cancel helper');
  cancel.props.onClick(); cancel.props.onClick();
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'cancel');
  assert.equal(button(view.render(), 'Cancelling').props.disabled, true);
  pending.reject(new Error('Cancel failed once')); await tick();
  assert.match(content(view.render()), /Cancel failed once/);
  assert.equal(button(view.render(), 'Cancel helper').props.disabled, false);
  const retryCalls = [];
  const failed = f.mount('SubagentTaskRow', {task: task({status: 'failed'}), onAction: async (...args) => retryCalls.push(args)});
  const failedTree = failed.render();
  await tick(); assert.equal(retryCalls.length, 0);
  button(failedTree, 'Retry helper').props.onClick(); await tick();
  assert.equal(retryCalls.length, 1); assert.equal(retryCalls[0][1], 'retry');
});

test('steering targets one helper, trims input, retains rejected drafts and clears accepted drafts', async () => {
  let reject = true; const calls = [];
  const f = harness({}), view = f.mount('SubagentTaskRow', {task: task(), onAction: async (...args) => {calls.push(args); if (reject) throw Error('Steer failed');}});
  let tree = view.render();
  assert.equal(button(tree, 'Send instruction').props.disabled, true);
  nodes(tree, node => node.type === 'textarea')[0].props.onChange({target: {value: '  Check the parent definition  '}});
  tree = view.render(); nodes(tree, node => node.type === 'form')[0].props.onSubmit({preventDefault() {}}); await tick();
  tree = view.render(); assert.match(content(tree), /Steer failed/);
  assert.equal(nodes(tree, node => node.type === 'textarea')[0].props.value, '  Check the parent definition  ');
  assert.equal(calls[0][0].id, 'helper-1'); assert.equal(calls[0][1], 'steer'); assert.equal(calls[0][2], 'Check the parent definition');
  reject = false; nodes(tree, node => node.type === 'form')[0].props.onSubmit({preventDefault() {}}); await tick();
  tree = view.render(); assert.equal(nodes(tree, node => node.type === 'textarea')[0].props.value, '');
  assert.match(content(tree), /Instruction sent to this helper/);
});

test('remaining time updates only for mounted running rows and extension is explicit, serialized and bounded', async () => {
  let nextTimer=0; const timers=new Map(), calls=[], waiting=deferred();
  const f=harness({}, {setInterval:(callback,ms)=>{assert.equal(ms,1000);timers.set(++nextTimer,callback);return nextTimer;},clearInterval:id=>timers.delete(id)});
  const now=Date.now(), running=task({deadlineAt:now+90000,maxDeadlineAt:now+7200000});
  const view=f.mount('SubagentTaskRow',{task:running,onAction:(...args)=>{calls.push(args);return waiting.promise;}});
  let tree=view.render();assert.match(content(tree), /1m \d{2}s left/);assert.equal(timers.size,1);assert.equal(calls.length,0);
  const extend=button(tree,'Extend 15 min');assert.equal(extend.props.disabled,false);
  extend.props.onClick();extend.props.onClick();assert.equal(calls.length,1);assert.equal(calls[0][1],'extend');
  assert.equal(button(view.render(),'Extending').props.disabled,true);
  waiting.resolve();await tick();assert.match(content(view.render()),/thinking settings are unchanged/);
  tree=view.render({task:{...running,deadlineAt:running.maxDeadlineAt},onAction:async()=>{}});
  assert.equal(button(tree,'Extend 15 min').props.disabled,true);assert.equal(timers.size,1);
  tree=view.render({task:{...running,status:'completed'},onAction:async()=>{}});assert.equal(timers.size,0);assert.equal(button(tree,'Extend'),undefined);
  view.render({task:running,onAction:async()=>{}});assert.equal(timers.size,1);view.close();assert.equal(timers.size,0);
});

test('expired or stopping helpers cannot extend and never show a fabricated completion percentage', () => {
  const ui=load(), now=Date.now();
  const render=patch=>renderToStaticMarkup(React.createElement(ui.SubagentTaskRow,{task:task({deadlineAt:now-1,maxDeadlineAt:now+7200000,...patch}),onAction:async()=>{}}));
  const html=render({});assert.match(html,/Time limit reached; stopping/);assert.match(html,/<button type="button" disabled=""[^>]*>Extend 15 min/);
  assert.doesNotMatch(html,/progressbar|aria-valuenow|[0-9]+%/);
  assert.match(render({deadlineAt:now+60000,stopReason:'cancelled'}),/Stopping helper/);
  assert.match(render({deadlineAt:now+60000,stopReason:'cancelled'}),/disabled=""/);
});

test('partial saved work requires review then explicit apply; stale failures invalidate review and preserve recovery details', async () => {
  const calls=[], f=harness({}), partial=task({kind:'implement',status:'failed',phase:'Time limit reached',stagingPath:'C:/fixture/helper-work/partial',partialPatch:true,error:'Timed out'});
  let rejectApply=false;
  const view=f.mount('SubagentTaskRow',{task:partial,onAction:async(_task,action)=>{calls.push(action);if(action==='review')return {changes:[{path:'Source/Fixture.cs'}],diff:'-class Before {}\n+class Partial {}'};if(action==='apply'&&rejectApply)throw Error('The source changed; staging retained.');}});
  let tree=view.render();assert.equal(calls.length,0);assert.match(content(tree),/Partial work is saved separately/);assert.match(content(tree),/C:\/fixture\/helper-work\/partial/);
  assert.equal(button(tree,'Apply reviewed'),undefined);assert(button(tree,'Review saved work'));assert(button(tree,'Discard saved work'));
  button(tree,'Review saved work').props.onClick();await tick();tree=view.render();
  assert.deepEqual(calls,['review']);assert.match(content(tree),/unfinished helper patch/);assert.match(content(tree),/class Partial/);assert.equal(button(tree,'Apply reviewed').props.disabled,false);
  rejectApply=true;button(tree,'Apply reviewed').props.onClick();await tick();tree=view.render();
  assert.deepEqual(calls,['review','apply']);assert.match(content(tree),/source changed/);assert.equal(button(tree,'Apply reviewed'),undefined);assert(button(tree,'Review saved work'));
  rejectApply=false;button(tree,'Review saved work').props.onClick();await tick();tree=view.render();button(tree,'Apply reviewed').props.onClick();await tick();tree=view.render();
  assert.match(content(tree),/Ask the lead to finish and validate/);assert.equal(button(tree,'Apply reviewed'),undefined);
  view.close();
});

test('legacy stopped stages remain reviewable, empty work cannot apply, and retired recovery files stay retired', async () => {
  const ui=load(), render=patch=>renderToStaticMarkup(React.createElement(ui.SubagentTaskRow,{task:task({kind:'implement',status:'interrupted',stagingPath:'C:/saved/legacy',...patch}),onAction:async()=>{}}));
  assert.match(render({}),/Review saved work/);assert.match(render({status:'cancelled'}),/Review saved work/);
  const retired=render({status:'cancelled',phase:'Patch retired; staged files retained',error:'Retained at C:/saved/legacy'});
  assert.doesNotMatch(retired,/Review saved work|Discard saved work/);assert.match(retired,/Retained at C:\/saved\/legacy/);
  const f=harness({}),view=f.mount('SubagentTaskRow',{task:task({kind:'implement',status:'failed',stagingPath:'C:/saved/empty'}),onAction:async()=>({changes:[],diff:''})});
  button(view.render(),'Review saved work').props.onClick();await tick();const tree=view.render();
  assert.match(content(tree),/No file changes were saved/);assert.equal(button(tree,'Apply reviewed').props.disabled,true);view.close();
});

test('helper controls dispatch extension and saved patch actions to the selected chat only', async () => {
  const calls=[],handlers=new Set(),partial=task({kind:'implement',status:'failed',stagingPath:'C:/saved/partial'}),review={changes:[{path:'Source/Fixture.cs'}],diff:'+class Partial {}'};
  const api={getSettings:async()=>({subagents:settings}),getSubagents:async id=>({conversationId:id,settings,tasks:[partial]}),onSubagentsChanged:fn=>{handlers.add(fn);return()=>handlers.delete(fn);},
    extendSubagent:async(...args)=>calls.push(['extend',...args]),reviewSubagentPatch:async(...args)=>{calls.push(['review',...args]);return review;},applySubagentPatch:async(...args)=>calls.push(['apply',...args])};
  const f=harness(api),view=f.mount('SubagentsControl',{conversationId:'chat-a'});button(view.render(),'Helpers').props.onClick();await tick();
  const row=nodes(view.render(),node=>node.type===f.ui.SubagentTaskRow)[0];assert(row);assert.equal(calls.length,0);
  await row.props.onAction(partial,'extend');assert.deepEqual(JSON.parse(JSON.stringify(await row.props.onAction(partial,'review'))),review);await row.props.onAction(partial,'apply');
  assert.deepEqual(calls,[['extend','chat-a','helper-1'],['review','chat-a','helper-1'],['apply','chat-a','helper-1']]);view.close();assert.equal(handlers.size,0);
});

test('applied partial work offers a fresh continuation even after manual cancellation', async () => {
  const calls=[], f=harness({});
  for(const status of ['failed','interrupted','cancelled']){
    const view=f.mount('SubagentTaskRow',{task:task({kind:'implement',status,partialPatch:true,applied:true,stagingPath:'C:/saved/partial',changes:[{path:'Source/Fixture.cs'}]}),onAction:async(_task,action)=>calls.push(action)});
    const tree=view.render();assert.match(content(tree),/Integrated/);assert.equal(button(tree,'Retry helper'),undefined);assert.equal(button(tree,'Review saved work'),undefined);
    button(tree,'Continue remaining work').props.onClick();await tick();assert.equal(calls.at(-1),'retry');view.close();
  }
  assert.equal(calls.length,3);
});

test('truncated saved patches cannot be applied from an incomplete UI review', async () => {
  for(const diff of ['+partial\n[Diff truncated; inspect individual files.]','x'.repeat(128*1024+1)]){
    const calls=[],f=harness({}),view=f.mount('SubagentTaskRow',{task:task({kind:'implement',status:'failed',stagingPath:'C:/saved/large'}),onAction:async(_task,action)=>{calls.push(action);return {changes:[{path:'Source/Large.cs'}],diff};}});
    button(view.render(),'Review saved work').props.onClick();await tick();const tree=view.render();
    assert.match(content(tree),/preview is truncated/);assert.match(content(tree),/review the saved patch in pages/);assert.equal(button(tree,'Apply reviewed'),undefined);
    assert.deepEqual(calls,['review']);view.close();
  }
});
