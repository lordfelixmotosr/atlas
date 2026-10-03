# Extending RimWorldForge

## Add helper generators, not a second XML language

The generic plan format should remain the stable interchange. New high-level helpers should produce that plan.

Good future helpers:

- `plan weapon`
- `plan apparel`
- `plan building`
- `plan animal`
- `plan mech`
- `plan biotech-xenotype`
- `plan har-race`
- `plan faction`
- `plan research-tree`

Each helper should search installed examples first and store which examples informed the generated plan.

## Reflection schema index

The highest-value validator upgrade is a small C# helper that loads metadata from the installed managed assemblies without executing game code, then emits:

```json
{
  "ThingDef": {
    "parent": "BuildableDef",
    "fields": {
      "race": "Verse.RaceProperties",
      "graphicData": "Verse.GraphicData",
      "comps": "List<CompProperties>"
    }
  }
}
```

Combine this with vanilla XML observations. The result lets Forge distinguish a typo from an unknown-but-framework-provided extension.

## PatchOperation engine

A typed PatchOperation planner should support a bounded subset first:

- Add
- Replace
- Remove
- Sequence
- FindMod
- Conditional

Then dry-run XPath against an indexed XML snapshot. Do not pretend this exactly reproduces RimWorld's patch loader until parity is tested.

## Runtime harness

The 1.0 feature should be a controlled load test:

1. snapshot the user's active config
2. build a temporary test mod set containing Core/DLC/framework dependencies + generated mod
3. launch RimWorld with a test-specific user-data root if supported safely
4. wait for main menu / timeout
5. parse Player.log and attribute errors to the generated package
6. restore nothing because the live config was never changed

The runtime harness must not silently alter saves or the user's normal active mod list.

## Framework adapters

Framework support belongs behind explicit adapters with detected versions:

```text
adapters/har/
adapters/harmony/
adapters/vehicle-framework/
adapters/vanilla-expanded-framework/
```

An adapter may teach plan helpers and validators. It must not vendor third-party binaries or claim compatibility with an untested version.

## New MCP tools

Default answer: do not add one.

If a capability can be represented as an option of `rw_generate`, `rw_validate`, or a CLI-only expert command, keep the MCP small. Add a tool only when it materially improves discovery or avoids passing huge payloads through a generic tool.
