'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false,
    transparent: true, frame: false, backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false }
  });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('yazildi:', out, img.getSize());
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
