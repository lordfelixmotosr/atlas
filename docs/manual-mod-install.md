# Manual mod installation

**Install update** is shown beside the launch controls when the installed Atlas runtime copy has a DLL mismatch. Detection compares file hashes, so deleted DLLs and same-timestamp changes count. Source files alone do not activate it: compile first. XML/texture-only changes continue to use normal Sync to game or the next test launch.

Clicking installs the entire current release selection, including XML, textures, versioned content and approved extra folders. This is replacement of the managed runtime snapshot, so obsolete files and folders disappear. It does not overlay new DLLs onto an old folder. Development files remain excluded; unknown root folders are warned about and can be approved for release in `.atlas/release.json`.

If the game is running, Atlas asks the user to save and confirm closing it. A failed close aborts before installing. The game stays closed afterward. No model request is made. Active agent work and registered C# builds block installation. Each affected mod uses the existing serialized runtime transaction and recovery journal. If a later mod fails, the error identifies those already installed; the game stays closed and failed-copy recovery paths remain available. The operation does not write the normal ModsConfig.xml or Workshop directory.

First installations still use Sync to game or a test launch. Atlas refuses to overwrite an unmanaged directory. Dependency detection includes transitive workspace dependencies and companions saved after the last successful test. Plans are checked again when accepting a close/warning confirmation; a changed package requires fresh confirmation.

## Readable folder navigation

Home → **Open named mod folders** creates Windows `.lnk` shortcuts in the profile's `Mod folders` directory. Each name includes package ID (or author/name), modification time and a short stable identifier. Targets remain the original workspace folders. This avoids breaking chat/session paths, project references and saved settings. Only unchanged shortcuts recorded as Atlas-owned are replaced; user files and edited links are preserved. Refresh the view after moving Atlas.

## Verification

Automated checks exercise DLL additions/removals, equal timestamps with different bytes, all LoadFolders versions, extra DLL paths, full-copy stale-file removal, Workshop-ID preservation, confirmation cancellation/revalidation, failed close, busy/build guards and error reporting. The Windows sync regression suite covers file/directory locks, simultaneous processes, failed installation and failed rollback. Native startup and a separate isolated game/bridge test are recorded in release evidence.
