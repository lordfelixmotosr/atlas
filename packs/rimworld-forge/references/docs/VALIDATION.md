# Validation and evidence

## Static validation is intentionally not a game emulator

RimWorld loads XML through reflection-heavy game code, resolves cross-references after Def loading, and many semantic problems only appear when content is instantiated. Static analysis can catch a large class of failures, but it cannot honestly prove runtime correctness.

## Evidence states

### syntax_valid
About/Defs/Patches parsed and structural static checks passed.

### references_valid
Forge had a real installed-game Def index and conservative reference checks found no blocking errors. This is still not exhaustive because XML field semantics vary by Def class and framework.

### compiled
A configured C# project compiled and produced a DLL. Compiler success does not prove Harmony targets exist or gameplay code is correct.

### load_tested
RimWorld actually loaded the mod in a controlled test run without relevant startup failures. Foundation 0.1 does not automate this tier.

### runtime_tested
Generated content was instantiated and exercised. Foundation 0.1 does not automate this tier.

### visual_tested
A human or vision system inspected actual in-game rendering at expected rotations, scales and UI contexts.

## Warning philosophy

Warnings are used where the validator has a useful suspicion but insufficient type information to safely reject the build, for example:

- a texture path has no obvious local PNG/DDS
- a reference-looking XML tag points to a string absent from the current compact Def index
- a non-abstract Def lacks a defName

A future reflection index can promote some warnings to errors when it can prove the field type from the installed assemblies.
