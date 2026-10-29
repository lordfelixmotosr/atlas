const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
function load(file){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,'../src/lib',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports});return m.exports;}
const {toSteamChangeNotes:convert,parseSteamNotes:parse}=load('workshop-notes.ts'),{parseModDescription:description}=load('mod-description.ts');
test('player notes become Steam headings, bullets and bold without raw Markdown',()=>{
 const input='## New features\n- **Ammo recycling (Combat Extended):** Recycle ammunition.\n- **Downed-pawn hover card:** See injuries.\n\n## Combat changes\n- **Melee Charge** now commits to closing distance.';
 const expected='[h2]New features[/h2]\n[list]\n[*][b]Ammo recycling (Combat Extended):[/b] Recycle ammunition.\n[*][b]Downed-pawn hover card:[/b] See injuries.\n[/list]\n\n[h2]Combat changes[/h2]\n[list]\n[*][b]Melee Charge[/b] now commits to closing distance.\n[/list]';
 assert.equal(convert(input),expected);assert.equal(convert(expected),expected);
 const nodes=parse(expected);assert(nodes.some(n=>n.tag==='h2'));assert(nodes.filter(n=>n.tag==='list').every(n=>n.children.filter(c=>c.tag==='li').length));
});
test('plain wording, Unicode, Steam tags and literal code are preserved',()=>{
 for(const input of ['Fixed rifle_damage and UI — 25% faster.', '[h1]Fixes[/h1]\n[list][*][b]Safe[/b] updates[/list]', '[list][*]Outer[list][*]Inner[/list][*]**literal**[/list]', '[url=https://example.com]Guide[/url]', '[code]## not a heading\n**not bold**[/code]'])assert.equal(convert(input),input);
 assert.equal(convert('```cs\nvar rifle_damage = "**test**";\n```'),'[code]var rifle_damage = "**test**";[/code]');
 assert.equal(convert('Use `Mods/file_name` and \\*literal\\*.'),'Use [code]Mods/file_name[/code] and [noparse]*[/noparse]literal[noparse]*[/noparse].');
 assert.equal(convert('[Guide](https://example.com) and *text*'),'[url=https://example.com]Guide[/url] and [i]text[/i]');
});
test('nested and numbered lists remain structured and conversion is idempotent',()=>{
 const input='1. First\n   - Nested **bold**\n   - Other\n2. Second';const converted=convert(input);assert.equal(convert(converted),converted);
 const list=parse(converted)[0];assert.equal(list.tag,'olist');assert.equal(list.children.filter(n=>n.tag==='li').length,2);assert(list.children.find(n=>n.tag==='li').children.some(n=>n.tag==='list'));
});
test('preview treats HTML and executable links as inert text nodes and bounds nesting',()=>{
 const nodes=parse('<img src=x onerror=alert(1)>[url=javascript:alert(1)]click[/url][noparse][b]literal[/b][/noparse]');
 assert.equal(nodes[0].text,'<img src=x onerror=alert(1)>');assert.equal(nodes[1].tag,'url');assert.equal(nodes[2].children[0].text,'[b]literal[/b]');
 assert.doesNotThrow(()=>parse('[b]'.repeat(10000)+'text'+'[/b]'.repeat(10000)));
});
test('structured notes exclude private warnings and deterministic coverage is retained',()=>{
 const result=description(JSON.stringify({notes:'## Changes\n- Added recruits.',reviewWarnings:['Confirm balance.']}),JSON.stringify({omittedFiles:12,evidence:[{path:'Source/Main.cs',action:'edited',earlierTextAvailable:false,afterTextTruncated:true}]}));
 assert.equal(result.text,'## Changes\n- Added recruits.');assert.equal(result.reviewWarnings.length,4);assert(!convert(result.text).includes('Confirm'));assert(result.reviewWarnings.some(w=>/12 changed files/.test(w)));
 assert.equal(description('```json\n{"notes":"Files updated.","reviewWarnings":[]}\n```','{}').text,'Files updated.');
});
test('malformed model responses never fall back to public prose or overwrite the draft',()=>{
 for(const output of ['## Changes\nSome evidence is missing.','{"notes":"Good"}','{"notes":"","reviewWarnings":[]}','{"notes":"Good","reviewWarnings":"Private"}','{"notes":"Good","reviewWarnings":[{}]}'])assert.throws(()=>description(output,'{}'),/separate release notes/);
});

const playerEvidence=JSON.stringify({schemaVersion:2,comparison:'published',evidence:[{id:'file-1',path:'Source/Targeting.cs',action:'edited',earlierTextAvailable:true},{id:'file-2',path:'Defs/Armor.xml',action:'edited',earlierTextAvailable:true}],definitionChanges:[{id:'definition-1',label:'scale armor'}]});
const item=(section,text,evidenceIds=['file-1'])=>({section,text,evidenceIds});
const draft=(changes,reviewWarnings=[])=>JSON.stringify({changes,reviewWarnings});

