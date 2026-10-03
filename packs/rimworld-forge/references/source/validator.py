from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .util import DEF_NAME_RE, PACKAGE_ID_RE, read_json, write_json

REFERENCE_FIELDS = {
    "thingDef", "hediffDef", "pawnKind", "pawnKindDef", "recipeDef", "researchPrerequisite",
    "researchPrerequisites", "factionDef", "geneDef", "xenotype", "xenotypeDef", "body", "bodyDef",
    "soundDef", "designationCategory", "designationCategoryDef", "terrainDef", "stuffCategories",
}


def _problem(level: str, code: str, message: str, file: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"level": level, "code": code, "message": message, "file": file, **extra}


def _texture_exists(source: Path, tex_path: str) -> bool:
    base = source / "Textures" / Path(tex_path.replace("\\", "/"))
    candidates = [base.with_suffix(ext) for ext in (".png", ".dds", ".jpg", ".jpeg", ".tga")]
    if any(p.is_file() for p in candidates):
        return True
    parent = base.parent
    if parent.is_dir():
        stem = base.name.lower()
        return any(p.is_file() and p.stem.lower().startswith(stem + "_") for p in parent.iterdir())
    return False


def validate_workspace(workspace: Path, vanilla_index: Path | None = None) -> dict[str, Any]:
    workspace = workspace.resolve()
    source = workspace / "source"
    problems: list[dict[str, Any]] = []
    stats = {"xml_files": 0, "defs": 0, "textures_referenced": 0}
    about_path = source / "About" / "About.xml"
    if not about_path.is_file():
        problems.append(_problem("error", "about.missing", "About/About.xml is required", str(about_path)))
    else:
        try:
            root = ET.parse(about_path).getroot()
            if root.tag != "ModMetaData":
                problems.append(_problem("error", "about.root", "About.xml root must be ModMetaData", str(about_path)))
            required = {tag: root.findtext(tag) for tag in ("name", "author", "packageId", "description")}
            for tag, text in required.items():
                if not text or not text.strip():
                    level = "warning" if tag == "author" else "error"
                    problems.append(_problem(level, f"about.{tag}", f"About.xml should have a non-empty <{tag}>", str(about_path)))
            pid = (root.findtext("packageId") or "").strip()
            if pid and (not PACKAGE_ID_RE.match(pid) or "." not in pid):
                problems.append(_problem("error", "about.packageId_format", "packageId must be distinctive, dot-qualified, and use letters/numbers/._-", str(about_path)))
            versions = [((li.text or "").strip()) for li in root.findall("./supportedVersions/li")]
            if "1.6" not in versions:
                problems.append(_problem("warning", "about.version", "RimWorldForge foundation targets 1.6 but About.xml does not declare 1.6", str(about_path)))
        except ET.ParseError as exc:
            problems.append(_problem("error", "about.xml", str(exc), str(about_path)))
    known_defs: set[str] = set()
    if vanilla_index and vanilla_index.is_file():
        try:
            data = read_json(vanilla_index)
            known_defs.update((r.get("def_name") or "").lower() for r in data.get("records", []) if r.get("def_name"))
        except Exception as exc:
            problems.append(_problem("warning", "index.unreadable", f"Could not read vanilla index: {exc}", str(vanilla_index)))
    project_defs: dict[str, str] = {}
    parsed_nodes: list[tuple[Path, ET.Element]] = []
    defs_root = source / "Defs"
    for path in sorted(defs_root.rglob("*.xml")) if defs_root.is_dir() else []:
        stats["xml_files"] += 1
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            problems.append(_problem("error", "xml.parse", str(exc), str(path)))
            continue
        if root.tag != "Defs":
            problems.append(_problem("error", "defs.root", "Def XML root must be <Defs>", str(path)))
            continue
        for node in root:
            stats["defs"] += 1
            parsed_nodes.append((path, node))
            dn = (node.findtext("defName") or "").strip()
            if not dn:
                if node.attrib.get("Abstract", "false").lower() != "true":
                    problems.append(_problem("warning", "def.no_name", f"{node.tag} has no defName", str(path)))
                continue
            if not DEF_NAME_RE.match(dn):
                problems.append(_problem("error", "def.name_format", f"Invalid defName: {dn}", str(path), defName=dn))
            key = dn.lower()
            if key in project_defs:
                problems.append(_problem("error", "def.duplicate", f"Duplicate project defName {dn}; first seen in {project_defs[key]}", str(path), defName=dn))
            else:
                project_defs[key] = str(path)
    known_defs.update(project_defs.keys())
    for path, node in parsed_nodes:
        for elem in node.iter():
            if elem.tag == "texPath" and elem.text and elem.text.strip():
                stats["textures_referenced"] += 1
                tex = elem.text.strip()
                if not _texture_exists(source, tex):
                    problems.append(_problem("warning", "texture.missing", f"No local texture found for texPath '{tex}'", str(path), texPath=tex))
            if vanilla_index and elem.tag in REFERENCE_FIELDS and elem.text and elem.text.strip():
                value = elem.text.strip()
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", value) and value.lower() not in known_defs:
                    problems.append(_problem("warning", "reference.unresolved_candidate", f"Reference-like field <{elem.tag}> points to unknown '{value}'", str(path), value=value))
    patch_root = source / "Patches"
    for path in sorted(patch_root.rglob("*.xml")) if patch_root.is_dir() else []:
        stats["xml_files"] += 1
        try:
            root = ET.parse(path).getroot()
            if root.tag != "Patch":
                problems.append(_problem("warning", "patch.root", "Patch XML normally uses <Patch> root", str(path)))
        except ET.ParseError as exc:
            problems.append(_problem("error", "patch.parse", str(exc), str(path)))
    assets_manifest = workspace / "plans" / "ASSETS-NEEDED.json"
    if assets_manifest.is_file():
        try:
            manifest = read_json(assets_manifest)
            for asset in manifest.get("assets", []):
                target = asset.get("target") or asset.get("path")
                if target and not (source / target).is_file():
                    problems.append(_problem("warning", "asset.missing", f"Declared asset not present: {target}", str(assets_manifest), asset=asset))
        except Exception as exc:
            problems.append(_problem("error", "asset.manifest", f"Invalid ASSETS-NEEDED.json: {exc}", str(assets_manifest)))
    errors = [p for p in problems if p["level"] == "error"]
    warnings = [p for p in problems if p["level"] == "warning"]
    result = {
        "ok": not errors,
        "evidence": {
            "syntax_valid": not errors,
            "references_valid": bool(vanilla_index) and not any(p["code"].startswith("reference.") and p["level"] == "error" for p in problems),
            "compiled": None,
            "load_tested": False,
            "runtime_tested": False,
            "visual_tested": False,
        },
        "stats": stats,
        "errors": errors,
        "warnings": warnings,
        "problems": problems,
        "note": "Static validation is not RimWorld runtime evidence. Load and gameplay testing remain separate evidence tiers.",
    }
    write_json(workspace / "reports" / "validation.json", result)
    return result
