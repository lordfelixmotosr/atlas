import fs from 'node:fs';
import path from 'node:path';

export interface RimWorldRuntime {
  engine: 'unity' | 'waylith';
  targetFramework: string;
  sdkMajor: number;
  assemblyDir: string;
  references: string[];
}

/** Inspect the selected installation, never infer a runtime from the user's last save. */
export function inspectRimWorldRuntime(assemblyDir: string): RimWorldRuntime {
  const waylith = fs.existsSync(path.join(assemblyDir, 'Waylith.dll'));
  let targetFramework = 'net472';
  if (waylith) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(assemblyDir, 'RimWorld.runtimeconfig.json'), 'utf8'));
      const tfm = config.runtimeOptions?.tfm;
      if (typeof tfm !== 'string' || !/^net\d{2,}\.\d+$/.test(tfm)) throw new Error('Unrecognized target framework');
      targetFramework = tfm;
    } catch {
      throw new Error('Cannot read the Waylith runtime from RimWorld.runtimeconfig.json. Verify the game files in Steam before building C# mods.');
    }
  }
  const names = waylith
    ? ['Assembly-CSharp', 'UnityStubs', 'Waylith.UnityCompat', 'Waylith', 'Brutal.Core.Numerics', 'Brutal.Core.Common']
    : ['Assembly-CSharp', 'UnityEngine', 'UnityEngine.CoreModule', 'UnityEngine.IMGUIModule', 'UnityEngine.TextRenderingModule'];
  return {
    engine: waylith ? 'waylith' : 'unity', targetFramework,
    sdkMajor: waylith ? Number(targetFramework.match(/^net(\d+)/)![1]) : 6,
    assemblyDir,
    references: names.filter(name => fs.existsSync(path.join(assemblyDir, `${name}.dll`))),
  };
}

export function escapeProjectXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderGameReferences(runtime: RimWorldRuntime): string {
  return runtime.references.map(name => `    <Reference Include="${name}">
      <HintPath>${escapeProjectXml(path.join(runtime.assemblyDir, `${name}.dll`))}</HintPath>
      <Private>false</Private>
    </Reference>`).join('\n');
}

export function renderFrameworkPackage(runtime: RimWorldRuntime): string {
  return runtime.engine === 'unity'
    ? '    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />'
    : '';
}

export function readInstalledVersion(installRoot: string | null): string | null {
  if (!installRoot) return null;
  for (const name of ['Version.txt', 'RimWorldMac.app/Version.txt']) {
    try {
      const value = fs.readFileSync(path.join(installRoot, name), 'utf8').replace(/^\uFEFF/, '').trim();
      if (/^\d+\.\d+/.test(value)) return value;
    } catch { /* next candidate */ }
  }
  return null;
}

/** Assembly directory is the install root on Waylith; Unity keeps its platform layout. */
export function installRootFromAssemblies(assemblyDir: string): string {
  if (fs.existsSync(path.join(assemblyDir, 'RimWorld.runtimeconfig.json')) || fs.existsSync(path.join(assemblyDir, 'Waylith.dll'))) return assemblyDir;
  const parent = path.dirname(path.dirname(assemblyDir));
  if (path.basename(parent) === 'Resources' && path.basename(path.dirname(parent)) === 'Contents') return path.dirname(path.dirname(parent));
  return parent;
}
