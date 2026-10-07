# Sprite Studio workflow

## Asset profiles

| Profile | Required artwork | Export scope |
|---|---|---|
| Pawn | South, east, north | Three directional textures; west mirrored |
| Odyssey bird | Three layered views with eight flight frames each | Three standing and 24 flight PNGs |
| Apparel | Inventory icon plus Male/Female/Thin/Fat/Hulk south/east/north | 16 PNGs for vanilla adults |
| Hat | Inventory icon plus south/east/north worn overlays | Four PNGs; west mirrored |
| Building or furniture, directional | South, east, north, west | Four explicit world textures |
| Building or furniture, single view | Main texture | One PNG, nonrotating |

Worn apparel and hats contain the garment or headwear alone, aligned to the schematic mannequin/head guide. The suggested apparel XML explicitly targets adults. Child, Baby, custom race body shapes and complex color masks require separate work. Buildings and furniture separate their occupied tile footprint from their visual draw dimensions. The copied XML is an integration fragment for an existing definition, not a complete functional chair, table, bed or building.

## Importing your master art

Create a family with **Import master art**, choose **Reference** to guide generation or a specific asset slot to import a finished view, then select the PNG. A direct imported view is saved as a candidate for approval. The file chooser can be cancelled without leaving an empty family. Describe desired colors in the brief or use the master artwork to guide them. Imported PNG colors are preserved. A flat bird image cannot supply a wing rig.

## Archiving and deleting

Archive a selected family to retain it outside the active list. Use the archived filter and Restore to resume it. Archived families remain viewable, while edits, generation and export require restoration. Delete family removes its recipe, copied references and candidate history after confirmation. Exported mod PNGs and backups stay in their existing folders.

1. Create a family in **Sprite Studio**. A family represents one sprite identity across directions and animation frames.
2. Describe its shape, materials, colors and markings. Choose the shared canvas before generating artwork. Import up to six PNG references, preferably approved game sprites with compatible proportions.
3. Choose your connected model, select the directions, and generate a candidate. This uses normal model usage on the selected account. Generated output is bounded SVG geometry, not executable code or an external raster image API.
4. Review all directions at small size. Check silhouette, shading, identity, scale and alignment. The centre guide uses RimWorld's default central anchor.
5. Approve good views individually. Revise only selected directions; earlier candidates remain available. Choose an earlier candidate and approve its view again to restore it.
6. For birds, inspect flight from all three native views. The approved body is constant and the separate wings move. Onion skin helps reveal clipping and misplaced shoulder pivots. Native west uses a mirrored east view.
7. Preview export into a RimWorld workspace mod. Read the file list and XML fragment. Export only approved artwork. Atlas creates backups and refuses a stale export plan; it does not rewrite definitions automatically.
8. Integrate the suggested XML into the intended PawnKindDef and visually test grounded and flying sprites in RimWorld. Static checks and a Studio preview cannot prove runtime correctness.

The design action stays at the top of the workspace. **Design flight frames** requests all three bird views using saved reference/import artwork, even before that artwork is approved. Each imported view is added to the working set; partial revisions retain earlier views. Current and historical files remain available until you delete the family. Artwork references preserve PNG transparency when sent to a model that supports image input.

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

Canvas and profile structure are locked once a family has artwork, preventing old approvals from silently changing. Create a new family for a different structure. A flat PNG import can provide a static direction or visual reference; it cannot reveal separate wing geometry or guarantee animated reconstruction.
