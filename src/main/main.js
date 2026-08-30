'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  shell,
  session,
  systemPreferences,
  nativeImage,
  Tray,
  Menu,
  screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let tray = null;
let embeddedServer = null;
let pendingDisplaySource = null;   // secilen kaynagin id'si

/* -------------------------------------------------------------------------- */
/*                             Ayarlar (userData)                              */
/* -------------------------------------------------------------------------- */

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  username: os.userInfo().username || 'Kullanici',
  color: '#5b8cff',
  lastServer: '',
  recentServers: [],
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  noiseMode: 'rnnoise',        // 'off' | 'browser' | 'rnnoise'
  suppressionMix: 1,
  echoCancellation: true,
  autoGainControl: true,
  inputVolume: 1,
  outputVolume: 1,
  vadGate: false,
  vadThreshold: 0.6,
  pttEnabled: false,
  pttKey: 'F8',
  userVolumes: {},
  theme: 'midnight',
  accent: '#5b8cff',
  windowBounds: null,
  screenShareQuality: '1080p30',
  shareSystemAudio: true,
  startServerOnLaunch: false,
  serverPort: 4545,
  serverPassword: '',

  // Ag: 'lan' yalnizca yerel/VPN adaylari, 'auto' STUN ile internet uzerinden de dener
  iceMode: 'auto',
  turnUrl: '',
  turnUser: '',
  turnPass: ''
};

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[settings] yazilamadi:', err.message);
  }
  return merged;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* -------------------------------------------------------------------------- */
/*                                  Pencere                                    */
/* -------------------------------------------------------------------------- */

