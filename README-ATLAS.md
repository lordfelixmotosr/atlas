# Atlas 0.2.4 portable

Atlas is a Windows x64 fork of ModMixer 0.10.5 maintained by Felix, with your stag logo, portable storage, and signed knowledge and skill updates. This release supports **RimWorld**. Minecraft is disabled in both game registries and its tools, grammar, bridge JAR and reference pack are excluded. Atlas's application and UI are now compiled from TypeScript/React source.

## Run it

1. Extract the complete portable ZIP to a writable folder, such as `D:\Atlas`. Keep `Atlas.exe`, `resources`, `tools` and the other runtime files together.
2. Run `Atlas.exe`. Complete setup, sign in to your chosen AI provider, and select RimWorld if it is not detected.
3. Open **Knowledge & Skills** in the top toolbar to manage the library.

No installer or administrator access is required. The executable is a locally built, unsigned Windows app. It is separate from the original ModMixer installation. Use one app at a time when using the in-game monitoring or live bridge: those inherited bridges share local ports.

## 0.2.4 sign-in, workspace and responsiveness

OpenAI account login now shares account-name validation with credential storage, fixing the missing-helper error when choosing **Sign in to OpenAI**. Both account slots and saved account names are preserved.

Choose **Compact editor** in the workspace toolbar to reduce the middle panel to about 320 pixels and hide its file list. Drag the divider to shrink the middle panel further, down to 260 pixels on desktop layouts; arrow keys also resize it, and double-click resets the chat width. **Hide editor** gives chat the whole workspace, while **Show editor** restores it without discarding an unsaved draft. **Show files / Hide files** controls the file list separately. Layout choices are remembered locally; narrow windows keep the stacked layout.

The file list now renders only visible rows and can scroll beyond the former 300-row display limit. Search uses a cached filename index. Directory browsing runs asynchronously, avoids unused per-file size checks, and batches rapid file-change refreshes; hidden editor panels pause scans and refresh when reopened. Idle chats stop the three-second activity polling that repeatedly reloaded their transcript. Active task recovery and final status reconciliation remain enabled. These changes reduce UI work; they do not change provider response speed or token usage.

## 0.2.3 task progress

Active chat tasks show a thin animated progress bar below the current agent phase, elapsed time and last activity. It works during model thinking, tool execution, receiving a reply and context compaction. Provider retry waits pause the animation. The bar disappears when the task finishes or is stopped, and respects reduced-motion preferences. Model tasks have no known total, so the bar does not claim a percentage or estimate a finish time.

## 0.2.2 additions

On **Home**, choose **Import ModMixer mods**. Atlas detects the old Windows ModMixer profile and shows a review list with every RimWorld project selected, including archived mods. **Choose folder** supports another profile, a portable ModMixer folder, its `workspace` folder or `workspace/Mods`. Search and deselect individual projects if needed, then choose **Import all**.

Close ModMixer before copying so its files stay consistent. Atlas copies mod files, binary assets, source code, Workshop IDs, schematics and preferences into new Atlas project folders. Original files are not moved or changed. Copied `.modmixer` metadata becomes `.atlas`; existing Atlas metadata takes priority, with conflicting legacy files preserved under an `imported-legacy-*` folder. Build caches (`bin`, `obj`, `.vs`), Git internals and `node_modules` are excluded.

Repeating an import from the same source workspace skips completed copies using per-project import receipts. Distinct projects with the same name or package ID remain separate. Minecraft, linked folders/files and projects missing RimWorld `About/About.xml` are reported as skipped or failed; the single **Import mod** option can handle unfinished mod folders. Chats, save history, account sign-ins and workspace-wide settings are not imported. The **Stop import** button keeps complete projects and discards the incomplete staged copy. Errors are shown per mod; scan again after resolving them to retry. Importing does not enable a mod in RimWorld or publish it.

**Queued steering:** each pending instruction has a **Cancel** button, with **Cancel all** when several are queued. These buttons withdraw instructions before they are delivered to the agent, including their image attachments, without stopping the current request. An instruction already being applied cannot be recalled. **Stop** still interrupts the active request.

