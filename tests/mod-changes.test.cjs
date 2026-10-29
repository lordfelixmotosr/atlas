const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../build-tools/native/node_modules/typescript');
function load(file,cache=new Map()){
 const full=path.resolve(__dirname,'../src',file);if(cache.has(full))return cache.get(full).exports;
 const module={exports:{}};cache.set(full,module);
 const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const localRequire=id=>id.startsWith('.')?load(path.relative(path.resolve(__dirname,'../src'),path.resolve(path.dirname(full),id+'.ts')),cache):require(id);
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Buffer,console,process,Set,Map,Date})(localRequire,module,module.exports);return module.exports;
}
const api=load('atlas/mod-changes.ts'),base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(t){const area=fs.mkdtempSync(path.join(base,'changes-')),root=path.join(area,'Mods/project');fs.mkdirSync(root,{recursive:true});t.after(()=>{assert(area.startsWith(base+path.sep));fs.rmSync(area,{recursive:true,force:true})});return{area,root,state:path.join(area,'Mods/.atlas/mod-changes/project/state.json')};}
function write(root,file,text){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);}
const xml=(name,label)=>`<Defs><ThingDef><defName>${name}</defName><label>${label}</label></ThingDef></Defs>`;

test('runtime-only publication retains local source inputs in the change baseline',async t=>{
 const {root}=fixture(t);write(root,'Source/Mod.cs','class Before {}');write(root,'Defs/Thing.xml',xml('Fixture','old'));
 const inputs=await api.collectModInventory(root);const runtime={...inputs,files:{'Defs/Thing.xml':inputs.files['Defs/Thing.xml']}};
 const baseline=api.mergePublishedInventory(inputs,runtime);await api.recordModBaseline(root,'published','Runtime release',baseline);
 assert.equal((await api.readModChanges(root,null,'published')).status,'clean');
 write(root,'Source/Mod.cs','class After {}');const report=await api.readModChanges(root,null,'published');assert.equal(report.status,'modified');assert(report.files.some(f=>f.path==='Source/Mod.cs'));
});

