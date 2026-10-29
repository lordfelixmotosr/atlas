import type {ModChangeFile, ModInventory} from './mod-changes';

type File = ModInventory['files'][string];
type Def = NonNullable<File['defs']>[string];
type Occurrence = {path: string; def: Def};
type Line = {kind: ' ' | '-' | '+'; text: string; before?: number; after?: number};
const size = (value: unknown) => JSON.stringify(value).length;

/** Keep the actual changed lines and nearby context, not the start of each file.
 * Unique-line anchors keep the comparison bounded even for generated files. */
function changedLines(before: string, after: string): string {
  const old = before.replace(/\r\n?/g, '\n').split('\n'), next = after.replace(/\r\n?/g, '\n').split('\n'), lines: Line[] = [];
  function compare(a: number, b: number, c: number, d: number, depth: number) {
    while (a < b && c < d && old[a] === next[c]) lines.push({kind: ' ', text: old[a], before: ++a, after: ++c});
    let suffix = 0;
    while (a < b - suffix && c < d - suffix && old[b - suffix - 1] === next[d - suffix - 1]) suffix++;
    const endOld = b - suffix, endNew = d - suffix;
    const oldCounts = new Map<string, number>(), newCounts = new Map<string, number>();
    if (depth < 12) {
      for (let i = a; i < endOld; i++) oldCounts.set(old[i], oldCounts.has(old[i]) ? -1 : i);
      for (let i = c; i < endNew; i++) newCounts.set(next[i], newCounts.has(next[i]) ? -1 : i);
    }
    const pairs: [number, number][] = [];
    for (const [text, position] of oldCounts) {
      const other = newCounts.get(text);
      if (text.trim() && position >= 0 && other !== undefined && other >= 0) pairs.push([position, other]);
    }
    const tails: number[] = [], previous = new Array<number>(pairs.length).fill(-1);
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const middle = (lo + hi) >> 1; if (pairs[tails[middle]][1] < pairs[i][1]) lo = middle + 1; else hi = middle; }
      previous[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
    }
    const anchors: [number, number][] = [];
    for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) anchors.push(pairs[index]);
    anchors.reverse();
    if (anchors.length) {
      for (const [x, y] of anchors) { compare(a, x, c, y, depth + 1); lines.push({kind: ' ', text: old[x], before: x + 1, after: y + 1}); a = x + 1; c = y + 1; }
      compare(a, endOld, c, endNew, depth + 1);
    } else {
      for (let i = a; i < endOld; i++) lines.push({kind: '-', text: old[i], before: i + 1});
      for (let i = c; i < endNew; i++) lines.push({kind: '+', text: next[i], after: i + 1});
    }
    for (let i = 0; i < suffix; i++) lines.push({kind: ' ', text: old[endOld + i], before: endOld + i + 1, after: endNew + i + 1});
  }
  compare(0, old.length, 0, next.length, 0);
  const ranges: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].kind !== ' ') {
    const start = Math.max(0, i - 2), end = Math.min(lines.length, i + 3), last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => '@@ changed excerpt @@\n' + lines.slice(start, end).map(line => `${line.kind}${line.before ?? ''}/${line.after ?? ''}: ${line.text}`).join('\n')).join('\n\n');
}

