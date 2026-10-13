# RimWorld 1.6 and 1.7 in Atlas

Atlas 0.2.20 detects the installed engine and version. Steam's last saved ModsConfig version can lag behind a branch update, so Version.txt takes priority. Windows 1.7.4976 was inspected and tested locally; other platform paths have fixture coverage only.

| Area | RimWorld 1.6 | RimWorld 1.7.4976 |
| --- | --- | --- |
| Engine | Unity / Mono | Waylith |
| Windows executable | RimWorldWin64.exe | RimWorld.exe |
| Assembly directory | RimWorldWin64_Data/Managed | Install root |
| New C# target | net472 | net10.0, read from RimWorld.runtimeconfig.json |
| Engine references | UnityEngine modules present in the install | UnityStubs, Waylith.UnityCompat, Waylith and required Brutal libraries |
| Windows log under the normal save-data directory | Player.log | Logs/Player.log |

## Building and testing

Select the game installation in Settings. Atlas rebuilds its source and Def index after a version change and provisions a suitable SDK when needed. New C# projects, live-session projects and scratch code use the selected game's references with Private=false. Game DLLs must never be copied into a published mod. Existing source projects are preserved; build diagnostics explain a framework mismatch instead of rewriting the project without review.

UnityEngine namespaces still occur in 1.7 through compatibility assemblies. Keep these namespaces where the installed source uses them; do not add nonexistent UnityEngine.CoreModule paths. Look up exact APIs in the installed source index. Earlier Unity rendering, AssetBundle and threading recipes are historical guidance, not proof of Waylith behavior.

The bundled diagnostic bridge has separate Unity and Waylith assemblies selected by LoadFolders.xml. Its 1.7 build uses Harmony 3.0.0-rc.2, matching the Harmony 3 generation shipped by the installed 1.7 Workshop mod. Harmony 2.4.1 failed with a CoreCLR 10 unsupported error during testing. Compilation alone did not expose that failure. The replacement passed an actual 1.7 bridge handshake, performance messages and a captured warning from a generated mod.

For a mod supporting both versions, retain the working 1.6 assembly and place separately compiled 1.7 code under 1.7/Assemblies with explicit LoadFolders entries. A net10.0 assembly cannot be loaded by Unity's Mono runtime. An existing 1.6 binary may work through Waylith compatibility; test before rebuilding or changing supportedVersions. Atlas does not automatically mark existing mods as compatible.

## Forge and knowledge

The Atlas Forge adapter supports indexing 1.6 and 1.7 installed Defs and selects the corresponding content folders for static checks. An explicit LoadFolders file without an entry for the selected version produces an incomplete-check diagnostic; conditional entries still require the actual mod list. Existing foundation recipes are retained as references. Static validation does not prove runtime or visual compatibility.

1.7 continues to honor -savedatafolder for isolated tests. The normal log is still outside that isolated profile. Atlas's test process recognizes both executable names, and launches the selected Waylith executable directly with Steam context. An isolated smoke test confirmed the normal ModsConfig file was unchanged.

Evidence: local Version.txt, RimWorld.runtimeconfig.json, decompiled GenFilePaths, GenCommandLine, UnityEngine.Application and RimWorldWaylith.Bootstrap from 1.7.4976. No game assemblies or decompiled game source are redistributed.

Primary references: [Ludeon's 1.7 announcement](https://ludeon.com/blog/2026/10/announcing-the-waylith-engine-and-update-1-7/) and [Harmony releases](https://github.com/pardeike/Harmony/releases). The announcement identifies 1.7 as the unstable branch on October 12, 2026; Atlas uses the installed files to select build settings.
