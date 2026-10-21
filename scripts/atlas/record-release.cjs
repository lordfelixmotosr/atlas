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
project.buildPhases.push(version+': Uninstall from RimWorld in the existing mod menu; retain workspace and publication identity; serialized atomic removal with Windows lock checks');
project.implementation.modUninstall='Owned runtime/junction only; game closed and no active agent/build work; preserves workspace/chats/Workshop/subscriptions/load order; atomic move outside Mods with bounded retries and explicit cleanup paths; durable removal marker prevents automatic reinstallation';
project.acceptanceResults.passed.push(version+' 51 uninstall, install, runtime history/release and scan regression tests passed, including native Windows DLL and directory locks; source type checking passed',version+' isolated native UI verified menu visibility, named confirmation, cancellation without IPC, blocked removal, project retention and bounded narrow layout; production startup and second-launch checks passed',version+' portable, full-update and compact application ZIPs passed CRC, private-folder exclusion and receipt hash checks; no user game mod was uninstalled during verification');
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
Open a project and choose More mod actions (the three-dot menu) > Uninstall from RimWorld. The option appears for Atlas-managed runtime copies and older workspace junctions. Confirm the named game copy to remove it while keeping the Atlas project, source files, chats and publication identity.
Save and close RimWorld first. Active agent work or C# compilation blocks removal. Uninstall shares the install queue and checks Windows file locks. The runtime moves outside Mods before cleanup; any retained cleanup folder is reported. Ordinary launches and library scans do not recreate a successfully removed runtime. Test or Sync can explicitly install it again.
Workshop files/subscriptions, the normal ModsConfig.xml and saved runtime history remain unchanged. A subscribed Workshop copy can still appear in the game. Current thinking preferences, project paths, mods, chats and saved accounts are preserved.

Validated with 51 runtime/install/uninstall regression checks, real Windows DLL/directory sharing locks, source type checking, isolated native UI checks and production startup/second-launch checks. No user game mod was removed during verification.
Knowledge updates require reviewed versions published by the maintainer. Existing packs work offline. Windows executable code signing is separate from Atlas's signed feed and pack envelopes.
See README-ATLAS.md for details.
`);
console.log('Recorded Atlas '+version+' release and refreshed its local signed feed.');
