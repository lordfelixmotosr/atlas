from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .project import write_about
from .util import DEF_NAME_RE, PACKAGE_ID_RE, ensure_dir, read_json, safe_slug, write_json


def validate_plan(plan: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if plan.get("schema") != 1:
        errors.append("plan.schema must be 1")
    mod = plan.get("mod")
    if not isinstance(mod, dict):
        errors.append("plan.mod must be an object")
        mod = {}
    for key in ("name", "packageId"):
        if not isinstance(mod.get(key), str) or not mod.get(key, "").strip():
            errors.append(f"mod.{key} is required")
    package_id = str(mod.get("packageId", ""))
    if package_id and (not PACKAGE_ID_RE.match(package_id) or "." not in package_id):
        errors.append("mod.packageId should contain only letters/numbers/._- and include a dot")
    versions = mod.get("supportedVersions", ["1.6"])
    if not isinstance(versions, list) or not all(isinstance(x, str) for x in versions):
        errors.append("mod.supportedVersions must be a string list")
    elif "1.6" not in versions:
        warnings.append("Foundation targets RimWorld 1.6; this plan does not declare 1.6")
    defs = plan.get("defs", [])
    if not isinstance(defs, list):
        errors.append("plan.defs must be a list")
        defs = []
    seen: set[str] = set()
    for i, item in enumerate(defs):
        if not isinstance(item, dict):
            errors.append(f"defs[{i}] must be an object")
            continue
        dtype = item.get("type")
        fields = item.get("fields")
        if not isinstance(dtype, str) or not dtype:
            errors.append(f"defs[{i}].type is required")
        if not isinstance(fields, dict):
            errors.append(f"defs[{i}].fields must be an object")
            continue
        dn = fields.get("defName")
        if not isinstance(dn, str) or not dn:
            errors.append(f"defs[{i}].fields.defName is required")
        elif not DEF_NAME_RE.match(dn):
            errors.append(f"defs[{i}] invalid defName: {dn}")
        elif dn.lower() in seen:
            errors.append(f"duplicate defName in plan: {dn}")
        else:
            seen.add(dn.lower())
        attrs = item.get("attributes", {})
        if attrs is not None and not isinstance(attrs, dict):
            errors.append(f"defs[{i}].attributes must be an object")
    assets = plan.get("assets", [])
    if assets is not None and not isinstance(assets, list):
        errors.append("plan.assets must be a list")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "defs": len(defs)}


def _scalar_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _append_value(parent: ET.Element, tag: str, value: Any) -> ET.Element:
    if isinstance(value, dict):
        attrs = {k[1:]: _scalar_text(v) for k, v in value.items() if k.startswith("@")}
        elem = ET.SubElement(parent, tag, attrs)
        if "_text" in value:
            elem.text = _scalar_text(value["_text"])
        for key, child in value.items():
            if key.startswith("@") or key == "_text":
                continue
            _append_value(elem, key, child)
        return elem
    if isinstance(value, list):
        elem = ET.SubElement(parent, tag)
        for child in value:
            if isinstance(child, dict) and "_tag" in child:
                child_copy = copy.deepcopy(child)
                child_tag = str(child_copy.pop("_tag"))
                _append_value(elem, child_tag, child_copy)
            else:
                _append_value(elem, "li", child)
        return elem
    elem = ET.SubElement(parent, tag)
    elem.text = _scalar_text(value)
    return elem


def _indent(tree: ET.ElementTree) -> None:
    try:
        ET.indent(tree, space="  ")
    except AttributeError:
        pass


def _write_defs_file(path: Path, defs: list[dict[str, Any]]) -> None:
    root = ET.Element("Defs")
    for item in defs:
        attrs = {str(k): _scalar_text(v) for k, v in (item.get("attributes") or {}).items()}
        node = ET.SubElement(root, item["type"], attrs)
        for tag, value in item["fields"].items():
            _append_value(node, tag, value)
    tree = ET.ElementTree(root)
    _indent(tree)
    ensure_dir(path.parent)
    tree.write(path, encoding="utf-8", xml_declaration=True)


