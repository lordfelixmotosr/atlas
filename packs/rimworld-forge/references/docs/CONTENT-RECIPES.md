# Content recipes

These are agent recipes, not frozen XML templates. RimWorld XML fields and framework details should be learned from the installed 1.6 game/framework before authoring.

## Named NPC / pawn archetype

Use when the user wants a new kind of humanoid pawn rather than a fundamentally new species.

### Inspect first

```text
rwforge search "soldier" --type PawnKindDef
rwforge inspect <closest PawnKindDef>
rwforge search "human" --type ThingDef
```

### Typical pieces

- `PawnKindDef` for the pawn archetype
- existing human race Def unless a new species is required
- apparel/weapon Defs or existing equipment references
- faction pawn groups if the NPC should spawn naturally
- backstories/name makers where appropriate
- optional custom Hediffs/abilities/traits only when needed

### Test

Spawn several pawns, not one. Check age/gender/body variety, gear generation, faction relations, combat behavior, portraits and save/load.

## New faction

A faction is more than a label and icon. It needs a population story.

### Inspect first

```text
rwforge search "outlander" --type FactionDef
rwforge search "tribe" --type FactionDef
rwforge inspect <closest faction>
```

Then inspect the pawn kinds and pawn-group makers referenced by that faction.

### Typical pieces

- `FactionDef`
- pawn kinds
- pawn group makers / raid composition
- settlement/trader behavior where relevant
- goodwill/hostility defaults
- name makers/culture/ideology integration when appropriate
- faction icon and UI assets

### Test

World generation, settlements, caravans/traders, raids at multiple threat points, diplomacy and quest references.

## Biotech xenotype

Use when the concept can remain fundamentally human and its biological/gameplay identity fits genes.

### Inspect first

```text
rwforge search "xenotype" --type XenotypeDef
rwforge search "gene" --type GeneDef
rwforge inspect <similar XenotypeDef>
```

Never invent gene defNames. Search the installed Biotech corpus.

### Typical pieces

- existing GeneDefs when possible
- custom GeneDefs only for genuinely new mechanics or presentation
- one or more `XenotypeDef`s
- icon art
- faction/pawn-kind integration if the xenotype should appear in the world

### Escalation

If the user wants nonhuman body rendering, tails, custom heads, race-level apparel restrictions or body addons that genes cannot express cleanly, consider HAR rather than forcing everything through Biotech.

## Humanoid Alien Races race

Use when a full custom humanoid race and a HAR dependency are acceptable.

### Detect framework

```text
rwforge mods-scan
```

Confirm `erdelf.HumanoidAlienRaces` is installed or tell the user it is a dependency. Inspect the installed HAR version/docs rather than relying on stale examples.

### Typical pieces

- HAR race `ThingDef`
- pawn kinds
- body/head/body-addon graphics
- color/gender/life-stage configuration
- restrictions and thoughts only when the design needs them
- faction/world integration
- apparel compatibility strategy

### Art burden

A race is an art project as much as an XML project. Create an asset manifest before generating images. Keep body/head/addons and directions consistent. Test portraits and world sprites separately.

### Test

Character generation, apparel, equipment, health tab/body parts, reproduction/genes if mixed with Biotech, ideology interactions, relationships, corpses/butchering, caravans, save/load, and combat.

## Animal / creature

### Inspect first

```text
rwforge search "wolf" --type ThingDef
rwforge search "thrumbo" --type PawnKindDef
```

### Typical pieces

- animal race `ThingDef`
- `PawnKindDef`
- body/health capacities if nonstandard
- life stages
- trainability/diet/wildness
- biome/ecosystem spawning when desired
- directional graphics

### Test

Wild spawn, taming, food search, combat, reproduction, caravan behavior, corpse/butchering and temperature survival.

## Mechanoid / mechanitor mech

Do not start from the bundled Warden plan alone. Search the installed build because Core and Biotech mechs have important differences.

### Inspect first

```text
rwforge search "mech" --type ThingDef
rwforge search "centipede" --type ThingDef
rwforge search "mech" --type PawnKindDef
rwforge inspect <closest mech race>
rwforge inspect <closest mech pawn kind>
```

A powerful workflow is:

```text
rwforge def-blueprint <real mech Def> Author_NewMech --output plans/new-mech.json
```

Then delete fields you do not understand before changing values. Smaller reviewed plans are safer than copying a giant Def wholesale.

### Typical pieces

- mech race `ThingDef`
- `PawnKindDef`
- weapons/projectiles or melee tools
- stats and combat power
- mechanitor/build/gestation/research integration when it is a controllable mech
- corpse/waste/loot behavior where applicable
- directional sprites
- C# only for genuinely novel behavior

### Test

Enemy and player-controlled contexts if both are supported, targeting, pathing, down/death behavior, gestation/control bandwidth, caravan/gravship behavior where relevant, and combat at several ranges.

## Weapon

### Inspect first

```text
rwforge search "rifle" --type ThingDef
rwforge inspect <closest weapon>
rwforge search "bullet" --type ThingDef
```

### Typical pieces

- weapon `ThingDef`
- projectile `ThingDef` for ranged weapons
- verbs/tools
- sound references
- crafting recipe
- research prerequisite
- trader/loot/tag integration only where intended
- transparent weapon art

### Test

Accuracy/range, burst cadence, projectile impact, cover, armor interaction, melee fallback, UI stats, crafting and AI use.

## Apparel / armor

Inspect several pieces that occupy the same layers/body parts. Apparel compatibility problems are often layering/body coverage issues rather than XML syntax errors.

Typical pieces:

- apparel `ThingDef`
- layers/body-part groups
- armor/insulation stats
- recipe/research
- worn graphics and masks if required
- race-specific variants only where necessary

Test all body types, facing directions, drafted poses, portraits, beds and other render contexts.

## Building / workbench

### Inspect first

```text
rwforge search "workbench" --type ThingDef
rwforge search "fabrication" --type ThingDef
rwforge inspect <closest building>
```

Typical pieces:

- building `ThingDef`
- `designationCategory`
- costs/stats
- power/fuel/comps
- recipes if it is a work table
- research
- terrain/placement rules where relevant
- texture, size and interaction cell

Test placement, rotation, construction, destruction, power/fuel, bills, interaction spots, pathing and save/load.

## Research tree

Search peer projects at the same tech level. Do not create prerequisite loops. Keep research as an integration layer around actual content rather than a decorative tree disconnected from recipes/buildings.

RimWorldForge static validation currently catches XML and duplicate issues but does not yet prove the research graph is acyclic. That belongs in a future semantic validator.

## Ability / custom behavior

Search installed ability/comp/job Defs and inspect the associated C# class names first.

Escalation ladder:

```text
existing Def behavior
-> existing Comp/Ability class configured by XML
-> small custom Comp / DefModExtension / JobDriver
-> Harmony patch only when existing code must be intercepted
```

If C# is needed:

```text
rwforge csharp-scaffold <workspace>
# edit generated source
rwforge csharp-build <workspace> --approve
```

Compiler acceptance is not runtime evidence. Analyze Player.log after the first real load.
