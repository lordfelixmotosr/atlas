# Practical RimWorld modding guide for Forge agents

## Standard mod tree

RimWorld recognizes a small set of conventional folders. A normal generated project starts with:

```text
About/       metadata and preview
Defs/        new definitions
Patches/     XML PatchOperations against existing Defs
Textures/    sprites and UI art
Languages/   translations
Assemblies/  compiled custom code
Sounds/      optional custom audio
```

Only `About/About.xml` is universally required, but content mods usually add Defs or Patches.

## About.xml

For a 1.6-only development mod, generate a unique dot-qualified `packageId`, declare 1.6, and list dependencies explicitly when a framework is required. Do not declare older/newer support just to make warnings disappear.

## Defs

Every Def XML file has `<Defs>` as its root. Direct children name a Def class such as `ThingDef`, `RecipeDef`, `ResearchProjectDef`, `PawnKindDef`, `GeneDef`, or `XenotypeDef`.

The critical mental model is:

```text
XML element name <-> C# field/property on a Def class
```

That is why guessing field names is fragile and why installed examples matter.

### Inheritance

Use XML attributes in a Forge plan:

```json
{
  "type": "ThingDef",
  "attributes": {"ParentName": "SomeVanillaParent"},
  "fields": {"defName": "Author_MyThing"}
}
```

becomes:

```xml
<ThingDef ParentName="SomeVanillaParent">
  <defName>Author_MyThing</defName>
</ThingDef>
```

Abstract definitions use the same attribute mechanism.

### Lists

A JSON list becomes `<li>` entries. An item can include XML attributes by using keys starting with `@`.

```json
"comps": [
  {"@Class": "Namespace.CompProperties_Example", "someField": 5}
]
```

### Explicit child tag

If a list is not a normal `<li>` list, give an item `_tag` and the generator will use that tag.

## Patches

PatchOperations are preferable to copying and overriding vanilla Defs when changing existing content. Foundation generation focuses on new Defs; patch XML can be authored directly under `source/Patches` and the validator will at least parse it. A future release should add a typed PatchOperation planner and XPath dry-run against indexed XML.

## LoadFolders.xml

Use it when content should load conditionally by RimWorld version, DLC, or another mod. RimWorld 1.6 supports conditions including `IfModActive`, `IfModNotActive`, and `IfModActiveAll`. Keep paths case-correct for cross-platform compatibility.

## C#

Escalate when XML cannot express the behavior. Foundation scaffolding references the installed game's managed assemblies rather than shipping copyrighted DLLs.

If Harmony is needed, supply a local Harmony DLL explicitly. Forge does not download or redistribute it.

## Balance

Vanilla values are evidence of scale, not automatic balance. Compare several peers in the same tech/combat role. Record deliberate balance choices in the plan or a design document so an agent does not drift them on later revisions.
