'use strict';

/**
 * Renderer duman testi (Electron ana sureci olarak calisir):
 *   npm run test:renderer
 *
 * Gorunmez bir pencerede index.html'i yukler, modullerin hatasiz
 * ayaga kalktigini ve RNNoise AudioWorklet zincirinin gercekten
 * ses isledigini dogrular.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..');
const consoleErrors = [];
let fails = 0;

const ok = (cond, label, extra) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
  if (!cond) fails++;
};

app.whenReady().then(async () => {
  // Uygulamanin gercek izin politikasini kullan (test "her seye izin" demesin)
  require(path.join(ROOT, 'src', 'main', 'permissions.js')).applyTo(session.defaultSession);

  // Uygulamanin kendi IPC kanallari (gercek main.js calismadigi icin taklit)
  ipcMain.handle('settings:get', () => ({
    username: 'TestKullanici', color: '#5b8cff', noiseMode: 'rnnoise',
    suppressionMix: 1, echoCancellation: true, autoGainControl: true,
    inputVolume: 1, outputVolume: 1, vadGate: false, vadThreshold: 0.6,
    inputDeviceId: 'default', outputDeviceId: 'default', userVolumes: {},
    theme: 'midnight', accent: '#5b8cff', pttEnabled: false, pttKey: 'F8',
    recentServers: ['25.1.2.3:4545'], lastServer: '', serverPort: 4545,
    screenShareQuality: '1080p30', startServerOnLaunch: false,
    iceMode: 'auto', turnUrl: '', turnUser: '', turnPass: '', serverPassword: ''
  }));
  ipcMain.handle('settings:set', (_e, p) => p);
  ipcMain.handle('app:info', () => ({
    version: '1.0.0', platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome,
    hostname: 'test', userData: '/tmp/test'
  }));
  ipcMain.handle('rnnoise:wasm', async () => {
    const file = path.join(ROOT, 'src', 'renderer', 'vendor', 'rnnoise', 'rnnoise.wasm');
    return new Uint8Array(await fs.promises.readFile(file));
  });
  ipcMain.handle('server:status', () => ({ running: false, port: 4545, addresses: [] }));
  ipcMain.handle('update:state', () => ({ status: 'idle', version: null, progress: 0, error: null, canAutoInstall: false, currentVersion: '1.0.0' }));
  ipcMain.handle('update:check', () => ({ status: 'none' }));
  ['update:download', 'update:install', 'update:openReleases'].forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));
  ipcMain.handle('discovery:scan', () => ([
    { address: '25.14.88.201', port: 4545, name: 'Test Sunucusu', users: 2, hamachi: true, locked: false }
  ]));
  ipcMain.handle('mic:permission', () => ({ status: 'granted' }));
  ipcMain.handle('screen:permission', () => ({ status: 'granted' }));
  ['app:openExternal', 'screen:sources', 'screen:select', 'system:openPrefs',
   'server:start', 'server:stop', 'ptt:register', 'ptt:unregister']
    .forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));

  const win = new BrowserWindow({
    show: false,
    width: 1300,
    height: 850,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false
    }
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push(`${message} (${String(source).split('/').pop()}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('YUKLENEMEDI:', code, desc);
    process.exit(1);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  console.log('\n1) Modul yuklemesi');
  ok(await js('typeof window.app === "object"'), 'app.js calisti, window.app olustu');
  ok(await js('typeof window.io === "function"'), 'socket.io istemcisi yuklendi');
  ok(await js('!!window.app.net && !!window.app.audio && !!window.app.mesh'), 'net/audio/mesh katmanlari kuruldu');
  ok(await js('!!window.app.ui && !!window.app.chat && !!window.app.voice && !!window.app.settingsUI'),
    'arayuz denetleyicileri kuruldu');

  console.log('\n2) DOM ve tema');
  ok(await js('!!document.querySelector("#connectScreen") && !document.querySelector("#connectScreen").classList.contains("hidden")'),
    'baglanti ekrani gorunur');
  ok(await js('document.querySelector("#app").classList.contains("hidden")'), 'ana uygulama gizli');
  ok(await js('document.documentElement.dataset.theme === "midnight"'), 'tema uygulandi');
  ok(await js('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#5b8cff"'),
    'vurgu rengi degiskeni ayarlandi');
  ok(await js('document.querySelector("#inpName").value === "TestKullanici"'), 'ayarlar formu dolduruldu');
  ok(await js('document.querySelectorAll("#recentServers .recent-item").length === 1'), 'son sunucular listelendi');
  await new Promise((r) => setTimeout(r, 1200));
  ok(await js('document.querySelectorAll("#foundList .found-item").length === 1'), 'agda bulunan sunucu listelendi');
  ok(await js('!!document.querySelector("#btnAuto") && !!document.querySelector("#inpPassword")'),
    'otomatik bagla ve sifre alanlari mevcut');
  ok(await js('window.app.buildIceServers().length === 1'), 'STUN sunuculari yapilandirildi');
  ok(await js('document.body.dataset.platform === process_platform'.replace('process_platform', JSON.stringify(process.platform))),
    'platform sinifi body uzerinde');

  console.log('\n3) Ikonlar ve stil');
  ok(await js(`getComputedStyle(document.documentElement).getPropertyValue("--i-mic").includes("svg")`),
    'ikon maskeleri yuklendi');
  ok(await js(`getComputedStyle(document.querySelector(".brand-mark")).width === "48px"`),
    'components.css uygulandi');

  console.log('\n4) Markdown isleyici');
  const md = await js(`(async () => {
    const m = await import('./js/util.js');
    return {
      bold: m.renderMarkdown('**kalin**'),
      code: m.renderMarkdown('\`kod\`'),
      xss: m.renderMarkdown('<img src=x onerror=alert(1)>'),
      emoji: m.isOnlyEmoji(String.fromCodePoint(0x1F600))
    };
  })()`);
  ok(md.bold === '<strong>kalin</strong>', 'kalin metin islendi', md.bold);
  ok(md.code.includes('inline-code'), 'satir ici kod islendi');
  ok(!md.xss.includes('<img'), 'HTML kacisi calisiyor (XSS engellendi)', md.xss);
  ok(md.emoji === true, 'tek emoji tespiti calisiyor');

  console.log('\n5) RNNoise AudioWorklet zinciri');
  const audio = await js(`(async () => {
    const a = window.app.audio;
    try {
      await a.ensureContext();
      const sr = a.ctx.sampleRate;
      const bytes = await a.loadRnnoise();
      return { ok: true, sampleRate: sr, wasmBytes: bytes ? bytes.byteLength : 0 };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`);
  ok(audio.ok, 'AudioContext ve worklet modulu yuklendi', audio.error);
  ok(audio.sampleRate === 48000, `ornekleme hizi 48 kHz (RNNoise sarti)`, String(audio.sampleRate));
  ok(audio.wasmBytes > 1000000, 'rnnoise.wasm IPC uzerinden alindi', `${audio.wasmBytes} bayt`);

  // Gercek ses isleme: gurultulu sinyali worklet'ten gecirip cikisi olc
  const dsp = await js(`(async () => {
    const a = window.app.audio;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 48000, sampleRate: 48000 });
    await ctx.audioWorklet.addModule('./worklets/mic-processor.js');
    const bytes = await a.loadRnnoise();

    // 1 saniyelik beyaz gurultu
    const buf = ctx.createBuffer(1, 48000, 48000);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() - 0.5) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const node = new AudioWorkletNode(ctx, 'mic-processor', {
      outputChannelCount: [1],
      processorOptions: { wasmBytes: bytes.slice(0), denoise: true, mix: 1, vadGate: false, boost: 1 }
    });
    const readyP = new Promise((r) => { node.port.onmessage = (e) => { if (e.data.type === 'ready') r(e.data); }; });
    src.connect(node); node.connect(ctx.destination);

    // WASM derlemesi asenkron; render baslamadan once hazir olmasini bekle
    const ready = await Promise.race([
      readyP,
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'zaman asimi (5 sn)' }), 5000))
    ]);

    src.start();
    const rendered = await ctx.startRendering();

    const out = rendered.getChannelData(0);
    const rms = (arr, from, to) => {
      let s = 0; for (let i = from; i < to; i++) s += arr[i] * arr[i];
      return Math.sqrt(s / (to - from));
    };
    return {
      ready,
      inRms: rms(d, 24000, 48000),
      outRms: rms(out, 24000, 48000)
    };
  })()`);

  ok(dsp.ready && dsp.ready.ok, 'worklet icinde RNNoise WASM ornegi olusturuldu',
    dsp.ready && dsp.ready.error);
  const reduction = dsp.inRms > 0 ? 20 * Math.log10(dsp.outRms / dsp.inRms) : 0;
  ok(dsp.outRms < dsp.inRms * 0.2,
    'beyaz gurultu bastirildi',
    `giris ${dsp.inRms.toFixed(4)} -> cikis ${dsp.outRms.toFixed(4)}  (${reduction.toFixed(1)} dB)`);

  console.log('\n6) Genel kullanim duzeltmeleri');

  // Bas-konus tusu duz bir harf olabilir; mesaj yazarken tetiklenmemeli
  const typing = await js(`(() => {
    const a = window.app;
    return {
      composer: a.isTyping({ target: document.querySelector('#inpMessage') }),
      input: a.isTyping({ target: document.querySelector('#inpName') }),
      body: a.isTyping({ target: document.body })
    };
  })()`);
  ok(typing.composer === true, 'mesaj kutusu "yaziyor" sayiliyor (PTT tetiklenmez)');
  ok(typing.input === true, 'metin kutusu "yaziyor" sayiliyor');
  ok(typing.body === false, 'bos alanda PTT calisabilir');

  // Kulakligi kapatip acinca mikrofon eski haline donmeli
  const deafen = await js(`(() => {
    const a = window.app;
    a.state.self = { id: 'x', username: 'Test', color: '#5b8cff', status: 'online' };
    a.state.muted = false;
    a.state.deafened = false;
    a.toggleDeafen();
    const whileDeaf = { muted: a.state.muted, deafened: a.state.deafened };
    a.toggleDeafen();
    const after = { muted: a.state.muted, deafened: a.state.deafened };

    // Zaten kapali mikrofonla kulaklik kapatilip acilirsa kapali kalmali
    a.state.muted = true; a.state.deafened = false; a._mutedBeforeDeafen = undefined;
    a.toggleDeafen(); a.toggleDeafen();
    const stayMuted = a.state.muted;
    return { whileDeaf, after, stayMuted };
  })()`);
  ok(deafen.whileDeaf.muted === true, 'kulaklik kapatilinca mikrofon da kapaniyor');
  ok(deafen.after.muted === false && deafen.after.deafened === false,
    'kulaklik geri acilinca mikrofon da geri geliyor');
  ok(deafen.stayMuted === true, 'zaten kapali mikrofon kendiliginden acilmiyor');

  // Yukari kaydirmisken gelen mesaj icin gosterge
  const jump = await js(`(() => {
    const c = window.app.chat;
    c.showJumpButton(); c.showJumpButton();
    const btn = document.querySelector('.jump-new');
    const shown = !!(btn && btn.classList.contains('show'));
    const txt = btn && btn.querySelector('.jn-text').textContent;
    c.hideJumpButton();
    const hidden = !!(btn && !btn.classList.contains('show'));
    return { shown, txt, hidden };
  })()`);
  ok(jump.shown, 'yeni mesaj gostergesi cikiyor');
  ok(jump.txt === '2 yeni mesaj', 'gosterge sayiyi yaziyor', jump.txt);
  ok(jump.hidden, 'asagi inince gosterge kayboluyor');

  // Baglanti yokken mesaj sessizce kaybolmamali
  const offline = await js(`(() => {
    const c = window.app.chat;
    c.channelId = 'genel';
    c.inputNode.textContent = 'kaybolmamali';
    c.send();
    return {
      korundu: c.inputNode.innerText.trim(),
      uyari: !!document.querySelector('.toast.err')
    };
  })()`);
  ok(offline.korundu === 'kaybolmamali', 'baglanti yokken mesaj kutuda kaliyor');
  ok(offline.uyari, 'kullaniciya hata bildirimi gosteriliyor');

  console.log('\n7) Guncelleme yapilandirmasi');
  // Bu bolum iki gercek hatayi yakalamak icin var:
  //  - updater.js'te fs require edilmemisti, ReferenceError sessiz catch'e dusuyordu
  //  - module.exports kaldirilmis bir fonksiyona atif yapiyordu, modul hic yuklenmiyordu
  let updaterOk = true;
  let updaterErr = null;
  let cfg = null;
  let exportsOk = false;
  try {
    const upd = require(path.join(ROOT, 'src', 'main', 'updater.js'));
    exportsOk = ['setup', 'check', 'readUpdateConfig', 'releasesUrl']
      .every((k) => typeof upd[k] === 'function');

    const fixture = path.join(require('os').tmpdir(), `lanchat-upd-${Date.now()}.yml`);
    fs.writeFileSync(fixture, 'owner: test-kullanici\nrepo: test-depo\nprovider: github\n');
    cfg = upd.readUpdateConfig(fixture);
    fs.unlinkSync(fixture);
  } catch (err) {
    updaterOk = false;
    updaterErr = err.message;
  }
  ok(updaterOk, 'updater modulu hatasiz yukleniyor', updaterErr);
  ok(exportsOk, 'updater disa aktarimlari eksiksiz');
  ok(cfg && cfg.owner === 'test-kullanici' && cfg.repo === 'test-depo',
    'app-update.yml gercekten okunabiliyor', cfg ? JSON.stringify(cfg) : 'null');

  // Giris ekranindayken ayarlara ulasilabilmeli: guncelleme bildirimi
  // geldiginde kullanici kuracak yeri bulamiyordu.
  const reach = await js(`(() => {
    const btn = document.querySelector('#btnConnectSettings');
    const visible = btn && btn.offsetParent !== null;
    btn && btn.click();
    const opened = !!document.querySelector('.modal-backdrop');
    const close = document.querySelector('.modal-head .icon-btn');
    if (close) close.click();
    return { visible: !!visible, opened };
  })()`);
  ok(reach.visible, 'giris ekraninda ayarlar dugmesi gorunuyor');
  ok(reach.opened, 'giris ekranindan ayarlar acilabiliyor');

  const bar = await js(`(() => {
    const a = window.app;
    a.renderUpdateBar({ status: 'ready', version: '9.9.9', canAutoInstall: true });
    const el = document.querySelector('#updateBar');
    const shown = el && !el.classList.contains('hidden');
    const msg = document.querySelector('#updateBarMsg').textContent;
    const action = document.querySelector('#updateBarAction').textContent;
    a.renderUpdateBar({ status: 'none' });
    const hiddenAfter = document.querySelector('#updateBar').classList.contains('hidden');
    return { shown, msg, action, hiddenAfter };
  })()`);
  ok(bar.shown, 'guncelleme cubugu goruntuleniyor');
  ok(/9\.9\.9/.test(bar.msg), 'cubuk surumu yaziyor', bar.msg);
  ok(bar.action === 'Kur ve yeniden baslat', 'cubukta dogrudan kurulum dugmesi var', bar.action);
  ok(bar.hiddenAfter, 'guncelleme yokken cubuk gizleniyor');

  console.log('\n8) Konsol hatalari');
  ok(consoleErrors.length === 0, 'renderer konsolunda hata yok', consoleErrors.join(' | ') || undefined);

  console.log(`\n${fails === 0 ? 'RENDERER TESTLERI GECTI' : fails + ' TEST BASARISIZ'}\n`);
  app.exit(fails ? 1 : 0);
}).catch((err) => {
  console.error('TEST COKTU:', err);
  app.exit(1);
});
