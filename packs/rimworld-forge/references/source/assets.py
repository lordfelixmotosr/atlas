from __future__ import annotations

from pathlib import Path
from typing import Any

from .util import ensure_dir, read_json, safe_slug, write_json

PROMPT = """Create one isolated RimWorld-compatible {kind} game asset.
Transparent background: {transparent}.
Target file: {target}
Canvas: {canvas}
Direction/view: {direction}
Visual direction: {style}
Requirements: {notes}
No scenic background, no text, no UI frame, no baked floor or drop shadow unless the asset brief explicitly requires one.
Keep the subject readable at small in-game scale and preserve transparent padding for alignment.
This is a production asset brief, not a concept-art composition.
"""


def emit_prompts(workspace: Path) -> dict[str, Any]:
    manifest = workspace / "plans" / "ASSETS-NEEDED.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"Asset manifest not found: {manifest}")
    data = read_json(manifest)
    out_dir = ensure_dir(workspace / "plans" / "art-prompts")
    outputs: list[str] = []
    for i, asset in enumerate(data.get("assets", []), start=1):
        ident = safe_slug(str(asset.get("id") or f"asset-{i}"))
        canvas = asset.get("canvas") or "unspecified; inspect relevant game/framework examples first"
        if isinstance(canvas, list):
            canvas = "x".join(str(x) for x in canvas)
        direction = asset.get("direction") or ", ".join(asset.get("directions", [])) or "asset-specific"
        text = PROMPT.format(
            kind=asset.get("kind", "game texture"),
            transparent="required" if asset.get("transparent", True) else "follow brief",
            target=asset.get("target", "unspecified"),
            canvas=canvas,
            direction=direction,
            style=asset.get("style", "Match RimWorld visual readability and the mod's established art direction."),
            notes=asset.get("notes", "Inspect an appropriate installed/reference asset before finalizing scale and anchor."),
        )
        path = out_dir / f"{ident}.txt"
        path.write_text(text, encoding="utf-8", newline="\n")
        outputs.append(str(path))
    index = {"schema": 1, "count": len(outputs), "prompts": outputs}
    write_json(out_dir / "index.json", index)
    return {"ok": True, **index}
