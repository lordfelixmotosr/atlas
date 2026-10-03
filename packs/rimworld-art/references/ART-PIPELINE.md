# Art pipeline

RimWorldForge treats art as a typed asset job, not an afterthought.

## Why

A generated image can be visually excellent and still be unusable as a RimWorld texture because it has the wrong camera, opaque background, baked floor shadow, inconsistent scale, directional asymmetry, or a composition that only works as concept art.

The Forge therefore separates:

1. **concept image** for design language
2. **game asset brief** for exact file requirements
3. **generated raw asset**
4. **normalization** for alpha, canvas, crop and naming
5. **in-game visual test**

## Asset manifest fields

Recommended fields in `ASSETS-NEEDED.json`:

```json
{
  "id": "warden_body",
  "kind": "pawn_directional",
  "target": "Textures/Shugoki/Warden/Warden_south.png",
  "transparent": true,
  "canvas": [128, 128],
  "directions": ["south", "north", "east"],
  "mirrorWest": true,
  "style": "RimWorld-compatible top-down sci-fi mech pawn sprite",
  "silhouette": "broad torso, short heavy legs, one cannon arm",
  "palette": "worn ivory armor, dark joints, cyan emissives",
  "forbid": ["background", "ground plane", "drop shadow", "text", "perspective camera"],
  "notes": "Keep the same footprint and anchor across directions."
}
```

## Recommended image-generation prompt shape

Use the manifest, plus one inspected vanilla/community-compatible reference when licensing allows visual reference use.

```text
Create one isolated RimWorld-compatible [asset kind].
Orthographic/top-down game sprite, readable at small scale.
Transparent background.
Exact subject: [silhouette / equipment / materials].
Palette: [palette].
No floor, no scenic background, no text, no UI, no frame, no baked shadow.
Preserve generous transparent padding around the subject.
This output is the [south/north/east] directional sprite and must match the other directions in scale and anchor.
```

Generate each direction as its own asset or from a controlled multi-view source. Do not ask for a 3x3 sticker sheet and then hope every crop is aligned.

## Mechs

For mechs, keep the visual hierarchy readable from above:

- torso mass
- locomotion silhouette
- weapon silhouette
- head/sensor direction
- one or two emissive accents

Tiny greebles disappear in-game. Spend detail budget on the outline and weapon read.

## Humanoid races

Separate body, head, ears/horns/tails/body addons, apparel compatibility and portrait-facing requirements. A beautiful full-body character illustration is not a pawn texture.

For HAR, inspect the framework's current graphic path and body-addon rules before naming files.

## Weapons and apparel

Weapon sprites need a clear diagonal/side silhouette and transparent padding. Apparel may require body-type variants and masks. Search installed examples/framework docs before deciding the final file set.

## Preview.png

The RimWorld Wiki currently recommends a 640x360 16:9 `About/Preview.png`. This is a marketing/manager image, so it can be composed more cinematically than an in-game texture. Do not reuse it as the pawn sprite.

## Visual evidence

A file existing at the expected path only proves `asset_present`. It does not prove:

- correct anchor
- correct draw size
- no clipping
- correct rotation
- correct apparel layering
- good readability on snow/dirt/floors

Those require an in-game screenshot or human playtest. Future RimWorldForge should automate screenshot capture and vision review as a distinct evidence tier.
