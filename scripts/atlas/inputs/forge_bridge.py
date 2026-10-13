"""Atlas adapter for the bundled RimWorldForge. See the bundled LICENSE."""
from __future__ import annotations

import os
import argparse
import copy
import hashlib
import json
import shutil
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG = {}
FORGE_ROOT = BASE
sys.path.insert(0, str(FORGE_ROOT / "src"))
from rwforge import __version__ as ENGINE_VERSION
from rwforge import cli, discovery, indexer, validator
from rwforge.util import read_json, safe_slug

# Adapt the foundation's Unity-only discovery without rewriting its source.
_legacy_managed_dir = discovery.managed_dir
_legacy_player_log_path = discovery.player_log_path
discovery.managed_dir = lambda game: game if (game / "Waylith.dll").is_file() and (game / "Assembly-CSharp.dll").is_file() else _legacy_managed_dir(game)


def atlas_player_log_path() -> Path:
    game = discovery.discover_game()
    legacy = _legacy_player_log_path()
    if game and (game / "Waylith.dll").is_file():
        if sys.platform == "darwin":
            return Path.home() / "Library/Application Support/Ludeon Studios/RimWorld by Ludeon Studios/Logs/Player.log"
        return legacy.parent / "Logs" / "Player.log"
    return legacy


discovery.player_log_path = atlas_player_log_path


def selected_game_version() -> str:
    game = discovery.discover_game()
    version = discovery.game_version(game) if game else None
    major_minor = ".".join((version or "").split(".")[:2])
    if major_minor not in ("1.6", "1.7"):
        raise ValueError("Atlas Forge supports installed RimWorld 1.6 or 1.7; select the game folder first.")
    return major_minor

DATA = Path(os.environ.get("ATLAS_ROOT", str(BASE.parent.parent))) / "data" / "forge"
CURRENT = DATA / "current-index.json"

_legacy_discover_game = discovery.discover_game


def atlas_discover_game(explicit: str | None = None) -> Path | None:
    if not explicit and not os.environ.get("RIMWORLD_ROOT"):
        try:
            settings = read_json(DATA.parent / "profile" / "settings.json")
            selected = settings.get("rimworldInstallOverride")
            if isinstance(selected, str) and selected:
                found = _legacy_discover_game(selected)
                if found:
                    return found
        except (OSError, ValueError, TypeError):
            pass
    return _legacy_discover_game(explicit)