**Mod changes:** Home tiles show whether a mod has changed since its last publication or marked update, along with the last content change detected. Open a mod and choose **Changes** next to **Launch in RimWorld** to see added, edited and removed files, definition names and labels, category summaries, saved release notes, and file-location buttons. Compare with the latest baseline, the last Workshop publication, or the last marked update. **Mark this version updated** saves a local comparison and optional description; it does not upload to Steam. Successful Workshop publications automatically save the actual staged upload as their comparison, so edits made during uploading remain unpublished changes.

Comparison records live in the workspace's `.atlas/mod-changes` folder, outside individual mod snapshots. Atlas cannot reconstruct changes made before its first saved comparison. Descriptions are based on file contents and named XML definitions, without a model request; they do not claim to infer gameplay effects. Cache files and Atlas preferences are excluded. Linked content is reported as unavailable rather than followed.

## What's new in 0.2.0

- **Workspace:** collapsible project navigation, source editor and asset preview in the center, and resizable or hideable chat. XML, C#, and text files can be edited with Ctrl+S. Conflicting external edits are detected before saving.
- **Agent progress:** actual work phase, elapsed time, last activity, and waiting or retry explanations. Steering, resume, manual compaction, two OpenAI accounts, Fast speed, usage, and the saved sentence shortcut remain available.
- **Assets:** direction and body variants are grouped together, with search, folder/status filters, compact view, pagination, thumbnails, and file location buttons. Select a group or a page for batch replacement. A preview shows exact path matches and affected references; existing files are backed up. Changed files invalidate the preview.
- **Recovery:** signed update status shows its source and last check. After an updater installation, a separate watcher checks that the window and app API start successfully. A failed startup restores the previous application files while keeping private data.
- **Future games:** a versioned adapter interface and starter template. The Knowledge & Skills panel displays local adapter manifests. A manifest alone cannot enable a game; its source adapter must be reviewed, implemented, and compiled.
- **Consistent UI:** neutral charcoal and gray surfaces with soft blue accents, readable controls, coordinated spacing, focus states, and dialogs across workspace, setup, chat, assets, settings, and library.

To update an existing Atlas folder manually, close Atlas, keep a backup of that folder, and extract the **application-update ZIP's Atlas folder contents** into it. Keep your existing `data`, `custom`, `library`, and `updates` folders. The **portable ZIP** is for a fresh folder. Manual replacement does not run the startup recovery watcher; use Restart and install from a signed local feed for that recovery flow.

## 0.2.1 corrections

The green surfaces have been replaced with neutral charcoal, gray borders, and restrained blue accents. New mod metadata uses `.atlas`: preferences, schematics, C# asset manifests, and placeholder records. The hidden folder is needed for Atlas's mod management; it is excluded from Workshop uploads.

When Atlas opens metadata in an older project, it renames `.modmixer` to `.atlas` if the Atlas folder does not already exist. The whole directory is preserved, including unknown files. If both folders exist, Atlas prefers matching files in `.atlas` and keeps the legacy files without overwriting either folder. Old history saves remain readable.

## What moves with Atlas

| Folder | Contents |
| --- | --- |
| `data/profile` | Settings, chats, account profiles and mod workspace (`workspace/Mods`) |
| `data/cache` | Browser cache |
| `data/forge` | Rebuildable local Forge indexes and reports |
| `library/packs` | Installed, versioned, managed reference packs |
| `custom/skills` | Your own skills; matching names override managed skills |
| `custom/references`, `custom/art-profiles` | Your private references and style notes |
| `custom/game-adapters` | Local adapter manifests for future source integration |
| `updates` | Bundled offline signed starter feed |
| `backups` | Application files saved before updates |

Close Atlas before copying the entire folder to another drive or computer. External game, Steam, attachment and exported-mod paths may need selecting again. Windows encrypts stored credentials for the current user and machine; sign in again on a new computer. Keep your used Atlas folder private. The delivered ZIP contains no user account credentials or private mod projects.

