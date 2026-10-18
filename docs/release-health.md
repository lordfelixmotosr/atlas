# Build status and Steam verification

Atlas 0.2.24 adds both checks to a RimWorld mod's Publish panel. They use local
filesystem and Steam SDK results, without an AI request.

## C# build status

- **No build recorded:** an imported or existing source mod has no successful
  Atlas build record yet. Atlas does not infer one from file timestamps.
- **Needs rebuild:** workspace inputs or released DLLs differ from the recorded
  build, or a later build failed or was interrupted.
- **Build recorded · source unchanged:** input and released DLL hashes still
  match the last successful recorded Atlas build.
- **XML / assets only:** there is no C# source/project to rebuild.

**Rebuild C#** uses the same RimWorld builder as the assistant's build_mod tool
and exposes compiler output. Builds for one mod cannot overlap. Source changes
during compilation prevent a successful build record. Failed builds keep the
previous successful record and mark the latest attempt as failed.

The fingerprint covers workspace Source files, workspace C# projects/source,
MSBuild props/targets and relevant root configuration. Generated bin/obj caches
and Atlas metadata are omitted. Runtime DLLs come from the shared release plan.
Records live in .atlas/build-state.json and are excluded from uploads.

This is a conservative workspace check. It does not evaluate every external
MSBuild import, referenced game/dependency DLL or custom build command. Rebuild
after changing those dependencies. A successful default project build records
the DLL inventory present afterward; it does **not** certify that every version
of every DLL was compiled. Mods supporting multiple engines still need separate
builds and tests for their intended versions. External builds do not create an
Atlas record; run Rebuild C# once to establish one.

Status refreshes on panel open, window focus, mod-change notifications and
explicit Check status. Publishing always performs a fresh check. Build warnings
appear in the publish confirmation; they do not forbid intentionally publishing
an existing DLL.

## Verification after publishing

After Steam accepts an upload, Atlas saves its exact file paths, sizes and SHA256
hashes in .atlas/published-runtime.json. This captures staged bytes, including a
new Workshop ID, independently of later workspace changes. Only that Workshop
ID can use the record.

Atlas then asks Steam to download/update that item without changing subscription
settings or giving it priority over other downloads. The bundled SDK exposes
download state rather than the DownloadItemResult callback. Atlas waits for
installed content with no needs-update, pending or downloading flags on two
successive polls. It compares every downloaded path with the saved manifest,
then checks Steam has not started another update while hashing.

**Steam copy verified** means the Steam-managed local copy matches all recorded
upload files and has no unexpected development files. Missing, changed and extra
files are listed separately. The verifier does not apply release filtering to
the download: doing so would conceal leaked Source folders or stray DLLs.

The comparison is read-only. It never removes a subscriber's manually added
files or modifies the workspace. An already current Steam copy may be reused;
this is a byte comparison of Steam's installed content, not a server-side
attestation or a purge of historical/manual backups.

From Atlas 0.2.25, the Steam copy shares the workspace's Library entry when both
its package ID and Workshop ID match. Its files remain in Steam's cache. A
different Workshop ID remains visible even if it reuses the package ID. This
grouping affects Atlas's registry; verification does not add Steam subscriptions.

### Delays and retry

- If RimWorld is running, the successful upload is saved and verification is
  deferred. Close the game, then choose **Verify Steam copy**.
- Steam has up to two minutes to provide settled downloaded content. Offline,
  rejected, pending or interrupted downloads remain unverified and can be retried.
- **Stop checking** stops Atlas's check and releases its Steam host. Steam may
  finish a download it has already queued; the SDK has no download-cancel API.
- An app restart turns an interrupted check into a retryable status.
- A verification failure is shown separately from the successful upload. Retrying
  verification never uploads or creates another Workshop item.
- An older publication has no exact upload record. Publish once with this Atlas
  version to enable checks against the recorded payload.

## Evidence

67 focused checks cover source edits with restored timestamps, failed builds,
changes during compilation, output changes, exact manifests, download state,
offline/cancel/timeout handling, post-upload mismatch reporting, running-game
deferral, release filtering, Windows DLL locks and retained behavior.

A real Steam SDK download of the user's existing published mod was compared with
its current workspace runtime plan: all 1,339 files matched, with no development
leftovers. That download comparison did not publish anything or create a receipt
in the user's workspace. Simulated publishing tests verify that automatic checks
use the actual staged upload manifest and keep upload success separate from
download verification failures. No paid model request was needed.

A real .NET build of a disposable game probe also recorded a successful build
fingerprint. Editing a source file and restoring its timestamp correctly changed
the result to Needs rebuild; the fixture source was then restored.
