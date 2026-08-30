'use strict';

/**
 * Arayuz ekran goruntusu uretici (Electron ana sureci olarak calisir):
 *   npm run shots
 *
 * Sunucuya baglanmadan sahte veriyle arayuzu doldurur ve
 * ./shots/ altina PNG dosyalari yazar. Tasarim kontrolu icin.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots');

const SETTINGS = {
  username: 'Batuhan', color: '#5b8cff', noiseMode: 'rnnoise', suppressionMix: 1,
  echoCancellation: true, autoGainControl: true, inputVolume: 1, outputVolume: 1,
  vadGate: false, vadThreshold: 0.6, inputDeviceId: 'default', outputDeviceId: 'default',
  userVolumes: {}, theme: 'midnight', accent: '#5b8cff', pttEnabled: false, pttKey: 'F8',
  recentServers: ['25.14.88.201:4545', '25.9.4.77:4545'], lastServer: '25.14.88.201:4545',
  serverPort: 4545, screenShareQuality: '1080p30', startServerOnLaunch: false,
  iceMode: 'auto', turnUrl: '', turnUser: '', turnPass: '', serverPassword: ''
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));

  ipcMain.handle('settings:get', () => SETTINGS);
  ipcMain.handle('settings:set', (_e, p) => Object.assign(SETTINGS, p));
  ipcMain.handle('app:info', () => ({
    version: '1.0.0', platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome,
    hostname: 'mac', userData: '~/Library/Application Support/LanChat'
  }));
  ipcMain.handle('rnnoise:wasm', async () =>
    new Uint8Array(await fs.promises.readFile(path.join(ROOT, 'src/renderer/vendor/rnnoise/rnnoise.wasm'))));
  ipcMain.handle('server:status', () => ({
    running: true, port: 4545,
    addresses: [
      { nic: 'ham0', address: '25.14.88.201', hamachi: true },
      { nic: 'en0', address: '192.168.1.15', hamachi: false }
    ]
  }));
  ipcMain.handle('mic:permission', () => ({ status: 'granted' }));
  ipcMain.handle('screen:permission', () => ({ status: 'granted' }));
  ['app:openExternal', 'screen:select', 'system:openPrefs', 'server:start', 'server:stop',
   'ptt:register', 'ptt:unregister'].forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));
  ipcMain.handle('screen:sources', () => []);
  ipcMain.handle('update:state', () => ({ status: 'idle', version: null, progress: 0, error: null, canAutoInstall: false, currentVersion: '1.0.0' }));
  ipcMain.handle('update:check', () => ({ status: 'none' }));
  ['update:download', 'update:install', 'update:openReleases'].forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));
  ipcMain.handle('discovery:scan', () => ([
    { address: '25.14.88.201', port: 4545, name: 'Kanka Sunucusu', users: 3, hamachi: true, locked: false },
    { address: '192.168.1.15', port: 4545, name: 'Ev Sunucusu', users: 1, hamachi: false, locked: true }
  ]));

  const win = new BrowserWindow({
    show: false, width: 1360, height: 880,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('[renderer]', msg); });

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  yazildi:', `shots/${name}.png`);
  };

  await shot('01-baglanti');

  await win.webContents.executeJavaScript(`
    document.querySelector('[data-tab="host"]').click();
    window.app.refreshHostStatus();
  `, true);
  await new Promise((r) => setTimeout(r, 500));
  await shot('02-sunucu-kur');

  // --- Sahte oturum ---
  await win.webContents.executeJavaScript(`(async () => {
    const a = window.app;
    const now = Date.now();
    const t = (min) => new Date(now - min * 60000).toISOString();

    const users = [
      { id: 'u1', username: 'Batuhan', color: '#5b8cff', status: 'online' },
      { id: 'u2', username: 'Kerem',   color: '#3ba55d', status: 'online' },
      { id: 'u3', username: 'Elif',    color: '#e91e63', status: 'online' },
      { id: 'u4', username: 'Mert',    color: '#faa61a', status: 'idle' }
    ];

    a.state.self = users[0];
    a.state.serverName = 'Kanka Sunucusu';
    a.state.users = users;
    a.state.channels = [
      { id: 'genel', name: 'genel', type: 'text', topic: 'Herkese acik sohbet' },
      { id: 'oyun', name: 'oyun', type: 'text', topic: 'Oyun planlari' },
      { id: 'lobi', name: 'Lobi', type: 'voice', limit: 8 },
      { id: 'oyun-odasi', name: 'Oyun Odasi', type: 'voice', limit: 8 }
    ];
    a.state.voice = {
      'lobi': [
        { id: 'u1', username: 'Batuhan', color: '#5b8cff', muted: false, deafened: false, screensharing: false },
        { id: 'u2', username: 'Kerem',   color: '#3ba55d', muted: true,  deafened: false, screensharing: false },
        { id: 'u3', username: 'Elif',    color: '#e91e63', muted: false, deafened: false, screensharing: true }
      ]
    };
    a.state.activeChannel = 'genel';
    a.net.url = 'http://25.14.88.201:4545';
    a.net.latency = 24;

    a.chat.channelId = 'genel';
    a.chat.messages = [
      { id: 'm1', channelId: 'genel', authorId: 'u2', author: 'Kerem', color: '#3ba55d',
        text: 'Aksam valorant var mi?', ts: t(48), reactions: {} },
      { id: 'm2', channelId: 'genel', authorId: 'u3', author: 'Elif', color: '#e91e63',
        text: 'Varim, 21:00 gibi musaitim', ts: t(46), reactions: { '\\u{1F44D}': ['u1', 'u2'] } },
      { id: 'm3', channelId: 'genel', authorId: 'u1', author: 'Batuhan', color: '#5b8cff',
        text: 'Ben de varim. Sunucuyu ben acarim, **Hamachi**\\'yi acmayi unutmayin.', ts: t(44), reactions: {} },
      { id: 'm4', channelId: 'genel', authorId: 'u1', author: 'Batuhan', color: '#5b8cff',
        text: 'Adres: \`25.14.88.201:4545\`', ts: t(44), reactions: {} },
      { id: 'm5', channelId: 'genel', authorId: 'u4', author: 'Mert', color: '#faa61a',
        text: 'Mikrofonumda cok parazit vardi, RNNoise\\'u actim simdi tertemiz', ts: t(12),
        reactions: { '\\u{1F525}': ['u1'] } },
      { id: 'm6', channelId: 'genel', authorId: 'u2', author: 'Kerem', color: '#3ba55d',
        text: 'Bu ayari nereden actin?', ts: t(9), replyTo: 'm5', reactions: {} },
      { id: 'm7', channelId: 'genel', authorId: 'u4', author: 'Mert', color: '#faa61a',
        text: 'Ayarlar > Ses ve mikrofon > Gurultu engelleme\\n\\n\`\`\`js\\n// veya ses panelindeki kalkan dugmesine bas\\nvoice.cycleNoiseMode()\\n\`\`\`', ts: t(8), reactions: {} },
      { id: 'm8', channelId: 'genel', authorId: 'u3', author: 'Elif', color: '#e91e63',
        text: '@Batuhan ekranini paylasabilir misin?', ts: t(2), reactions: {} }
    ];

    document.querySelector('#connectScreen').classList.add('hidden');
    document.querySelector('#app').classList.remove('hidden');

    a.ui.renderServer();
    a.ui.renderSelf();
    a.ui.renderChannels();
    a.ui.renderMembers();
    a.ui.renderHeader();
    a.ui.setLatency(24);
    a.chat.render();
    a.chat.scrollToBottom(true);
    a.chat.typingUsers.set('u2', { username: 'Kerem', at: Date.now() });
    a.chat.renderTyping();
    return true;
  })()`, true);

  await new Promise((r) => setTimeout(r, 700));
  await shot('03-sohbet');

  // Ses paneli + kutucuklar
  await win.webContents.executeJavaScript(`
    const a = window.app;
    a.voice.channelId = 'lobi';
    a.voice.joinedAt = Date.now() - 1000 * 60 * 12;
    a.voice.setPanel('connected', 'lobi');
    a.voice.renderTiles();
    document.querySelector('#btnShareScreen').classList.add('live');
    document.querySelectorAll('.vtile')[0].classList.add('speaking');
    document.querySelectorAll('.vtile')[0].querySelector('.avatar').classList.add('speaking');
    document.querySelector('#ubAvatar').classList.add('speaking');
    true;
  `, true);
  await new Promise((r) => setTimeout(r, 500));
  await shot('04-sesli-sohbet');

  // Ayarlar - ses
  await win.webContents.executeJavaScript(`window.app.settingsUI.open('audio'); true;`, true);
  await new Promise((r) => setTimeout(r, 900));
  await shot('05-ayarlar-ses');

  await win.webContents.executeJavaScript(`
    document.querySelector('.modal-head .icon-btn').click();
    window.app.settingsUI.open('appearance');
    true;
  `, true);
  await new Promise((r) => setTimeout(r, 600));
  await shot('06-ayarlar-gorunum');

  // Aydinlik tema
  await win.webContents.executeJavaScript(`
    document.querySelector('.modal-head .icon-btn').click();
    window.app.settings.theme = 'daylight';
    window.app.applyTheme();
    true;
  `, true);
  await new Promise((r) => setTimeout(r, 500));
  await shot('07-aydinlik-tema');

  console.log('\nTum ekran goruntuleri hazir: shots/\n');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
