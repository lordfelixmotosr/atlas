# Atlas 0.2.16 portable

## 0.2.16 connection recovery and accurate chat activity

Codex chats now default to HTTP server-sent events instead of automatic WebSocket connections. Fast still selects priority service; Standard still selects default service. Model, thinking, context, prompt caching, account and output-limit settings are preserved. An explicitly configured transport remains respected. Claude and other providers retain their existing transport.

The chat distinguishes connecting, waiting for the model, receiving reasoning, receiving a reply and preparing a tool. After 60 seconds without response data, it displays a waiting notice. Silence alone is not treated as a lost connection. Polling the status cannot reset the response-data clock. Tool execution and context compaction have their own states; tools are not subject to the model stream inactivity timeout. Model activity has no known completion percentage.

Recognized connection failures show an actionable message and keep received text in chat history. Retry or Resume requires an explicit click; active requests and mod-writing tools are not automatically replayed. Deep thinking can still take minutes, and HTTP streaming cannot guarantee that a provider never disconnects. The existing ten-minute model stream inactivity guard remains in place. This release does not lower thinking or automatically compact conversations.

Verification uses local stream fixtures and a mocked bundled Codex provider at both speeds, plus the real Electron chat and progress components. No paid model requests are made during development tests. Transport reliability with the account and network still needs normal use after installation.

## 0.2.15 selected directions, sprite gallery and progress

Choose one, two or all three directions beside the **Design flight frames** button. All design actions use the same selected views. Other profiles let you select their required asset slots. Earlier views and approvals stay in place, and saved artwork guides later directions even before approval.

The **Gallery** tab shows individual sprites and flight frames from the working revision or all revisions. Filter by direction and artwork type, browse pages, and inspect a larger preview with its revision label. Copied unchanged artwork is grouped to avoid repeated thumbnails; the original revision history remains available.

Generation displays the selected views, model request count, elapsed time, and a Stop action. Model reply time uses an indeterminate bar. PNG rendering shows actual completed files and a percentage for that stage, followed by saving and review-ready status. Progress does not estimate remaining model time. Generated art still requires review and in-game visual testing.

## 0.2.14 apparel, hats, buildings and furniture

Sprite Studio now includes apparel, hats, buildings and furniture profiles. Apparel has one inventory icon and 15 worn overlays for the five vanilla adult body types. Hats have an inventory icon and three worn views; west mirrors east. Apparel previews offer schematic body/head fit guides. These guides assist alignment and do not prove fit in RimWorld. Juvenile and custom race body types and worn masks require additional artwork and configuration.

Buildings and furniture support four explicit rotations, including west, or a single nonrotating texture. Set the occupied tile footprint separately from the image's drawn width and height. The preview shows a schematic footprint grid. Export suggests graphics, footprint and rotation XML fields for an existing definition; gameplay behavior, materials, costs and recipes remain a separate modding step.

Choose **Import master art** when creating a family to copy an existing PNG as a reference or a selected asset view. Cancelling the picker creates no family; failed imports roll back the new family. References guide newly generated SVG artwork, while direct view imports keep the PNG's colors and still require approval. The palette control and restriction have been removed: describe colors in the design brief or use your master artwork as the reference. Large apparel requests run in batches of four views and commit one candidate only when every batch validates. Normal model usage applies to every batch.

**Archive** hides a family from the active list while retaining its artwork and history. Choose the archived filter and **Restore** to resume it. **Delete family** asks for confirmation and removes that saved family; exported mod textures and export backups are retained. Existing bird and pawn families remain compatible.

Design controls are now visible at the top of the workspace. **Design flight frames** uses the existing bird family and imported artwork to request all three layered views. Flat artwork has an explicit design action in Animation. Partial imports and revisions keep earlier working views visible; their approvals point to the actual source revision. Sprite references are sent as PNGs to preserve transparency. A selected model that cannot view images asks you to choose an image-capable model before designing from reference artwork.

Workshop preview browsing accepts animated GIFs up to 1 MiB. Atlas retains the animation for the Publish panel and Steam preview, and creates a static first-frame `About/Preview.png` for RimWorld. Static replacement clears the older GIF after a successful write; a newer generated PNG also takes precedence. Preview imports keep backups and roll back failed writes. Steam upload/display still needs testing on the target Workshop item; development verification performs no Steam publishing.

## 0.2.13 Sprite Studio

Open **Sprite Studio** beside Library to create a saved RimWorld sprite family. Choose a static sprite or Odyssey bird, describe its identity, choose a palette and canvas, and import PNG references. **Generate selected views** uses your selected connected GPT/Claude model and normal account usage to design SVG layers, which Atlas validates and renders into transparent PNGs. It uses no separate image API. Small, graphic art is the focus; model quality and visual consistency still require review.