test('starts tracking without inventing past publication history and stores state outside the mod',async t=>{
 const {root,state}=fixture(t);write(root,'About/About.xml','<ModMetaData/>');
 const report=await api.readModChanges(root,100);assert.equal(report.status,'tracking');assert.equal(report.lastPublishedAt,100);assert.equal(report.count,0);assert(fs.existsSync(state));assert(!fs.existsSync(path.join(root,'.atlas')));
 const published=await api.readModChanges(root,100,'published');assert.equal(published.status,'unavailable');assert.match(published.description,/No file snapshot/);
});
test('reports added definitions, edited code and removed assets since publication',async t=>{
 const {root}=fixture(t);write(root,'Defs/Items.xml',xml('Armor','old armor'));write(root,'Source/Mod.cs','class Old {}');write(root,'Textures/old.png',Buffer.from([0,255,1]));
 const at=Date.now();await api.recordModBaseline(root,'published','First Workshop release',undefined,at);
 write(root,'Defs/Items.xml',xml('Armor','new armor').replace('</Defs>','<ThingDef><defName>Helmet</defName><label>helmet</label></ThingDef></Defs>'));write(root,'Source/Mod.cs','class New {}');fs.unlinkSync(path.join(root,'Textures/old.png'));write(root,'Sounds/new.ogg',Buffer.from([7,8,9]));
 const report=await api.readModChanges(root,at);assert.equal(report.status,'modified');assert.equal(report.count,4);assert.equal(report.note,'First Workshop release');assert.match(report.description,/Edited 1 C# source/);assert.match(report.files.find(f=>f.path==='Defs/Items.xml').description,/Edited ThingDef Armor.*Added ThingDef Helmet/);assert.equal(report.files.find(f=>f.path==='Textures/old.png').action,'removed');
});
test('mtime-only and excluded metadata/cache changes stay clean; actual content changes are detected',async t=>{
 const {root}=fixture(t);write(root,'Source/Main.cs','original');await api.recordModBaseline(root,'updated');
 const before=await api.readModChanges(root);const future=new Date(Date.now()+10000);fs.utimesSync(path.join(root,'Source/Main.cs'),future,future);write(root,'.atlas/prefs.json','changed');write(root,'.modmixer/old.json','changed');write(root,'obj/cache','changed');write(root,'bin/compiler','changed');
 const clean=await api.readModChanges(root);assert.equal(clean.status,'clean');assert.equal(clean.lastModifiedAt,before.lastModifiedAt);
 write(root,'Source/Main.cs','different');const edited=await api.readModChanges(root);assert.equal(edited.count,1);write(root,'Source/Main.cs','original');assert.equal((await api.readModChanges(root)).status,'clean');
});
test('keeps published and marked-update comparisons separate and chooses the latest',async t=>{
 const {root}=fixture(t);write(root,'file.txt','published');await api.recordModBaseline(root,'published','public',undefined,100);
 write(root,'file.txt','updated');await api.recordModBaseline(root,'updated','private update',undefined,200);
 const latest=await api.readModChanges(root,100);assert.equal(latest.status,'clean');assert.equal(latest.baselineKind,'updated');assert.equal(latest.lastPublishedAt,100);assert.equal(latest.lastUpdatedAt,200);
 assert.equal((await api.readModChanges(root,100,'published')).status,'modified');write(root,'file.txt','third');assert.equal((await api.readModChanges(root,100,'updated')).count,1);
});
test('records uploaded staging inventory so concurrent live edits remain unpublished',async t=>{
 const {root,area}=fixture(t);write(root,'file.txt','upload');const stage=path.join(area,'staged');fs.mkdirSync(stage);write(stage,'file.txt','upload');const captured=await api.collectModInventory(stage);
 write(root,'file.txt','edited during upload');await api.recordModBaseline(root,'published','upload',captured,100);
 const report=await api.readModChanges(root,100);assert.equal(report.status,'modified');assert.equal(report.files[0].action,'edited');
});
test('a missing latest publication baseline is reported instead of comparing an older upload',async t=>{
 const {root}=fixture(t);write(root,'file.txt','one');await api.recordModBaseline(root,'published','',undefined,100);
 const report=await api.readModChanges(root,200,'published');assert.equal(report.status,'unavailable');assert.equal(report.lastPublishedAt,200);assert.match(report.description,/latest publication/);
});
test('rejects linked content and linked baseline destinations without touching their targets',async t=>{
 const {root,area}=fixture(t);const outside=path.join(area,'outside');fs.mkdirSync(outside);write(outside,'secret.txt','unchanged');fs.symlinkSync(outside,path.join(root,'linked'),'junction');
 assert.equal((await api.readModChanges(root)).status,'unavailable');await assert.rejects(api.recordModBaseline(root,'updated'),/Linked path/);fs.unlinkSync(path.join(root,'linked'));
 fs.symlinkSync(outside,path.join(area,'Mods/.atlas'),'junction');await assert.rejects(api.recordModBaseline(root,'updated'),/link|escape|directory/i);assert.equal(fs.readdirSync(outside).length,1);
});
test('persists deletion detection across restarts and preserves the publication record across mod restore',async t=>{
 const {root,state}=fixture(t);write(root,'file.txt','release');await api.recordModBaseline(root,'published','',undefined,100);fs.unlinkSync(path.join(root,'file.txt'));
 const deleted=await api.readModChanges(root,100);const restarted=load('atlas/mod-changes.ts');assert.equal((await restarted.readModChanges(root,100)).lastModifiedAt,deleted.lastModifiedAt);
 write(root,'file.txt','restored earlier content');const report=await restarted.readModChanges(root,100);assert.equal(report.lastPublishedAt,100);assert.equal(report.status,'modified');assert.equal(JSON.parse(fs.readFileSync(state)).published.at,100);
});

test('feature overview names new content and explains recorded balance changes',async t=>{
 const {root}=fixture(t);write(root,'Defs/Armor.xml','<Defs><ThingDef><defName>ScaleArmor</defName><label>scale armor</label><apparel/><statBases><ArmorRating_Sharp>0.3</ArmorRating_Sharp></statBases></ThingDef></Defs>');await api.recordModBaseline(root,'updated');
 write(root,'Defs/Armor.xml','<Defs><ThingDef><defName>ScaleArmor</defName><label>scale armor</label><apparel/><statBases><ArmorRating_Sharp>0.45</ArmorRating_Sharp></statBases></ThingDef><AbilityDef><defName>Rally</defName><label>rally allies</label><description>Rallies nearby allies to hold their position.</description></AbilityDef></Defs>');
 const report=await api.readModChanges(root);assert.match(report.features.changed.join('\n'),/scale armor.*sharp protection: 0.3 → 0.45/);assert.match(report.features.added.join('\n'),/rally allies.*Rallies nearby allies/);assert.equal(report.features.removed.length,0);
});
test('AI evidence carries actual earlier/current source and excludes credential previews',async t=>{
 const {root}=fixture(t);write(root,'Source/Rewards.cs','int Reward = 5;');write(root,'auth.json','private credential');await api.recordModBaseline(root,'published');write(root,'Source/Rewards.cs','int Reward = 8;');write(root,'auth.json','updated credential');
 const report=await api.readModChanges(root),evidence=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));const code=evidence.evidence.find(file=>file.path==='Source/Rewards.cs');assert.equal(code.before,'int Reward = 5;');assert.equal(code.after,'int Reward = 8;');assert.equal(code.earlierTextAvailable,true);assert(!JSON.stringify(evidence).includes('private credential'));assert(!JSON.stringify(evidence).includes('updated credential'));
});
test('descriptions persist only for their exact content and comparison without marking an update',async t=>{
 const {root}=fixture(t);write(root,'Source/Main.cs','one');await api.recordModBaseline(root,'published','release',undefined,100);write(root,'Source/Main.cs','two');const report=await api.readModChanges(root,100);
 await api.saveModDescription(root,'latest',report.descriptionKey,'Added a recruitment feature.','ai','Test model');const saved=await api.readModChanges(root,100);assert.equal(saved.featureDescription,'Added a recruitment feature.');assert.equal(saved.descriptionOrigin,'ai');assert.equal(saved.status,'modified');assert.equal(saved.lastPublishedAt,100);assert.equal(saved.lastUpdatedAt,null);
 write(root,'Source/Main.cs','three');const changed=await api.readModChanges(root,100);assert.equal(changed.featureDescription,'');await assert.rejects(api.saveModDescription(root,'latest',report.descriptionKey,'stale'),/changed/);await assert.rejects(api.prepareModDescription(root,'latest',report.descriptionKey),/changed/);
});
test('old baselines without source snapshots remain usable and declare missing evidence',async t=>{
 const {root,state}=fixture(t);write(root,'Source/Main.cs','before');await api.recordModBaseline(root,'published');const stored=JSON.parse(fs.readFileSync(state));delete stored.published.inventory.files['Source/Main.cs'].preview;fs.writeFileSync(state,JSON.stringify(stored));fs.rmSync(path.join(path.dirname(root),'.atlas/mod-note-sources'),{recursive:true,force:true});write(root,'Source/Main.cs','after');const report=await api.readModChanges(root);assert.equal(report.status,'modified');const evidence=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));assert.equal(evidence.evidence[0].earlierTextAvailable,false);assert.equal(evidence.evidence[0].before,null);assert.match(report.features.changed[0],/Main mod code/);
});
test('text snapshots and AI evidence are bounded and a saved description cannot use the wrong baseline',async t=>{
 const {root}=fixture(t);for(let i=0;i<25;i++)write(root,'Source/File'+i+'.cs','a'.repeat(32000));await api.recordModBaseline(root,'published','',undefined,100);write(root,'Source/File0.cs','b'.repeat(32000));await api.recordModBaseline(root,'updated','',undefined,200);for(let i=0;i<25;i++)write(root,'Source/File'+i+'.cs','c'.repeat(32000));
 const inventory=await api.collectModInventory(root);assert(Object.values(inventory.files).reduce((total,file)=>total+Buffer.byteLength(file.preview??''),0)<=512*1024);const latest=await api.readModChanges(root),evidence=await api.prepareModDescription(root,'latest',latest.descriptionKey);assert(evidence.length<=150000);const payload=JSON.parse(evidence);assert.equal(payload.omittedFiles,0);assert.equal(payload.evidence.length,25);assert(payload.evidence.some(file=>file.excerptTruncated));await assert.rejects(api.saveModDescription(root,'published',latest.descriptionKey,'wrong comparison'),/changed/);
});

