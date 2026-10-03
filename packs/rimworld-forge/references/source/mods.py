from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Any

from .discovery import discover_game

KNOWN_FRAMEWORKS = {
    "erdelf.humanoidalienraces": "Humanoid Alien Races",
    "brrainz.harmony": "Harmony",
    "smashphil.vehicleframework": "Vehicle Framework",
    "redmattis.bigsmall.core": "Big & Small Core",
    "oskarpotocki.vanillafactionsexpanded.core": "Vanilla Factions Expanded - Core",
    "vanillaexpanded.vfecore": "Vanilla Expanded Framework",
    "memegoddess.giddyup": "Giddy-Up",
    "rim.job.world": "RimJobWorld",
    "cj.rimtalk": "RimTalk",
    "unlimitedhugs.hugslib": "HugsLib",
    "syrchalis.processor.framework": "Processor Framework",
    "smashphil.tabula": "Tabula Rasa",
    "o21.betterloading": "Better Loading",
}

# Frameworks whose presence is detected from their DLL/assembly layout or well-known
# About.xml <modVersion>/<url> markers rather than a single packageId.
ASSEMBLY_MARKERS = {
    "0Harmony.dll": "Harmony",
    "HAR.dll": "Humanoid Alien Races",
    " AlienRace.dll": "Humanoid Alien Races",
}


def _workshop_root(game_root: Path) -> Path | None:
    # <SteamLibrary>/steamapps/common/RimWorld -> <SteamLibrary>/steamapps/workshop/content/294100
    try:
        steamapps = game_root.parents[1]
        p = steamapps / "workshop" / "content" / "294100"
        return p if p.is_dir() else None
    except IndexError:
        return None


def workshop_roots(game_root: Path | None = None) -> list[Path]:
    """All RimWorld Workshop content roots findable on this machine.

    Env override first (RIMWORLD_WORKSHOP_ROOT, os.pathsep-separated), then the
    library containing the game itself, then every other Steam library via
    libraryfolders.vdf. Different machines keep games on different drives; all of
    them are covered without hardcoding anything.
    RIMWORLD_FORGE_OFFLINE=1 disables Steam-library probing entirely (hermetic tests).
    """
    roots: list[Path] = []
    seen: set[str] = set()

    def add(p: Path) -> None:
        key = str(p).lower() if os.name == "nt" else str(p)
        if p.is_dir() and key not in seen:
            seen.add(key)
            roots.append(p)

    extra = os.environ.get("RIMWORLD_WORKSHOP_ROOT")
    if extra:
        for part in extra.split(os.pathsep):
            add(Path(part.strip().strip('"')).expanduser() / "content" / "294100")
            add(Path(part.strip().strip('"')).expanduser())
    wr = _workshop_root(game_root) if game_root else None
    if wr:
        add(wr)
    if os.environ.get("RIMWORLD_FORGE_OFFLINE") == "1":
        return roots  # no library probing
    for steam in _steam_libraries():
        add(steam / "steamapps" / "workshop" / "content" / "294100")
    return roots