Review south, east and north together, compare a candidate with the approved view, and approve each direction. Candidates and approvals are saved separately so a revision preserves earlier artwork. West previews mirror east, matching native RimWorld flight. Palette, canvas and animation structure stay locked after artwork exists. Recipes, reference hashes, sources, asset manifests and candidates live in `data/profile/sprite-studio`, outside your mods. That folder travels with the portable app.

Bird candidates use separate body and wing layers. Atlas holds the body, head, tail and markings fixed and poses the wings into eight full-body PNG frames per direction. The preview follows RimWorld's `(frameCount + 1) * ticksPerFrame` timing, including its final-frame hold. Grounded draw size is set separately from flight draw size. A flat imported PNG can be approved as a static direction; it cannot supply a layered flight rig. North/east/south approval is required before export. Native flight does not provide an independent west animation.

**Preview export** lists the exact PNG paths and replacement actions. Export applies only that reviewed plan, checks for intervening changes, backs up replacements outside the mod, and rolls back on a write failure. Bird exports include three grounded sprites and 24 flight textures. The suggested XML fragment is displayed for review and copying; existing definitions are not overwritten. PNG, canvas and geometry checks do not prove in-game appearance or animation quality: test the exported textures in RimWorld before publishing.

Generation has its own cancellation and Activity status. It does not steer or interrupt a mod chat. Account switching and application restart wait for sprite work to settle.

## 0.2.12 Windows startup settings recovery

Startup keeps an unchanged agent settings file in place. When the portable folder moves, shell-path updates retry temporary Windows file locks; a persistent lock preserves the existing settings and records a diagnostic in `data/logs/startup.log`. The bundled shell is also selected in memory, so agent commands can use the current Atlas folder even when its new path cannot be saved yet. This repairs the startup `EPERM` error replacing `pi-agent/settings.json`.

## 0.2.11 credits, composer and image previews

The chat toolbar groups model, thinking, speed and account controls above plan usage, credits, context and compaction. It wraps to suit the chat pane width. ChatGPT credit balances are displayed alongside included plan limits, including zero and unlimited balances when supplied by OpenAI. Unavailable balances are labeled explicitly; stale data is marked. Switching accounts clears old usage immediately, and late responses cannot display the previous account's balance.

Chat image paths resolve inside the conversation's mod. Relative paths, encoded paths with spaces, Windows absolute paths, file URLs and existing asset URLs are supported for image files in the workspace or registered mod roots. Remote HTTPS images and image tool results can also be displayed. Missing or inaccessible images have a labeled fallback. Local preview requests validate file types and canonical paths, so links cannot grant access to unrelated folders.

## 0.2.10 Atlas globe logo

The cream and forest-green A with a globe replaces the previous mark in the app and setup headers, window icon and Windows executable. Native builds generate all Windows icon sizes from the same transparent source image, and update packages carry both icon resources.

## 0.2.9 Odyssey and chat layout fixes

Isolated RimWorld tests preserve Odyssey when it is installed and enabled in the normal game profile. Official content detection and load priority include Odyssey after Anomaly. Installed DLCs that are disabled in the normal profile stay disabled unless explicitly required by the target mod. Normal saves and the normal active-mod list are retained.

Visible chat rows flow naturally so growing replies, tool results and panel resizing cannot overlap neighboring messages. Long transcripts remain virtualized. Jump to latest stays available whenever you are away from the newest message, including idle chats. New replies keep your reading position until you jump back.

## 0.2.8 feature descriptions and forest accents

Atlas uses muted forest green accents for actions, selections, focus, and progress in both light and dark themes. Change tracking now has a feature overview, including named additions, removals, and recorded property changes. Small text files are captured in future baselines so descriptions can compare actual earlier and current source. Existing comparisons remain usable; missing earlier text is identified rather than reconstructed.

In **Changes**, choose **Write description with AI** to create player-facing release notes using the selected default model and normal account usage. You can cancel, edit, save, copy, or use the description as an update note. Descriptions are stored outside the mod and tied to the exact comparison; further edits invalidate them. Generating a description does not steer or interrupt the mod chat. Image file changes are reported without claiming unverified pixel changes. File details remain available below the overview.

## 0.2.7 install and restart repair

The Windows updater now uses a separate launcher and waits for the installer to validate and stage the update before Atlas closes. Installer startup failures keep Atlas open and display an error. The helpers run from an independent copy, write diagnostics to `data/updates/installer.log`, and retain startup recovery. A complete real Electron install, exit and healthy restart was verified in an isolated portable copy.

