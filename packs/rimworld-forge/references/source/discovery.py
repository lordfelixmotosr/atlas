from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Iterable

from .util import json_result

DLC_DIRS = ("Core", "Royalty", "Ideology", "Biotech", "Anomaly", "Odyssey")


def _steam_roots_windows() -> Iterable[Path]:
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
    candidates += [Path(r"C:\Program Files (x86)\Steam"), Path(r"C:\Program Files\Steam")]
    for root in candidates:
        root = root.expanduser()
        if root in seen:
            continue
        seen.add(root)
        yield root
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            try:
                text = vdf.read_text(encoding="utf-8", errors="ignore")
                for match in re.finditer(r'"path"\s+"([^"]+)"', text):
                    p = Path(match.group(1).replace("\\\\", "\\"))
                    if p not in seen:
                        seen.add(p)
                        yield p
            except OSError:
                pass


def candidate_game_roots() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("RIMWORLD_ROOT")
    if env:
        out.append(Path(env).expanduser())
    if os.name == "nt":
        for steam in _steam_roots_windows():
            out.append(steam / "steamapps" / "common" / "RimWorld")
    elif sys.platform == "darwin":
        out += [
            Path.home() / "Library/Application Support/Steam/steamapps/common/RimWorld/RimWorldMac.app",
            Path.home() / "Library/Application Support/Steam/steamapps/common/RimWorld",
        ]
    else:
        out += [
            Path.home() / ".steam/steam/steamapps/common/RimWorld",
            Path.home() / ".local/share/Steam/steamapps/common/RimWorld",
        ]
    unique: list[Path] = []
    seen: set[str] = set()
    for p in out:
        key = str(p).lower() if os.name == "nt" else str(p)
        if key not in seen:
            unique.append(p)
            seen.add(key)
    return unique


def validate_game_root(root: Path) -> bool:
    data = root / "Data"
    return data.is_dir() and (data / "Core" / "Defs").is_dir()


def discover_game(explicit: str | None = None) -> Path | None:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        return p if validate_game_root(p) else None
    for p in candidate_game_roots():
        if validate_game_root(p):
            return p.resolve()
    return None


def game_version(root: Path) -> str | None:
    for candidate in (root / "Version.txt", root / "version.txt"):
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8", errors="ignore").strip()
            if text:
                return text.splitlines()[0].strip()
    return None


def managed_dir(root: Path) -> Path | None:
    candidates = [
        root / "RimWorldWin64_Data" / "Managed",
        root / "RimWorldLinux_Data" / "Managed",
        root / "Contents" / "Resources" / "Data" / "Managed",
    ]
    for p in candidates:
        if p.is_dir():
            return p
    return None


def player_log_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("USERPROFILE", Path.home()))
        return base / "AppData/LocalLow/Ludeon Studios/RimWorld by Ludeon Studios/Player.log"
    if sys.platform == "darwin":
        return Path.home() / "Library/Logs/Unity/Player.log"
    return Path.home() / ".config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios/Player.log"


def doctor(explicit: str | None = None) -> dict:
    root = discover_game(explicit)
    if not root:
        return json_result(False, game_found=False, candidates=[str(p) for p in candidate_game_roots()])
    data = root / "Data"
    packs = {name: (data / name).is_dir() for name in DLC_DIRS}
    managed = managed_dir(root)
    mods = root / "Mods"
    log = player_log_path()
    return json_result(
        True,
        game_found=True,
        root=str(root),
        version=game_version(root),
        data=str(data),
        mods=str(mods),
        managed=str(managed) if managed else None,
        dlc=packs,
        player_log=str(log),
        player_log_exists=log.is_file(),
    )
