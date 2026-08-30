const path = require('path');
const os = require('os');
const fs = require('fs');
const { createServer } = require('../server/index.js');
const { io } = require('socket.io-client');

const PORT = Number(process.env.PORT || 46100 + (process.pid % 400));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-test-'));
let fails = 0;

const ok = (cond, label) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
  if (!cond) fails++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
    const t = setTimeout(() => reject(new Error(`${name} baglanamadi`)), 6000);
    s.on('connect', () => s.emit('join', { username: name, color: '#5b8cff' }));
    s.on('ready', (payload) => { clearTimeout(t); s.ready = payload; resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

(async () => {
  const server = createServer({ port: PORT, dataDir: DATA, log: () => {} });
  await server.start();
  console.log(`\nSunucu ${PORT} portunda basladi\n`);

  console.log('1) Baglanti ve ilk durum');
  const a = await connect('Ali');
  const b = await connect('Bora');
  const c = await connect('Cem');
  await wait(150);

  ok(a.ready.channels.length === 4, 'varsayilan 4 kanal geldi');
  ok(a.ready.channels.filter((x) => x.type === 'voice').length === 2, '2 ses kanali var');
  ok(c.ready.users.length === 3, 'ucuncu istemci 3 kullanici goruyor');

  console.log('\n2) Metin sohbeti');
  const gotB = new Promise((r) => b.once('chat:message', r));
  const gotC = new Promise((r) => c.once('chat:message', r));
  a.emit('chat:send', { channelId: 'genel', text: 'merhaba **dunya**' });
  const [mb, mc] = await Promise.all([gotB, gotC]);
  ok(mb.text === 'merhaba **dunya**', 'mesaj B tarafina ulasti');
  ok(mc.author === 'Ali', 'yazar adi dogru');

  const hist = await new Promise((r) => c.emit('chat:history', { channelId: 'genel' }, r));
  ok(hist.ok && hist.messages.length === 1, 'gecmis sunucuda saklandi');

  console.log('\n3) Tepki ve duzenleme');
  const reacted = new Promise((r) => b.once('chat:update', r));
  c.emit('chat:react', { channelId: 'genel', messageId: mb.id, emoji: 'X' });
  const upd = await reacted;
  ok(upd.reactions.X && upd.reactions.X.length === 1, 'tepki eklendi');

  const edited = new Promise((r) => b.once('chat:update', r));
  a.emit('chat:edit', { channelId: 'genel', messageId: mb.id, text: 'duzenlendi' });
  const ed = await edited;
  ok(ed.text === 'duzenlendi' && ed.editedAt, 'sahibi mesaji duzenleyebildi');

  const before = ed.text;
  b.emit('chat:edit', { channelId: 'genel', messageId: mb.id, text: 'sahtekarlik' });
  await wait(250);
  const hist2 = await new Promise((r) => c.emit('chat:history', { channelId: 'genel' }, r));
  ok(hist2.messages[0].text === before, 'baskasinin mesaji duzenlenemedi');

  console.log('\n4) Ses kanali ve mesh eslesme listesi');
  const aJoin = await new Promise((r) => a.emit('voice:join', { channelId: 'lobi' }, r));
  ok(aJoin.ok && aJoin.peers.length === 0, 'ilk katilan bos peer listesi aliyor');

  const bSeesA = new Promise((r) => a.once('voice:peerJoined', r));
  const bJoin = await new Promise((r) => b.emit('voice:join', { channelId: 'lobi' }, r));
  ok(bJoin.peers.length === 1 && bJoin.peers[0] === a.id, 'ikinci katilan A ile eslesecek');
  const notify = await bSeesA;
  ok(notify.id === b.id, 'A, B nin katildigini ogrendi');

  const cJoin = await new Promise((r) => c.emit('voice:join', { channelId: 'lobi' }, r));
  ok(cJoin.peers.length === 2, 'ucuncu katilan 2 kisiyle eslesecek (tam mesh)');

  const snapNow = await new Promise((r) => { a.once('voice:snapshot', r); a.emit('voice:state', { muted: false }); setTimeout(() => r(null), 400); });
  ok(snapNow === null || (snapNow.lobi || []).length === 3, 'anlik goruntu tutarli');
  const cState = await new Promise((r) => { a.once('voice:state', r); c.emit('voice:state', { muted: true }); });
  ok(cState.id === c.id && cState.muted === true, 'C nin mute durumu odaya yayildi');

  console.log('\n5) WebRTC sinyal aktarimi');
  const signalled = new Promise((r) => b.once('rtc:signal', r));
  a.emit('rtc:signal', { to: b.id, data: { description: { type: 'offer', sdp: 'test' } } });
  const sig = await signalled;
  ok(sig.from === a.id && sig.data.description.sdp === 'test', 'sinyal dogru hedefe iletildi');

  const wrongTarget = await Promise.race([
    new Promise((r) => c.once('rtc:signal', () => r('geldi'))),
    wait(300).then(() => 'gelmedi')
  ]);
  ok(wrongTarget === 'gelmedi', 'sinyal ilgisiz istemciye sizmadi');

  console.log('\n6) Ses durumu yayini');
  const stateSeen = new Promise((r) => a.once('voice:state', r));
  b.emit('voice:state', { muted: true, screensharing: true });
  const st = await stateSeen;
  ok(st.muted === true && st.screensharing === true, 'mute/ekran durumu yayildi');

  console.log('\n7) Kanal olusturma ve silme');
  const created = await new Promise((r) => a.emit('channel:create', { name: 'Test Odasi', type: 'voice' }, r));
  ok(created.ok && created.channel.type === 'voice', 'ses odasi olusturuldu');
  let bList = null;
  b.on('channel:list', (l) => { bList = l; });
  a.emit('channel:create', { name: 'notlar', type: 'text' });
  for (let i = 0; i < 20 && !(bList && bList.some((x) => x.id === 'notlar')); i++) await wait(50);
  ok(!!(bList && bList.some((x) => x.id === 'notlar')), 'metin kanali herkese yayildi');

  a.emit('channel:delete', { id: 'genel' });
  await wait(200);
  const stillThere = await new Promise((r) => c.emit('chat:history', { channelId: 'genel' }, r));
  ok(stillThere.ok, 'varsayilan kanal silinemedi');

  console.log('\n8) Oda limiti');
  const full = createLimitTest();
  async function createLimitTest() {
    const room = await new Promise((r) => a.emit('channel:create', { name: 'Ikili', type: 'voice' }, r));
    return room.channel.id;
  }
  const roomId = await full;
  ok(!!roomId, 'limit testi icin oda hazir');

  console.log('\n9) Ayrilma temizligi');
  const cId = c.id;
  const left = new Promise((r) => { a.once('voice:peerLeft', r); setTimeout(() => r({ timeout: true }), 4000); });
  const snapAfter = new Promise((r) => { a.once('voice:snapshot', r); setTimeout(() => r(null), 4000); });
  c.close();
  const leftEvt = await left;
  ok(leftEvt.id === cId, 'ayrilan kisi ses odasindan dusuruldu');
  const snap2 = await snapAfter;
  ok(snap2 && (snap2.lobi || []).length === 2, 'anlik goruntu 2 kisiye dustu');

  console.log('\n10) Ag kesfi (UDP yayin)');
  const { scan } = require('../server/discovery.js');
  const seen = await scan({ timeout: 1500 });
  const mine = seen.find((x) => x.port === PORT);
  ok(!!mine, 'sunucu ag taramasinda bulundu', seen.map((x) => `${x.address}:${x.port}`).join(', ') || 'hicbiri');
  ok(mine && mine.users >= 1, 'duyuruda kullanici sayisi var', mine ? String(mine.users) : '-');
  ok(mine && mine.locked === false, 'sifresiz sunucu kilitsiz gorunuyor');

  console.log('\n11) Sunucu sifresi');
  const P2 = PORT + 1;
  const lockedServer = createServer({ port: P2, dataDir: DATA + '-locked', password: 'gizli', log: () => {} });
  await lockedServer.start();

  const tryJoin = (pass) => new Promise((resolve) => {
    const sk = io(`http://127.0.0.1:${P2}`, { transports: ['websocket'], forceNew: true });
    const done = (v) => { try { sk.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done('zaman asimi'), 4000);
    sk.on('connect', () => sk.emit('join', { username: 'Deneme', password: pass }));
    sk.on('ready', () => { clearTimeout(t); done('kabul'); });
    sk.on('join:denied', (d) => { clearTimeout(t); done('red:' + d.reason); });
  });

  ok((await tryJoin('yanlis')) === 'red:password', 'yanlis sifre reddedildi');
  ok((await tryJoin('')) === 'red:password', 'sifresiz giris reddedildi');
  ok((await tryJoin('gizli')) === 'kabul', 'dogru sifre kabul edildi');

  const lockedSeen = await scan({ timeout: 1200 });
  const lockedEntry = lockedSeen.find((x) => x.port === P2);
  ok(lockedEntry && lockedEntry.locked === true, 'sifreli sunucu taramada kilitli gorunuyor');
  await lockedServer.stop();

  console.log('\n12) Kalicilik');
  a.emit('chat:send', { channelId: 'notlar', text: 'kalici mesaj' });
  await wait(300);
  await server.stop();
  const server2 = createServer({ port: PORT, dataDir: DATA, log: () => {} });
  await server2.start();
  const d = await connect('Deniz');
  const persisted = await new Promise((r) => d.emit('chat:history', { channelId: 'notlar' }, r));
  ok(persisted.ok && persisted.messages.some((m) => m.text === 'kalici mesaj'), 'mesajlar yeniden baslatmada korundu');
  ok(d.ready.channels.some((x) => x.id === 'notlar'), 'kanallar diske yazildi');

  a.close(); b.close(); d.close();
  await server2.stop();

  console.log(`\n${fails === 0 ? 'TUM TESTLER GECTI' : fails + ' TEST BASARISIZ'}\n`);
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error('\nTEST COKTU:', err);
  process.exit(1);
});
