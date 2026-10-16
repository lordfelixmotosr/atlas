// Headless, isolated Electron UI fixture. No Atlas data or provider requests.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
app.setPath('userData', path.join(root, 'build-check/thinking-ui-profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({width:360,height:140,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  try {
    await win.loadFile(path.join(root, 'build-check/thinking-ui.html'));
    const result = await win.webContents.executeJavaScript('window.runThinkingFixture()');
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'build-check/thinking-controls.png'), screenshot.toPNG());
    fs.writeFileSync(path.join(root, 'build-check/thinking-ui-result.json'), JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch(error) {console.error(error);app.exit(1);}
});
