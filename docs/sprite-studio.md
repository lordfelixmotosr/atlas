# Sprite Studio workflow

1. Create a family in **Sprite Studio**. A family represents one sprite identity across directions and animation frames.
2. Describe its anatomy, materials and markings. Choose the shared canvas and palette before generating artwork. Import up to six PNG references, preferably approved game sprites with compatible proportions.
3. Choose your connected model, select the directions, and generate a candidate. This uses normal model usage on the selected account. Generated output is bounded SVG geometry, not executable code or an external raster image API.
4. Review all directions at small size. Check silhouette, shading, identity, scale and alignment. The centre guide uses RimWorld's default central anchor.
5. Approve good views individually. Revise only selected directions; earlier candidates remain available. Choose an earlier candidate and approve its view again to restore it.
6. For birds, inspect flight from all three native views. The approved body is constant and the separate wings move. Onion skin helps reveal clipping and misplaced shoulder pivots. Native west uses a mirrored east view.
7. Preview export into a RimWorld workspace mod. Read the file list and XML fragment. Export only approved artwork. Atlas creates backups and refuses a stale export plan; it does not rewrite definitions automatically.
8. Integrate the suggested XML into the intended PawnKindDef and visually test grounded and flying sprites in RimWorld. Static checks and a Studio preview cannot prove runtime correctness.

## Bird texture profile

The native Odyssey profile uses eight individual full-body frames per direction:

```
Textures/Things/Pawn/Animal/MyBird/MyBird_south.png
Textures/Things/Pawn/Animal/MyBird/MyBird_east.png
Textures/Things/Pawn/Animal/MyBird/MyBird_north.png
Textures/Things/Pawn/Animal/MyBird/MyBird_Flying_1_south.png
...
Textures/Things/Pawn/Animal/MyBird/MyBird_Flying_8_north.png
```

Flight prefixes in XML omit `Textures/` and `.png`. The preview loop is `(8 + 1) * ticksPerFrame`; RimWorld holds the final frame longer than a uniform eight-frame player. Flight draw size is independent of the grounded sprite size. Separate female flight families, independent west artwork, custom renderers and additional games can be added as future export profiles.

## Portability and records

Family state, asset manifests, imported reference hashes and immutable candidates are stored under `data/profile/sprite-studio`. Export backups are under `backups/sprite-exports`. Neither is copied into a mod or included in a public application release. Account sign-ins remain in the existing private credential store.

Palette, canvas and animation structure are locked once a family has artwork, preventing old approvals from silently changing. Create a new family for a different structure. A flat PNG import can provide a static direction or visual reference; it cannot reveal separate wing geometry or guarantee animated reconstruction.
