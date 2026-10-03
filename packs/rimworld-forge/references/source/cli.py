from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .assets import emit_prompts
from .blueprints import blueprint_from_def
from .builder import build_project, stage_project
from .csharp import build as csharp_build, scaffold as csharp_scaffold
from .discovery import discover_game, doctor, player_log_path
from .generator import apply_plan, validate_plan
from .indexer import build_index, inspect_def, search_index
from .logs import analyze_log
from .mods import scan_mods
from .project import new_project
from .util import read_json, state_root
from .validator import validate_workspace


def emit(value, pretty: bool = True) -> None:
    print(json.dumps(value, indent=2 if pretty else None, ensure_ascii=False, sort_keys=True))


def require_game(explicit: str | None) -> Path:
    root = discover_game(explicit)
    if not root:
        raise FileNotFoundError("RimWorld installation not found. Set RIMWORLD_ROOT or pass --game.")
    return root


def capabilities() -> dict:
    return {
        "ok": True,
        "version": __version__,
        "capabilities": {
            "game_discovery": "implemented",
            "vanilla_dlc_def_index": "implemented",
            "def_search_inspect": "implemented",
            "def_blueprint_from_installed_example": "implemented",
            "installed_mod_framework_scan": "implemented",
            "art_prompt_emission": "implemented",
            "typed_plan_generation": "implemented",
            "about_xml_generation": "implemented",
            "loadfolders_generation": "implemented",
            "static_xml_validation": "implemented",
            "candidate_reference_validation": "implemented_with_index",
            "texture_presence_checks": "implemented",
            "deterministic_build_zip_receipt": "implemented",
            "player_log_analysis": "implemented",
            "csharp_scaffold": "implemented",
            "csharp_compile": "implemented_external_approval_required",
            "stage_to_game_mods": "implemented_external_write_approval_required",
            "runtime_launch_automation": "not_implemented",
            "runtime_spawn_test": "not_implemented",
            "visual_validation": "human_or_vision_required",
            "image_generation": "adapter_contract_only",
            "steam_workshop_publish": "not_implemented",
        },
        "evidence_order": ["observed runtime", "compiler/game log", "static Forge validation", "current docs", "model recall"],
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="rwforge", description="RimWorldForge local-first AI modding workbench")
    p.add_argument("--version", action="version", version=f"rwforge {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("doctor")
    d.add_argument("--game")

    sub.add_parser("capabilities")

    idx = sub.add_parser("index")
    idx.add_argument("--game")
    idx.add_argument("--mods-root", action="append", help="Extra mods directory to index (repeatable). Defaults to auto-discovery: game Mods folder + every Steam library Workshop root (or RIMWORLD_WORKSHOP_ROOT / RIMWORLD_MODS_ROOT env overrides).")
    idx.add_argument("--output")

    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--type")
    s.add_argument("--index")
    s.add_argument("--limit", type=int, default=20)

    ins = sub.add_parser("inspect")
    ins.add_argument("def_name")
    ins.add_argument("--index")

    bp = sub.add_parser("def-blueprint")
    bp.add_argument("def_name")
    bp.add_argument("new_def_name")
    bp.add_argument("--output", required=True)
    bp.add_argument("--index")
    bp.add_argument("--package-id", default="author.blueprint")
    bp.add_argument("--mod-name", default="Blueprint Mod")

    ms = sub.add_parser("mods-scan")
    ms.add_argument("--game")

    pn = sub.add_parser("project-new")
    pn.add_argument("name")
    pn.add_argument("--package-id", required=True)
    pn.add_argument("--author", default="")
    pn.add_argument("--description", default="Generated with RimWorldForge.")
    pn.add_argument("--workspace")

    pv = sub.add_parser("plan-validate")
    pv.add_argument("plan")

    gen = sub.add_parser("generate")
    gen.add_argument("workspace")
    gen.add_argument("plan")

    val = sub.add_parser("validate")
    val.add_argument("workspace")
    val.add_argument("--index")

    b = sub.add_parser("build")
    b.add_argument("workspace")
    b.add_argument("--index")

    st = sub.add_parser("stage")
    st.add_argument("workspace")
    st.add_argument("--game")
    st.add_argument("--approve", action="store_true")

    ap = sub.add_parser("art-prompts")
    ap.add_argument("workspace")

    la = sub.add_parser("log-analyze")
    la.add_argument("log", nargs="?")
    la.add_argument("--context", type=int, default=1)
    la.add_argument("--max-hits", type=int, default=200)

    cs = sub.add_parser("csharp-scaffold")
    cs.add_argument("workspace")
    cs.add_argument("--game")
    cs.add_argument("--namespace")
    cs.add_argument("--harmony-dll")

    cb = sub.add_parser("csharp-build")
    cb.add_argument("workspace")
    cb.add_argument("--approve", action="store_true")

    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "doctor":
            result = doctor(args.game)
        elif args.command == "capabilities":
            result = capabilities()
        elif args.command == "index":
            game = require_game(args.game)
            extra = [Path(p) for p in args.mods_root] if getattr(args, "mods_root", None) else []
            # explicit --mods-root REPLACES auto-discovery for predictability; no flag = discover everything
            result = build_index(game, extra if extra else None, Path(args.output) if args.output else None)
        elif args.command == "search":
            result = {"ok": True, "results": search_index(args.query, args.type, Path(args.index) if args.index else None, args.limit)}
        elif args.command == "inspect":
            found = inspect_def(args.def_name, Path(args.index) if args.index else None)
            result = {"ok": bool(found), "def": found}
        elif args.command == "def-blueprint":
            result = blueprint_from_def(args.def_name, args.new_def_name, Path(args.output), Path(args.index) if args.index else None, args.package_id, args.mod_name)
        elif args.command == "mods-scan":
            result = scan_mods(require_game(args.game))
        elif args.command == "project-new":
            result = new_project(args.name, args.package_id, args.author, args.description, Path(args.workspace) if args.workspace else None)
        elif args.command == "plan-validate":
            result = validate_plan(read_json(Path(args.plan)))
        elif args.command == "generate":
            result = apply_plan(Path(args.workspace), Path(args.plan))
        elif args.command == "validate":
            result = validate_workspace(Path(args.workspace), Path(args.index) if args.index else None)
        elif args.command == "build":
            result = build_project(Path(args.workspace), Path(args.index) if args.index else None)
        elif args.command == "stage":
            result = stage_project(Path(args.workspace), require_game(args.game), args.approve)
        elif args.command == "art-prompts":
            result = emit_prompts(Path(args.workspace))
        elif args.command == "log-analyze":
            result = analyze_log(Path(args.log) if args.log else player_log_path(), args.context, args.max_hits)
        elif args.command == "csharp-scaffold":
            result = csharp_scaffold(Path(args.workspace), require_game(args.game), args.namespace, Path(args.harmony_dll) if args.harmony_dll else None)
        elif args.command == "csharp-build":
            result = csharp_build(Path(args.workspace), args.approve)
        else:
            raise RuntimeError(f"Unknown command: {args.command}")
        emit(result)
        return 0 if result.get("ok") else 2
    except (ValueError, FileNotFoundError, FileExistsError, json.JSONDecodeError) as exc:
        emit({"ok": False, "error": str(exc), "error_type": type(exc).__name__})
        return 2
    except KeyboardInterrupt:
        emit({"ok": False, "error": "interrupted"})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