function createWindow() {
  const settings = readSettings();
  const bounds = settings.windowBounds;
  const area = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: bounds?.width || Math.min(1320, area.width - 80),
    height: bounds?.height || Math.min(860, area.height - 80),
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1117',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    // Gelistirme modunda renderer konsolunu terminale aktar
    const levels = ['log', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const src = String(sourceId).split('/').pop();
      console.log(`[renderer:${levels[level] || level}] ${message}  (${src}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) =>
      console.error('[renderer] surec sonlandi:', details));
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
      console.error('[renderer] yuklenemedi:', code, desc));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    writeSettings({ windowBounds: mainWindow.getNormalBounds() });
  }, 600);
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) =>
    mainWindow.on(ev, () => send('win:state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    }))
  );
}

/* -------------------------------------------------------------------------- */
/*                        Mikrofon / ekran izinleri                            */
/* -------------------------------------------------------------------------- */

function setupPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'clipboard-read', 'notifications'];
    callback(allowed.includes(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications'].includes(permission)
  );

  // getDisplayMedia: kendi secicimizden gelen kaynagi kullan.
  // callback gercek bir DesktopCapturerSource bekler, bu yuzden id ile yeniden ariyoruz.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const wanted = pendingDisplaySource;
    pendingDisplaySource = null;
    if (!wanted) return callback({});
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 }
      });
      const source = sources.find((s) => s.id === wanted.id);
      if (!source) return callback({});
      // Sistem sesi yalnizca Windows'ta ve istendiginde yakalanir.
      // Bazi ses surucilerinde loopback acilamaz; o durumda renderer
      // sessiz paylasimla yeniden dener.
      callback(wanted.audio && process.platform === 'win32'
        ? { video: source, audio: 'loopback' }
        : { video: source });
    } catch (err) {
      console.warn('[display] kaynak bulunamadi:', err.message);
      callback({});
    }
  }, { useSystemPicker: false });
}

/* -------------------------------------------------------------------------- */
/*                          Push-to-talk global kisayol                        */
/* -------------------------------------------------------------------------- */

let pttAccelerator = null;
let pttReleaseTimer = null;
let pttDown = false;

function releasePtt() {
  if (!pttDown) return;
  pttDown = false;
  send('ptt:change', false);
}

function registerPtt(accelerator) {
  unregisterPtt();
  if (!accelerator) return { ok: true };
  try {
    const ok = globalShortcut.register(accelerator, () => {
      // globalShortcut'ta keyup olayi yok: tus tekrarini zamanlayiciyla takip ediyoruz
      if (!pttDown) {
        pttDown = true;
        send('ptt:change', true);
      }
      clearTimeout(pttReleaseTimer);
      pttReleaseTimer = setTimeout(releasePtt, 260);
    });
    if (!ok) return { ok: false, error: 'Kisayol baska bir uygulama tarafindan kullaniliyor' };
    pttAccelerator = accelerator;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function unregisterPtt() {
  if (pttAccelerator) {
    try { globalShortcut.unregister(pttAccelerator); } catch {}
    pttAccelerator = null;
  }
  clearTimeout(pttReleaseTimer);
  releasePtt();
}

/* -------------------------------------------------------------------------- */
/*                                 Tepsi (tray)                                */
/* -------------------------------------------------------------------------- */

function trayIcon(muted) {
  // Electron nativeImage SVG okumaz; build/ altindaki PNG'ler kullaniliyor.
  const file = path.join(__dirname, '..', '..', 'build', muted ? 'tray-mic-muted.png' : 'tray-mic.png');
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return nativeImage.createEmpty();
  const small = img.resize({ width: 16, height: 16 });
  if (isMac && !muted) small.setTemplateImage(true);
  return small;
}

function buildTray() {
  try {
    tray = new Tray(trayIcon(false));
    tray.setToolTip('LanChat');
    updateTrayMenu({ muted: false, deafened: false, inVoice: false });
    tray.on('click', () => {
      if (!mainWindow) return;
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    });
  } catch (err) {
    console.warn('[tray] olusturulamadi:', err.message);
  }
}

function updateTrayMenu(state = {}) {
  if (!tray) return;
  try { tray.setImage(trayIcon(state.muted)); } catch {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.inVoice ? 'Ses kanalinda' : 'Ses kanalinda degil', enabled: false },
    { type: 'separator' },
    { label: state.muted ? 'Mikrofonu ac' : 'Mikrofonu kapat', click: () => send('tray:action', 'toggleMute') },
    { label: state.deafened ? 'Sesi ac' : 'Kulakligi kapat', click: () => send('tray:action', 'toggleDeafen') },
    { type: 'separator' },
    { label: 'Pencereyi goster', click: () => mainWindow && mainWindow.show() },
    { label: 'Cikis', click: () => { app.quit(); } }
  ]));
}

/* -------------------------------------------------------------------------- */
/*                                    IPC                                      */
/* -------------------------------------------------------------------------- */

function setupIpc() {
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch || {}));

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    hostname: os.hostname(),
    userData: app.getPath('userData')
  }));

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  /* --- Ekran paylasimi --- */

  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources
      .filter((s) => !(s.name === 'LanChat' && !s.id.startsWith('screen:')))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      }));
  });

  ipcMain.handle('screen:select', (_e, sourceId, opts = {}) => {
    pendingDisplaySource = sourceId ? { id: sourceId, audio: !!(opts && opts.audio) } : null;
    return { ok: true };
  });

  ipcMain.handle('screen:permission', async () => {
    if (!isMac) return { status: 'granted' };
    return { status: systemPreferences.getMediaAccessStatus('screen') };
  });

  ipcMain.handle('mic:permission', async () => {
    if (!isMac) return { status: 'granted' };
    let status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') {
      try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
      status = systemPreferences.getMediaAccessStatus('microphone');
    }
    return { status };
  });

  ipcMain.handle('system:openPrefs', (_e, panel) => {
    if (!isMac) return;
    const map = {
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    };
    if (map[panel]) shell.openExternal(map[panel]);
  });

  /* --- RNNoise WASM (file:// uzerinde fetch calismaz) --- */

  ipcMain.handle('rnnoise:wasm', async () => {
    try {
      const file = path.join(__dirname, '..', 'renderer', 'vendor', 'rnnoise', 'rnnoise.wasm');
      const buf = await fs.promises.readFile(file);
      return new Uint8Array(buf);
    } catch (err) {
      console.warn('[rnnoise] okunamadi:', err.message);
      return null;
    }
  });

  /* --- Gomulu sunucu --- */

  ipcMain.handle('server:start', async (_e, { port } = {}) => {
    if (embeddedServer) {
      return { ok: true, running: true, port: embeddedServer.port, addresses: embeddedServer.addresses() };
    }
    const wanted = port || readSettings().serverPort || 4545;
    try {
      const { createServer } = require(path.join(__dirname, '..', '..', 'server', 'index.js'));
      embeddedServer = createServer({
        port: wanted,
        dataDir: path.join(app.getPath('userData'), 'server'),
        password: readSettings().serverPassword,
        log: (...args) => send('server:log', args.join(' '))
      });
      const info = await embeddedServer.start();
      return { ok: true, running: true, port: info.port, addresses: info.addresses };
    } catch (err) {
      embeddedServer = null;
      return { ok: false, error: err.code === 'EADDRINUSE' ? `${wanted} portu zaten kullanimda` : err.message };
    }
  });

  ipcMain.handle('server:stop', async () => {
    if (!embeddedServer) return { ok: true, running: false };
    await embeddedServer.stop();
    embeddedServer = null;
    return { ok: true, running: false };
  });

  ipcMain.handle('discovery:scan', async (_e, { timeout } = {}) => {
    try {
      const { scan } = require(path.join(__dirname, '..', '..', 'server', 'discovery.js'));
      const list = await scan({ timeout: timeout || 1200 });
      // Kendi sunucumuz listede iki kez gorunmesin
      const mine = embeddedServer ? embeddedServer.port : null;
      return list.map((s) => ({ ...s, self: !!(mine && s.local && s.port === mine) }));
    } catch (err) {
      console.warn('[kesif] tarama hatasi:', err.message);
      return [];
    }
  });

  ipcMain.handle('server:status', () => {
    const { localAddresses } = require(path.join(__dirname, '..', '..', 'server', 'index.js'));
    return {
      running: !!embeddedServer,
      port: embeddedServer ? embeddedServer.port : readSettings().serverPort,
      addresses: localAddresses()
    };
  });

  /* --- Push to talk --- */

  ipcMain.handle('ptt:register', (_e, accelerator) => registerPtt(accelerator));
  ipcMain.handle('ptt:unregister', () => { unregisterPtt(); return { ok: true }; });

  /* --- Pencere kontrolleri --- */

  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win:maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('win:close', () => mainWindow && mainWindow.close());
  ipcMain.on('win:flash', () => {
    if (mainWindow && !mainWindow.isFocused()) {
      if (isMac) app.dock && app.dock.bounce('informational');
      else mainWindow.flashFrame(true);
    }
  });
  ipcMain.on('win:setAlwaysOnTop', (_e, value) => mainWindow && mainWindow.setAlwaysOnTop(!!value, 'floating'));

  ipcMain.on('tray:update', (_e, state) => updateTrayMenu(state || {}));
  ipcMain.on('badge:set', (_e, count) => {
    if (isMac && app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
  });
}

/* -------------------------------------------------------------------------- */
/*                                Uygulama akisi                               */
/* -------------------------------------------------------------------------- */

app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    setupPermissions();
    setupIpc();
    createWindow();
    buildTray();

    try {
      require('./updater.js').setup(send);
    } catch (err) {
      console.warn('[updater] baslatilamadi:', err.message);
    }

    const settings = readSettings();
    if (settings.pttEnabled && settings.pttKey) registerPtt(settings.pttKey);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) mainWindow.show();
    });
  });
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  if (embeddedServer) await embeddedServer.stop();
});