def _write_load_folders(path: Path, spec: dict[str, Any]) -> None:
    root = ET.Element("loadFolders")
    for version, entries in spec.items():
        vnode = ET.SubElement(root, version if version.startswith("v") else f"v{version}")
        for entry in entries:
            if isinstance(entry, str):
                ET.SubElement(vnode, "li").text = entry
            elif isinstance(entry, dict):
                attrs = {k: str(v) for k, v in entry.items() if k != "path"}
                ET.SubElement(vnode, "li", attrs).text = str(entry.get("path", "/"))
    tree = ET.ElementTree(root)
    _indent(tree)
    tree.write(path, encoding="utf-8", xml_declaration=True)


def apply_plan(workspace: Path, plan_path: Path) -> dict[str, Any]:
    plan = read_json(plan_path)
    verdict = validate_plan(plan)
    if not verdict["ok"]:
        return verdict
    workspace = workspace.resolve()
    source = workspace / "source"
    if not (workspace / "forge.json").is_file() or not source.is_dir():
        raise FileNotFoundError(f"Not a RimWorldForge workspace: {workspace}")
    mod = plan["mod"]
    write_about(
        source / "About" / "About.xml",
        mod["name"], mod["packageId"], mod.get("author", ""),
        mod.get("description", "Generated with RimWorldForge."), mod.get("supportedVersions", ["1.6"]),
    )
    dependencies = mod.get("dependencies", [])
    if dependencies:
        about = ET.parse(source / "About" / "About.xml")
        root = about.getroot()
        deps = ET.SubElement(root, "modDependencies")
        for dep in dependencies:
            li = ET.SubElement(deps, "li")
            if isinstance(dep, str):
                ET.SubElement(li, "packageId").text = dep
                ET.SubElement(li, "displayName").text = dep
            else:
                ET.SubElement(li, "packageId").text = str(dep["packageId"])
                ET.SubElement(li, "displayName").text = str(dep.get("displayName", dep["packageId"]))
                if dep.get("steamWorkshopUrl"):
                    ET.SubElement(li, "steamWorkshopUrl").text = str(dep["steamWorkshopUrl"])
        _indent(about)
        about.write(source / "About" / "About.xml", encoding="utf-8", xml_declaration=True)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in plan.get("defs", []):
        group = item.get("file") or f"Generated/{item['type']}s.xml"
        grouped.setdefault(group, []).append(item)
    generated: list[str] = []
    for relative, items in grouped.items():
        target = source / "Defs" / relative
        if target.suffix.lower() != ".xml":
            target = target.with_suffix(".xml")
        _write_defs_file(target, items)
        generated.append(str(target.relative_to(workspace)))
    if plan.get("loadFolders"):
        _write_load_folders(source / "LoadFolders.xml", plan["loadFolders"])
        generated.append("source/LoadFolders.xml")
    assets = list(plan.get("assets", []) or [])
    if not any((a.get("target") or "").replace("\\", "/").lower() == "about/preview.png" for a in assets if isinstance(a, dict)):
        assets.insert(0, {
            "id": "mod_preview",
            "kind": "mod_preview",
            "target": "About/Preview.png",
            "transparent": False,
            "canvas": [640, 360],
            "style": "16:9 RimWorld mod-manager preview with readable subject silhouette",
            "notes": "Marketing/manager art, not an in-game sprite."
        })
    write_json(workspace / "plans" / "ASSETS-NEEDED.json", {"schema": 1, "assets": assets})
    write_json(workspace / "plans" / "last-applied.plan.json", plan)
    return {
        "ok": True,
        "workspace": str(workspace),
        "generated": generated,
        "defs": len(plan.get("defs", [])),
        "assets_declared": len(assets),
        "warnings": verdict["warnings"],
    }
