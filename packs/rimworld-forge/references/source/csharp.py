from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from .discovery import managed_dir
from .util import ensure_dir, read_json, safe_slug, write_json

CSPROJ = r'''<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <AssemblyName>{assembly}</AssemblyName>
    <RootNamespace>{namespace}</RootNamespace>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="Assembly-CSharp"><HintPath>{managed}\Assembly-CSharp.dll</HintPath><Private>false</Private></Reference>
    <Reference Include="UnityEngine"><HintPath>{managed}\UnityEngine.dll</HintPath><Private>false</Private></Reference>
    <Reference Include="UnityEngine.CoreModule"><HintPath>{managed}\UnityEngine.CoreModule.dll</HintPath><Private>false</Private></Reference>
{harmony_ref}  </ItemGroup>
</Project>
'''

SOURCE = r'''using Verse;

namespace {namespace};

public sealed class {class_name}Mod : Mod
{{
    public {class_name}Mod(ModContentPack content) : base(content)
    {{
        Log.Message("[{assembly}] loaded");
    }}
}}
'''


def scaffold(workspace: Path, game_root: Path, namespace: str | None = None, harmony_dll: Path | None = None) -> dict[str, Any]:
    config = read_json(workspace / "forge.json")
    managed = managed_dir(game_root)
    if not managed:
        raise FileNotFoundError("RimWorld Managed directory was not found")
    assembly = safe_slug(config.get("name", "RimWorldForgeMod")).replace("-", "")
    ns = namespace or f"RimWorldForge.{assembly}"
    class_name = "".join(ch for ch in assembly if ch.isalnum()) or "Generated"
    project = ensure_dir(workspace / "csharp" / assembly)
    href = ""
    if harmony_dll:
        href = f'    <Reference Include="0Harmony"><HintPath>{harmony_dll}</HintPath><Private>false</Private></Reference>\n'
    (project / f"{assembly}.csproj").write_text(CSPROJ.format(assembly=assembly, namespace=ns, managed=str(managed), harmony_ref=href), encoding="utf-8")
    (project / "Mod.cs").write_text(SOURCE.format(namespace=ns, class_name=class_name, assembly=assembly), encoding="utf-8")
    return {"ok": True, "project": str(project), "assembly": assembly, "namespace": ns}


def build(workspace: Path, approve: bool = False) -> dict[str, Any]:
    if not approve:
        return {"ok": False, "refused": True, "reason": "C# build executes an external compiler and requires --approve."}
    projects = sorted((workspace / "csharp").glob("*/*.csproj"))
    if not projects:
        raise FileNotFoundError("No C# project. Run `rwforge csharp-scaffold` first.")
    dotnet = shutil.which("dotnet")
    if not dotnet:
        return {"ok": False, "dependency": "dotnet", "reason": "dotnet was not found on PATH"}
    results: list[dict[str, Any]] = []
    assemblies = ensure_dir(workspace / "source" / "Assemblies")
    all_ok = True
    for project in projects:
        proc = subprocess.run([dotnet, "build", str(project), "-c", "Release", "--nologo"], capture_output=True, text=True, shell=False)
        item = {"project": str(project), "exit_code": proc.returncode, "stdout": proc.stdout[-12000:], "stderr": proc.stderr[-12000:]}
        if proc.returncode == 0:
            dlls = list((project.parent / "bin" / "Release").glob("*.dll"))
            copied = []
            for dll in dlls:
                if dll.name.lower().endswith(".resources.dll"):
                    continue
                target = assemblies / dll.name
                shutil.copy2(dll, target)
                copied.append(str(target))
            item["copied"] = copied
        else:
            all_ok = False
        results.append(item)
    report = {"ok": all_ok, "results": results}
    write_json(workspace / "reports" / "csharp-build.json", report)
    return report