test('change evidence focuses on late changed lines rather than a large unchanged prefix',async t=>{
 const {root}=fixture(t),prefix=Array.from({length:500},(_,i)=>`// Unchanged fixture line ${i}`).join('\n')+'\n';
 write(root,'Source/Targeting.cs',prefix+'bool CanTarget(Pawn pawn) { return true; }\n');await api.recordModBaseline(root,'published');
 write(root,'Source/Targeting.cs',prefix+'bool CanTarget(Pawn pawn) { return pawn.Faction != Faction.OfPlayer; }\n');
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey)),entry=payload.evidence[0];
 assert.equal(payload.schemaVersion,2);assert.equal(payload.featuresAreHeuristics,true);assert.equal(entry.id,'file-1');assert.equal(entry.before,null);assert.equal(entry.after,null);assert.equal(entry.textEvidence,'comparison');assert.match(entry.changeExcerpt,/return true/);assert.match(entry.changeExcerpt,/pawn.Faction != Faction.OfPlayer/);assert(!entry.changeExcerpt.includes('fixture line 0'));assert.match(entry.changeExcerpt,/-501\//);assert.equal(entry.excerptTruncated,false);
});

test('changes past library excerpts use full hash-verified baseline source',async t=>{
 const {root}=fixture(t),prefix='// retained prefix\n'.repeat(2200);write(root,'Source/Large.cs',prefix+'return false;');await api.recordModBaseline(root,'published');write(root,'Source/Large.cs',prefix+'return true;');
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey)),entry=payload.evidence[0];
 assert.equal(entry.changesOutsideCapturedText,false);assert.equal(entry.beforeTextTruncated,false);assert.equal(entry.afterTextTruncated,false);assert.match(entry.changeExcerpt,/return false/);assert.match(entry.changeExcerpt,/return true/);
});

