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
const fs = require('fs');

let autoUpdater = null;
let sendToRenderer = () => {};
let state = {
  status: 'idle',        // idle | checking | available | downloading | ready | none | error | unsupported
  version: null,
  notes: null,
  progress: 0,
  error: null,
  source: null,          // "owner/repo" - teshis icin
  canAutoInstall: process.platform === 'win32'
};

/**
 * Guncelleme kaynagini oku.
 *
 * DIKKAT: Bunu package.json > build.publish uzerinden okumak calismaz -
 * electron-builder paketlerken package.json'dan "build" alanini siler.
 * Dogru kaynak, electron-builder'in paketin icine koydugu app-update.yml
 * dosyasidir; electron-updater da zaten onu kullanir.
 */
function readUpdateConfig(filePath) {
  try {
    const file = filePath || path.join(process.resourcesPath, 'app-update.yml');
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return cfg.owner && cfg.repo ? cfg : null;
  } catch (err) {
    console.warn('[updater] app-update.yml okunamadi:', err.message);
    return null;
  }
}

function releasesUrl() {
  const cfg = readUpdateConfig();
  return cfg ? `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest` : null;
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
    console.warn('[updater] electron-updater yuklenemedi:', err.message);
    push({ status: 'error', error: `electron-updater yuklenemedi: ${err.message}` });
    return;
  }

  autoUpdater.autoDownload = false;          // indirmeyi kullanici baslatsin
  autoUpdater.autoInstallOnAppQuit = process.platform === 'win32';
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] kontrol ediliyor...');
    push({ status: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] yeni surum bulundu:', info && info.version);
    push({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    });
    // Windows'ta indirmeyi hemen baslat; macOS'ta zaten kuramayiz
    if (process.platform === 'win32') autoUpdater.downloadUpdate().catch(() => {});
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] guncel:', info && info.version);
    push({ status: 'none', version: null, progress: 0 });
  });

  autoUpdater.on('download-progress', (p) =>
    push({ status: 'downloading', progress: Math.round(p.percent) }));

  autoUpdater.on('update-downloaded', (info) =>
    push({ status: 'ready', version: info.version, progress: 100 }));

  autoUpdater.on('error', (err) => {
    console.warn('[updater] hata:', String((err && err.message) || err));
    push({ status: 'error', error: String((err && err.message) || err) });
  });
}

async function check({ silent } = {}) {
  if (!app.isPackaged) {
    console.log('[updater] paketlenmemis calisma - guncelleme atlandi');
    push({ status: 'unsupported', error: 'Guncelleme yalnizca paketlenmis uygulamada calisir.' });
    return state;
  }

  const cfg = readUpdateConfig();
  if (!cfg) {
    console.warn('[updater] app-update.yml okunamadi:', path.join(process.resourcesPath, 'app-update.yml'));
    push({
      status: 'unsupported',
      error: 'app-update.yml bulunamadi - bu paket yayin yapilandirmasi olmadan derlenmis.'
    });
    return state;
  }
  if (!autoUpdater) {
    push({ status: 'error', error: 'electron-updater hazir degil' });
    return state;
  }

  console.log(`[updater] kaynak: ${cfg.owner}/${cfg.repo} (surum ${app.getVersion()})`);
  push({ source: `${cfg.owner}/${cfg.repo}` });

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    const message = String((err && err.message) || err);
    // Sessiz kontrolde de durumu kaydet: sorunu Ayarlar > Hakkinda'dan gorebilelim
    console.warn('[updater] kontrol basarisiz:', message);
    push({ status: 'error', error: message });
  }
  return state;
}

function setup(send) {
  const cfg = readUpdateConfig();
  console.log(`[updater] paketlenmis=${app.isPackaged} surum=${app.getVersion()} ` +
              `kaynak=${cfg ? cfg.owner + '/' + cfg.repo : 'yok'}`);
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

module.exports = { setup, check, readUpdateConfig, releasesUrl };
