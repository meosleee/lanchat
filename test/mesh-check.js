'use strict';

/**
 * Uctan uca WebRTC mesh testi (Electron ana sureci olarak calisir):
 *   npm run test:mesh
 *
 * Ayni surecte iki gercek renderer penceresi acar, ikisini de yerel
 * sunucuya baglar, ayni ses kanalina sokar ve aralarinda gercek bir
 * RTCPeerConnection kurulup ses akip akmadigini olcer.
 * Mikrofon icin Chromium'un sahte cihazi kullanilir.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 47100 + (process.pid % 300));

let fails = 0;
const ok = (cond, label, extra) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
  if (!cond) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSettings(name, color) {
  return {
    username: name, color, noiseMode: 'rnnoise', suppressionMix: 1,
    echoCancellation: false, autoGainControl: false, inputVolume: 1, outputVolume: 1,
    vadGate: false, vadThreshold: 0.6, inputDeviceId: 'default', outputDeviceId: 'default',
    userVolumes: {}, theme: 'midnight', accent: '#5b8cff', pttEnabled: false, pttKey: 'F8',
    recentServers: [], lastServer: '', serverPort: PORT, screenShareQuality: '1080p30',
    startServerOnLaunch: false, iceMode: 'lan', turnUrl: '', turnUser: '', turnPass: '', serverPassword: ''
  };
}

// Her pencere kendi ayarlarini alsin diye webContents id'sine gore ayiriyoruz
const settingsByWc = new Map();

app.whenReady().then(async () => {
  const { createServer } = require(path.join(ROOT, 'server', 'index.js'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-mesh-'));
  const server = createServer({ port: PORT, dataDir, log: () => {} });
  await server.start();
  console.log(`\nSunucu 127.0.0.1:${PORT} uzerinde\n`);

  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  ipcMain.handle('settings:get', (e) => settingsByWc.get(e.sender.id));
  ipcMain.handle('settings:set', (e, p) => Object.assign(settingsByWc.get(e.sender.id), p));
  ipcMain.handle('app:info', () => ({
    version: '1.0.0', platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome,
    hostname: 'test', userData: dataDir
  }));
  ipcMain.handle('rnnoise:wasm', async () =>
    new Uint8Array(await fs.promises.readFile(path.join(ROOT, 'src/renderer/vendor/rnnoise/rnnoise.wasm'))));
  ipcMain.handle('mic:permission', () => ({ status: 'granted' }));
  ipcMain.handle('screen:permission', () => ({ status: 'granted' }));
  ipcMain.handle('server:status', () => ({ running: false, port: PORT, addresses: [] }));
  ipcMain.handle('screen:sources', () => []);
  ipcMain.handle('update:state', () => ({ status: 'idle', version: null, progress: 0, error: null, canAutoInstall: false, currentVersion: '1.0.0' }));
  ipcMain.handle('update:check', () => ({ status: 'none' }));
  ['update:download', 'update:install', 'update:openReleases'].forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));
  ipcMain.handle('discovery:scan', () => []);
  ['app:openExternal', 'screen:select', 'system:openPrefs', 'server:start', 'server:stop',
   'ptt:register', 'ptt:unregister'].forEach((ch) => ipcMain.handle(ch, () => ({ ok: true })));

  const errors = { A: [], B: [], C: [] };

  async function makeWindow(name, color, tag) {
    const win = new BrowserWindow({
      show: false, width: 1200, height: 800,
      webPreferences: {
        preload: path.join(ROOT, 'src/main/preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        backgroundThrottling: false
      }
    });
    settingsByWc.set(win.webContents.id, makeSettings(name, color));
    win.webContents.on('console-message', (_e, lvl, msg, line, src) => {
      if (lvl >= 2) errors[tag].push(`${msg} (${String(src).split('/').pop()}:${line})`);
    });
    await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
    await wait(900);
    return win;
  }

  const winA = await makeWindow('Ali', '#5b8cff', 'A');
  const winB = await makeWindow('Bora', '#3ba55d', 'B');

  const js = (win, code) => win.webContents.executeJavaScript(code, true);

  console.log('1) Sunucuya baglanma');
  const connect = (win) => js(win, `(async () => {
    document.querySelector('#inpServer').value = '127.0.0.1:${PORT}';
    await window.app.connect();
    return { status: window.app.net.status, self: window.app.state.self && window.app.state.self.username };
  })()`);

  const ra = await connect(winA);
  const rb = await connect(winB);
  ok(ra.status === 'online' && ra.self === 'Ali', 'A baglandi', ra.status);
  ok(rb.status === 'online' && rb.self === 'Bora', 'B baglandi', rb.status);
  await wait(400);
  ok((await js(winA, 'window.app.state.users.length')) === 2, 'A iki kullanici goruyor');

  console.log('\n2) Ses kanalina katilma ve mikrofon zinciri');
  await js(winA, `window.app.voice.join('lobi')`);
  await wait(1200);
  await js(winB, `window.app.voice.join('lobi')`);
  await wait(1200);

  const micA = await js(winA, `(() => {
    const a = window.app.audio;
    return {
      hasStream: !!a.outputStream,
      tracks: a.outputStream ? a.outputStream.getAudioTracks().length : 0,
      rnnoise: a.rnnoiseOk,
      ctxState: a.ctx && a.ctx.state,
      rate: a.ctx && a.ctx.sampleRate
    };
  })()`);
  ok(micA.hasStream && micA.tracks === 1, 'A mikrofon zinciri kuruldu');
  ok(micA.rnnoise === true, 'A tarafinda RNNoise worklet hazir');
  ok(micA.ctxState === 'running', 'AudioContext calisiyor', micA.ctxState);
  ok(micA.rate === 48000, 'ornekleme hizi 48 kHz');

  console.log('\n3) Mesh eslesmesi');
  ok((await js(winA, 'window.app.mesh.peers.size')) === 1, 'A tek eslesme kurdu');
  ok((await js(winB, 'window.app.mesh.peers.size')) === 1, 'B tek eslesme kurdu');

  // Baglantinin kurulmasini bekle
  let stateA = '', stateB = '';
  for (let i = 0; i < 40; i++) {
    stateA = await js(winA, `[...window.app.mesh.peers.values()][0].pc.connectionState`);
    stateB = await js(winB, `[...window.app.mesh.peers.values()][0].pc.connectionState`);
    if (stateA === 'connected' && stateB === 'connected') break;
    await wait(300);
  }
  ok(stateA === 'connected', 'A tarafinda RTCPeerConnection kuruldu', stateA);
  ok(stateB === 'connected', 'B tarafinda RTCPeerConnection kuruldu', stateB);

  const sdp = await js(winA, `(() => {
    const e = [...window.app.mesh.peers.values()][0];
    const lines = e.pc.localDescription.sdp.split('\\n').filter((l) => l.startsWith('m='));
    const opus = /opus/i.test(e.pc.localDescription.sdp);
    return { mLines: lines.map((l) => l.trim().split(' ')[0]), opus };
  })()`);
  ok(sdp.mLines.length === 2 && sdp.mLines[0] === 'm=audio' && sdp.mLines[1] === 'm=video',
    'sabit m-line duzeni (audio, video)', sdp.mLines.join(', '));
  ok(sdp.opus, 'Opus codec pazarlikta yer aliyor');

  console.log('\n4) Gurultu engelleme modunu canli degistirme');
  // Chromium'un sahte mikrofonu saf 440 Hz ton uretir; RNNoise bunu dogru
  // sekilde "konusma degil" sayip bastirir. Akis olcumu icin filtreyi kapatiyoruz.
  await js(winA, `window.app.setNoiseMode('off')`);
  await js(winB, `window.app.setNoiseMode('off')`);
  await wait(1500);
  const afterSwitch = await js(winA, `(() => {
    const e = [...window.app.mesh.peers.values()][0];
    return {
      tracks: window.app.audio.outputStream.getAudioTracks().length,
      senderTrack: !!e.audioSender.track,
      live: e.audioSender.track && e.audioSender.track.readyState,
      state: e.pc.connectionState
    };
  })()`);
  ok(afterSwitch.tracks === 1 && afterSwitch.senderTrack, 'mikrofon yeniden kuruldu ve gondericiye baglandi');
  ok(afterSwitch.live === 'live', 'gonderilen parca canli', afterSwitch.live);
  ok(afterSwitch.state === 'connected', 'baglanti mikrofon degisiminde kopmadi', afterSwitch.state);

  console.log('\n5) Gercek ses akisi');
  await wait(3000);
  const flow = await js(winA, `(async () => {
    const e = [...window.app.mesh.peers.values()][0];
    await window.app.mesh.collectStats();
    const remote = window.app.audio.peers.get(e.id);

    // Chromium'un sahte mikrofonu araliklarla bip calar; anlik okuma
    // sessiz bosluga denk gelebilir. 2 saniye boyunca tepe degeri olcuyoruz.
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      const lv = window.app.audio.remoteLevels()[e.id] || 0;
      if (lv > peak) peak = lv;
      await new Promise((r) => setTimeout(r, 25));
    }
    return { stats: e.stats, attached: !!remote, peak };
  })()`);
  ok(flow.attached, 'uzak ses akisi AudioEngine e baglandi');
  ok(flow.stats.inKbps > 0, 'A veri aliyor', `${flow.stats.inKbps} kbps`);
  ok(flow.stats.outKbps > 0, 'A veri gonderiyor', `${flow.stats.outKbps} kbps`);
  ok(flow.stats.rtt != null, 'RTT olculebiliyor', `${flow.stats.rtt} ms`);
  ok(flow.peak > 0.001, 'uzak taraftan gelen seste sinyal var (tepe)', flow.peak.toFixed(4));

  console.log('\n6) Kisi basi ses seviyesi');
  const volTest = await js(winA, `(() => {
    const id = [...window.app.mesh.peers.keys()][0];
    window.app.audio.setUserVolume(id, 0);
    const muted = window.app.audio.peers.get(id).gain.gain.value;
    window.app.audio.setUserVolume(id, 1.5);
    return { id, mutedTarget: window.app.audio.getUserVolume(id) };
  })()`);
  ok(volTest.mutedTarget === 1.5, 'kisi basi ses seviyesi ayarlanabiliyor');

  console.log('\n7) Uc kisilik tam mesh');
  const winC = await makeWindow('Ceyda', '#e91e63', 'C');
  const rc = await js(winC, `(async () => {
    document.querySelector('#inpServer').value = '127.0.0.1:${PORT}';
    await window.app.connect();
    return window.app.net.status;
  })()`);
  ok(rc === 'online', 'C baglandi', rc);
  await js(winC, `window.app.setNoiseMode('off')`);
  await js(winC, `window.app.voice.join('lobi')`);

  let counts = [0, 0, 0];
  for (let i = 0; i < 40; i++) {
    counts = await Promise.all([winA, winB, winC].map((w) =>
      js(w, `[...window.app.mesh.peers.values()].filter(e => e.pc.connectionState === 'connected').length`)));
    if (counts.every((n) => n === 2)) break;
    await wait(400);
  }
  ok(counts[0] === 2, 'A iki eslesme kurdu', String(counts[0]));
  ok(counts[1] === 2, 'B iki eslesme kurdu', String(counts[1]));
  ok(counts[2] === 2, 'C iki eslesme kurdu', String(counts[2]));

  const mline3 = await js(winC, `(() => {
    const bad = [...window.app.mesh.peers.values()].filter(e =>
      (e.pc.localDescription.sdp.match(/^m=/gm) || []).length !== 2);
    return bad.length;
  })()`);
  ok(mline3 === 0, 'uc kisilikte de her baglantida 2 m-line var');

  console.log('\n8) Ekran paylasimi (replaceTrack, yeniden pazarlik olmadan)');
  // desktopCapturer test ortaminda yok; ayni kod yolunu canvas akisiyla suruyoruz
  const beforeSdp = await js(winB, `[...window.app.mesh.peers.values()][0].pc.remoteDescription.sdp.length`);
  await js(winA, `(async () => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const ctx = c.getContext('2d');
    let f = 0;
    setInterval(() => {
      f++;
      ctx.fillStyle = 'hsl(' + (f * 7 % 360) + ',70%,50%)';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif';
      ctx.fillText('kare ' + f, 40, 200);
    }, 66);
    window.__shareStream = c.captureStream(15);
    await window.app.mesh.setLocalVideoTrack(window.__shareStream.getVideoTracks()[0]);
    window.app.net.emitTo('voice:state', { screensharing: true });
    return true;
  })()`);

  // WebRTC cozunurlugu bant genisligi tahminiyle kademeli yukseltir;
  // ilk saniyelerde 640x360 yerine olcekli bir kare gelmesi normaldir.
  const videoInfo = (w) => js(w, `(async () => {
    const e = [...window.app.mesh.peers.values()].find(x => x.remoteVideo);
    if (!e) return null;
    const report = await e.pc.getStats();
    let r = null;
    report.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') r = s; });
    return r ? { w: r.frameWidth || 0, h: r.frameHeight || 0, frames: r.framesDecoded || 0, bytes: r.bytesReceived || 0 } : null;
  })()`);

  let vidB = null, vidC = null;
  for (let i = 0; i < 50; i++) {
    [vidB, vidC] = await Promise.all([videoInfo(winB), videoInfo(winC)]);
    if (vidB && vidB.frames > 10 && vidC && vidC.frames > 10) break;
    await wait(400);
  }
  const shapeOk = (v) => v && v.w >= 320 && Math.abs(v.w / v.h - 16 / 9) < 0.05 && v.frames > 10;
  ok(shapeOk(vidB), 'B ekran goruntusunu aliyor',
    vidB ? `${vidB.w}x${vidB.h}, ${vidB.frames} kare, ${vidB.bytes} bayt` : 'video yok');
  ok(shapeOk(vidC), 'C ekran goruntusunu aliyor',
    vidC ? `${vidC.w}x${vidC.h}, ${vidC.frames} kare, ${vidC.bytes} bayt` : 'video yok');

  const afterSdp = await js(winB, `[...window.app.mesh.peers.values()][0].pc.remoteDescription.sdp.length`);
  ok(beforeSdp === afterSdp, 'ekran paylasimi yeniden pazarlik tetiklemedi (SDP degismedi)');

  const stageOpen = await js(winB, `!document.querySelector('#stage').classList.contains('hidden')`);
  ok(stageOpen, 'izleyicide paylasim sahnesi acildi');

  await js(winA, `(async () => {
    await window.app.mesh.setLocalVideoTrack(null);
    window.__shareStream.getTracks().forEach(t => t.stop());
    return true;
  })()`);
  // replaceTrack(null) sonrasi alicidaki parca "mute" olayini birkac saniye sonra alir
  let stageClosed = false;
  for (let i = 0; i < 30; i++) {
    stageClosed = await js(winB, `document.querySelector('#stage').classList.contains('hidden')`);
    if (stageClosed) break;
    await wait(500);
  }
  ok(stageClosed, 'paylasim durunca sahne kapandi');

  winC.destroy();
  await wait(800);

  console.log('\n9) Ses kanalindan ayrilma');
  await js(winB, `window.app.voice.leave()`);
  await wait(1200);
  ok((await js(winA, 'window.app.mesh.peers.size')) === 0, 'A tarafinda eslesme temizlendi');
  ok((await js(winA, 'window.app.audio.peers.size')) === 0, 'uzak ses dugumleri serbest birakildi');
  ok((await js(winB, 'window.app.audio.rawStream === null')), 'B mikrofonu kapatti');

  console.log('\n10) Konsol hatalari');
  ok(errors.A.length === 0, 'A penceresinde hata yok', errors.A.join(' | ') || undefined);
  ok(errors.B.length === 0, 'B penceresinde hata yok', errors.B.join(' | ') || undefined);
  ok(errors.C.length === 0, 'C penceresinde hata yok', errors.C.join(' | ') || undefined);

  await server.stop();
  console.log(`\n${fails === 0 ? 'MESH TESTLERI GECTI' : fails + ' TEST BASARISIZ'}\n`);
  app.exit(fails ? 1 : 0);
}).catch((err) => {
  console.error('TEST COKTU:', err);
  app.exit(1);
});
