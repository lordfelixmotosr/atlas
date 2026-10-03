# Architecture

## Goal

Turn a general AI model into a disciplined RimWorld mod engineer without requiring a giant always-on tool schema.

## Layers

### 1. Installed-game evidence

`rwforge index` reads the user's actual Core and installed DLC Defs. This is the strongest static source because it corresponds to the executable and content they are actually running.

The index intentionally stores a compact record plus source path. `rwforge inspect` reopens the source file to return raw XML on demand. The AI pays context for one relevant example, not the whole game.

### 2. Typed authoring plans

Plans are JSON and map almost one-to-one to XML. That choice is deliberate:

- easy for an LLM to emit
- easy to validate before writes
- easy to diff and review
- generic across future `Def` subclasses
- avoids a huge hand-written DSL that goes stale

The plan writer supports arbitrary nested XML nodes and attributes. Specialized helper planners can later sit on top of the same format.

### 3. Transactional workspaces

Forge writes only under a workspace until `stage --approve` is used.

```text
workspace/
  source/    authoritative mod tree
  plans/     agent/user intent and asset contracts
  csharp/    source projects
  reports/   machine evidence
  build/     disposable build outputs
```

The source tree is never the live `RimWorld/Mods` copy. This prevents a half-generated pass from corrupting the version the user is testing.

### 4. Validation

Static validation is conservative. A validator that emits false certainty is worse than one that emits a warning.

Current checks:

- About.xml existence and required metadata
- target-version declaration
- XML parseability
- `<Defs>` root structure
- duplicate and malformed defNames
- Patch XML parseability
- local texture-path presence
- declared asset presence
- optional conservative reference candidates against a real installed-game index

Future reflection-backed schema validation should inspect the installed `Assembly-CSharp.dll` and map XML fields onto live `Def` subclasses.

### 5. External execution gate

C# compile and staging are separate operations because they cross the pure-data boundary.

- `csharp-build --approve` launches `dotnet`
- `stage --approve` writes a copy into the game's Mods directory

Future runtime launch automation should use its own explicit gate and a temporary mod profile.

### 6. Evidence receipts

Build receipts use SHA-256 for every built file and the archive. Evidence flags remain distinct. The system must never upgrade `syntax_valid` into `runtime_tested` simply because no parser threw.

## Why the MCP is small

The MCP has 11 broad tools. The agent skill provides routing rules and CLI escalation. This mirrors the bundle's token-discipline philosophy: capability should be discoverable without paying the schema cost on unrelated turns.