Atlas is a Windows x64 fork of ModMixer 0.10.5 maintained by Felix, with the Atlas globe logo, portable storage, and signed knowledge and skill updates. This release supports **RimWorld**. Minecraft is disabled in both game registries and its tools, grammar, bridge JAR and reference pack are excluded. Atlas's application and UI are now compiled from TypeScript/React source.

## Run it

1. Extract the complete portable ZIP to a writable folder, such as `D:\Atlas`. Keep `Atlas.exe`, `resources`, `tools` and the other runtime files together.
2. Run `Atlas.exe`. Complete setup, sign in to your chosen AI provider, and select RimWorld if it is not detected.
3. Open **Knowledge & Skills** in the top toolbar to manage the library.

No installer or administrator access is required. The executable is a locally built, unsigned Windows app. It is separate from the original ModMixer installation. Use one app at a time when using the in-game monitoring or live bridge: those inherited bridges share local ports.

## 0.2.6 application download progress

Application updates show actual percentage, downloaded MB / total MB, and average transfer speed, with **Downloading**, **Verifying** and **Ready to install** stages. Both manual and automatic downloads report progress while the Knowledge & Skills panel is open; reopening it shows the current status. Archives stream directly to a temporary file, reducing memory use. The total comes from the signed feed. Interrupted, oversized, incomplete or corrupted downloads never become installable, and temporary files are discarded before retrying.

After verification, choose **Install and restart**. Atlas checks again that the downloaded archive is unchanged and refuses to restart while an agent, compaction or account operation is active. The existing update helper backs up application files and watches startup, retaining private data. There is no estimated finish time; download speed depends on the connection and GitHub.

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

For GitHub publishing, push reviewed source to `lordfelixmotosr/atlas`, then upload the signed feed JSON files, portable ZIP, compact application-update ZIP, full-update ZIP and checksums as assets on the same release. `scripts/atlas/github-release.cjs publish` prepares a draft, verifies any already-uploaded draft assets by SHA-256, and publishes after all assets are present. It uses the existing Git credential in memory; the credential and private signing key are never packaged or published. Keep the signing key backed up privately. GitHub's automatic source archive is available separately from the Windows runtime ZIPs.

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

Chat, confirmation, library and provider setup labels use Atlas. Windows product metadata identifies Atlas 0.2.7 maintained by Felix. The local OpenAI/Claude browser callback page uses the stag logo; provider-owned sign-in/consent pages and registered OAuth identities remain controlled by the provider. Legacy internal IPC names, bridge package IDs and project sidecars are retained for compatibility. Required upstream authorship stays in LICENSE, NOTICE and source provenance. Old product website links and leaderboard registration are removed from the Atlas workflow.

Verification: source type checking; 86 automated tests, including installer launch failures, acknowledgement gating, cancelled handoffs, persistent diagnostics, download resume and startup recovery. A real Electron install, close, application replacement and healthy restart was verified in an isolated portable runtime. Existing editor, model context, account, import and modification tracking tests passed. No live model request, provider sign-in, or Steam upload was performed.

## Atlas 0.2.6

Application updates now use a compact archive of changed application files. The complete runtime remains available as a full recovery package; signed runtime compatibility checks automatically select it if required components differ or are missing. Interrupted downloads retain a private partial file under `data/updates`. Pause survives restart and prevents automatic resuming; Resume validates HTTP ranges and checks the entire signed size and SHA-256 before installation. Cancel discards the partial download. Servers without Range support restart safely at zero.

The Activity button lists AI work, compiler tasks, reference indexing, and app downloads with elapsed time, recent phase logs, and supported stop/resume/retry controls. AI tasks show activity without a guessed completion percentage; indexing percentages describe the current stage. Logs are bounded and last for the current Atlas process.

The file editor has XML/C# highlighting, line numbers, folding, file tabs with preserved drafts and undo, folder navigation, in-file find, and literal project-content search. Ctrl+S saves, Ctrl+F searches the current file, and Ctrl+Shift+F searches the project. Content searches skip private/build folders, limit text files to 2 MB, scan up to 64 MB, and cap matches at 200. Saves retain the external-change conflict guard. Closing an edited file or project asks before discarding drafts. Windows CRLF line endings are preserved; opening a file does not mark it changed.

Known OpenAI GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra models resolve to the documented 1,050,000 context window on startup, selection, account changes, and catalogue refreshes. This corrects stale 272k metadata in Atlas; it does not guarantee that every provider connection or account accepts that many input tokens. Output reservation and compaction thresholds remain separate. No live model request was made during verification.