test('definition relocation and byte-identical file moves are not new content or removals',async t=>{
 const {root}=fixture(t);write(root,'Defs/Old.xml',xml('Armor','scale armor'));await api.recordModBaseline(root,'published');fs.renameSync(path.join(root,'Defs/Old.xml'),path.join(root,'Defs/New.xml'));
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));
 assert.equal(payload.definitionChanges.length,1);const def=payload.definitionChanges[0];assert.equal(def.action,'relocated');assert.equal(def.sameContentMove,true);assert.equal(def.playerChangeEstablished,false);assert.equal(def.id,'definition-1');assert.equal(def.evidenceIds.length,2);assert(payload.evidence.every(file=>file.sameContentMove));assert(def.evidenceIds.every(id=>payload.evidence.some(file=>file.id===id)));
});

test('version variants retain their own values and cannot masquerade as global new content',async t=>{
 const {root}=fixture(t),armor=value=>`<Defs><ThingDef><defName>Armor</defName><label>scale armor</label><statBases><ArmorRating_Sharp>${value}</ArmorRating_Sharp></statBases></ThingDef></Defs>`;
 write(root,'1.6/Defs/Armor.xml',armor('0.2'));write(root,'1.7/Defs/Armor.xml',armor('0.3'));await api.recordModBaseline(root,'published');write(root,'1.7/Defs/Armor.xml',armor('0.4'));write(root,'1.8/Defs/Armor.xml',armor('0.4'));
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));const edited=payload.definitionChanges.find(def=>def.action==='edited'),variant=payload.definitionChanges.find(def=>def.action==='variant-added');
 assert(edited);assert.equal(edited.beforePaths[0],'1.7/Defs/Armor.xml');assert.equal(edited.fieldChanges[0].before,'0.3');assert.equal(edited.fieldChanges[0].after,'0.4');assert.equal(edited.multipleVersionOrLoadVariants,true);assert.equal(edited.fieldComparisonAmbiguous,false);assert(variant?.ambiguous);assert(!payload.definitionChanges.some(def=>def.action==='added'));assert(payload.evidence.every(file=>file.category==='Def XML'));
});

