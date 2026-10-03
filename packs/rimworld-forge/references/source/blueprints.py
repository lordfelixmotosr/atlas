from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .indexer import inspect_def
from .util import DEF_NAME_RE, write_json


def _element_value(elem: ET.Element) -> Any:
    attrs = {f"@{k}": v for k, v in elem.attrib.items()}
    children = list(elem)
    text = (elem.text or "").strip()
    if not children:
        if attrs:
            if text:
                attrs["_text"] = text
            return attrs
        return text
    if children and all(c.tag == "li" for c in children):
        values = [_element_value(c) for c in children]
        if attrs:
            return {**attrs, "li": values}
        return values
    out: dict[str, Any] = dict(attrs)
    for child in children:
        value = _element_value(child)
        if child.tag not in out:
            out[child.tag] = value
        else:
            current = out[child.tag]
            if not isinstance(current, list):
                current = [{"_tag": child.tag, "_value": current}]
            current.append({"_tag": child.tag, "_value": value})
            out[child.tag] = current
    if text:
        out["_text"] = text
    return out


def blueprint_from_def(def_name: str, new_def_name: str, output: Path, index_path: Path | None = None, package_id: str = "author.blueprint", mod_name: str = "Blueprint Mod") -> dict[str, Any]:
    if not DEF_NAME_RE.match(new_def_name):
        raise ValueError(f"Invalid new defName: {new_def_name}")
    record = inspect_def(def_name, index_path)
    if not record or not record.get("xml"):
        raise FileNotFoundError(f"Indexed Def not found or could not be reopened: {def_name}")
    node = ET.fromstring(record["xml"])
    fields: dict[str, Any] = {}
    for child in node:
        fields[child.tag] = _element_value(child)
    fields["defName"] = new_def_name
    plan = {
        "schema": 1,
        "mod": {
            "name": mod_name,
            "packageId": package_id,
            "author": "Author",
            "supportedVersions": ["1.6"],
            "description": f"Blueprint derived from installed {def_name}. Review every inherited/copy field before release."
        },
        "defs": [{
            "type": node.tag,
            "attributes": dict(node.attrib),
            "fields": fields,
            "sourceExample": {
                "defName": def_name,
                "sourcePack": record.get("source_pack"),
                "sourceFile": record.get("source_file")
            }
        }],
        "assets": []
    }
    write_json(output, plan)
    return {"ok": True, "output": str(output), "source": def_name, "new_def_name": new_def_name, "def_type": node.tag}
