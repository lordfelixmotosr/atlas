from __future__ import annotations

import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

from .util import copytree_clean, ensure_dir, read_json, safe_slug, sha256_file, write_json
from .validator import validate_workspace


def build_project(workspace: Path, vanilla_index: Path | None = None) -> dict[str, Any]:
    workspace = workspace.resolve()
    config_path = workspace / "forge.json"
    if not config_path.is_file():
        raise FileNotFoundError(f"Not a RimWorldForge workspace: {workspace}")
    validation = validate_workspace(workspace, vanilla_index)
    if not validation["ok"]:
        return {"ok": False, "stage": "validate", "validation": validation}
    config = read_json(config_path)
    name = safe_slug(config.get("name", "RimWorldMod"))
    source = workspace / config.get("source", "source")
    build_root = ensure_dir(workspace / config.get("build", "build"))
    mod_root = build_root / name
    copytree_clean(source, mod_root)
    receipt_files: list[dict[str, Any]] = []
    for path in sorted(p for p in mod_root.rglob("*") if p.is_file()):
        receipt_files.append({
            "path": str(path.relative_to(mod_root)).replace("\\", "/"),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    zip_path = build_root / f"{name}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(p for p in mod_root.rglob("*") if p.is_file()):
            zf.write(path, arcname=f"{name}/{path.relative_to(mod_root).as_posix()}")
    receipt = {
        "schema": 1,
        "built_unix": int(time.time()),
        "workspace": str(workspace),
        "mod_root": str(mod_root),
        "archive": str(zip_path),
        "archive_sha256": sha256_file(zip_path),
        "files": receipt_files,
        "validation": validation,
        "evidence": {
            "syntax_valid": True,
            "references_valid": validation["evidence"]["references_valid"],
            "compiled": None,
            "load_tested": False,
            "runtime_tested": False,
            "visual_tested": False,
        },
    }
    write_json(workspace / "reports" / "build-receipt.json", receipt)
    return {"ok": True, "mod_root": str(mod_root), "archive": str(zip_path), "receipt": str(workspace / "reports" / "build-receipt.json")}


def stage_project(workspace: Path, game_root: Path, approve: bool = False) -> dict[str, Any]:
    if not approve:
        return {"ok": False, "refused": True, "reason": "Staging writes into RimWorld/Mods and requires --approve."}
    config = read_json(workspace / "forge.json")
    name = safe_slug(config.get("name", "RimWorldMod"))
    built = workspace / config.get("build", "build") / name
    if not built.is_dir():
        raise FileNotFoundError("No built mod folder. Run `rwforge build` first.")
    mods = game_root / "Mods"
    if not mods.is_dir():
        raise FileNotFoundError(f"RimWorld Mods directory not found: {mods}")
    target = mods / name
    copytree_clean(built, target)
    return {"ok": True, "staged": str(target), "note": "Game files outside the mod folder were not modified."}
