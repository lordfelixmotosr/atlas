# Runtime harness design for the next milestone

The foundation intentionally stops before automatically launching RimWorld. This document defines the safe path to that feature so a future agent does not bolt on a brittle `subprocess.Popen(RimWorld.exe)` and call it testing.

## Target outcome

A command such as:

```text
rwforge load-test <workspace> --approve
```

should produce a receipt proving one narrow fact: the generated mod reached the main menu in a controlled test environment without relevant load errors.

## Requirements

### Preserve the user's normal game state

Do not edit the live active mod configuration and promise to restore it later. A crash can happen between those steps. Prefer a separate user-data/config root if RimWorld exposes a reliable supported mechanism. If no isolated profile mechanism can be proven, stop and require a human to enable the mod.

### Dependency closure

A test mod set needs:

- Core
- required DLCs
- explicit framework dependencies from About.xml
- the generated mod

Do not load the user's entire 500-mod list for a basic load test unless compatibility against that list is what is being tested.

### Process evidence

Capture:

- exact executable path and hash if practical
- RimWorld version/build as observed
- package IDs in the test set
- launch arguments
- start/end timestamps
- exit code
- Player.log path/hash
- errors attributed to the generated package or its dependency closure

### Ready signal

Do not infer success from "process is still running after N seconds." Find a deterministic main-menu/log signal for the installed 1.6 build and test it against known-good and intentionally-broken mods.

### Timeout and cleanup

Kill only the process started by the harness. Never kill arbitrary `RimWorldWin64.exe` processes by name because the user may have a real game session open.

## Runtime spawn testing

This is a separate tier from load testing. A future developer-mode harness should create a controlled scenario/map, instantiate requested Defs, exercise basic actions, capture exceptions, and take screenshots. It needs stronger evidence and more game-version-specific work than the main-menu loader.

## Visual testing

Screenshots should be reviewed for:

- missing/pink textures
- clipping
- incorrect directional sprite
- draw size and anchor
- weapon/apparel alignment
- UI icon readability

A vision model can assist, but the receipt must label that as visual inspection rather than engine validation.