test('a move across game-version scopes is ambiguous even when its bytes are identical',async t=>{
 const {root}=fixture(t);write(root,'1.6/Defs/Armor.xml',xml('Armor','armor'));await api.recordModBaseline(root,'published');write(root,'1.7/Defs/Armor.xml',xml('Armor','armor'));fs.unlinkSync(path.join(root,'1.6/Defs/Armor.xml'));
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));assert.equal(payload.definitionChanges[0].action,'ambiguous');assert.equal(payload.definitionChanges[0].ambiguous,true);
});

test('repeated nested field names are excluded from precise definition balance deltas',async t=>{
 const {root}=fixture(t),data=value=>`<Defs><ThingDef><defName>Weapon</defName><label>bow</label><verbs><li><damageAmountBase>${value}</damageAmountBase></li><li><damageAmountBase>99</damageAmountBase></li></verbs><statBases><Mass>2</Mass></statBases></ThingDef></Defs>`;
 write(root,'Defs/Bow.xml',data('4'));await api.recordModBaseline(root,'published');write(root,'Defs/Bow.xml',data('8'));
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey)),def=payload.definitionChanges[0];assert(def.ambiguousFields.includes('damageAmountBase'));assert(!def.fieldChanges.some(field=>field.field==='damageAmountBase'));assert(payload.evidenceWarnings.some(w=>/ambiguous/.test(w)));
});

test('missing legacy definition snapshots never establish that existing content was newly added',async t=>{
 const {root,state}=fixture(t);write(root,'Defs/Armor.xml',xml('Armor','old armor'));await api.recordModBaseline(root,'published');const stored=JSON.parse(fs.readFileSync(state));delete stored.published.inventory.files['Defs/Armor.xml'].defs;fs.writeFileSync(state,JSON.stringify(stored));write(root,'Defs/Armor.xml',xml('Armor','new armor'));
 const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));assert.equal(payload.definitionCoverage.beforeComplete,false);assert.equal(payload.definitionChanges[0].action,'unconfirmed-added');assert.equal(payload.definitionChanges[0].ambiguous,true);assert(payload.evidenceWarnings.some(w=>/snapshots are missing/.test(w)));
});

test('JSON escaping cannot exceed the model evidence budget and tracking scope stays explicit',async t=>{
 const {root}=fixture(t);for(let i=0;i<60;i++)write(root,`Source/File${i}.cs`,'a'.repeat(10000));await api.readModChanges(root);for(let i=0;i<60;i++)write(root,`Source/File${i}.cs`,'\u0001'.repeat(9000));
 const report=await api.readModChanges(root),text=await api.prepareModDescription(root,'latest',report.descriptionKey),payload=JSON.parse(text);assert(text.length<=150000);assert.equal(payload.evidence.length,60);assert(payload.evidence.some(entry=>entry.excerptTruncated));assert(payload.evidenceWarnings.some(w=>/when Atlas began tracking/.test(w)));
});