function shortened(text: string, maximum: number): string | null {
  if (text.length <= maximum) return text;
  if (maximum < 80) return null;
  const marker = '\n[Middle of excerpt omitted; do not infer omitted changes.]\n', half = Math.floor((maximum - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(-half);
}

function boundedExcerpt(text: string, encodedBudget: number): string | null {
  let low = 0, high = Math.min(text.length, encodedBudget), result: string | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1, candidate = shortened(text, middle);
    if (size(candidate) <= encodedBudget) { result = candidate; low = middle + 1; } else high = middle - 1;
  }
  return result;
}

function fairBudgets(demands: number[], available: number): number[] {
  const results = demands.map(() => 0), order = demands.map((demand, index) => ({demand, index})).sort((a, b) => a.demand - b.demand);
  for (let i = 0; i < order.length; i++) {
    const allowance = Math.min(order[i].demand, Math.max(0, Math.floor(available / (order.length - i))));
    results[order[i].index] = allowance; available -= allowance;
  }
  return results;
}

const privateFile = (filename: string) => /(?:^|\/)(?:auth|credentials?|secrets?|tokens?)(?:[.-]|$)/i.test(filename);
const definitionFile = (filename: string) => /\.xml$/i.test(filename) && !privateFile(filename);
function definitionIndex(inventory: ModInventory): Map<string, Occurrence[]> {
  const index = new Map<string, Occurrence[]>();
  for (const filename of Object.keys(inventory.files).sort().filter(definitionFile)) for (const [name, def] of Object.entries(inventory.files[filename].defs ?? {})) {
    const key = def.type + '\0' + name, occurrences = index.get(key) ?? [];
    occurrences.push({path: filename, def}); index.set(key, occurrences);
  }
  return index;
}

/** A definition name is not globally unique across version folders or load branches.
 * Match exact content/path first and leave remaining branch matches ambiguous. */
function definitionEvidence(previous: ModInventory, current: ModInventory, ids: Map<string, string>) {
  const oldIndex = definitionIndex(previous), newIndex = definitionIndex(current), entries: Record<string, unknown>[] = [];
  const missingBefore = Object.keys(previous.files).filter(filename => definitionFile(filename) && previous.files[filename].defs === undefined);
  const missingAfter = Object.keys(current.files).filter(filename => definitionFile(filename) && current.files[filename].defs === undefined);
  for (const identity of [...new Set([...oldIndex.keys(), ...newIndex.keys()])].sort()) {
    const allOld = oldIndex.get(identity) ?? [], allNew = newIndex.get(identity) ?? [], old = [...allOld], next = [...allNew];
    const [type, name] = identity.split('\0');
    function emit(action: string, before: Occurrence[], after: Occurrence[], ambiguous = false) {
      const chosen = after[0]?.def ?? before[0].def, firstOld = before[0]?.def, firstNew = after[0]?.def;
      const fieldChanges: {field: string; before: string | null; after: string | null}[] = [];
      if (firstOld && firstNew && !ambiguous && action === 'edited') for (const field of new Set([...Object.keys(firstOld.fields ?? {}), ...Object.keys(firstNew.fields ?? {})])) {
        if (firstOld.ambiguousFields?.includes(field) || firstNew.ambiguousFields?.includes(field)) continue;
        if (firstOld.fields?.[field] !== firstNew.fields?.[field]) fieldChanges.push({field, before: firstOld.fields?.[field] ?? null, after: firstNew.fields?.[field] ?? null});
      }
      const paths = [...new Set([...before, ...after].map(item => item.path))];
      entries.push({id: `definition-${entries.length + 1}`, name, type, label: chosen.label, kind: chosen.kind, action,
        beforePaths: before.map(item => item.path), afterPaths: after.map(item => item.path), evidenceIds: paths.map(p => ids.get(p)).filter(Boolean),
        beforeLabel: firstOld?.label ?? null, afterLabel: firstNew?.label ?? null,
        beforeDescription: firstOld?.description ?? null, afterDescription: firstNew?.description ?? null,
        fieldChanges: fieldChanges.slice(0, 20), omittedFieldChanges: Math.max(0, fieldChanges.length - 20),
        fieldValuesArePartial: true, fieldComparisonAmbiguous: !!firstOld && !!firstNew && (firstOld.fieldFormat !== 2 || firstNew.fieldFormat !== 2),
        ambiguousFields: [...new Set([...(firstOld?.ambiguousFields ?? []), ...(firstNew?.ambiguousFields ?? [])])],
        definitionFieldsTruncated: !!firstOld?.fieldsTruncated || !!firstNew?.fieldsTruncated,
        ambiguous, multipleVersionOrLoadVariants: allOld.length > 1 || allNew.length > 1,
        presenceDoesNotProveEnabled: true,
        ...(action === 'relocated' ? {sameContentMove: true, playerChangeEstablished: false} : {}),
      });
    }
    function pairWhere(predicate: (a: Occurrence, b: Occurrence) => boolean, action?: string) {
      for (let i = old.length - 1; i >= 0; i--) {
        const j = next.findIndex(item => predicate(old[i], item)); if (j < 0) continue;
        const before = old.splice(i, 1)[0], after = next.splice(j, 1)[0]; if (action) emit(action, [before], [after]);
      }
    }
    pairWhere((a, b) => a.path === b.path && a.def.hash === b.def.hash);
    pairWhere((a, b) => a.path === b.path, 'edited');
    // Only a unique unpaired identity can safely be described as a relocation.
    const versionScope = (filename: string) => filename.match(/(?:^|\/)(\d+\.\d+)(?:\/|$)/)?.[1] ?? 'shared';
    if (old.length === 1 && next.length === 1 && allOld.length === 1 && allNew.length === 1 && versionScope(old[0].path) === versionScope(next[0].path)) {
      emit(old[0].def.hash === next[0].def.hash ? 'relocated' : 'edited', old.splice(0), next.splice(0));
    }
    if (!old.length && !next.length) continue;
    if (!allOld.length) for (const added of next) emit(missingBefore.length ? 'unconfirmed-added' : 'added', [], [added], !!missingBefore.length);
    else if (!allNew.length) for (const removed of old) emit(missingAfter.length ? 'unconfirmed-removed' : 'removed', [removed], [], !!missingAfter.length);
    else if (!old.length) for (const added of next) emit('variant-added', [], [added], true);
    else if (!next.length) for (const removed of old) emit('variant-removed', [removed], [], true);
    else emit('ambiguous', old, next, true);
  }
  return {entries, definitionCoverage: {beforeComplete: !missingBefore.length, afterComplete: !missingAfter.length, missingBeforeFiles: missingBefore.length, missingAfterFiles: missingAfter.length}};
}

function rank(row: ModChangeFile): number {
  if (row.category === 'C# source') return 0;
  if (/Def XML|patch XML/.test(row.category)) return 1;
  if (row.category === 'translations') return 2;
  if (row.category === 'mod metadata') return 3;
  return 4;
}

export function buildChangeNoteEvidence(previous: ModInventory, current: ModInventory, rows: ModChangeFile[]) {
  const allIds = new Map(rows.map((row, index) => [row.path, `file-${index + 1}`]));
  const removed = new Map<string, string[]>(), added = new Map<string, string[]>();
  for (const row of rows) if (row.action !== 'edited') {
    const map = row.action === 'added' ? added : removed, digest = (row.action === 'added' ? current : previous).files[row.path].hash;
    map.set(digest, [...(map.get(digest) ?? []), row.path]);
  }
  let metadataCost = 2;
  const prepared = [...rows].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)).flatMap(row => {
    if (privateFile(row.path)) return [];
    const before = previous.files[row.path], after = current.files[row.path], hasBefore = typeof before?.preview === 'string', hasAfter = typeof after?.preview === 'string';
    const beforeText = hasBefore ? before!.preview! : null, afterText = hasAfter ? after!.preview! : null;
    const excerpt = hasBefore && hasAfter ? changedLines(beforeText!, afterText!) : hasAfter ? 'Current captured text only; no earlier text comparison:\n' + afterText : hasBefore ? 'Previous captured text only:\n' + beforeText : '';
    const digest = after?.hash ?? before?.hash, oldPaths = removed.get(digest) ?? [], newPaths = added.get(digest) ?? [];
    const sameContentMove = row.action !== 'edited' && oldPaths.length === 1 && newPaths.length === 1;
    const entry = {id: allIds.get(row.path)!, path: row.path, action: row.action, category: row.category, description: row.description.slice(0, 500),
      before: null as string | null, after: null as string | null,
      earlierTextAvailable: hasBefore, currentTextAvailable: hasAfter,
      beforeTextTruncated: !!before?.previewTruncated, afterTextTruncated: !!after?.previewTruncated,
      textEvidence: hasBefore && hasAfter ? 'comparison' : hasAfter ? 'current-only' : hasBefore ? 'previous-only' : 'unavailable',
      changesOutsideCapturedText: row.action === 'edited' && hasBefore && hasAfter && !excerpt,
      changeExcerpt: null as string | null, excerptTruncated: false,
      ...(sameContentMove ? {sameContentMove: true, movedFrom: oldPaths[0], movedTo: newPaths[0]} : {}),
    };
    const cost = size(entry) + 2;
    if (metadataCost + cost > 55000) return [];
    metadataCost += cost;
    return [{entry, excerpt, beforeText, afterText}];
  });
  const ids = new Map(prepared.map(item => [item.entry.path, item.entry.id]));
  const {entries: defs, definitionCoverage} = definitionEvidence(previous, current, ids), definitionChanges: Record<string, unknown>[] = [];
  let definitionCost = 2;
  for (const entry of defs) { const cost = size(entry) + 2; if (definitionCost + cost > 26000) continue; definitionChanges.push(entry); definitionCost += cost; }
  const textBudgets = fairBudgets(prepared.map(item => item.excerpt ? Math.min(13000, size(item.excerpt) + 1800) : 0), 111000 - metadataCost);
  const evidence = prepared.map(({entry, excerpt, beforeText, afterText}, index) => {
    const allowance = textBudgets[index];
    // Keep the old complete small-file fields for existing consumers. Larger
    // files use changed excerpts, with shortening declared separately.
    if (size([beforeText, afterText]) < Math.min(1600, allowance / 3)) { entry.before = beforeText; entry.after = afterText; }
    const available = Math.max(0, allowance - size([entry.before, entry.after]) - 64);
    entry.changeExcerpt = boundedExcerpt(excerpt, available);
    entry.excerptTruncated = !!excerpt && entry.changeExcerpt !== excerpt;
    return entry;
  });
  const evidenceWarnings: string[] = [];
  if (evidence.some(item => item.changesOutsideCapturedText)) evidenceWarnings.push('Some file changes occurred outside the text saved in the comparison. Their behavior changes cannot be established from the captured text.');
  if (definitionChanges.some(item => item.ambiguous || item.fieldComparisonAmbiguous || (item.ambiguousFields as string[]).length)) evidenceWarnings.push('Some definition fields or version/load variants are ambiguous. Do not treat those records as verified new features, removals or precise balance changes without corroborating text.');
  if (definitionChanges.some(item => item.sameContentMove)) evidenceWarnings.push('Some definitions moved between files without content changes. Moving files alone is not a new feature or removal.');
  if (!definitionCoverage.beforeComplete || !definitionCoverage.afterComplete) evidenceWarnings.push('Some XML definition snapshots are missing. Unconfirmed-added and unconfirmed-removed records show presence only; they do not establish that content was newly added or removed.');
  return {schemaVersion: 2, evidence, definitionChanges, definitionCoverage, totalChangedFiles: rows.length, omittedFiles: rows.length - evidence.length,
    omittedDefinitions: defs.length - definitionChanges.length, evidenceWarnings};
}
