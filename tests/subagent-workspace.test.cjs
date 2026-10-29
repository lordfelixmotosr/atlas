const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/atlas/subagent-workspace.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { SubagentWorkspace, SubagentWorkspaceApplyError } = loaded.exports;
const fixtureBase = path.resolve(__dirname, '../build-check/fixtures');
fs.mkdirSync(fixtureBase, { recursive: true });

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function fixture(t, initial = {}) {
  const area = fs.mkdtempSync(path.join(fixtureBase, 'subagent-'));
  const root = path.join(area, 'mod');
  const stagingRoot = path.join(area, 'staging');
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(initial)) write(root, relative, content);
  t.after(() => {
    assert(path.resolve(area).startsWith(fixtureBase + path.sep));
    fs.rmSync(area, { recursive: true, force: true });
  });
  return { area, root, stagingRoot, make(ownedFiles, extra = {}) { return new SubagentWorkspace({ root, stagingRoot, taskId: 'worker-1', ownedFiles, ...extra }); } };
}
function tree(root) {
  const entries = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (item.isDirectory()) walk(full);
      else entries.push(relative);
    }
  }
  walk(root);
  return entries.sort();
}

test('isolates owned edits until apply, reads other text, and never copies the mod', t => {
  const { root, make } = fixture(t, { 'Source/Main.cs': 'class Original {}\r\n', 'Defs/Reference.xml': '<Defs/>', 'Textures/a.png': Buffer.from([0, 1, 255]) });
  const workspace = make(['Source/Main.cs']);
  assert.equal(workspace.read('Defs/Reference.xml'), '<Defs/>');
  workspace.edit('Source/Main.cs', 'Original', 'Updated');
  assert.equal(workspace.read('Source/Main.cs'), 'class Updated {}\r\n');
  assert.equal(fs.readFileSync(path.join(root, 'Source/Main.cs'), 'utf8'), 'class Original {}\r\n');
  assert(!workspace.stagingPath.startsWith(root + path.sep));
  assert.equal(tree(workspace.stagingPath).length, 2);
  assert(!tree(workspace.stagingPath).some(file => /Reference|Textures|\.png/.test(file)));
  const [change] = workspace.changes();
  assert.equal(change.kind, 'modified');
  assert.match(change.beforeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(change.beforeHash, change.afterHash);
  assert.match(workspace.diff(), /--- a\/Source\/Main.cs[\s\S]*-class Original[\s\S]*\+class Updated/);
  assert.deepEqual(workspace.apply(), { files: ['Source/Main.cs'] });
  assert.equal(fs.readFileSync(path.join(root, 'Source/Main.cs'), 'utf8'), 'class Updated {}\r\n');
  assert.throws(() => workspace.write('Source/Main.cs', 'again'), /applied/);
  workspace.discard();
  assert(!fs.existsSync(workspace.stagingPath));
  assert.equal(fs.readFileSync(path.join(root, 'Source/Main.cs'), 'utf8'), 'class Updated {}\r\n');
});

test('creates and deletes only owned files, merges listings, and treats undone edits as no change', t => {
  const { root, make } = fixture(t, { 'old.xml': '<old/>', 'same.txt': 'unchanged' });
  const workspace = make(['old.xml', 'New/Deep/new.xml', 'same.txt', 'never.txt']);
  workspace.remove('old.xml');
  workspace.write('New/Deep/new.xml', '<new/>');
  workspace.write('same.txt', 'temporary');
  workspace.write('same.txt', 'unchanged');
  workspace.write('never.txt', 'temporary');
  workspace.remove('never.txt');
  assert.deepEqual(workspace.list(), [{ path: 'New', type: 'directory' }, { path: 'same.txt', type: 'file' }]);
  assert.deepEqual(workspace.list('New'), [{ path: 'New/Deep', type: 'directory' }]);
  assert.deepEqual(workspace.list('New/Deep'), [{ path: 'New/Deep/new.xml', type: 'file' }]);
  assert.throws(() => workspace.read('old.xml'), /removed/);
  assert.deepEqual(workspace.changes().map(({ path, kind }) => ({ path, kind })), [{ path: 'New/Deep/new.xml', kind: 'added' }, { path: 'old.xml', kind: 'deleted' }]);
  workspace.apply();
  assert(!fs.existsSync(path.join(root, 'old.xml')));
  assert(!fs.existsSync(path.join(root, 'never.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'New/Deep/new.xml'), 'utf8'), '<new/>');
});

test('enforces exact owned paths, unambiguous edits, and cross-platform path confinement', t => {
  const { make } = fixture(t, { 'owned.txt': 'repeat repeat', 'other.txt': 'private ownership' });
  const workspace = make(['owned.txt']);
  for (const invalid of ['../other.txt', 'dir/../owned.txt', './owned.txt', '/owned.txt', 'C:\\owned.txt', 'C:owned.txt', '\\\\server\\share\\file.txt', 'dir//file.txt', 'owned.txt:stream', 'owned.txt.', 'owned.txt ', 'NUL.txt', 'folder/COM1.xml', 'zero\0.txt']) {
    assert.throws(() => workspace.read(invalid), /path|Private/i, invalid);
    assert.throws(() => workspace.write(invalid, 'no'), /path|Private/i, invalid);
  }
  for (const operation of [() => workspace.write('other.txt', 'no'), () => workspace.edit('other.txt', 'private', 'no'), () => workspace.remove('other.txt')]) assert.throws(operation, /ownedFiles/);
  assert.throws(() => workspace.edit('owned.txt', 'repeat', 'once'), /exactly once/);
  assert.throws(() => workspace.edit('owned.txt', 'absent', 'once'), /exactly once/);
  assert.throws(() => workspace.edit('owned.txt', '', 'once'), /nonempty/);
  workspace.edit('owned.txt', 'repeat repeat', 'once');
  assert.equal(workspace.read('owned.txt'), 'once');
});

test('blocks credentials, private state, and binary files from ownership, reads, and listings', t => {
  const files = { 'safe.xml': '<safe/>', '.atlas/state.json': '{}', '.git/config': 'git', '.aws/credentials': 'secret', '.env': 'secret', '.env.local': 'secret', 'credentials.json': 'secret', '.credentials.json': 'secret', 'client_secret.json': 'secret', 'auth.json': 'secret', 'tokens.json': 'secret', 'bin/private.cs': 'secret', 'mod.dll': 'binary', 'image.png': 'binary', 'invalid.txt': Buffer.from([0xff, 0xfe]), 'binary.txt': Buffer.from([97, 0, 98]) };
  const { make } = fixture(t, files);
  const workspace = make(['safe.xml']);
  for (const relative of Object.keys(files).filter(file => file !== 'safe.xml')) {
    assert.throws(() => workspace.read(relative), /private|credentials|binary|UTF-8/i, relative);
    assert.throws(() => make([relative]), /private|credentials|binary|UTF-8/i, relative);
  }
  assert.deepEqual(workspace.list().map(entry => entry.path), ['binary.txt', 'invalid.txt', 'safe.xml']);
});

test('stages and reopens PowerShell import-tool edits without altering source before apply', t => {
  const importPath = 'Tools/Import-WesterosTunic.ps1';
  const validatePath = 'Tools/Validate-TexturePack.ps1';
  const beforeImport = '\ufeffparam([int]$Canvas = 256)\r\nWrite-Output $Canvas\r\n';
  const beforeValidate = 'param([int]$Canvas = 256)\r\nif ($Canvas -lt 1) { throw "Invalid canvas" }\r\n';
  const { root, make } = fixture(t, {
    [importPath]: beforeImport,
    [validatePath]: beforeValidate,
    'Tools/reference.py': 'CANVAS = 1024\n',
  });
  const workspace = make([importPath, validatePath, 'Tools/Canvas.psm1']);
  assert.deepEqual(workspace.list('Tools').map(entry => entry.path), [importPath, 'Tools/reference.py', validatePath].sort((a, b) => a.localeCompare(b)));
  assert.equal(workspace.read('Tools/reference.py'), 'CANVAS = 1024\n');
  workspace.edit(importPath, '$Canvas = 256', '$Canvas = 1024');
  workspace.edit(validatePath, '$Canvas = 256', '$Canvas = 1024');
  workspace.write('Tools/Canvas.psm1', 'function Get-Canvas { return 1024 }\r\n');
  workspace.checkpoint();
  assert.equal(fs.readFileSync(path.join(root, importPath), 'utf8'), beforeImport);
  assert.equal(fs.readFileSync(path.join(root, validatePath), 'utf8'), beforeValidate);
  assert(!fs.existsSync(path.join(root, 'Tools/Canvas.psm1')));
  const reopened = SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath });
  assert.equal(reopened.read(importPath), beforeImport.replace('$Canvas = 256', '$Canvas = 1024'));
  assert.match(reopened.diff(), /Import-WesterosTunic\.ps1[\s\S]*\$Canvas = 1024/);
  assert.deepEqual(reopened.apply().files, ['Tools/Canvas.psm1', importPath, validatePath]);
  assert.equal(fs.readFileSync(path.join(root, importPath), 'utf8'), beforeImport.replace('$Canvas = 256', '$Canvas = 1024'));
  assert.equal(fs.readFileSync(path.join(root, validatePath), 'utf8'), beforeValidate.replace('$Canvas = 256', '$Canvas = 1024'));
});

test('recognizes common script formats while retaining UTF-8, binary, private-path and size guards', t => {
  const extensions = ['ps1', 'psm1', 'psd1', 'py', 'pyw', 'pyi', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'mjs', 'cjs', 'mts', 'cts'];
  const originals = Object.fromEntries(extensions.map(extension => [`Tools/source.${extension}`, '# source\n']));
  const { make } = fixture(t, {
    ...originals,
    'Tools/binary.ps1': Buffer.from([0x61, 0, 0x62]),
    'Tools/invalid.py': Buffer.from([0xc3, 0x28]),
    'Tools/large.ps1': Buffer.alloc(1024 * 1024 + 1, 97),
    'Tools/asset.unknown': 'Unknown files do not bypass the format check.',
    'Tools/secret.ps1': 'secret',
  });
  const workspace = make(Object.keys(originals));
  for (const file of Object.keys(originals)) {
    assert.equal(workspace.read(file), '# source\n');
    workspace.write(file, '# staged\n');
    assert.equal(workspace.read(file), '# staged\n');
  }
  for (const [file, expected] of [
    ['Tools/binary.ps1', /Binary/],
    ['Tools/invalid.py', /UTF-8/],
    ['Tools/large.ps1', /1 MB/],
    ['Tools/secret.ps1', /Private/],
    ['Tools/asset.unknown', /Unsupported helper file type \.unknown: Tools\/asset\.unknown/],
    ['Tools/texture.png', /binary files are unavailable/],
  ]) {
    assert.throws(() => workspace.read(file), expected, file);
    assert.throws(() => make([file]), expected, file);
  }
  assert.throws(() => workspace.write('Tools/source.ps1', 'binary\0script'), /Binary/);
  assert.throws(() => workspace.write('Tools/source.py', 'a'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.equal(workspace.read('Tools/source.ps1'), '# staged\n');
  assert.equal(workspace.read('Tools/source.py'), '# staged\n');
});

test('preflights and normalizes assignments without staging or source writes', t => {
  const { area, root, stagingRoot } = fixture(t, {
    'Tools/Import.ps1': '\ufeffparam([int]$Canvas = 256)\r\n',
    'Tools/binary.ps1': Buffer.from([0, 1, 2]),
    'Tools/invalid.py': Buffer.from([0xc3, 0x28]),
    'Tools/large.ps1': Buffer.alloc(1024 * 1024 + 1, 97),
  });
  const before = tree(area);
  assert.deepEqual(SubagentWorkspace.validateAssignment(root, ['Tools\\Import.ps1', 'Tools/New.py']), ['Tools/Import.ps1', 'Tools/New.py']);
  for (const [files, expected] of [
    [['Tools/Import.ps1', 'Tools\\Import.ps1'], /Duplicate/],
    [['Tools/../escape.ps1'], /path/],
    [['Tools/auth.ps1'], /Private/],
    [['Tools/image.png'], /Unsupported helper file type \.png: Tools\/image\.png/],
    [['Tools/binary.ps1'], /Binary/],
    [['Tools/invalid.py'], /UTF-8/],
    [['Tools/large.ps1'], /1 MB/],
  ]) assert.throws(() => SubagentWorkspace.validateAssignment(root, files), expected);
  assert.throws(() => SubagentWorkspace.validateAssignment('.', []), /absolute/);
  assert.throws(() => SubagentWorkspace.validateAssignment(root, Array.from({ length: 31 }, (_, index) => `${index}.py`)), /30 text/);
  assert.deepEqual(tree(area), before);
  assert(!fs.existsSync(stagingRoot));
  assert.equal(fs.readFileSync(path.join(root, 'Tools/Import.ps1'), 'utf8'), '\ufeffparam([int]$Canvas = 256)\r\n');
});

test('caps ownership and text size and rejects invalid staging roots', t => {
  const { root, make } = fixture(t, { 'large.txt': Buffer.alloc(1024 * 1024 + 1, 97), 'safe.txt': 'safe' });
  assert.throws(() => make(Array.from({ length: 31 }, (_, index) => `${index}.txt`)), /30 text files/);
  assert.throws(() => make(['safe.txt', 'safe.txt']), /Duplicate/);
  assert.throws(() => make(['safe.txt'], { stagingRoot: path.join(root, 'stage') }), /outside/);
  assert.throws(() => make(['safe.txt'], { stagingRoot: root }), /outside/);
  assert.throws(() => make(['safe.txt'], { taskId: '../escape' }), /task ID/);
  assert.throws(() => make(['safe.txt'], { root: '.' }), /absolute/);
  const workspace = make(['safe.txt']);
  assert.throws(() => workspace.read('large.txt'), /1 MB/);
  assert.throws(() => workspace.write('safe.txt', 'a'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.throws(() => workspace.write('safe.txt', 'a\0b'), /Binary/);
  assert.deepEqual(workspace.changes(), []);
});

test('rejects junction escapes in the root, file parents, and staging ancestors', t => {
  const { area, root, make } = fixture(t, { 'safe.txt': 'safe' });
  const outside = path.join(area, 'outside');
  fs.mkdirSync(outside);
  write(outside, 'reference.txt', 'unchanged');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  fs.symlinkSync(root, path.join(area, 'root-link'), 'junction');
  fs.symlinkSync(outside, path.join(area, 'stage-link'), 'junction');
  const workspace = make(['safe.txt']);
  assert.throws(() => workspace.read('linked/reference.txt'), /Linked|redirected/);
  assert.throws(() => workspace.list('linked'), /Linked|redirected/);
  assert.throws(() => make(['linked/new.txt']), /Linked|redirected/);
  assert.throws(() => SubagentWorkspace.validateAssignment(root, ['linked/new.ps1']), /Linked|redirected/);
  assert.throws(() => SubagentWorkspace.validateAssignment(path.join(area, 'root-link'), ['safe.txt']), /Linked|redirected/);
  assert.throws(() => make(['safe.txt'], { root: path.join(area, 'root-link') }), /Linked|redirected/);
  assert.throws(() => make(['safe.txt'], { stagingRoot: path.join(area, 'stage-link', 'nested') }), /Linked|redirected/);
  assert.deepEqual(workspace.list(), [{ path: 'safe.txt', type: 'file' }]);
  assert.equal(fs.readFileSync(path.join(outside, 'reference.txt'), 'utf8'), 'unchanged');
});

test('rechecks parent links at apply and refuses all writes before touching any source file', t => {
  const { area, root, make } = fixture(t, { 'a.txt': 'original', 'Source/b.cs': 'original' });
  const workspace = make(['a.txt', 'Source/b.cs']);
  workspace.write('a.txt', 'updated');
  workspace.write('Source/b.cs', 'updated');
  const outside = path.join(area, 'outside');
  fs.mkdirSync(outside);
  write(outside, 'b.cs', 'outside');
  fs.renameSync(path.join(root, 'Source'), path.join(area, 'old-source'));
  fs.symlinkSync(outside, path.join(root, 'Source'), 'junction');
  assert.throws(() => workspace.apply(), /Linked|redirected/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(outside, 'b.cs'), 'utf8'), 'outside');
});

test('checks both unmodified owned files and read dependencies before applying any change', t => {
  const { root, make } = fixture(t, { 'a.txt': 'original', 'b.txt': 'owned', 'reference.xml': '<before/>' });
  const workspace = make(['a.txt', 'b.txt']);
  workspace.write('a.txt', 'patch');
  workspace.read('reference.xml');
  write(root, 'b.txt', 'external owned edit');
  assert.throws(() => workspace.apply(), /Conflict: b.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
  write(root, 'b.txt', 'owned');
  write(root, 'reference.xml', '<external/>');
  assert.throws(() => workspace.apply(), /Conflict: reference.xml/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
  assert.equal(workspace.read('a.txt'), 'patch');
  assert(fs.existsSync(workspace.stagingPath));
});

test('detects new files, deleted files, and a missing read dependency that appears later', t => {
  const { root, make } = fixture(t, { 'old.txt': 'original' });
  const workspace = make(['old.txt', 'new.txt']);
  workspace.write('new.txt', 'patch');
  workspace.remove('old.txt');
  write(root, 'new.txt', 'external');
  assert.throws(() => workspace.apply(), /Conflict: new.txt/);
  fs.unlinkSync(path.join(root, 'new.txt'));
  fs.unlinkSync(path.join(root, 'old.txt'));
  assert.throws(() => workspace.apply(), /Conflict: old.txt/);
  write(root, 'old.txt', 'original');
  assert.throws(() => workspace.read('reference.txt'), /does not exist/);
  write(root, 'reference.txt', 'appeared');
  assert.throws(() => workspace.apply(), /Conflict: reference.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'original');
});

test('rolls back a failed multi-file apply including deletion, additions, and created directories', t => {
  const { root, make } = fixture(t, { 'a.txt': 'original a', 'b.txt': 'original b', 'z.txt': 'original z' });
  const workspace = make(['a.txt', 'b.txt', 'New/Deep/c.txt', 'z.txt'], { hooks: { beforeApplyFile(_file, index) { if (index === 3) throw new Error('injected write failure'); } } });
  workspace.write('a.txt', 'patch a');
  workspace.remove('b.txt');
  workspace.write('New/Deep/c.txt', 'patch c');
  workspace.write('z.txt', 'patch z');
  const diff = workspace.diff();
  assert.throws(() => workspace.apply(), error => error instanceof SubagentWorkspaceApplyError && /injected write failure.*All applied files were restored/.test(error.message) && error.recoveryPaths.length === 0);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
  assert.equal(fs.readFileSync(path.join(root, 'z.txt'), 'utf8'), 'original z');
  assert(!fs.existsSync(path.join(root, 'New')));
  assert.equal(workspace.diff(), diff);
  assert(!tree(root).some(file => file.includes('.tmp')));
  workspace.cancel();
  assert(!fs.existsSync(workspace.stagingPath));
});

test('preserves recovery backups and refuses discard when rollback itself fails', t => {
  const { root, make } = fixture(t, { 'a.txt': 'original a', 'b.txt': 'original b', 'c.txt': 'original c' });
  const workspace = make(['a.txt', 'b.txt', 'c.txt'], { hooks: { beforeApplyFile(_file, index) { if (index === 2) throw new Error('injected apply failure'); }, beforeRollbackFile(file) { if (file === 'b.txt') throw new Error('injected restore failure'); } } });
  for (const file of ['a.txt', 'b.txt', 'c.txt']) workspace.write(file, 'patch ' + file);
  let failure;
  try { workspace.apply(); } catch (error) { failure = error; }
  assert(failure instanceof SubagentWorkspaceApplyError);
  assert.match(failure.message, /Rollback needs recovery.*injected restore failure/);
  assert(failure.recoveryPaths.length >= 2);
  for (const recoveryPath of failure.recoveryPaths) assert(fs.existsSync(recoveryPath));
  const manifest = JSON.parse(fs.readFileSync(path.join(failure.recoveryPaths[0], 'manifest.json'), 'utf8'));
  const backup = manifest.files.find(file => file.path === 'b.txt').backup;
  assert.equal(fs.readFileSync(backup, 'utf8'), 'original b');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'patch b.txt');
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'original c');
  assert.throws(() => workspace.discard(), /Recovery files must be retained/);
  assert.throws(() => workspace.cancel(), /Recovery files must be retained/);
  assert.throws(() => workspace.apply(), /recovery-required/);
  assert(fs.existsSync(backup));
  assert.equal(workspace.changes().length, 3);
});

test('does not overwrite concurrent edits when restoring a failed apply', t => {
  const { root, make } = fixture(t, { 'a.txt': 'original a', 'b.txt': 'original b' });
  const workspace = make(['a.txt', 'b.txt'], { hooks: { beforeApplyFile(_file, index) { if (index === 1) { write(root, 'a.txt', 'external edit during apply'); throw new Error('injected'); } } } });
  workspace.write('a.txt', 'patch a');
  workspace.write('b.txt', 'patch b');
  assert.throws(() => workspace.apply(), /recovery.*File changed during apply/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'external edit during apply');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
});

test('rolls back if a read dependency changes during apply', t => {
  const { root, make } = fixture(t, { 'a.txt': 'original a', 'b.txt': 'original b', 'reference.xml': '<before/>' });
  const workspace = make(['a.txt', 'b.txt'], { hooks: { beforeApplyFile(_file, index) { if (index === 1) write(root, 'reference.xml', '<external/>'); } } });
  workspace.read('reference.xml');
  workspace.write('a.txt', 'patch a');
  workspace.write('b.txt', 'patch b');
  assert.throws(() => workspace.apply(), /Conflict: reference.xml changed during apply.*All applied files were restored/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
  assert.equal(fs.readFileSync(path.join(root, 'reference.xml'), 'utf8'), '<external/>');
});

test('never recreates a mod root that disappeared after the workspace opened', t => {
  const { area, root, make } = fixture(t);
  const workspace = make(['new.txt']);
  workspace.write('new.txt', 'patch');
  fs.renameSync(root, path.join(area, 'moved-mod'));
  assert.throws(() => workspace.apply(), /ENOENT/);
  assert(!fs.existsSync(root));
});

test('detects stage tampering and stage junction replacement before root writes', t => {
  const { area, root, make } = fixture(t, { 'safe.txt': 'original' });
  const workspace = make(['safe.txt']);
  workspace.write('safe.txt', 'patch');
  const overlay = path.join(workspace.stagingPath, 'overlay');
  const file = fs.readdirSync(overlay)[0];
  fs.writeFileSync(path.join(overlay, file), 'tampered');
  assert.throws(() => workspace.apply(), /Staged file changed/);
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
  fs.renameSync(overlay, path.join(area, 'moved-overlay'));
  fs.symlinkSync(path.join(area, 'moved-overlay'), overlay, 'junction');
  assert.throws(() => workspace.apply(), /Linked|redirected/);
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
});

test('cancel and discard only remove staging and never apply patches', t => {
  const { root, make } = fixture(t, { 'safe.txt': 'original' });
  for (const operation of ['cancel', 'discard']) {
    const workspace = make(['safe.txt', 'new.txt']);
    workspace.remove('safe.txt');
    workspace.write('new.txt', 'new patch');
    workspace[operation]();
    assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
    assert(!fs.existsSync(path.join(root, 'new.txt')));
    assert(!fs.existsSync(workspace.stagingPath));
    assert.throws(() => workspace.apply(), /discarded/);
    workspace.discard();
  }
});

test('diffs remain bounded with very long lines and preserve UTF-8 BOMs', t => {
  const { root, make } = fixture(t, { 'safe.txt': '\ufefforiginal\r\n' });
  const workspace = make(['safe.txt']);
  assert.equal(workspace.read('safe.txt'), '\ufefforiginal\r\n');
  workspace.write('safe.txt', '\ufeff' + 'é'.repeat(300000));
  const diff = workspace.diff();
  assert(Buffer.byteLength(diff) <= 128 * 1024);
  assert.match(diff, /Diff truncated/);
  workspace.apply();
  assert(fs.readFileSync(path.join(root, 'safe.txt')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
});

test('lists and observed dependencies are bounded', t => {
  const initial = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`many/${index}.txt`, 'x']));
  const { make } = fixture(t, initial);
  const workspace = make([]);
  assert.throws(() => workspace.list('many'), /500 entries/);
  for (let index = 0; index < 256; index++) assert.equal(workspace.read(`many/${index}.txt`), 'x');
  assert.throws(() => workspace.read('many/256.txt'), /256 observed-file/);
  const retainedBuffers = new Set([...workspace.observed.values()].map(snapshot => snapshot.bytes.buffer));
  assert([...retainedBuffers].reduce((total, buffer) => total + buffer.byteLength, 0) < 512 * 1024,
    'Small observed files must not retain one 1 MB read allocation per file');
});

test('reopens a checkpoint in place and validates read dependencies saved after the last edit', t => {
  const { root, stagingRoot, make } = fixture(t, { 'safe.txt': 'original', 'reference.xml': '<before/>' });
  const workspace = make(['safe.txt', 'new.xml']);
  workspace.write('safe.txt', 'patch');
  workspace.write('new.xml', '<new/>');
  workspace.read('reference.xml');
  workspace.checkpoint();
  const metadataFile = path.join(workspace.stagingPath, 'metadata.json');
  const metadata = fs.readFileSync(metadataFile);
  const diff = workspace.diff();
  const reopened = SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath });
  assert.equal(reopened.stagingPath, workspace.stagingPath);
  assert.equal(fs.readdirSync(stagingRoot).length, 1);
  assert.deepEqual(fs.readFileSync(metadataFile), metadata);
  assert.equal(reopened.diff(), diff);
  write(root, 'reference.xml', '<external/>');
  assert.throws(() => reopened.apply(), /Conflict: reference.xml/);
  assert.throws(() => SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath }), /Conflict: reference.xml.*staging is preserved/);
  assert.deepEqual(fs.readFileSync(metadataFile), metadata);
  write(root, 'reference.xml', '<before/>');
  assert.deepEqual(reopened.apply(), { files: ['new.xml', 'safe.txt'] });
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'patch');
});

