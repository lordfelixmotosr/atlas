const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
function stage(runtimeBase, compiled17, destination) {
  for (const relative of ['About/About.xml', 'Assemblies/ModMixerBridge.dll', 'Assemblies/0Harmony.dll']) {
    if (!fs.existsSync(path.join(runtimeBase, 'resources/modmixer-bridge', relative))) throw new Error('Missing 1.6 bridge: ' + relative);
  }
  for (const name of ['ModMixerBridge.dll', '0Harmony.dll']) if (!fs.existsSync(path.join(compiled17, name))) throw new Error('Build the 1.7 bridge before packaging: ' + name);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(runtimeBase, 'resources/modmixer-bridge'), destination, { recursive: true });
  fs.mkdirSync(path.join(destination, '1.7/Assemblies'), { recursive: true });
  for (const name of ['ModMixerBridge.dll', '0Harmony.dll']) fs.copyFileSync(path.join(compiled17, name), path.join(destination, '1.7/Assemblies', name));
  const about = fs.readFileSync(path.join(root, 'vendor/modmixer-bridge/About/About.xml'), 'utf8').replace('<li>1.6</li>', '<li>1.6</li>\n    <li>1.7</li>');
  fs.writeFileSync(path.join(destination, 'About/About.xml'), about);
  fs.writeFileSync(path.join(destination, 'LoadFolders.xml'), '<loadFolders><v1.5><li>/</li></v1.5><v1.6><li>/</li></v1.6><v1.7><li>1.7</li></v1.7></loadFolders>\n');
}
if (require.main === module) {
  const [base, compiled, dest] = process.argv.slice(2);
  if (!base || !compiled || !dest) throw new Error('Usage: node stage-rimworld-bridge.cjs <Atlas runtime base> <1.7 compiled Assemblies> <destination>');
  stage(path.resolve(base), path.resolve(compiled), path.resolve(dest));
}
module.exports = { stage };