def _steam_libraries() -> list[Path]:
    """Every Steam library root advertised by libraryfolders.vdf (plus default installs)."""
    out: list[Path] = []
    seen: set[Path] = set()
    candidates: list[Path] = []
    try:
        import winreg  # type: ignore

        for hive, key in (
            (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
        ):
            try:
                with winreg.OpenKey(hive, key) as h:
                    for value_name in ("SteamPath", "InstallPath"):
                        try:
                            value, _ = winreg.QueryValueEx(h, value_name)
                            candidates.append(Path(value))
                        except OSError:
                            pass
            except OSError:
                pass
    except Exception:
        pass
    candidates += [Path(r"C:\Program Files (x86)\Steam"), Path.home() / ".steam" / "steam", Path.home() / ".local" / "share" / "Steam"]
    for root in candidates:
        root = root.expanduser()
        if root not in seen:
            seen.add(root)
            out.append(root)
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            try:
                text = vdf.read_text(encoding="utf-8", errors="ignore")
                for match in re.finditer(r'"path"\s+"([^"]+)"', text):
                    p = Path(match.group(1).replace("\\\\", "\\"))
                    if p not in seen:
                        seen.add(p)
                        out.append(p)
            except OSError:
                pass
    return out


def mod_roots(game_root: Path) -> list[tuple[str, Path]]:
    roots: list[tuple[str, Path]] = []
    local = game_root / "Mods"
    if local.is_dir():
        roots.append(("local", local))
    for wr in workshop_roots(game_root):
        roots.append(("workshop", wr))
    extra = os.environ.get("RIMWORLD_MODS_ROOT")
    if extra:
        p = Path(extra).expanduser()
        if p.is_dir():
            roots.append(("extra", p))
    return roots


def _parse_about(path: Path, origin: str) -> dict[str, Any] | None:
    try:
        root = ET.parse(path).getroot()
        if root.tag != "ModMetaData":
            return None
        pid = (root.findtext("packageId") or "").strip()
        if not pid:
            return None
        return {
            "origin": origin,
            "root": str(path.parent.parent),
            "name": (root.findtext("name") or path.parent.parent.name).strip(),
            "packageId": pid,
            "author": (root.findtext("author") or "").strip() or None,
            "supportedVersions": [(x.text or "").strip() for x in root.findall("./supportedVersions/li") if (x.text or "").strip()],
            "dependencies": [(x.text or "").strip() for x in root.findall("./modDependencies/li/packageId") if (x.text or "").strip()],
        }
    except (ET.ParseError, OSError):
        return None


def scan_mods(game_root: Path) -> dict[str, Any]:
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for origin, root in mod_roots(game_root):
        for child in sorted(p for p in root.iterdir() if p.is_dir()):
            about = child / "About" / "About.xml"
            if not about.is_file():
                continue
            rec = _parse_about(about, origin)
            if not rec:
                continue
            key = rec["packageId"].lower()
            if key in seen:
                rec["duplicatePackageId"] = True
            seen.add(key)
            found.append(rec)
    frameworks = []
    for pid, title in KNOWN_FRAMEWORKS.items():
        matches = [m for m in found if m["packageId"].lower() == pid]
        frameworks.append({"packageId": pid, "name": title, "installed": bool(matches), "matches": matches})
    # assembly-marker detection catches renamed/repackaged framework installs
    marker_hits: dict[str, list[str]] = {}
    for origin, root in mod_roots(game_root):
        for child in sorted(p for p in root.iterdir() if p.is_dir()):
            if not (child / "About" / "About.xml").is_file():
                continue
            assemblies = child / "Assemblies"
            for vers in ((child, assemblies), (child / "1.6", child / "1.6" / "Assemblies"), (child / "Common", child / "Common" / "Assemblies")):
                adir = vers[1]
                if not adir.is_dir():
                    continue
                try:
                    names = {f.name.lower() for f in adir.iterdir() if f.is_file()}
                except OSError:
                    continue
                for marker, title in ASSEMBLY_MARKERS.items():
                    if marker.lower() in names and child.name not in marker_hits.get(title, []):
                        marker_hits.setdefault(title, []).append(child.name)
    for title, mods_ in marker_hits.items():
        existing = next((f for f in frameworks if f["name"] == title), None)
        if existing is None:
            frameworks.append({"packageId": None, "name": title, "installed": True, "matches": [], "detected_by": "assembly_marker", "mods": mods_})
        elif not existing["installed"]:
            existing["installed"] = True
            existing["detected_by"] = "assembly_marker"
            existing["mods"] = mods_
    return {"ok": True, "mods": found, "count": len(found), "frameworks": frameworks, "roots": [{"origin": o, "path": str(p)} for o, p in mod_roots(game_root)]}
