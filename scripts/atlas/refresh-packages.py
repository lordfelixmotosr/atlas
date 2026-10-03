"""Refresh application files while retaining verified compressed public runtimes."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import zipfile

source, output = map(lambda value: Path(value).resolve(), sys.argv[1:3])
version = json.loads((source / "atlas-build.json").read_text())["version"]
replacements = {"resources/app.asar", "Atlas.exe", "atlas-build.json", "README-ATLAS.md", "resources/atlas/apply-update.ps1", "resources/modmixer-bridge/About/About.xml", "resources/node_modules/@earendil-works/pi-ai/dist/auth/oauth/oauth-page.js"}
replacements.add("resources/atlas/watch-update.ps1")
replacements.add("resources/atlas/distribution.json")
replacements.update({"LICENSE", "NOTICE"})
replacements.update(file.relative_to(source).as_posix() for file in (source / "resources/atlas/game-adapter-template").rglob("*") if file.is_file())
replacements.update(file.relative_to(source).as_posix() for file in (source / "resources/atlas/seed").glob("*.atlas.json"))
result = {}
for kind in ("portable", "application-update"):
    current_replacements = replacements | ({file.relative_to(source).as_posix() for file in (source / "updates").glob("*.atlas.json")} if kind == "portable" else set())
    target = output / f"Atlas-{version}-win-x64-{kind}.zip"
    temporary = target.with_suffix(".zip.refresh.tmp")
    previous = target if target.exists() else output / f"Atlas-{sys.argv[3]}-win-x64-{kind}.zip"
    with zipfile.ZipFile(previous) as old, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as new:
        entries = old.infolist()
        for index, item in enumerate(entries):
            relative = item.filename.removeprefix("Atlas/")
            if relative in current_replacements:
                continue
            end = entries[index + 1].header_offset if index + 1 < len(entries) else old.start_dir
            remaining = end - item.header_offset
            cloned = copy.copy(item)
            cloned.header_offset = new.fp.tell()
            old.fp.seek(item.header_offset)
            while remaining:
                chunk = old.fp.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError("Incomplete source archive")
                new.fp.write(chunk)
                remaining -= len(chunk)
            new.filelist.append(cloned)
            new.NameToInfo[cloned.filename] = cloned
            new.start_dir = new.fp.tell()
            new._didModify = True
        for relative in sorted(current_replacements):
            new.write(source / relative, "Atlas/" + relative)
    with zipfile.ZipFile(temporary) as checked:
        if checked.testzip() is not None:
            raise RuntimeError("Refreshed archive integrity failed")
        names = checked.namelist()
        if len(names) != len(set(names)) or any(name.startswith(tuple("Atlas/" + private + "/" for private in ("data", "custom", "library", "backups"))) for name in names):
            raise RuntimeError("Duplicate or private archive entry")
        manifest = json.loads(checked.read("Atlas/atlas-build.json"))
        for relative, key in (("resources/app.asar", "archiveSha256"), ("Atlas.exe", "exeSha256")):
            if hashlib.sha256(checked.read("Atlas/" + relative)).hexdigest() != manifest[key]:
                raise RuntimeError("Release receipt differs from archive")
    os.replace(temporary, target)
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    result[kind] = {"path": target.name, "size": target.stat().st_size, "sha256": digest}
    print(kind + " ZIP refreshed and verified", flush=True)
(output / f"Atlas-{version}-checksums.json").write_text(json.dumps(result, indent=2))
shutil.copyfile(source / "README-ATLAS.md", output / "Atlas-README.md")
