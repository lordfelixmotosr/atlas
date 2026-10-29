// @ts-nocheck
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PublishConfirmDialog} from '../src/components/mod-publish/publish-confirm-dialog';
import {ModChangesButton} from '../src/atlas/mod-changes-ui';

const generatedNotes='## New features\n- Recruit guards to defend your colony.\n\n## Improvements\n- Guard armor now offers more protection against sharp attacks.\n\n## Fixes\n- Fixed guards occasionally targeting friendly pawns.';
let report={status:'modified',label:'Unpublished changes',description:'Three files changed.',count:3,files:[],features:{added:['Guard recruitment mod code — Source/GuardRecruitment.cs'],changed:['ArmorRating_Sharp: 0.2 → 0.3','GuardTargeting mod code'],removed:[]},descriptionKey:'fixture',featureDescription:location.search.includes('empty')?'':'## Features\n- **Guards:** Recruit guards.',reviewWarnings:['PRIVATE: Some changed files were omitted.'],lastModifiedAt:Date.now(),lastPublishedAt:Date.now()-86400000,lastUpdatedAt:null,baselineAt:Date.now()-86400000};
window.fixtureCalls={generate:[],comparisons:[],save:[],cancel:0,confirm:[]};
window.confirmResult=true;
window.notesGenerationFailure='';
window.confirm=message=>{window.fixtureCalls.confirm.push(message);return window.confirmResult;};
window.modmixer={
 modChanges:async(_folder,comparison)=>{window.fixtureCalls.comparisons.push(comparison);return {...report,descriptionKey:'fixture-'+comparison};},
 cancelModDescription:async()=>{window.fixtureCalls.cancel++;window.rejectNotesGeneration?.(new Error('Description cancelled.'));},
 generateModDescription:async(folder,comparison,key)=>{window.fixtureCalls.generate.push({folder,comparison,key});await new Promise((resolve,reject)=>{window.finishNotesGeneration=resolve;window.rejectNotesGeneration=reject;});if(window.notesGenerationFailure)throw new Error(window.notesGenerationFailure);report={...report,featureDescription:generatedNotes,reviewWarnings:['PRIVATE: Uncertain artwork changes require review.']};return {...report,descriptionKey:key};},
 saveModDescription:async(_folder,_comparison,key,text)=>{window.fixtureCalls.save.push(text);report={...report,featureDescription:text};return {...report,descriptionKey:key};},
 markModUpdated:async(_folder,note)=>{window.savedUpdateNote=note;return report;}
};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedNotes=text;}}});
const publish=location.search.includes('publish');
createRoot(document.getElementById('root')!).render(publish ? <PublishConfirmDialog open isUpdate modName="Fixture mod" supportedVersions={['1.6','1.7']} releaseSummary="3 files · Runtime files only" releaseWarnings={[]} initialTrackOnLeaderboard={false} onCancel={()=>{window.cancelled=true;}} onConfirm={result=>{window.submitted=result;}}/> : <ModChangesButton mod={{folder:'fixture',about:{name:'Fixture mod'}}} busy={false}/>);
