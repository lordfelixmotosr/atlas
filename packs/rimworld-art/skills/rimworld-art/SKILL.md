---
name: rimworld-art
description: Sprite briefs, transparency, directions, body variants, naming, style consistency and visual validation.
---

# RimWorld art workflow
Read `../../references/ART-PIPELINE.md` before making assets. Create an ASSETS-NEEDED.json manifest with individual output paths, canvas dimensions, directions, transparency, anchor, palette and forbidden elements. Separate concepts from game sprites. Preserve scale and anchor across directions and body types. Use the configured image provider when available; otherwise use Atlas SVG rendering or request generated/imported PNGs. Never claim an unconfigured image provider is available. Use only licensed or user-provided references. Check alpha, dimensions and missing variants, then inspect in-game screenshots. An image file existing proves neither visual quality nor correct layering.
