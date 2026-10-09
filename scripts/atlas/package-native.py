"""Package a verified native Atlas folder without private portable data."""
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
version = json.loads((source / "atlas-build.json").read_text(encoding="utf-8"))["version"]
if not (source / "Atlas.exe").is_file() or not (source / "resources/app.asar").is_file():
    raise SystemExit("Atlas runtime is incomplete")

private_roots = {"data", "custom", "library", "backups"}
files = []
for base, dirs, names in os.walk(source):
    directory = Path(base)
    dirs[:] = [name for name in sorted(dirs) if name != "__pycache__" and (directory != source or name not in private_roots)]
    for name in sorted(names):
        path = directory / name
        relative = path.relative_to(source).as_posix()
        if name.endswith(".pyc"):
            continue
        if path.is_symlink() or name.lower() in {"auth.json", "auth.enc"} or name.endswith(".private.pem"):
            raise SystemExit(f"Unexpected private or linked file: {relative}")
        files.append((path, relative))

compact_roots = {
    "Atlas.exe", "LICENSE", "NOTICE", "README-ATLAS.md", "atlas-build.json",
    "resources/app.asar", "resources/modmixer-bridge/About/About.xml",
    "resources/node_modules/@earendil-works/pi-ai/dist/auth/oauth/oauth-page.js",
}
def compact(relative):
    return relative in compact_roots or relative.startswith("resources/atlas/")

output.mkdir(parents=True, exist_ok=True)
receipts = {}
for kind in ("portable", "full-update", "application-update"):
    members = [(path, relative) for path, relative in files
               if (kind == "portable" or not relative.startswith("updates/"))
               and (kind != "application-update" or compact(relative))]
    if kind == "application-update" and not compact_roots.issubset({relative for _, relative in members}):
        raise SystemExit("Compact update is missing an essential runtime file")
    target = output / f"Atlas-{version}-win-x64-{kind}.zip"
    temporary = target.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path, relative in members:
            archive.write(path, "Atlas/" + relative)
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise SystemExit(f"ZIP integrity check failed: {kind}")
    digest = hashlib.sha256()
    with temporary.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    temporary.replace(target)
    receipts[kind] = {"path": target.name, "size": target.stat().st_size, "sha256": digest.hexdigest()}
    print(f"{kind}: {len(members)} files, {target.stat().st_size:,} bytes", flush=True)

(output / f"Atlas-{version}-checksums.json").write_text(json.dumps(receipts, indent=2) + "\n", encoding="utf-8")