test('referenced changes become grouped player notes without IDs, duplicate items or private commentary',()=>{
 const result=description(draft([
  item('fixes','Fixed archers occasionally targeting friendly pawns.'),
  item('improvements','Scale armor now provides more protection against sharp attacks.',['definition-1','file-2']),
  item('new_features','You can now recruit mercenaries.'),
  item('fixes','Fixed archers occasionally targeting friendly pawns.'),
  item('removed','Removed the obsolete training order.'),
 ],['Check changes outside captured source.']),playerEvidence);
 assert.equal(result.text,'## New features\n- You can now recruit mercenaries.\n\n## Improvements\n- Scale armor now provides more protection against sharp attacks.\n\n## Fixes\n- Fixed archers occasionally targeting friendly pawns.\n\n## Removed\n- Removed the obsolete training order.');
 assert(!result.text.includes('file-'));assert(!result.text.includes('definition-'));assert(!result.text.includes('Check changes'));assert.equal((result.text.match(/Fixed archers/g)||[]).length,1);
 const steam=convert(result.text);assert(steam.includes('[h2]Improvements[/h2]'));assert(steam.includes('[*]Scale armor'));assert(!steam.includes('Check changes'));
});

test('missing or invented evidence IDs and malformed sections cannot enter generated notes',()=>{
 for(const change of [item('fixes','Fixed targeting.',[]),item('fixes','Fixed targeting.',['missing']),item('fixes','Fixed targeting.',['file-1',5]),item('made_up','Something.'),item('fixes',''),null])assert.throws(()=>description(draft([change]),playerEvidence),/invalid item|matching evidence/);
 assert.throws(()=>description(JSON.stringify({notes:'Old unverified output',reviewWarnings:[]}),playerEvidence),/separate release notes/);
 assert.throws(()=>description(JSON.stringify({changes:[],notes:'extra',reviewWarnings:[]}),playerEvidence),/separate release notes/);
});

test('raw code paths and internal citations fail instead of becoming public notes',()=>{
 for(const text of ['Updated Targeting.cs.','Changed Defs/Armor.xml.','Updated Textures/Bird.png.','Edited Settings.json.','Improved targeting [file-1].','Changed <ThingDef>.','**New feature**','[b]New feature[/b]'])assert.throws(()=>description(draft([item('improvements',text)]),playerEvidence),/file details|internal references/);
});

test('a no-detail result explains why no draft was made instead of emitting a generic public note',()=>{
 const evidence=JSON.stringify({schemaVersion:2,omittedFiles:3,omittedDefinitions:2,evidenceWarnings:['Changed bytes are outside the captured text.'],evidence:[{id:'file-1',path:'Source/Large.cs',action:'edited',earlierTextAvailable:false,excerptTruncated:true}]});
 assert.throws(()=>description(draft([]),evidence),error=>/No update notes were generated\./.test(error.message)&&/3 changed files/.test(error.message)&&/outside the captured/.test(error.message)&&/existing notes were kept/.test(error.message)&&!error.message.includes('Mod files updated.'));
 assert.throws(()=>description(draft([]),playerEvidence),/No update notes were generated/);
 assert.throws(()=>description(draft([item('improvements','Mod files updated.')]),playerEvidence),/No update notes were generated/);
 const result=description(draft([item('improvements','Mod files updated.'),item('fixes','Fixed the menu.')]),playerEvidence);assert.equal(result.text,'## Fixes\n- Fixed the menu.');
});

test('missing history does not discard a specific supported item or leak coverage warnings publicly',()=>{
 const evidence=JSON.stringify({schemaVersion:2,evidence:[{id:'file-1',path:'Source/Contract.cs',action:'edited',earlierTextAvailable:false,currentTextAvailable:true,changeExcerpt:'bool CanDeploy(Contract contract) => contract.Mode == mode;'}]});
 const result=description(draft([item('improvements','The deployment check uses the selected contract mode.')],['Earlier source is unavailable, so the prior behavior is unknown.']),evidence);
 assert.equal(result.text,'## Improvements\n- The deployment check uses the selected contract mode.');assert(!result.text.includes('unavailable'));assert(result.reviewWarnings.some(w=>/Earlier text/.test(w)));assert(result.reviewWarnings.some(w=>/prior behavior/.test(w)));
});

test('no-draft explanations are bounded and never become public text',()=>{const warnings=Array.from({length:10},(_,i)=>'Reason '+i+' '+ 'word '.repeat(295));assert.throws(()=>description(draft([],warnings),playerEvidence),error=>/No update notes were generated/.test(error.message)&&error.message.length<1500);});

test('generated note length is bounded without silently cutting or truncating claims',()=>{
 const changes=Array.from({length:8},(_,i)=>item('improvements',i+' '+ 'word '.repeat(130)));
 assert.throws(()=>description(draft(changes),playerEvidence),/too long for the update note/);
 const result=description(draft([item('fixes','Fixed the menu.')],Array.from({length:20},(_,i)=>'Private '+i)),JSON.stringify({schemaVersion:2,evidence:[{id:'file-1'}],evidenceWarnings:Array.from({length:40},(_,i)=>'Coverage '+i)}));assert(result.reviewWarnings.length<=23);assert.equal(result.text,'## Fixes\n- Fixed the menu.');
});
