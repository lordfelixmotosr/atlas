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