## Knowledge, code and image skills

Four starter packs are bundled: **RimWorld Core**, **C# & Harmony**, **RimWorldForge**, and **RimWorld Art**. The coding packs include XML and C# references, framework recipes, schemas, validation and log diagnostics. The art pack includes asset briefs, transparency, dimensions, direction and body variants, style consistency, and visual checks. It does not add a paid image generation service or change model weights. Your configured image provider or imported images remain necessary for raster generation.

Atlas discovers managed `SKILL.md` files and reads references on demand. **Open reference file** uses Atlas's read-only viewer, including for Python/C# examples and SVG source. It does not execute the file through Windows associations. Custom skills stay outside managed pack folders. Installed game files and dependency versions remain the authority for exact API and Def fields. Rebuild the game index after changing the game or dependencies; Forge also checks build/DLC changes and index age.

Bundled Forge validation runs through `tools/python/python.exe tools/forge/forge_bridge.py`. Python, Forge, and a personal copy of the public Git Bash runtime are included. Atlas rebases its agent shell path when the folder moves and keeps Git configuration under `data/git`. C# builds can still require the .NET SDK, which the inherited tool provisioning handles separately. First-time downloads, AI authentication and model calls require internet access.

## Automatic updates

**Auto-update daily** is enabled by default. Atlas checks the selected signed feed when the last library check is over 24 hours old, then checks periodically while running. Compatible reference updates are verified and installed into a new version folder; activation waits for active work to finish. Open chats retain their existing prompt references, and previous folders are kept. Use **Revert** to restore a previous pack for new chats. Offline or rejected downloads leave the installed library available.

Application releases use the same signed feed. Atlas downloads verified app updates automatically during scheduled checks and offers **Restart and install**. It refuses to restart during active agent or account work. The helper verifies the ZIP again, rejects unsafe/private paths, and backs up replaced application files. It restores them if replacement fails, or if the new process fails to confirm a working window and app API within two minutes. Private `data`, `custom` and `library` files are retained. This checks startup, not every later feature; a crash after startup confirmation does not trigger rollback. This release has no schema migrations; future migrations need separate compatibility and recovery tests.

