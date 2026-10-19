# Manual mod installation

**Install update** is shown beside the launch controls when the installed Atlas runtime copy has a DLL mismatch. Detection compares file hashes, so deleted DLLs and same-timestamp changes count. Source files alone do not activate it: compile first. XML/texture-only changes continue to use normal Sync to game or the next test launch.

Clicking opens a file review: added, changed and removed files, their sizes, unchanged counts and warnings. Confirm in that same panel to install the entire current release selection, including XML, textures, versioned content and approved extra folders. This replaces the managed runtime snapshot, removing obsolete files and folders. Development files remain excluded; unknown root folders are warned about and can be approved for release in `.atlas/release.json`. Cancelling the review does not close the game or change the runtime. Changes to workspace files, the installed files, the saved version or game-running state invalidate the confirmation and refresh the review.

Long warning lists are collapsed in the review. After a successful install or restore, a short result explains that installation completed, with every unique warning available under **View details**. These reports keep their heading and OK button visible while the warning body scrolls, including at smaller window sizes. Reviewing a completed result does not keep the installer busy. Asset warnings still require review and are not suppressed.

## Restore a previous installed version

Use the existing **More mod actions (⋯)** menu → **Restore previous version…**. The entry appears only when a saved runtime is available. Review the files and confirm; save your game first if Atlas must close RimWorld. Restoring leaves the game closed and preserves your workspace source edits and latest Workshop ID. Atlas Launch/Test keeps using that restored runtime until workspace runtime content changes or you explicitly choose Install update. Source-only C# edits require a new build before the runtime changes.

Retention is one previous committed runtime per mod, saved outside Mods in the game's `.atlas-release-stage` directory with a manifest and transaction journal. Unchanged installations do not rotate it or rewrite the runtime. The previous version is saved by the first changed installation after upgrading to 0.2.28; earlier releases did not retain one. Restoring saves the runtime being replaced as the next previous version. The action applies to the selected mod, and does not roll back dependency mods or publish an older build to Steam.

Saved file hashes and paths are checked before use. Modified, linked or unsafe backups are rejected. Development files present in a historical runtime are not restored. Approved extra folders and DLL paths are retained using the saved release manifest. If an old runtime cannot produce a safe restore manifest, its raw copy is retained for manual recovery and installation reports the path. Failed transactions and locked older copies are retained; automatic retention cleanup touches only the previously recorded successful version.

If the game is running, Atlas asks the user to save and confirm closing it. A failed close aborts before installing. The game stays closed afterward. No model request is made. Active agent work and registered C# builds block installation. Each affected mod uses the existing serialized runtime transaction and recovery journal. If a later mod fails, the error identifies those already installed; the game stays closed and failed-copy recovery paths remain available. The operation does not write the normal ModsConfig.xml or Workshop directory.

First installations still use Sync to game or a test launch. Atlas refuses to overwrite an unmanaged directory. Dependency detection includes transitive workspace dependencies and companions saved after the last successful test. Plans are checked again when accepting a close/warning confirmation; a changed package requires fresh confirmation.

## Library scans and duplicate entries

Opening Atlas or refreshing the library does not install workspace mods. Active package IDs alone do not authorize copying a workspace into the game's Mods directory. This keeps **Unsync** effective when the same package remains enabled. Explicit Sync, Install and Test still install runtime files; launches still refresh previously managed installations and recover missing recorded runtime mirrors.

RimWorld can list both a local runtime and a subscribed Workshop release of the same mod. Atlas's library groups matching workspace/runtime/publication identities, but that does not change RimWorld's own list. Keeping a local development copy and subscribing to its published version can therefore produce two game entries. Downloaded verification files are not themselves proof of a subscription. Atlas does not delete Workshop files or change subscriptions while scanning.

RimSort also scans downloaded files that are not subscribed. Automatic post-publish verification checks the subscription first and skips downloading unsubscribed items. The upload remains successful, with verification pending. If you choose manual verification, Atlas asks before creating a separate Steam download. Cancelling avoids that copy; confirming can make RimSort show two entries. Subscribed copies still verify automatically. Existing downloads are never silently removed by this update.

## Readable folder navigation

Home → **Open named mod folders** creates Windows `.lnk` shortcuts in the profile's `Mod folders` directory. Each name includes package ID (or author/name), modification time and a short stable identifier. Targets remain the original workspace folders. This avoids breaking chat/session paths, project references and saved settings. Only unchanged shortcuts recorded as Atlas-owned are replaced; user files and edited links are preserved. Refresh the view after moving Atlas.

## Verification

Automated checks exercise file preview counts/sizes, stale review rejection, one-version retention, no-op sync, restoration of removed assets/custom folders, development exclusions, source preservation, current Workshop IDs, corrupted backups, unmanaged destinations and failed restoration. They also cover DLL additions/removals, equal timestamps with different bytes, all LoadFolders versions, failed close and active-work guards. The Windows sync suite covers actual file/directory locks, simultaneous processes and failed rollback. Native startup and an isolated v1 → v2 → restored-v1 game/bridge test are recorded in release evidence.