test('private XML definition metadata cannot leak through summaries or changed-file descriptions',async t=>{
 const {root}=fixture(t);write(root,'credentials.xml',xml('PrivateItem','private old label'));write(root,'Source/Public.cs','before');await api.recordModBaseline(root,'published');write(root,'credentials.xml',xml('PrivateItem','private new label'));write(root,'Source/Public.cs','after');
 const report=await api.readModChanges(root),text=await api.prepareModDescription(root,'latest',report.descriptionKey),payload=JSON.parse(text);assert(!text.includes('private old label'));assert(!text.includes('private new label'));assert(!text.includes('PrivateItem'));assert.equal(payload.omittedFiles,1);assert.equal(payload.definitionChanges.length,0);assert.equal(payload.evidence[0].path,'Source/Public.cs');
});

test('private review warnings persist through editing and expire with the comparison',async t=>{const {root}=fixture(t);write(root,'Source/Main.cs','before');await api.recordModBaseline(root,'published');write(root,'Source/Main.cs','after');const report=await api.readModChanges(root);await api.saveModDescription(root,'latest',report.descriptionKey,'Added guards.','ai','Fixture',['Earlier text missing.']);let saved=await api.readModChanges(root);assert.equal(saved.reviewWarnings[0],'Earlier text missing.');assert(!saved.featureDescription.includes('missing'));await api.saveModDescription(root,'latest',report.descriptionKey,'Added recruitable guards.');saved=await api.readModChanges(root);assert.equal(saved.reviewWarnings[0],'Earlier text missing.');write(root,'Source/Main.cs','new edit');saved=await api.readModChanges(root);assert.equal(saved.reviewWarnings.length,0);assert.equal(saved.featureDescription,'');});

test('changed source outside the shared library preview budget is loaded on demand',async t=>{
 const {root}=fixture(t);for(let i=0;i<20;i++)write(root,`Defs/Bulk${i}.xml`,'<Defs><!--'+'bulk '.repeat(6400)+'--></Defs>');
 write(root,'Source/ZMission.cs','bool WaitAtEdge = false;');await api.recordModBaseline(root,'published');
 const snapshot=await api.collectModInventory(root);assert.equal(snapshot.files['Source/ZMission.cs'].preview,undefined);
 write(root,'Source/ZMission.cs','bool WaitAtEdge = true;');write(root,'Source/ZDeparture.cs','void MarchThenWait() {}');const report=await api.readModChanges(root),payload=JSON.parse(await api.prepareModDescription(root,'latest',report.descriptionKey));
 const mission=payload.evidence.find(e=>e.path==='Source/ZMission.cs'),departure=payload.evidence.find(e=>e.path==='Source/ZDeparture.cs');assert.equal(mission.earlierTextAvailable,true);assert.equal(mission.currentTextAvailable,true);assert.match(mission.changeExcerpt,/WaitAtEdge = false/);assert.match(mission.changeExcerpt,/WaitAtEdge = true/);assert.equal(departure.currentTextAvailable,true);assert.match(departure.changeExcerpt,/MarchThenWait/);
});

test('old generic AI fallback stays stored but cannot be copied as a generated public draft',async t=>{
 const {root,state}=fixture(t);write(root,'Source/Main.cs','before');await api.recordModBaseline(root,'published');write(root,'Source/Main.cs','after');let report=await api.readModChanges(root);
 await api.saveModDescription(root,'latest',report.descriptionKey,'Mod files updated.','ai','Fixture',['Missing source.']);const bytes=fs.readFileSync(state);report=await api.readModChanges(root);assert.equal(report.featureDescription,'');assert(report.reviewWarnings.includes('Missing source.'));assert(fs.readFileSync(state).equals(bytes));
 await api.saveModDescription(root,'latest',report.descriptionKey,'Mod files updated.','manual');report=await api.readModChanges(root);assert.equal(report.featureDescription,'Mod files updated.');
});

test('a live edit cannot be stored under an earlier published source hash',async t=>{
 const {root}=fixture(t);write(root,'Source/Main.cs','before');const captured=await api.collectModInventory(root);write(root,'Source/Main.cs','after');await api.recordModBaseline(root,'published','',captured);
 const capture=path.join(path.dirname(root),'.atlas/mod-note-sources',path.basename(root),captured.files['Source/Main.cs'].hash+'.txt');assert(!fs.existsSync(capture));
});