**Online updates use [Felix's Atlas releases](https://github.com/lordfelixmotosr/atlas/releases).** The default source is `https://github.com/lordfelixmotosr/atlas/releases/latest/download/`. On upgrading to 0.2.2, the former bundled `updates` default moves to this online feed once; custom sources and disabled automatic checks are preserved. Choose the local `updates` folder in Update source to use only the bundled offline feed. Downloads follow only this repository's release redirects and GitHub's release asset host, with credentials omitted. Each feed and pack still requires the trusted signature and each application archive must match its signed checksum.

Atlas checks only the selected signed feed. It does not scrape arbitrary repositories or automatically execute downloaded skill examples. A third-party Forge or skill repository is source material for a reviewed pack. Publishing new reviewed versions is the maintainer's responsibility; automatic checks cannot create new knowledge on their own. New remote releases expire after 90 days unless renewed, while installed verified packs remain usable offline.

## Prepare signed local updates

The source fork includes `scripts/atlas/publish-packs.cjs`. Pack sources are in `packs`; update `pack.meta.json` versions when changing content. Each pack contains its own upstream license and source link. Review upstream changes, validate against the supported game build, update the pack, then publish:

```powershell
node scripts/atlas/publish-packs.cjs packs release-feed release-tools/publisher.private.pem
```

The local private signing key is generated in `release-tools/publisher.private.pem` during the first build. It is **excluded from the portable ZIP and Git**. Keep an offline backup: future updates for this build must use the matching key. To include an application update, place its ZIP in the local feed and pass a JSON file as the fourth argument with `version`, `file`, `size`, and the ZIP's lowercase `sha256`. Use an **application-update ZIP**, which excludes the portable data/feed folders. Point Update source to the local feed folder to use it.

Reference packs may contain documentation, skills, images and source examples, but never executable installers. Signed envelopes, SHA-256 hashes, safe Windows paths, expiry, release sequencing and Atlas version requirements are checked. Cached signed packs continue to work after their feed expires; new remote expired releases are rejected. Changed installed files cannot silently become managed agent skills. Modify your own files under `custom` instead.

For GitHub publishing, push reviewed source to `lordfelixmotosr/atlas`, then upload the signed feed JSON files, portable ZIP, application-update ZIP and checksums as assets on the same release. `scripts/atlas/github-release.cjs publish` prepares a draft, verifies any already-uploaded draft assets by SHA-256, and publishes after all assets are present. It uses the existing Git credential in memory; the credential and private signing key are never packaged or published. Keep the signing key backed up privately. GitHub's automatic source archive is available separately from the Windows runtime ZIPs.

## Build and extend

`scripts/atlas/native-build.mjs` compiles the main process, preload, workshop helper, and React UI from source with Vite. Electron, native bindings, provider connectors, and public tools are reused from an extracted Atlas portable release. These dependencies are not rebuilt from their source. The builder excludes that runtime's `data`, `custom`, `library`, and `backups` folders, preserves Electron ASAR integrity, and writes `atlas-build.json` checksums. It never copies the installed ModMixer profile.

On a new development machine, install Node.js 22 and pnpm, extract a complete Atlas portable release into a separate runtime folder, then run from this source folder:

```powershell
pnpm --dir build-tools/native install --frozen-lockfile --ignore-scripts
New-Item -ItemType Junction -Path node_modules -Target (Resolve-Path build-tools/native/node_modules)
$env:ATLAS_RUNTIME_BASE = 'D:\Atlas-runtime'
node build-tools/native/node_modules/typescript/bin/tsc -p tsconfig.atlas.json --noEmit
node --test tests/*.test.cjs
node scripts/atlas/native-build.mjs
```

Create the `node_modules` junction only when that path does not already exist. The isolated compiler dependencies and lockfile are under `build-tools/native`; lifecycle scripts are not needed. The output is `dist/Atlas-<version>`. Use a separate extracted runtime folder, never the output folder. For compilation without staging, add `--compile-only`. The earlier `scripts/atlas/build.cjs` is retained as the initial runtime bootstrap tool; the current build entry point is the native builder. One-time source migration scripts are retained for provenance and must not be rerun.

Future games should provide a descriptor (capabilities, setup and labels), a main-process adapter (discovery, indexing, scaffold, build/test and publishing), game-specific reference packs and validation fixtures. Start with `templates/game-adapter/README.md`; a copy is included at `resources/atlas/game-adapter-template` in the portable release. Register reviewed implementations through `src/atlas/game-plugins.ts` and compile a new release. Only RimWorld is active in this release.

Upstream licenses and notices are retained. `LICENSE` and `NOTICE` cover the inherited ModMixer source; Forge and Python notices are included with their tools. Your original logo is preserved in `assets/atlas/logo-source.png`.

## Branding and verification

Chat, confirmation, library and provider setup labels use Atlas. Windows product metadata identifies Atlas 0.2.4 maintained by Felix. The local OpenAI/Claude browser callback page uses the stag logo; provider-owned sign-in/consent pages and registered OAuth identities remain controlled by the provider. Legacy internal IPC names, bridge package IDs and project sidecars are retained for compatibility. Required upstream authorship stays in LICENSE, NOTICE and source provenance. Old product website links and leaderboard registration are removed from the Atlas workflow.

Verification: source type checking; 63 automated tests covering signed packs and update validation, restricted GitHub redirects, startup recovery, source-file boundaries and conflicts, bulk replacement and backups, account/steering/compaction lifecycle, metadata migration, bulk ModMixer import and cancellation, withdrawing queued steering, and content comparisons across publications and updates; native Electron rendering, library IPC, reference viewer, synthetic mod import and change-report IPC; browser UI checks with synthetic projects. No live model request, provider account sign-in, or Steam upload was performed for this release.