test('reopens applied overlays for review using verified recovery originals, without applying twice', t => {
  const { root, make } = fixture(t, { 'old.txt': 'old', 'safe.txt': 'original' });
  const workspace = make(['old.txt', 'new.txt', 'safe.txt']);
  workspace.remove('old.txt');
  workspace.write('new.txt', 'new');
  workspace.write('safe.txt', 'patch');
  const diff = workspace.diff();
  workspace.apply();
  const reopened = SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath });
  assert.equal(reopened.diff(), diff);
  assert.throws(() => reopened.apply(), /applied/);
  const metadata = JSON.parse(fs.readFileSync(path.join(workspace.stagingPath, 'metadata.json'), 'utf8'));
  const backup = fs.readdirSync(metadata.recoveryDirectory).find(file => file.endsWith('.original'));
  fs.writeFileSync(path.join(metadata.recoveryDirectory, backup), 'tampered');
  assert.throws(() => SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath }), /recovery original changed/);
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'patch');
});

test('reopen refuses unknown or interrupted transaction states and preserves their metadata', t => {
  const { root, make } = fixture(t, { 'safe.txt': 'original' });
  const workspace = make(['safe.txt']);
  workspace.write('safe.txt', 'patch');
  const metadataFile = path.join(workspace.stagingPath, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  for (const state of ['applying', 'recovery-required', 'discarded', 'unknown']) {
    const bytes = Buffer.from(JSON.stringify({ ...metadata, state }));
    fs.writeFileSync(metadataFile, bytes);
    assert.throws(() => SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath }), error => error instanceof SubagentWorkspaceApplyError && error.recoveryPaths.includes(workspace.stagingPath));
    assert.deepEqual(fs.readFileSync(metadataFile), bytes);
  }
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
});

