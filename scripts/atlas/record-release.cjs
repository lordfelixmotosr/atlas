'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),out=path.resolve(root,'../outputs');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const project=JSON.parse(fs.readFileSync(path.join(root,'atlas.project.json')));
project.version=version;
project.status='Atlas '+version+' native source release built and verified';
project.implementation.runtime='Atlas TypeScript/React application compiled from source; Electron, native bindings, connectors and public tools reused from an Atlas portable runtime';
project.implementation.sources='src, templates/game-adapter';
project.implementation.applicationRollback='Verified application replacement with backups; startup window/API health check and failed-startup rollback; private data retained; no data migrations';
project.implementation.newGames='Versioned source adapter interface and starter template; local manifests are informational until a reviewed adapter is compiled; RimWorld only';
project.repository='https://github.com/lordfelixmotosr/atlas';
project.libraryDesign.onlinePublishing='Signed GitHub Release assets from lordfelixmotosr/atlas; restricted release redirects, daily checks, offline starter feed retained';
project.buildPhases=project.buildPhases.filter(entry=>!entry.startsWith(version+':'));
project.acceptanceResults.passed=project.acceptanceResults.passed.filter(entry=>!entry.startsWith(version+' '));
project.buildPhases.push(version+': Projects, Workspace, Knowledge and Settings redesign; Activity drawer; responsive focus layouts and in-memory file draft retention');
project.implementation.ui='Four main destinations, separate open-project tabs, grouped actions, searchable projects and references, full-page settings, Activity drawer; narrow workspaces show one pane at a time';
project.acceptanceResults.passed.push(version+' 45 focused editor, activity, thinking, installation and Workshop-note tests passed; source type checking passed',version+' isolated native renderer verified navigation, search, account settings, draft restoration and editing, discard cancellation, explicit discard, paused hidden-workspace scans, Activity drawer, and dark/light responsive layouts; production startup and second-launch checks passed',version+' portable, full-update and compact application ZIPs passed CRC, private-folder exclusion and receipt hash checks');
project.release=JSON.parse(fs.readFileSync(path.join(out,'Atlas-'+version+'-checksums.json')));
fs.writeFileSync(path.join(root,'atlas.project.json'),JSON.stringify(project,null,2)+'\n');
fs.copyFileSync(path.join(out,'Atlas-'+version+'-checksums.json'),path.join(root,'release-result.json'));
const application=project.release['application-update'],full=project.release['full-update'];
const runtimeChecks=['tools/python/python.exe','tools/git/bin/bash.exe','resources/better-sqlite3/build/Release/better_sqlite3.node'].map(relative=>({path:relative,sha256:require('../../src/atlas/library.cjs').sha(fs.readFileSync(path.join(root,'dist/Atlas-'+version,relative)))}));
fs.writeFileSync(path.join(root,'build-check/application-release.json'),JSON.stringify({version,file:path.basename(application.path),size:application.size,sha256:application.sha256,minimumVersion:'0.2.2',runtimeChecks,full:{file:path.basename(full.path),size:full.size,sha256:full.sha256}},null,2));
fs.copyFileSync(path.resolve(out,full.path),path.join(out,'Atlas-update-feed',path.basename(full.path)));
fs.copyFileSync(path.resolve(out,application.path),path.join(out,'Atlas-update-feed',path.basename(application.path)));
require('./publish-packs.cjs').publish(path.join(root,'packs'),path.join(out,'Atlas-update-feed'),path.join(root,'release-tools/publisher.private.pem'),JSON.parse(fs.readFileSync(path.join(root,'build-check/application-release.json'))));
fs.writeFileSync(path.join(out,'Atlas-'+version+'-UPDATE.txt'),`Atlas ${version} — Felix

Fresh installation: extract the portable ZIP into a writable folder and run Atlas.exe.
Existing installation: open Settings > Updates, check for updates, then choose Install and restart when ready. Your profile, mods, chats and account settings remain in data.
If you need to configure the signed source, open Knowledge > Knowledge update settings:
https://github.com/lordfelixmotosr/atlas/releases/latest/download/

New in this release:
Projects, Workspace, Knowledge and Settings replace the crowded toolbar. Installed mods and their load order are under Projects. Open-project tabs have their own strip. Workspace has Files, Assets, Test and Publish sections, a Layout menu and the existing assistant. Narrow windows show one workspace pane at a time. Activity opens a drawer.
Knowledge provides reference search, custom skills and pack management. Application updates have their own Settings section.
Unsaved editor tabs and undo state survive navigation and project switches. Closing a project with drafts asks before discarding. This retention is in memory, not crash recovery. Hidden workspaces pause file/asset scans and installation polling.
Current thinking preferences, project paths and accounts are preserved. Manual install previews, restore, safe runtime mirrors, changes, Workshop publication and signed update recovery remain available.

Validated with 45 focused regression checks, source type checking, isolated native UI checks and production startup/second-launch checks. UI fixtures do not call AI providers, launch RimWorld or publish to Steam.
Knowledge updates require reviewed versions published by the maintainer. Existing packs work offline. Windows executable code signing is separate from Atlas's signed feed and pack envelopes.
See README-ATLAS.md for details.
`);
console.log('Recorded Atlas '+version+' release and refreshed its local signed feed.');