discovery.discover_game = atlas_discover_game


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def within(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def game_fingerprint(game: Path) -> dict:
    managed = discovery.managed_dir(game)
    assembly = managed / "Assembly-CSharp.dll" if managed else None
    stat = assembly.stat() if assembly and assembly.is_file() else None
    return {"root": str(game.resolve()), "version": discovery.game_version(game),
            "dlc": [pack for pack in discovery.DLC_DIRS if (game / "Data" / pack).is_dir()],
            "assembly": {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns} if stat else None}


def index_status() -> tuple[Path | None, dict]:
    status = {"usable": False, "reason": "Run index --ensure to create the Forge reference index."}
    if not CURRENT.is_file():
        return None, status
    try:
        metadata = read_json(CURRENT)
        path = Path(metadata["index"])
        if not within(path, DATA / "indexes") or not path.is_file():
            raise ValueError("Index file is missing or outside the adapter cache")
        game = discovery.discover_game()
        if not game or game_fingerprint(game) != metadata["game_fingerprint"]:
            raise ValueError("Game path, build or DLC set changed; refresh the index")
        if time.time() - metadata["indexed_at"] > 86400:
            raise ValueError("Index is older than one day; refresh before reference validation")
        data = read_json(path)
        if not isinstance(data.get("records"), list) or not data["records"]:
            raise ValueError("Reference index has no usable Def records")
        if data.get("game_root") != metadata["game_fingerprint"]["root"]:
            raise ValueError("Reference index belongs to a different game installation")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != metadata["sha256"]:
            raise ValueError("Reference index changed since creation")
        status = {"usable": True, "index": str(path), "indexed_at": metadata["indexed_at"],
                  "records": len(data["records"]), "parse_errors": len(data.get("errors", [])),
                  "scope": "Installed game/DLC and installed mods; this does not prove a dependency is enabled.",
                  "freshness": "Game build/DLC and 24-hour age checked. Reindex after editing or updating dependencies."}
        return path, status
    except (OSError, ValueError, KeyError, TypeError) as error:
        status["reason"] = str(error)
        return None, status


def refresh_index(ensure: bool) -> dict:
    path, status = index_status()
    if ensure and path:
        return {"ok": True, "reused": True, **status}
    game = discovery.discover_game()
    if not game:
        raise FileNotFoundError("RimWorld was not found; configure RIMWORLD_ROOT.")
    version = discovery.game_version(game)
    selected_game_version()
    directory = DATA / "indexes"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("defs-" + uuid.uuid4().hex + ".json")
    fingerprint = game_fingerprint(game)
    result = indexer.build_index(game, output=path)
    if game_fingerprint(game) != fingerprint:
        raise ValueError("Game changed during indexing; run index again.")
    write_json(CURRENT, {"index": str(path), "indexed_at": time.time(), "game_fingerprint": fingerprint,
                         "engine_version": ENGINE_VERSION, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    _, status = index_status()
    return {**result, **status, "reused": False}


def load_roots(mod: Path, game_version: str | None = None) -> tuple[list[Path], list[dict], bool]:
    game_version = game_version or selected_game_version()
    problems, complete = [], True
    load = mod / "LoadFolders.xml"
    roots = []
    if load.is_file():
        try:
            document = ET.parse(load).getroot()
            if document.tag != "loadFolders":
                raise ValueError("LoadFolders.xml must have a <loadFolders> root")
            version = next((node for node in document if node.tag.lstrip("v") == game_version), None)
            if version is None:
                raise ValueError("LoadFolders.xml has no " + game_version + " entry; verify the game's fallback before declaring this mod compatible")
            for entry in version:
                if entry.tag != "li":
                    raise ValueError("Unsupported node in the " + game_version + " load-folder list: " + entry.tag)
                if entry.attrib:
                    complete = False
                    problems.append({"level": "warning", "code": "adapter.conditional_load_folder",
                                     "message": "Conditional load folder skipped; its activation requires the actual test mod list: " + (entry.text or "/"), "file": str(load)})
                    continue
                name = (entry.text or "").strip().replace("\\", "/").strip("/")
                root = (mod / name).resolve()
                if not within(root, mod):
                    raise ValueError("Load folder escapes the selected mod directory: " + name)
                if not root.is_dir():
                    raise ValueError("Load folder does not exist: " + name)
                roots.append(root)
        except (ET.ParseError, ValueError) as error:
            problems.append({"level": "error", "code": "adapter.load_folders", "message": str(error), "file": str(load)})
            complete = False
    else:
        versions = [name for name in ("1.6", "1.7") if name <= game_version and (mod / name).is_dir()]
        roots = [mod] + [mod / name for name in ("Common", *(versions[-1:])) if (mod / name).is_dir()]
    return list(dict.fromkeys(roots)), problems, complete


def validate_mod(mod: Path, max_problems: int = 40) -> dict:
    mod = mod.expanduser().resolve()
    if not mod.is_dir():
        raise FileNotFoundError("Mod folder not found: " + str(mod))
    forge_workspace = None
    if not (mod / "About" / "About.xml").is_file() and (mod / "source" / "About" / "About.xml").is_file():
        forge_workspace = mod
        mod = mod / "source"
    elif mod.name == "source" and (mod.parent / "forge.json").is_file():
        forge_workspace = mod.parent
    roots, additional, complete = load_roots(mod)
    index_path, status = index_status()
    if not index_path:
        additional.append({"level": "warning", "code": "adapter.index_unavailable", "message": status["reason"], "file": None})
    elif status["parse_errors"]:
        additional.append({"level": "warning", "code": "adapter.index_partial", "message": "Reference index contains XML parse errors in installed content; it is incomplete.", "file": status["index"]})
    mappings = {}
    def_names = {}
    with tempfile.TemporaryDirectory(prefix="modmixer-forge-") as temporary:
        workspace = Path(temporary).resolve()
        source = workspace / "source"
        source.mkdir()

        def snapshot(original: Path, target: Path) -> None:
            if not within(original, mod):
                raise ValueError("A source file points outside the selected mod: " + str(original))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            mappings[str(target)] = str(original)

        about = mod / "About" / "About.xml"
        if about.is_file():
            snapshot(about, source / "About" / "About.xml")
        else:
            mappings[str(source / "About" / "About.xml")] = str(about)
        for number, root in enumerate(roots):
            for category in ("Defs", "Patches"):
                directory = root / category
                if directory.is_dir():
                    for original in sorted(directory.rglob("*.xml")):
                        target = source / category / str(number) / original.relative_to(directory)
                        snapshot(original, target)
                        if category == "Defs":
                            try:
                                document = ET.parse(target).getroot()
                            except ET.ParseError:
                                continue  # Forge emits the syntax diagnostic from the snapshot.
                            if document.tag != "Defs":
                                continue
                            for node in document:
                                name = (node.findtext("defName") or "").strip()
                                if not name:
                                    continue
                                key = (node.tag, name.lower())
                                if key in def_names:
                                    additional.append({"level": "error", "code": "def.duplicate",
                                                       "message": "Duplicate " + node.tag + " defName " + name + "; first seen in " + def_names[key],
                                                       "file": str(original), "defName": name, "defType": node.tag})
                                else:
                                    def_names[key] = str(original)
        assets = forge_workspace / "plans" / "ASSETS-NEEDED.json" if forge_workspace else None
        if assets and assets.is_file():
            try:
                if not within(assets, forge_workspace):
                    raise ValueError("Asset manifest points outside the selected Forge workspace")
                manifest = read_json(assets)
                for asset in manifest.get("assets", []):
                    target = asset.get("target") or asset.get("path")
                    if target:
                        actual = mod / target
                        if not within(actual, mod):
                            raise ValueError("Asset target escapes the mod source: " + target)
                        if not actual.is_file():
                            additional.append({"level": "warning", "code": "asset.missing",
                                               "message": "Declared asset not present: " + target, "file": str(assets)})
            except (ValueError, TypeError, AttributeError) as error:
                additional.append({"level": "error", "code": "asset.manifest", "message": str(error), "file": str(assets)})

        original_texture_check = validator._texture_exists
        validator._texture_exists = lambda _source, texture: any(original_texture_check(root, texture) for root in roots)
        try:
            result = validator.validate_workspace(workspace, index_path)
        finally:
            validator._texture_exists = original_texture_check
        # Vanilla permits a ThingDef and PawnKindDef to share a name (e.g. Muffalo).
        # Replace Forge's global-name diagnostic with the scoped checks above.
        result["problems"] = [p for p in result["problems"] if p["code"] not in ("def.duplicate", "about.version")]
        if about.is_file():
            try:
                supported = [(node.text or "").strip() for node in ET.parse(about).getroot().findall("./supportedVersions/li")]
                current = selected_game_version()
                if current not in supported:
                    result["problems"].append({"level": "warning", "code": "about.version", "message": "About.xml does not declare RimWorld " + current + "; test before changing supportedVersions.", "file": str(about)})
            except ET.ParseError:
                pass  # The foundation already reports the syntax error.
        # Map every diagnostic back to the user's mod, then release the temporary snapshot.
        for problem in result["problems"]:
            file = problem.get("file")
            if file in mappings:
                problem["file"] = mappings[file]
            for old, new in mappings.items():
                problem["message"] = problem["message"].replace(old, new)
    result["problems"].extend(additional)
    result["errors"] = [p for p in result["problems"] if p["level"] == "error"]
    result["warnings"] = [p for p in result["problems"] if p["level"] == "warning"]
    result["ok"] = not result["errors"]
    unresolved = [p for p in result["problems"] if p["code"].startswith("reference.")]
    result["evidence"]["syntax_valid"] = False if result["errors"] else True if complete else None
    result["evidence"]["references_valid"] = (
        True if result["ok"] and complete and index_path and not status["parse_errors"] and not unresolved else None
    )
    result.update({"mod": str(mod), "engine_version": ENGINE_VERSION, "adapter_version": 2, "game_version": selected_game_version(),
                   "checked_at": time.time(), "index_status": status,
                   "coverage": {"load_folders_complete": complete, "load_folders": [str(root) for root in roots],
                                "reference_check": "Conservative scalar fields only; not dependency activation or type/schema validation."},
                   "note": "Static checks only. Texture warnings may refer to assets supplied by dependencies. Load, gameplay and visual tests remain unproven."})
    report = DATA / "reports" / (safe_slug(mod.name)[:50] + "-" + uuid.uuid4().hex + ".json")
    result["report"] = str(report)
    write_json(report, result)
    output = copy.deepcopy(result)
    output.pop("problems", None)
    output["error_count"], output["warning_count"] = len(result["errors"]), len(result["warnings"])
    output["errors"] = output["errors"][:max_problems]
    output["warnings"] = output["warnings"][:max_problems]
    output["details_truncated"] = output["error_count"] > max_problems or output["warning_count"] > max_problems
    return output


def main() -> int:
    # Use UTF-8 even when the ModMixer shell redirects output on Windows.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="RimWorldForge knowledge and static-check adapter for ModMixer")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    commands.add_parser("capabilities")
    build = commands.add_parser("index")
    build.add_argument("--ensure", action="store_true")
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--type")
    search.add_argument("--limit", type=int, default=10)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("def_name")
    validate = commands.add_parser("validate-mod")
    validate.add_argument("mod")
    validate.add_argument("--max-problems", type=int, default=40)
    plan = commands.add_parser("plan-validate")
    plan.add_argument("plan")
    log = commands.add_parser("log-analyze")
    log.add_argument("log", nargs="?")
    log.add_argument("--max-hits", type=int, default=50)
    args = parser.parse_args()
    try:
        if args.command in ("capabilities", "plan-validate", "log-analyze"):
            return cli.main(sys.argv[1:])
        if args.command == "doctor":
            result = discovery.doctor(None)
            result.update({"engine_version": ENGINE_VERSION, "forge_root": str(FORGE_ROOT),
                           "index_status": index_status()[1], "knowledge_snapshot": str(BASE / "docs")})
        elif args.command == "index":
            result = refresh_index(args.ensure)
        elif args.command in ("search", "inspect"):
            path, status = index_status()
            if not path:
                raise ValueError(status["reason"])
            if args.command == "search":
                result = {"ok": True, "results": indexer.search_index(args.query, args.type, path, max(1, min(50, args.limit))), "index_status": status}
            else:
                found = indexer.inspect_def(args.def_name, path)
                result = {"ok": bool(found and found.get("xml")), "def": found, "index_status": status}
        elif args.command == "validate-mod":
            result = validate_mod(Path(args.mod), max(1, min(200, args.max_problems)))
        else:
            raise ValueError("Unknown command")
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result.get("ok") else 2
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        print(json.dumps({"ok": False, "error": str(error), "error_type": type(error).__name__}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
