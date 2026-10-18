import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {app} from 'electron';

export interface SavedTestOptions {isolated: true; quicktest: boolean; autoOpenPalette: boolean; companionMods: string[]; paletteEntries: string[]}
export function savedTestOptions(value: Record<string, unknown>): SavedTestOptions {
  const strings = (v: unknown, max: number) => Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.length <= 1024))].slice(0, max) : [];
  return {isolated: true, quicktest: value.quicktest !== false, autoOpenPalette: value.autoOpenPalette !== false, companionMods: strings(value.companionMods, 200), paletteEntries: strings(value.paletteEntries, 200)};
}
function file(folder: string): string {return path.join(app.getPath('userData'), 'test-runs', createHash('sha256').update(folder).digest('hex') + '.json');}
export async function readTestOptions(folder: string): Promise<SavedTestOptions> {
  try {const r = JSON.parse(await fs.readFile(file(folder), 'utf8')); return savedTestOptions(r.folder === folder && r.version === 1 ? r.params : {});}
  catch {return savedTestOptions({});}
}
export async function saveTestOptions(folder: string, params: Record<string, unknown>): Promise<void> {
  const destination = file(folder), temporary = destination + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(destination), {recursive: true});
  try {await fs.writeFile(temporary, JSON.stringify({version: 1, folder, params: savedTestOptions(params)}), {flag: 'wx'}); await fs.rename(temporary, destination);}
  finally {await fs.unlink(temporary).catch(() => {});}
}
