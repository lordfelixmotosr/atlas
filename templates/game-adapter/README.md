# Add a game to Atlas

Atlas adapter API 1 keeps game identity and capabilities in a renderer safe descriptor, and build, test, setup, metadata, index and research behavior in a main process adapter. RimWorld 1.6 is the only active game in this release. Minecraft is excluded.

## Source integration

1. Copy this starter into `src/agent/<game-id>/`. Declare supported versions in `atlas-game.json`.
2. Create a `descriptor.ts` exporting a `GameDefinition` from `src/agent/games/types.ts`. Start with every optional capability false. Give each new game a unique `storageSegment`; do not share RimWorld's index or lore.
3. Implement `GameAdapter` from `src/agent/adapters/types.ts`, using `adapter.ts.template` as a checklist. No method may silently dispatch to RimWorld. Return actionable prerequisite failures for missing installs or toolchains.
4. Add the descriptor to the `GAMES` registry in `src/agent/games/registry.ts` (available in both renderer and main). Add the adapter through `registerGameAdapter` in `src/agent/adapters/index.ts`. Import its registration in `src/atlas/game-plugins.ts`. Atlas validates the complete adapter before registering it.
5. Implement the game's tools, paths and build/index workers behind its adapter. Scope writes to the selected project; read external game content only through explicit allowed roots. Do not call arbitrary manifest commands or load JavaScript from knowledge packs.
6. Add fixture checks for scaffold → metadata read/write → build → failed build → cancellation, install detection, missing paths, index invalidation and test cleanup. Preview UI with optional capabilities both enabled and disabled.
7. Run `pnpm run build:atlas:source` after preparing the local compiler dependencies described in `README-ATLAS.md`. Package only public runtime/tool content; never include user game assemblies or credentials.

## Manifest preview

Copy a manifest into `Atlas/custom/game-adapters/<adapter-id>/atlas-game.json` to inspect compatibility under **Knowledge and Skills → Game adapters**. This is a descriptor preview. A manifest alone does not enable a playable adapter. Executable adapters must be reviewed, compiled and released with Atlas. Knowledge and art packs remain signed data; they do not execute plugin code.

## Code and image reference packs

Add game specific packs using `scripts/atlas/publish-packs.cjs`. Declare game versions and Atlas compatibility. Preserve licenses and provenance. Reference retrieval should search and read selected files; never inject a complete game source tree into every prompt. Static art checks must be described separately from evidence obtained in the game.

Online publishing is not configured. The portable update folder is the distribution source for now.
