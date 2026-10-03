from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

from .discovery import DLC_DIRS
from .util import ensure_dir, state_root, write_json

TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


@dataclass
class DefRecord:
    def_type: str
    def_name: str | None
    label: str | None
    parent_name: str | None
    source_pack: str
    source_file: str
    xml_tag_count: int


def _iter_xml_files(root: Path) -> Iterable[Path]:
    if root.is_dir():
        yield from sorted(root.rglob("*.xml"))


def _read_defs(path: Path, source_pack: str) -> tuple[list[DefRecord], list[dict]]:
    records: list[DefRecord] = []
    errors: list[dict] = []
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        if root.tag != "Defs":
            return records, errors
        for child in root:
            def_name = child.findtext("defName")
            label = child.findtext("label")
            records.append(
                DefRecord(
                    def_type=child.tag,
                    def_name=def_name.strip() if def_name else None,
                    label=label.strip() if label else None,
                    parent_name=child.attrib.get("ParentName"),
                    source_pack=source_pack,
                    source_file=str(path),
                    xml_tag_count=sum(1 for _ in child.iter()),
                )
            )
    except (ET.ParseError, OSError) as exc:
        errors.append({"file": str(path), "error": str(exc)})
    return records, errors


VERSION_DIRS = ("1.6", "Common")  # RimWorldForge targets 1.6 only; other versions are leftovers


def _mod_def_dirs(mod_dir: Path) -> list[Path]:
    """Def directories of a mod, honoring versioned layouts (1.6/, Common/) and LoadFolders.xml.

    Flat `<mod>/Defs` and every versioned Defs dir seen in real Workshop mods both work.
    Unknown version dirs (1.4, 1.5...) are deliberately skipped: 1.6-only, no wasted index.
    """
    dirs: list[Path] = []
    flat = mod_dir / "Defs"
    if flat.is_dir():
        dirs.append(flat)
    for name in VERSION_DIRS:
        d = mod_dir / name / "Defs"
        if d.is_dir():
            dirs.append(d)
    load_folders = mod_dir / "LoadFolders.xml"
    if load_folders.is_file():
        try:
            root = ET.parse(load_folders).getroot()
            if root.tag == "loadFolders":
                for vnode in root:
                    ver = vnode.tag.lstrip("v")
                    if ver != "1.6":
                        continue
                    for li in vnode.iter("li"):
                        text = (li.text or "").strip().strip("/")
                        if not text or text in ("About", "About/", "LoadFolders.xml"):
                            continue
                        d = mod_dir / text / "Defs"
                        if d.is_dir() and d not in dirs:
                            dirs.append(d)
        except ET.ParseError:
            pass
    return dirs


def build_index(game_root: Path, include_mods: list[Path] | Path | None = None, output: Path | None = None) -> dict:
    records: list[DefRecord] = []
    errors: list[dict] = []
    data = game_root / "Data"
    for pack in DLC_DIRS:
        defs_dir = data / pack / "Defs"
        for path in _iter_xml_files(defs_dir):
            found, bad = _read_defs(path, pack)
            records.extend(found)
            errors.extend(bad)
    if include_mods is None:
        from .mods import mod_roots
        mod_dirs = [root for origin, root in mod_roots(game_root)]
    elif isinstance(include_mods, Path):
        mod_dirs = [include_mods]
    else:
        mod_dirs = list(include_mods)
    for mods_dir in mod_dirs:
        if not mods_dir.is_dir():
            continue
        for mod in sorted(p for p in mods_dir.iterdir() if p.is_dir()):
            for defs_dir in _mod_def_dirs(mod):
                for path in _iter_xml_files(defs_dir):
                    found, bad = _read_defs(path, f"mod:{mod.name}")
                    records.extend(found)
                    errors.extend(bad)
    destination = output or (ensure_dir(state_root() / "indexes") / "defs-index.json")
    payload = {
        "schema": 1,
        "game_root": str(game_root),
        "record_count": len(records),
        "errors": errors,
        "records": [asdict(r) for r in records],
    }
    write_json(destination, payload)
    return {"ok": True, "index": str(destination), "records": len(records), "parse_errors": len(errors)}


def load_index(path: Path | None = None) -> dict:
    target = path or (state_root() / "indexes" / "defs-index.json")
    if not target.is_file():
        raise FileNotFoundError(f"Def index not found: {target}. Run `rwforge index` first.")
    with target.open("r", encoding="utf-8") as f:
        return json.load(f)


def _tokens(text: str) -> set[str]:
    return {t.lower() for t in TOKEN_RE.findall(text)}


def search_index(query: str, def_type: str | None = None, index_path: Path | None = None, limit: int = 20) -> list[dict]:
    data = load_index(index_path)
    q = query.strip().lower()
    qt = _tokens(q)
    scored: list[tuple[float, dict]] = []
    for rec in data.get("records", []):
        if def_type and rec.get("def_type", "").lower() != def_type.lower():
            continue
        name = (rec.get("def_name") or "")
        label = (rec.get("label") or "")
        hay = f"{name} {label} {rec.get('def_type','')} {rec.get('source_pack','')}".lower()
        score = 0.0
        if name.lower() == q:
            score += 100
        if label.lower() == q:
            score += 80
        if q and q in name.lower():
            score += 35
        if q and q in label.lower():
            score += 25
        overlap = qt & _tokens(hay)
        score += 8 * len(overlap)
        if qt:
            score += 4 * len(overlap) / math.sqrt(len(qt))
        if score > 0:
            scored.append((score, rec))
    scored.sort(key=lambda x: (-x[0], x[1].get("def_name") or ""))
    return [{"score": round(score, 2), **rec} for score, rec in scored[: max(1, limit)]]


def inspect_def(def_name: str, index_path: Path | None = None) -> dict | None:
    data = load_index(index_path)
    for rec in data.get("records", []):
        if (rec.get("def_name") or "").lower() == def_name.lower():
            source = Path(rec["source_file"])
            xml = None
            try:
                tree = ET.parse(source)
                for child in tree.getroot():
                    if (child.findtext("defName") or "").lower() == def_name.lower():
                        xml = ET.tostring(child, encoding="unicode")
                        break
            except Exception:
                pass
            return {**rec, "xml": xml}
    return None
