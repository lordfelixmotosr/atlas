from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from .util import PACKAGE_ID_RE, ensure_dir, safe_slug, write_json


def _indent(tree: ET.ElementTree) -> None:
    try:
        ET.indent(tree, space="  ")
    except AttributeError:
        pass


def write_about(path: Path, name: str, package_id: str, author: str, description: str, versions: list[str]) -> None:
    root = ET.Element("ModMetaData")
    ET.SubElement(root, "name").text = name
    ET.SubElement(root, "author").text = author
    ET.SubElement(root, "packageId").text = package_id
    supported = ET.SubElement(root, "supportedVersions")
    for version in versions:
        ET.SubElement(supported, "li").text = version
    ET.SubElement(root, "description").text = description
    tree = ET.ElementTree(root)
    _indent(tree)
    ensure_dir(path.parent)
    tree.write(path, encoding="utf-8", xml_declaration=True)


def new_project(name: str, package_id: str, author: str = "", description: str = "Generated with RimWorldForge.", workspace: Path | None = None) -> dict:
    if not PACKAGE_ID_RE.match(package_id) or "." not in package_id:
        raise ValueError("packageId should be globally distinctive and contain a dot, e.g. author.modname")
    root = (workspace or (Path.cwd() / safe_slug(name))).expanduser().resolve()
    if root.exists() and any(root.iterdir()):
        raise FileExistsError(f"Workspace is not empty: {root}")
    source = root / "source"
    for folder in (
        "About", "Defs", "Patches", "Textures", "Languages/English/DefInjected", "Languages/English/Keyed", "Assemblies"
    ):
        ensure_dir(source / folder)
    ensure_dir(root / "plans")
    ensure_dir(root / "reports")
    ensure_dir(root / "build")
    ensure_dir(root / "csharp")
    write_about(source / "About" / "About.xml", name, package_id, author, description, ["1.6"])
    config = {
        "schema": 1,
        "name": name,
        "packageId": package_id,
        "author": author,
        "targetRimWorld": "1.6",
        "source": "source",
        "build": "build",
        "evidence": {
            "syntax_valid": False,
            "references_valid": False,
            "compiled": False,
            "load_tested": False,
            "runtime_tested": False,
            "visual_tested": False
        }
    }
    write_json(root / "forge.json", config)
    write_json(root / "plans" / "ASSETS-NEEDED.json", {"schema": 1, "assets": [{
        "id": "mod_preview",
        "kind": "mod_preview",
        "target": "About/Preview.png",
        "transparent": False,
        "canvas": [640, 360],
        "style": "16:9 RimWorld mod-manager preview with readable subject silhouette",
        "notes": "Marketing/manager art, not an in-game sprite. Keep title text optional and legible if used."
    }]})
    return {"ok": True, "workspace": str(root), "source": str(source), "packageId": package_id}
