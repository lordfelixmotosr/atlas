'use strict';
// Records the already-tested build and signs its release feed. Never prints keys.
const fs=require('node:fs'),path=require('node:path');
const {sha,verifyEnvelope}=require('../../src/atlas/library.cjs');
const root=path.resolve(__dirname,'../..'),out=path.resolve(root,'../outputs');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const verificationPath=process.env.ATLAS_RELEASE_VERIFICATION||path.join(root,'build-check/empty-notes-final-verification.json');
const verification=JSON.parse(fs.readFileSync(verificationPath));
if(verification.version!==version||!verification.regressionPassed||!verification.typecheckPassed||!verification.startupPassed||!verification.secondLaunchPassed)throw new Error('Supply a passing verification receipt for this release with ATLAS_RELEASE_VERIFICATION.');
const checks=JSON.parse(fs.readFileSync(path.join(out,'Atlas-'+version+'-checksums.json')));
for(const kind of ['portable','full-update','application-update']){
 const entry=checks[kind];
 if(!entry||path.basename(entry.path)!==entry.path||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Missing or invalid '+kind+' release metadata.');
 if(fs.statSync(path.join(out,entry.path)).size!==entry.size)throw new Error('Release archive size differs for '+kind+'.');
}
const project=JSON.parse(fs.readFileSync(path.join(root,'atlas.project.json')));
project.version=version;
project.status='Atlas '+version+' native source release built and verified';
project.implementation.runtime='Atlas TypeScript/React application compiled from source; Electron, native bindings, connectors and public tools reused from an Atlas portable runtime';
project.implementation.sources='src, templates/game-adapter';
project.implementation.applicationRollback='Verified application replacement with backups; startup window/API health check and failed-startup rollback; private data retained; no data migrations';
project.implementation.newGames='Versioned source adapter interface and starter template; local manifests are informational until a reviewed adapter is compiled; RimWorld only';
project.implementation.helperTeams='Efficient or match-main helpers; four concurrent by default and up to eight; only eligible models on the current provider; main thinking preferences retained; implementation helpers use isolated reviewed text patches';
project.implementation.helperRecovery='20-minute routine research and 30-minute implementation/review budgets, manual 15-minute extensions up to two hours; saved partial patches can be reviewed and explicitly applied before continuing remaining work; connection inactivity remains separate';
project.implementation.previewProtection='AI previews are separate proposals requiring explicit application; existing PNG/GIF artwork is preserved during unrelated coding, with recovery backups and reported paths on failure';
project.implementation.playerNotes='Focused changed-file evidence, full source captured for future baselines, and read-only history recovery requiring exact baseline hashes; plain-language player notes, private warnings, and an explicit no-draft result instead of a generic public fallback';
project.implementation.claudeAuthentication='Serialized sign-in, cancellation and usage-refresh authentication; rate-limit cooldowns are respected without automatic request retries';
project.repository='https://github.com/lordfelixmotosr/atlas';
project.libraryDesign.onlinePublishing='Signed GitHub Release assets from lordfelixmotosr/atlas; restricted release redirects, daily checks, offline starter feed retained';
project.buildPhases=project.buildPhases.filter(entry=>!entry.startsWith(version+':'));
project.acceptanceResults.passed=project.acceptanceResults.passed.filter(entry=>!entry.startsWith(version+' '));
project.buildPhases.push(version+': Helpers, preview preservation and player-facing change notes, including complete source evidence and explicit failure handling');
project.acceptanceResults.passed.push(
 version+' '+verification.regressionTests+' regression tests passed for the current repair; source type checking and packaged startup/second-launch verification passed',
 version+' isolated native UI checks passed for notes, private warnings, draft preservation and no automatic generation retries; prior helper/preservation checks retained',
 version+' repaired RimContractors comparison inspected read-only: all seven changed source/XML files have readable evidence, with recovered earlier source accepted only after complete baseline hash matching; no live provider request or Workshop upload used for this verification'
);
project.release=checks;
fs.writeFileSync(path.join(root,'atlas.project.json'),JSON.stringify(project,null,2)+'\n');
fs.copyFileSync(path.join(out,'Atlas-'+version+'-checksums.json'),path.join(root,'release-result.json'));
const application=checks['application-update'],full=checks['full-update'];
const runtimeChecks=['tools/python/python.exe','tools/git/bin/bash.exe','resources/better-sqlite3/build/Release/better_sqlite3.node'].map(relative=>({path:relative,sha256:sha(fs.readFileSync(path.join(root,'dist/Atlas-'+version,relative)))}));
const manifest={version,file:application.path,size:application.size,sha256:application.sha256,minimumVersion:'0.2.2',runtimeChecks,full:{file:full.path,size:full.size,sha256:full.sha256}};
fs.writeFileSync(path.join(root,'build-check/application-release.json'),JSON.stringify(manifest,null,2));
const feed=path.join(out,'Atlas-update-feed');fs.mkdirSync(feed,{recursive:true});
for(const entry of [full,application])fs.copyFileSync(path.join(out,entry.path),path.join(feed,entry.path));
require('./publish-packs.cjs').publish(path.join(root,'packs'),feed,path.join(root,'release-tools/publisher.private.pem'),manifest);
const trust=JSON.parse(fs.readFileSync(path.join(root,'dist/Atlas-'+version,'resources/atlas/trust.json')));
const signed=verifyEnvelope(fs.readFileSync(path.join(feed,'index.atlas.json')),trust);
if(signed.application?.version!==version||signed.application.sha256!==application.sha256||signed.application.full?.sha256!==full.sha256)throw new Error('Signed release feed differs from the verified application metadata.');
fs.writeFileSync(path.join(out,'Atlas-'+version+'-UPDATE.txt'),`Atlas ${version} — Felix

Fresh installation: extract the portable ZIP into a writable folder and run Atlas.exe.
Existing installation: open Settings > Updates, check for updates, then choose Install and restart when ready. Your profile, mods, chats and account settings remain in data.
Signed update source:
https://github.com/lordfelixmotosr/atlas/releases/latest/download/

Included since 0.3.2:
- Helpers: Efficient mode, four simultaneous helpers by default and up to eight. Routine research can use an eligible lighter model on the current provider; implementation and complex work keep the main model and requested thinking.
- Helper recovery: routine research has 20 minutes; implementation, reviews and complex research have 30. Extend running work by 15 minutes at a time, up to two hours. Review saved partial patches before explicitly applying them, then continue remaining work. The separate connection watchdog still stops requests after ten minutes without response data.
- Preview preservation: requested AI previews remain proposals until Use this preview is chosen. Unrelated coding preserves the existing PNG/GIF preview; recovery copies and paths are retained if restoration fails.
- Player update notes: explain known changes in everyday language, group related outcomes and keep private warnings out of public text. Changed source is read on demand; older source is recovered only when its full hash matches the selected baseline. Empty AI results keep the existing draft and report why no notes were generated.
- Claude sign-in: serialized sign-in and background usage authentication, with cancellation and rate-limit cooldown handling. Provider availability and limits still apply.

Current model, thinking and speed preferences, project paths, mods, chats, saved notes and account sign-ins are preserved. No user mod source, saved publication baseline or Workshop content was changed while verifying this release.

Validation: ${verification.regressionTests} regression tests, source type checking, packaged startup and second-launch checks, native notes UI checks, and read-only inspection of the repaired real mod comparison passed. AI responses and Steam uploads in tests were simulated; no live provider request or Workshop upload was used to validate wording.

Knowledge updates require reviewed versions published by the maintainer. Existing packs work offline. Windows executable code signing is separate from Atlas's signed feed and pack envelopes.
See README-ATLAS.md for details.
`);
console.log('Recorded Atlas '+version+' release and refreshed its locally verified signed feed.');
