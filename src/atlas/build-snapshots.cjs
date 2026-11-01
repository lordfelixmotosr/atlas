'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_METADATA = 32 * 1024 * 1024;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const key = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const matches = (stat, expected) => !!expected && stat.dev === expected.dev && stat.ino === expected.ino && stat.birthtimeMs === expected.birthtimeMs;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function plain(value) { return Object.prototype.toString.call(value) === '[object Object]'; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function aborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Completed-build snapshot capture was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
function relative(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length < 2048 && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && value.split('/').every((part) => part && part !== '.' && part !== '..'), 'Invalid snapshot file path.');
  return value;
}
function hashMap(value, label) {
  assert(plain(value) && Object.keys(value).length <= 100000, `Invalid ${label} hashes.`);
  const seen = new Set();
  for (const [name, digest] of Object.entries(value)) {
    relative(name);
    assert(!seen.has(name.toLowerCase()) && typeof digest === 'string' && HASH.test(digest), `Invalid ${label} hash entry.`);
    seen.add(name.toLowerCase());
  }
  return clone(value);
}
function successfulRecord(value) {
  assert(plain(value) && value.version === 1 && value.attempt === 'success' && Number.isFinite(value.builtAt) && value.builtAt > 0, 'A completed successful build record is required.');
  const inputs = hashMap(value.inputs, 'build input');
  const outputs = hashMap(value.outputs, 'build output');
  assert(Object.keys(outputs).length > 0 && Object.keys(outputs).every((name) => name.toLowerCase().endsWith('.dll')), 'A completed build must have releasable DLL outputs.');
  return { version: 1, attempt: 'success', builtAt: value.builtAt, inputs, outputs };
}
async function lstatOrNull(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function plainChain(file, allowMissing = false) {
  const resolved = path.resolve(file);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (allowMissing) return;
      const error = new Error('Snapshot path is missing.');
      error.code = 'ENOENT';
      throw error;
    }
    assert(!stat.isSymbolicLink(), 'Snapshot and source paths must not contain links.');
  }
}
async function plainDirectory(file) {
  await plainChain(file);
  const stat = await fs.lstat(file);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Snapshot and source roots must be real directories.');
  return stat;
}
async function readJson(file, maximum = MAX_METADATA) {
  await plainChain(file);
  const before = await fs.lstat(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum, 'Snapshot metadata is invalid or too large.');
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  assert(matches(after, identity(before)) && before.size === after.size && before.mtimeMs === after.mtimeMs, 'Snapshot metadata changed while being read.');
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}
async function writeExclusive(file, bytes) {
  await plainChain(path.dirname(file));
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function create({ root, workshopVerification: release, buildInputs, signature }) {
  assert(typeof root === 'string' && root.length > 0, 'Completed-build storage root is required.');
  assert(release && ['planRelease', 'copyRelease', 'auditRelease', 'releaseRelative', 'isDevelopmentPath', 'allowedDll', 'runtimeSignature'].every((name) => typeof release[name] === 'function'), 'Release verification helpers are required.');
  assert(typeof buildInputs === 'function' && typeof signature === 'function', 'Build input verification helpers are required.');
  const storeRoot = path.resolve(root);
  const pendingCaptures = new Map();
  let storeIdentity = null;

  async function sourceInfo(source) {
    assert(typeof source === 'string' && source.length > 0, 'Snapshot source is required.');
    const sourcePath = path.resolve(source);
    const stat = await plainDirectory(sourcePath);
    const real = await fs.realpath(sourcePath);
    assert(key(real) === key(sourcePath), 'Snapshot source must not traverse a link.');
    const canonical = key(real);
    const storage = key(storeRoot);
    assert(canonical !== storage && !canonical.startsWith(storage + path.sep) && !storage.startsWith(canonical + path.sep), 'Snapshot storage must be outside its source workspace.');
    return { source: real, canonical, sourceKey: sha(canonical), sourceIdentity: identity(stat) };
  }

  async function storeDirectory(info, createMissing) {
    await plainChain(storeRoot, true);
    let stat = await lstatOrNull(storeRoot);
    if (!stat && !createMissing) return null;
    if (!stat) { await fs.mkdir(storeRoot, { recursive: true }); stat = await plainDirectory(storeRoot); }
    else stat = await plainDirectory(storeRoot);
    if (storeIdentity) assert(matches(stat, storeIdentity), 'Completed-build storage root changed.');
    else storeIdentity = identity(stat);
    const namespace = path.join(storeRoot, info.sourceKey);
    const namespaceStat = await lstatOrNull(namespace);
    if (!namespaceStat && !createMissing) return null;
    if (!namespaceStat) await fs.mkdir(namespace);
    await plainDirectory(namespace);
    return namespace;
  }

  function validatePlan(value) {
    assert(plain(value) && value.valid === true && !value.inventoryOnly && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 100000 && Array.isArray(value.directories) && Array.isArray(value.loadRoots) && Array.isArray(value.allowDlls), 'Invalid completed-build runtime manifest.');
    const plan = clone(value);
    const seen = new Set();
    let total = 0;
    for (const entry of plan.files) {
      const name = relative(entry.path);
      assert(release.releaseRelative(name) === name && !release.isDevelopmentPath(name) && !seen.has(name.toLowerCase()) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.sha256 === 'string' && HASH.test(entry.sha256), 'Unsafe completed-build runtime file.');
      if (name.toLowerCase().endsWith('.dll')) assert(release.allowedDll(name, plan), 'Unapproved completed-build DLL.');
      total += entry.bytes;
      assert(Number.isSafeInteger(total), 'Completed-build runtime is too large.');
      seen.add(name.toLowerCase());
    }
    assert(seen.has('about/about.xml') && total === plan.totalBytes, 'Completed-build manifest totals or metadata are invalid.');
    const directories = new Set();
    for (const name of plan.directories) {
      relative(name);
      assert(release.releaseRelative(name) === name && !release.isDevelopmentPath(name) && !seen.has(name.toLowerCase()) && !directories.has(name.toLowerCase()), 'Unsafe completed-build runtime directory.');
      directories.add(name.toLowerCase());
    }
    for (const name of plan.loadRoots) assert(release.releaseRelative(name, true) === name, 'Unsafe completed-build load root.');
    for (const name of plan.allowDlls) assert(release.releaseRelative(name) === name, 'Unsafe completed-build DLL rule.');
    return plan;
  }

  const dlls = (plan) => Object.fromEntries(plan.files.filter((entry) => entry.path.toLowerCase().endsWith('.dll')).map((entry) => [entry.path, entry.sha256]));
  const planDigest = (plan) => sha(JSON.stringify({
    files: [...plan.files].map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    directories: [...plan.directories].sort(), loadRoots: [...plan.loadRoots].sort(), allowDlls: [...plan.allowDlls].sort(),
  }));
  const sameHashes = (actual, expected, label) => assert(signature(actual) === signature(expected), `${label} changed before the completed-build snapshot could be saved.`);

  function validateIdentity(value) {
    return plain(value) && Number.isFinite(value.dev) && Number.isFinite(value.ino) && Number.isFinite(value.birthtimeMs);
  }

  function descriptor(metadata, namespace) {
    const snapshotRoot = path.join(namespace, metadata.id);
    const runtimePath = path.join(snapshotRoot, 'runtime');
    return freeze({ id: metadata.id, source: metadata.source, sourceKey: metadata.sourceKey, root: snapshotRoot, path: runtimePath, runtimePath, plan: clone(metadata.plan), builtAt: metadata.builtAt, capturedAt: metadata.capturedAt, kind: metadata.kind, releaseSignature: metadata.releaseSignature, signature: metadata.planSignature, buildRecord: metadata.buildRecord ? clone(metadata.buildRecord) : null });
  }

  async function getWithInfo(info, requestedId, namespace) {
    let pointer = null;
    let id = requestedId;
    if (id === undefined || id === null) {
      try { pointer = (await readJson(path.join(namespace, 'latest.json'), 16384)).value; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      assert(pointer?.version === 1 && pointer.sourceKey === info.sourceKey && key(pointer.source) === info.canonical && UUID.test(pointer.id) && HASH.test(pointer.metadataSha256), 'Invalid completed-build latest pointer.');
      id = pointer.id;
    }
    assert(typeof id === 'string' && UUID.test(id), 'Invalid completed-build snapshot ID.');
    const snapshotRoot = path.join(namespace, id);
    const stat = await lstatOrNull(snapshotRoot);
    if (!stat) return null;
    await plainDirectory(snapshotRoot);
    const receipt = (await readJson(path.join(namespace, id + '.receipt.json'), 16384)).value;
    assert(receipt?.version === 1 && receipt.id === id && receipt.sourceKey === info.sourceKey && HASH.test(receipt.metadataSha256), 'Invalid completed-build snapshot receipt.');
    const { value: metadata, bytes } = await readJson(path.join(snapshotRoot, 'metadata.json'));
    assert(sha(bytes) === receipt.metadataSha256 && (!pointer || pointer.metadataSha256 === receipt.metadataSha256), 'Completed-build snapshot metadata changed.');
    assert(metadata?.version === 1 && metadata.status === 'completed' && metadata.id === id && metadata.sourceKey === info.sourceKey && typeof metadata.source === 'string' && key(metadata.source) === info.canonical && validateIdentity(metadata.sourceIdentity) && (metadata.kind === 'preview' ? metadata.builtAt === null : Number.isFinite(metadata.builtAt) && metadata.builtAt > 0) && Number.isFinite(metadata.capturedAt) && ['build', 'runtime', 'preview'].includes(metadata.kind), 'Invalid completed-build snapshot metadata.');
    assert(!pointer || metadata.kind !== 'preview', 'A preview-only snapshot cannot be the latest completed build.');
    assert(matches(await plainDirectory(info.source), metadata.sourceIdentity), 'The snapshot belongs to a different source directory.');
    metadata.plan = validatePlan(metadata.plan);
    assert(planDigest(metadata.plan) === metadata.planSignature && release.runtimeSignature(metadata.plan) === metadata.releaseSignature, 'Completed-build manifest changed.');
    if (metadata.kind === 'build') {
      const record = successfulRecord(metadata.buildRecord);
      assert(record.builtAt === metadata.builtAt, 'Completed-build timestamp changed.');
      sameHashes(dlls(metadata.plan), record.outputs, 'Snapshot DLL outputs');
    } else {
      assert(metadata.buildRecord === null && (metadata.kind === 'preview' || Object.keys(dlls(metadata.plan)).length === 0), 'Invalid runtime snapshot.');
      const inputs = hashMap(metadata.runtimeInputs, 'runtime input');
      assert(metadata.kind === 'preview' || !Object.keys(inputs).some((name) => /\.(?:cs|csproj)$/i.test(name)), 'A runtime-only snapshot cannot contain C# source inputs.');
    }
    const runtimePath = path.join(snapshotRoot, 'runtime');
    await plainDirectory(runtimePath);
    await release.auditRelease(runtimePath, metadata.plan);
    return descriptor(metadata, namespace);
  }

  async function get(source, id) {
    const info = await sourceInfo(source);
    const namespace = await storeDirectory(info, false);
    return namespace ? getWithInfo(info, id, namespace) : null;
  }

  async function captureOne(info, record, options, kind) {
    const signal = options?.signal;
    aborted(signal);
    const namespace = await storeDirectory(info, true);
    assert(matches(await plainDirectory(info.source), info.sourceIdentity), 'Source directory changed before snapshot capture.');
    const inputs = hashMap(await buildInputs(info.source), 'current build input');
    if (kind === 'build') sameHashes(inputs, record.inputs, 'Build inputs');
    else if (kind === 'runtime') assert(!Object.keys(inputs).some((name) => /\.(?:cs|csproj)$/i.test(name)), 'Runtime-only capture is for mods without C# source.');
    aborted(signal);
    const plan = validatePlan(await release.planRelease(info.source));
    const outputHashes = dlls(plan);
    if (kind === 'build') sameHashes(outputHashes, record.outputs, 'Released DLL outputs');
    else if (kind === 'runtime') assert(Object.keys(outputHashes).length === 0, 'Runtime-only capture requires a mod without compiled DLLs.');
    aborted(signal);
    const id = crypto.randomUUID();
    const pending = path.join(namespace, '.pending-' + id);
    const finalRoot = path.join(namespace, id);
    const runtimePath = path.join(pending, 'runtime');
    await fs.mkdir(pending);
    let publishedDirectory = false;
    let pointerTemporary = null;
    try {
      await plainDirectory(pending);
      await release.copyRelease(info.source, runtimePath, plan);
      aborted(signal);
      await release.auditRelease(runtimePath, plan);
      const afterPlan = validatePlan(await release.planRelease(info.source));
      assert(planDigest(afterPlan) === planDigest(plan), 'Runtime content changed while the completed-build snapshot was being saved.');
      if (kind === 'build') sameHashes(dlls(afterPlan), record.outputs, 'Released DLL outputs');
      const afterInputs = hashMap(await buildInputs(info.source), 'current build input');
      sameHashes(afterInputs, kind === 'build' ? record.inputs : inputs, 'Build inputs');
      assert(matches(await plainDirectory(info.source), info.sourceIdentity), 'Source directory changed during snapshot capture.');
      aborted(signal);
      await release.auditRelease(runtimePath, plan);
      if (options?.beforePublish !== undefined) {
        assert(typeof options.beforePublish === 'function', 'Invalid snapshot publication guard.');
        // A synchronous busy-state guard runs without an unnecessary await
        // yielding control after its last check. No snapshot has been published.
        const guard = options.beforePublish();
        if (guard && typeof guard.then === 'function') await guard;
      }
      aborted(signal);
      const builtAt = kind === 'build' ? record.builtAt : kind === 'runtime' ? Date.now() : null;
      const metadata = {
        version: 1, status: 'completed', id, source: info.source, sourceKey: info.sourceKey, sourceIdentity: info.sourceIdentity,
        kind, builtAt, capturedAt: Date.now(), buildRecord: kind === 'build' ? clone(record) : null,
        runtimeInputs: kind !== 'build' ? inputs : null, plan, planSignature: planDigest(plan), releaseSignature: release.runtimeSignature(plan),
      };
      const metadataBytes = Buffer.from(JSON.stringify(metadata));
      assert(metadataBytes.length <= MAX_METADATA, 'Completed-build snapshot metadata is too large.');
      await writeExclusive(path.join(pending, 'metadata.json'), metadataBytes);
      aborted(signal);
      await storeDirectory(info, false);
      await plainDirectory(pending);
      await fs.rename(pending, finalRoot);
      publishedDirectory = true;
      const metadataSha256 = sha(metadataBytes);
      await writeExclusive(path.join(namespace, id + '.receipt.json'), JSON.stringify({ version: 1, id, sourceKey: info.sourceKey, metadataSha256 }));
      const completed = await getWithInfo(info, id, namespace);
      aborted(signal);
      let replaceLatest = kind !== 'preview';
      if (replaceLatest) try {
          const prior = (await readJson(path.join(namespace, 'latest.json'), 16384)).value;
          if (prior?.version === 1 && Number.isFinite(prior.builtAt) && prior.builtAt > builtAt) replaceLatest = false;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (replaceLatest) {
        pointerTemporary = path.join(namespace, 'latest.' + crypto.randomUUID() + '.tmp');
        await writeExclusive(pointerTemporary, JSON.stringify({ version: 1, id, source: info.source, sourceKey: info.sourceKey, builtAt, metadataSha256 }));
        aborted(signal);
        await storeDirectory(info, false);
        await fs.rename(pointerTemporary, path.join(namespace, 'latest.json'));
        pointerTemporary = null;
      }
      return completed;
    } finally {
      // Only this invocation's unpublished UUID directory and pointer temp are
      // removable. Published snapshots stay available to every existing pin.
      try {
        await storeDirectory(info, false);
        if (!publishedDirectory && (await lstatOrNull(pending))) {
          await plainDirectory(pending);
          await fs.rm(pending, { recursive: true });
        }
        if (pointerTemporary && await lstatOrNull(pointerTemporary)) await fs.unlink(pointerTemporary);
      } catch {
        // Retain incomplete files when path ownership cannot be verified.
      }
    }
  }

  async function queuedCapture(source, record, options, kind) {
    const info = await sourceInfo(source);
    const previous = pendingCaptures.get(info.sourceKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => captureOne(info, record, options, kind));
    pendingCaptures.set(info.sourceKey, task);
    try { return await task; } finally { if (pendingCaptures.get(info.sourceKey) === task) pendingCaptures.delete(info.sourceKey); }
  }

  return Object.freeze({
    capture: async (source, record, options) => queuedCapture(source, successfulRecord(record), options, 'build'),
    captureRuntime: (source, options) => queuedCapture(source, null, options, 'runtime'),
    stageRuntime: (source, options) => queuedCapture(source, null, options, 'preview'),
    get,
  });
}

module.exports = { create };
