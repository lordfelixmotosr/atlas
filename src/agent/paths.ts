import { homedir, platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { installRootFromAssemblies, readInstalledVersion } from './rimworld/runtime.js';

let installOverride: string | null = null;
export function setRimWorldInstallOverride(root: string | null): void { installOverride = root || null; }
export function getRimWorldInstallOverride(): string | null { return installOverride; }

export interface RimWorldPaths {
  modsDir: string;
  /** Managed assembly directory: Unity's Managed/ or Waylith's install root. */
  managedDir: string | null;
  installRoot: string | null;
  version: string | null;
  engine: 'unity' | 'waylith' | null;
  executable: string | null;
  dataDir: string | null;
  workshopDir: string | null;
  playerLog: string | null;
  modsConfig: string | null;
  prefsXml: string | null;
}

const firstFile = (candidates: string[]) => candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;

/** Probe both layouts within ONE installation so assemblies, mods and executable cannot diverge. */
export function inspectRimWorldInstall(root: string, os: NodeJS.Platform = platform()) {
  const bundle = root.endsWith('.app') ? root : path.join(root, 'RimWorldMac.app');
  const candidates = [root, path.join(bundle, 'Contents/MacOS'), path.join(bundle, 'Contents/Resources'),
    path.join(root, 'RimWorldWin64_Data/Managed'), path.join(root, 'RimWorldLinux_Data/Managed'),
    path.join(bundle, 'Contents/Resources/Data/Managed')];
  const assemblyDir = candidates.find(dir => fs.existsSync(path.join(dir, 'Assembly-CSharp.dll')));
  if (!assemblyDir) return null;
  const waylith = fs.existsSync(path.join(assemblyDir, 'Waylith.dll'));
  const installRoot = os === 'darwin' && assemblyDir.startsWith(bundle + path.sep) ? bundle : installRootFromAssemblies(assemblyDir);
  let executable: string | null;
  if (os === 'darwin') {
    let name = '';
    try { name = fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8').match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ?? ''; } catch { /* fallback */ }
    executable = firstFile([...(name ? [path.join(bundle, 'Contents/MacOS', name)] : []),
      ...['RimWorld', 'RimWorld by Ludeon Studios', 'RimWorldMac'].map(n => path.join(bundle, 'Contents/MacOS', n))]);
  } else {
    executable = firstFile((os === 'win32' ? (waylith ? ['RimWorld.exe'] : ['RimWorldWin64.exe']) : (waylith ? ['RimWorld'] : ['RimWorldLinux'])).map(n => path.join(installRoot, n)));
  }
  const dataDir = [path.join(root, 'Data'), path.join(bundle, 'Data'), path.join(bundle, 'Contents/Resources'), path.join(installRoot, 'Data')]
    .find(dir => fs.existsSync(path.join(dir, 'Core/Defs'))) ?? null;
  return { managedDir: assemblyDir, installRoot, version: readInstalledVersion(installRoot) ?? readInstalledVersion(root), engine: waylith ? 'waylith' as const : 'unity' as const,
    executable, dataDir, modsDir: path.join(os === 'darwin' && fs.existsSync(bundle) ? bundle : installRoot, 'Mods') };
}

function steamInstallCandidates(os: NodeJS.Platform, home: string): string[] {
  const steamRoots = os === 'win32' ? ['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam']
    : os === 'darwin' ? [path.join(home, 'Library/Application Support/Steam')]
    : [path.join(home, '.steam/steam'), path.join(home, '.local/share/Steam')];
  const libraries = new Set(steamRoots);
  for (const steam of steamRoots) {
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps/libraryfolders.vdf'), 'utf8');
      for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1].replace(/\\\\/g, '\\'));
    } catch { /* Steam not installed here */ }
  }
  return [...libraries].map(library => path.join(library, 'steamapps/common/RimWorld'));
}

/** The installed version wins over ModsConfig, which can still describe the previous Steam branch. */
export function detectGameVersionMajorMinorSync(): string | null {
  const rim = detectRimWorldPaths();
  const installed = rim.version?.match(/^\d+\.\d+/)?.[0];
  if (installed) return installed;
  try { return fs.readFileSync(rim.modsConfig!, 'utf8').match(/<version>\s*(\d+\.\d+)/)?.[1] ?? null; } catch { return null; }
}

export function detectRimWorldPaths(): RimWorldPaths {
  const home = homedir(), os = platform();
  const candidates = [...(installOverride ? [installOverride] : []), ...steamInstallCandidates(os, home)];
  const install = candidates.map(root => inspectRimWorldInstall(root, os)).find(Boolean) ?? null;
  const userBases = os === 'win32'
    ? [path.join(process.env.USERPROFILE ?? home, 'AppData/LocalLow/Ludeon Studios/RimWorld by Ludeon Studios')]
    : os === 'darwin'
      ? [path.join(home, 'Library/Application Support/RimWorld'), path.join(home, 'Library/Application Support/RimWorld by Ludeon Studios')]
      : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'unity3d/Ludeon Studios/RimWorld by Ludeon Studios')];
  const modsConfig = firstFile(userBases.map(base => path.join(base, 'Config/ModsConfig.xml')));
  const workshopCandidates = [...(install?.installRoot ? [install.installRoot.replace(/[\\/]RimWorldMac\.app$/, '')] : []), ...candidates]
    .map(root => path.join(path.dirname(path.dirname(root)), 'workshop/content/294100'));
  const logs = [...userBases.map(base => path.join(base, 'Player.log'))];
  if (os === 'darwin') logs.unshift(path.join(home, 'Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios/Player.log'));
  if (install?.engine === 'waylith') {
    const logBases = os === 'darwin' ? [path.join(home, 'Library/Application Support/Ludeon Studios/RimWorld by Ludeon Studios')] : userBases;
    logs.unshift(...logBases.map(base => path.join(base, 'Logs/Player.log')));
  }
  return {
    modsDir: install?.modsDir ?? path.join(candidates[0], 'Mods'),
    managedDir: install?.managedDir ?? null, installRoot: install?.installRoot ?? null,
    version: install?.version ?? null, engine: install?.engine ?? null,
    executable: install?.executable ?? null, dataDir: install?.dataDir ?? null,
    workshopDir: workshopCandidates.find(p => fs.existsSync(p)) ?? null,
    playerLog: firstFile(logs), modsConfig,
    prefsXml: modsConfig ? firstFile([path.join(path.dirname(modsConfig), 'Prefs.xml')]) : null,
  };
}
