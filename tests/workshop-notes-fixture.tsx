// @ts-nocheck
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PublishConfirmDialog} from '../src/components/mod-publish/publish-confirm-dialog';
import {ModChangesButton} from '../src/atlas/mod-changes-ui';

const report={status:'modified',label:'Unpublished changes',description:'Three files changed.',count:3,files:[],features:{added:['Recruitable guards'],changed:[],removed:[]},descriptionKey:'fixture',featureDescription:'## Features\n- **Guards:** Recruit guards.',reviewWarnings:['PRIVATE: Some changed files were omitted.'],lastModifiedAt:Date.now(),lastPublishedAt:Date.now()-86400000,lastUpdatedAt:null,baselineAt:Date.now()-86400000};
window.modmixer={modChanges:async()=>report,cancelModDescription:async()=>{},generateModDescription:async()=>report,saveModDescription:async()=>report,markModUpdated:async(_folder,note)=>{window.savedUpdateNote=note;return report;}};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedNotes=text;}}});
const publish=location.search.includes('publish');
createRoot(document.getElementById('root')!).render(publish ? <PublishConfirmDialog open isUpdate modName="Fixture mod" supportedVersions={['1.6','1.7']} releaseSummary="3 files · Runtime files only" releaseWarnings={[]} initialTrackOnLeaderboard={false} onCancel={()=>{window.cancelled=true;}} onConfirm={result=>{window.submitted=result;}}/> : <ModChangesButton mod={{folder:'fixture',about:{name:'Fixture mod'}}} busy={false}/>);