test('reopen rejects malicious paths, checksums, duplicate originals, and oversized metadata without rewriting it', t => {
  const { root, make } = fixture(t, { 'safe.txt': 'original' });
  const workspace = make(['safe.txt']);
  workspace.write('safe.txt', 'patch');
  const metadataFile = path.join(workspace.stagingPath, 'metadata.json');
  const original = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const variants = [
    { ...original, root: path.dirname(root) },
    { ...original, taskId: undefined },
    { ...original, ownedFiles: ['../safe.txt'] },
    { ...original, originals: [] },
    { ...original, originals: [...original.originals, original.originals[0]] },
    { ...original, originals: [{ ...original.originals[0], path: '../safe.txt' }] },
    { ...original, originals: [{ ...original.originals[0], path: 'auth.json' }] },
    { ...original, changes: [{ ...original.changes[0], file: path.join(root, 'safe.txt') }] },
    { ...original, changes: [{ ...original.changes[0], hash: '0'.repeat(64) }] },
    { ...original, changes: [{ ...original.changes[0], bytes: 999 }] },
    { ...original, recoveryDirectory: root },
    { ...original, recoveryPaths: [root] },
  ];
  for (const variant of variants) {
    const bytes = Buffer.from(JSON.stringify(variant));
    fs.writeFileSync(metadataFile, bytes);
    assert.throws(() => SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath }));
    assert.deepEqual(fs.readFileSync(metadataFile), bytes);
  }
  fs.writeFileSync(metadataFile, ' '.repeat(256 * 1024 + 1));
  assert.throws(() => SubagentWorkspace.reopen({ root, stagingPath: workspace.stagingPath }), /256 KB/);
  assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
});
