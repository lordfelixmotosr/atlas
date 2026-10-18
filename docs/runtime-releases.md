# Runtime mirrors and Workshop upload contents

Atlas 0.2.23 keeps development in the workspace and installs a real copied
runtime directory in RimWorld's Mods/<folder>. A workspace junction is migrated
on the next sync. Every launch refreshes synced workspace mods, including test
companions. Editing a source file does not update the game's copy immediately.

Both the game mirror and Atlas's Steam uploader use the same release selection.
The uploader stages and audits its own snapshot before Steam can receive it.
In-game Workshop publishing sees only the runtime mirror.

## What is copied

- About/ (including PublishedFileId.txt) and LoadFolders.xml.
- All folders from every version and default block in LoadFolders.xml, including
  conditional entries. The XML, order and conditions are preserved byte for byte.
- With no explicit folder lists: conventional root content directories, Common/
  and version directories such as 1.6/ and 1.7/.
- LICENSE, NOTICE, COPYING and README documents when present. Atlas's publisher
  previews its generated LICENSE without writing it during a dry run.
- Additional runtime folders declared in .atlas/release.json.

`<li>/</li>`, `<li>\</li>` and `<li>.</li>` include conventional root content
directories. They do not opt the entire workspace into a release. Standard root
content directories are Defs, Patches, Textures, Sounds, Assemblies, Languages,
Strings, AssetBundles and AssetPacks.

## Additional folders

Some mods read files directly from RootDir, outside the conventional content
directories. For example:

```json
{
  "include": ["World", "WeaponTweakData"],
  "exclude": ["Docs", "Diagnostics"]
}
```

`include` adds existing directories relative to the workspace mod. `exclude`
acknowledges intentionally omitted optional paths. Do not exclude a required
LoadFolders directory or About/. Paths cannot escape the mod or traverse links.
Unknown root folders are listed as omitted warnings; declare runtime data before
publishing. Atlas does not infer arbitrary folder purpose from its name.

DLLs normally belong under Assemblies/ in one of the loaded content roots. A
native library or other intentional DLL outside those directories requires an
exact path in `allowDlls`, in addition to including its parent folder:

```json
{
  "include": ["Native"],
  "allowDlls": ["Native/example.dll"]
}
```

This cannot authorize development paths or copies of the game's engine/runtime
assemblies, such as Assembly-CSharp.dll, UnityEngine DLLs, Waylith DLLs or
System.Private.CoreLib.dll.

## Exclusions and checks

Source, Tests, Tools, ArtSources, .atlas, .modmixer, .git, bin, obj and common
editor/cache directories are excluded at every depth, case insensitively. C#
source/project/solution files, PDBs, deps.json files and Assets.zip* are excluded
as well. Explicit extras cannot override these rules.

In Publish, choose **Dry run · inspect files** for every included file and size,
the total, excluded paths, warnings and blocking errors. Publishing performs a
fresh preflight and hashes the actual staged bytes. Stray DLLs, unsafe paths,
links, malformed manifests, missing load folders, injected development files or
files changed during staging stop the operation before uploading.

## Ownership, IDs and locked files

Ownership records live in data/profile/runtime-mirrors, outside any mod upload.
They identify the workspace, destination and filesystem directory identity.
Atlas refuses to overwrite an unrelated or manually replaced game directory.
A successful refresh replaces the whole owned mirror, removing stale files.
The previous copy is retained until the replacement and ownership record commit.

PublishedFileId.txt travels into the mirror. Atlas watches for IDs written by
RimWorld and copies them back to the workspace, recovering again on startup.
Intentional workspace links/unlinks are propagated; conflicting changes are
reported rather than overwriting either value. Atlas must be running, or be
reopened, to perform recovery.

If a mirror DLL is locked or not writable, refresh reports its path and asks for
RimWorld/the locking program to be closed. The launch stops and the previous
mirror stays intact. The workspace is never replaced by this process.

## Verification

Regression fixtures compare ordered version/conditional content for 1.4 through
1.7, check default/root entries and empty folders, and cover stale files, ID
recovery, junction migration, unmanaged directories and a real Windows DLL
sharing lock. Simulated Steam uploads verify the actual staged file list and
block bad releases before Steam initialization or item creation.

An isolated game probe passed on installed RimWorld 1.7.4981: the game loaded a
real copied mod, shared Defs, the 1.7 override and extra World data, with all
development paths absent. The normal ModsConfig.xml was unchanged. Other engine
versions have file-preservation fixture evidence, not a live game-load result.
No mod was uploaded to Steam as a development test.

## Windows transaction repair (0.2.26)

The entire Mods root is serialized, including independent processes and sibling pruning. Staging moved to the game root outside Mods. Sharing locks receive bounded retries; failures retain the original exception, journal and recoverable copies. Copy recovery handles a backup directory that can be read but not renamed. Interrupted swaps recover before syncing again. Sync scans are read-only for workspace assets. See [Windows evidence and recovery](windows-runtime-sync.md).
