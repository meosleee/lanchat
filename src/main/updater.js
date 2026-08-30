'use strict';

/**
 * Guncelleme yonetimi
 * -------------------
 * Windows: electron-updater ile tam otomatik guncelleme (indir + kur).
 *
 * macOS: Squirrel.Mac, guncellemenin kod imzasinin calisan uygulamanin
 * "designated requirement" ile eslesmesini sart kosar. Apple Developer
 * sertifikamiz olmadigi icin uygulama ad-hoc imzali ve ad-hoc imzada bu
 * gereksinim ikilinin cdhash'ine baglidir - yeni bir derleme asla eslesmez.
 * Bu yuzden macOS'ta otomatik kurulum yapilamaz; onun yerine yeni surumu
 * haber verip indirme sayfasini aciyoruz.
 */

const { app, shell, ipcMain } = require('electron');
const path = require('path');

const PLACEHOLDER_OWNER = 'KULLANICI_ADIN';

let autoUpdater = null;
let sendToRenderer = () => {};
let state = {
  status: 'idle',        // idle | checking | available | downloading | ready | none | error | unsupported
  version: null,
  notes: null,
  progress: 0,
  error: null,
  canAutoInstall: process.platform === 'win32'
};

function publishConfig() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const pub = pkg.build && pkg.build.publish;
    return Array.isArray(pub) ? pub[0] : pub || null;
  } catch {
    return null;
  }
}

function isConfigured() {
  const pub = publishConfig();
  return !!(pub && pub.owner && pub.owner !== PLACEHOLDER_OWNER);
}

function releasesUrl() {
  const pub = publishConfig();
  if (!pub || !pub.owner) return null;
  return `https://github.com/${pub.owner}/${pub.repo}/releases/latest`;
}

function push(patch) {
  state = { ...state, ...patch };
  sendToRenderer('update:state', state);
}

function init(send) {
  sendToRenderer = send;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    push({ status: 'error', error: `electron-updater yuklenemedi: ${err.message}` });
    return;
  }

  autoUpdater.autoDownload = false;          // indirmeyi kullanici baslatsin
  autoUpdater.autoInstallOnAppQuit = process.platform === 'win32';
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => push({ status: 'checking', error: null }));

  autoUpdater.on('update-available', (info) => {
    push({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    });
    // Windows'ta indirmeyi hemen baslat; macOS'ta zaten kuramayiz
    if (process.platform === 'win32') autoUpdater.downloadUpdate().catch(() => {});
  });

  autoUpdater.on('update-not-available', () => push({ status: 'none', version: null, progress: 0 }));

  autoUpdater.on('download-progress', (p) =>
    push({ status: 'downloading', progress: Math.round(p.percent) }));

  autoUpdater.on('update-downloaded', (info) =>
    push({ status: 'ready', version: info.version, progress: 100 }));

  autoUpdater.on('error', (err) => {
    push({ status: 'error', error: String((err && err.message) || err) });
  });
}

async function check({ silent } = {}) {
  if (!app.isPackaged) {
    push({ status: 'unsupported', error: 'Guncelleme yalnizca paketlenmis uygulamada calisir.' });
    return state;
  }
  if (!isConfigured()) {
    push({
      status: 'unsupported',
      error: 'Guncelleme kaynagi ayarlanmamis. package.json > build.publish icindeki owner alanini doldur.'
    });
    return state;
  }
  if (!autoUpdater) return state;

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (!silent) push({ status: 'error', error: String((err && err.message) || err) });
  }
  return state;
}

function setup(send) {
  init(send);

  ipcMain.handle('update:state', () => ({ ...state, currentVersion: app.getVersion() }));
  ipcMain.handle('update:check', (_e, opts) => check(opts || {}));

  ipcMain.handle('update:download', async () => {
    if (!autoUpdater) return { ok: false, error: 'hazir degil' };
    // macOS'ta kuramadigimiz icin indirmek yerine surum sayfasini aciyoruz
    if (process.platform !== 'win32') {
      const url = releasesUrl();
      if (url) shell.openExternal(url);
      return { ok: true, opened: true };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('update:install', () => {
    if (process.platform !== 'win32') {
      const url = releasesUrl();
      if (url) shell.openExternal(url);
      return { ok: false, error: 'macOS ta otomatik kurulum desteklenmiyor' };
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  ipcMain.handle('update:openReleases', () => {
    const url = releasesUrl();
    if (url) shell.openExternal(url);
    return { ok: !!url };
  });

  // Aciliistan 8 saniye sonra sessizce bir kez bak
  setTimeout(() => { check({ silent: true }).catch(() => {}); }, 8000);
}

module.exports = { setup, check, isConfigured, releasesUrl };
