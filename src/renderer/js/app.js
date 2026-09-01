import { $, $$, el, debounce } from './util.js';
import { Net } from './net.js';
import { AudioEngine } from './audio.js';
import { MeshManager } from './rtc.js';
import { UI } from './ui.js';
import { Chat } from './chat.js';
import { Voice } from './voice.js';
import { SettingsUI } from './settings.js';
import { toast, confirmDialog } from './ui-kit.js';

class App {
  constructor() {
    this.settings = {};
    this.state = {
      self: null,
      serverName: '',
      channels: [],
      users: [],
      voice: {},
      activeChannel: null,
      muted: false,
      deafened: false
    };
    this.alwaysOnTop = false;
    this.unreadTotal = 0;

    this.net = new Net();
    this.audio = new AudioEngine();
    this.mesh = new MeshManager({ net: this.net, audio: this.audio });
  }

  /* ================================ Baslangic ============================= */

  async init() {
    document.body.dataset.platform = window.lanchat.platform;

    this.settings = await window.lanchat.getSettings();
    this.applyTheme();

    // kisi basi ses seviyelerini geri yukle
    for (const [id, v] of Object.entries(this.settings.userVolumes || {})) {
      this.audio.userVolumes.set(id, v);
    }
    this.audio.setMasterVolume(this.settings.outputVolume ?? 1);
    this.audio.updateConfig({
      noiseMode: this.settings.noiseMode,
      echoCancellation: this.settings.echoCancellation,
      autoGainControl: this.settings.autoGainControl,
      suppressionMix: this.settings.suppressionMix ?? 1,
      vadGate: this.settings.vadGate,
      vadThreshold: this.settings.vadThreshold ?? 0.6,
      inputBoost: this.settings.inputVolume ?? 1,
      inputDeviceId: this.settings.inputDeviceId
    });
    await this.audio.setOutputDevice(this.settings.outputDeviceId);

    this.mesh.setIceServers(this.buildIceServers());

    this.ui = new UI(this);
    this.chat = new Chat(this);
    this.voice = new Voice(this);
    this.settingsUI = new SettingsUI(this);

    this.bindConnectScreen();
    this.bindNet();
    this.bindMesh();
    this.bindAudio();
    this.bindShortcuts();
    this.bindMainProcess();

    const info = await window.lanchat.appInfo();
    $('#appVersionLine').textContent = `LanChat v${info.version} - ${info.platform}/${info.arch}`;

    // varsayilanlari doldur
    $('#inpName').value = this.settings.username || '';
    $('#inpColor').value = this.settings.color || '#5b8cff';
    $('#inpServer').value = this.settings.lastServer || '';
    $('#inpPort').value = this.settings.serverPort || 4545;
    this.renderRecentServers();

    if (this.settings.startServerOnLaunch) await this.startHost(true);
    this.scanNetwork();
  }

  /**
   * WebRTC ICE sunucu listesi.
   * LAN/Hamachi/Tailscale uzerinde host adaylari yeterlidir; internet uzerinden
   * baglanirken NAT arkasindaki adresi ogrenmek icin STUN sart, simetrik NAT
   * durumunda ise trafigi aktaracak bir TURN sunucusu gerekir.
   */
  buildIceServers() {
    const list = [];
    if (this.settings.iceMode !== 'lan') {
      list.push({
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302'
        ]
      });
    }
    if (this.settings.turnUrl) {
      list.push({
        urls: this.settings.turnUrl,
        username: this.settings.turnUser || undefined,
        credential: this.settings.turnPass || undefined
      });
    }
    return list;
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.settings.theme || 'midnight';
    const accent = this.settings.accent || '#5b8cff';
    document.documentElement.style.setProperty('--accent', accent);
    const rgb = accent.match(/[a-f\d]{2}/gi).map((h) => parseInt(h, 16));
    document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb.join(',')}, 0.16)`);
    document.documentElement.style.setProperty('--accent-line', `rgba(${rgb.join(',')}, 0.4)`);
  }

  async saveSettings(patch) {
    this.settings = await window.lanchat.setSettings(patch);
    if (patch && ('iceMode' in patch || 'turnUrl' in patch || 'turnUser' in patch || 'turnPass' in patch)) {
      this.mesh.setIceServers(this.buildIceServers());
    }
    return this.settings;
  }

  saveUserVolume = debounce((id, v) => {
    const map = { ...(this.settings.userVolumes || {}), [id]: v };
    this.saveSettings({ userVolumes: map });
  }, 400);

  /* ============================== Baglanti ekrani ========================== */

  bindConnectScreen() {
    $$('#connectTabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('#connectTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
        if (tab.dataset.tab === 'host') this.refreshHostStatus();
      });
    });

    $('#btnConnectSettings').addEventListener('click', () => this.settingsUI.open('about'));
    $('#btnAuto').addEventListener('click', () => this.autoConnect());
    $('#btnRescan').addEventListener('click', () => this.scanNetwork());
    $('#btnConnect').addEventListener('click', () => this.connect());

    const hostPass = $('#inpHostPassword');
    hostPass.value = this.settings.serverPassword || '';
    hostPass.addEventListener('change', () => this.saveSettings({ serverPassword: hostPass.value.trim() }));

    const autoHost = $('#chkAutoHost');
    autoHost.checked = !!this.settings.startServerOnLaunch;
    autoHost.addEventListener('change', () => this.saveSettings({ startServerOnLaunch: autoHost.checked }));
    $('#inpServer').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.connect(); });
    $('#inpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.connect(); });
    $('#btnHost').addEventListener('click', () => this.toggleHost());

    window.lanchat.onServerLog((line) => {
      const log = $('#hostLog');
      log.classList.add('show');
      log.textContent = `${log.textContent}${line}\n`.split('\n').slice(-40).join('\n');
      log.scrollTop = log.scrollHeight;
    });
  }

  /** Agi tara ve bulunan sunuculari listele */
  async scanNetwork() {
    const btn = $('#btnRescan');
    const list = $('#foundList');
    btn.classList.add('scanning');
    list.replaceChildren(el('div', { class: 'found-empty' }, 'Ag taraniyor...'));

    const servers = await window.lanchat.scanServers({ timeout: 1400 });
    this.foundServers = servers;
    btn.classList.remove('scanning');

    if (!servers.length) {
      list.replaceChildren(el('div', { class: 'found-empty' },
        'Agda calisan sunucu bulunamadi. "Otomatik bagla" dersen kendi sunucunu baslatir.'));
      return;
    }

    list.replaceChildren(...servers.map((sv) =>
      el('button', {
        class: 'found-item',
        onclick: () => {
          $('#inpServer').value = `${sv.address}:${sv.port}`;
          this.connect();
        }
      },
        el('div', { class: 'fi-mark' }),
        el('div', { class: 'fi-text' },
          el('div', { class: 'fi-name' }, sv.name || 'LanChat Sunucusu'),
          el('div', { class: 'fi-sub' }, `${sv.address}:${sv.port}`)
        ),
        el('div', { class: 'fi-tags' },
          sv.hamachi ? el('span', { class: 'pill' }, 'HAMACHI') : null,
          sv.locked ? el('span', { class: 'pill warn' }, 'SIFRELI') : null,
          sv.self ? el('span', { class: 'pill ok' }, 'SENIN') : null,
          el('span', { class: 'pill' }, `${sv.users} kisi`)
        )
      )
    ));
  }

  /**
   * Tek dugmeyle baglanma:
   *   agda sunucu varsa katil, yoksa kendi sunucunu baslatip icine gir.
   */
  async autoConnect() {
    const btn = $('#btnAuto');
    const label = btn.querySelector('.btn-label');
    const username = $('#inpName').value.trim();
    if (!username) { this.showConnectError('Once bir ad yaz.'); return; }

    $('#connectError').classList.remove('show');
    btn.classList.add('loading');

    try {
      label.textContent = 'Ag taraniyor...';
      const servers = await window.lanchat.scanServers({ timeout: 1400 });
      this.foundServers = servers;

      if (servers.length) {
        const pick = servers[0];
        $('#inpServer').value = `${pick.address}:${pick.port}`;
        btn.classList.remove('loading');
        await this.connect();
        return;
      }

      // Sunucu yok: kendi sunucumuzu baslat ve ona bagla
      label.textContent = 'Sunucu baslatiliyor...';
      const port = Number($('#inpPort').value) || this.settings.serverPort || 4545;
      const res = await window.lanchat.startServer({ port });
      if (!res.ok) {
        this.showConnectError(`Sunucu baslatilamadi: ${res.error}`);
        return;
      }
      $('#inpServer').value = `127.0.0.1:${res.port}`;
      btn.classList.remove('loading');
      await this.connect();

      const hamachi = (res.addresses || []).find((a) => a.hamachi);
      toast('Sunucu sende calisiyor',
        hamachi
          ? `Arkadaslarin ${hamachi.address}:${res.port} adresiyle katilabilir.`
          : `Arkadaslarin bu bilgisayara ${res.port} portundan baglanmali.`,
        'ok', 7000);
    } catch (err) {
      this.showConnectError(err.message);
    } finally {
      btn.classList.remove('loading');
      label.textContent = 'Otomatik bagla';
    }
  }

  renderRecentServers() {
    const list = $('#recentServers');
    const recents = this.settings.recentServers || [];
    list.replaceChildren(...recents.slice(0, 4).map((addr) =>
      el('div', {
        class: 'recent-item',
        onclick: () => { $('#inpServer').value = addr; this.connect(); }
      },
        el('span', {}, addr),
        el('button', {
          class: 'icon-btn tiny rm', 'data-icon': 'close',
          onclick: (e) => {
            e.stopPropagation();
            this.saveSettings({ recentServers: recents.filter((r) => r !== addr) })
              .then(() => this.renderRecentServers());
          }
        })
      )
    ));
  }

  async connect() {
    const btn = $('#btnConnect');
    const errNode = $('#connectError');
    const username = $('#inpName').value.trim();
    const address = $('#inpServer').value.trim();
    const color = $('#inpColor').value;

    errNode.classList.remove('show');

    if (!username) { this.showConnectError('Once bir ad yaz.'); return; }
    if (!address) { this.showConnectError('Sunucu adresini gir (ornek: 25.14.88.201:4545).'); return; }

    const password = ($('#inpPassword').value || '').trim();

    btn.classList.add('loading');
    try {
      await this.net.connect(address, { username, color, password });

      const normalized = Net.normalizeUrl(address).replace(/^https?:\/\//, '');
      const recents = [normalized, ...(this.settings.recentServers || []).filter((r) => r !== normalized)].slice(0, 6);
      await this.saveSettings({ username, color, lastServer: normalized, recentServers: recents });

      $('#connectScreen').classList.add('hidden');
      $('#app').classList.remove('hidden');
      this.ui.renderServer();
      this.ui.renderSelf();
    } catch (err) {
      this.showConnectError(err.message);
      if (err.code === 'password') {
        $('#manualBox').open = true;
        $('#inpPassword').focus();
      }
    } finally {
      btn.classList.remove('loading');
    }
  }

  showConnectError(msg) {
    const n = $('#connectError');
    n.textContent = msg;
    n.classList.add('show');
  }

  /* ------------------------------ Sunucu barindirma ------------------------ */

  async toggleHost() {
    const status = await window.lanchat.serverStatus();
    if (status.running) {
      await window.lanchat.stopServer();
      toast('Sunucu durduruldu', null, 'info');
    } else {
      await this.startHost();
    }
    this.refreshHostStatus();
  }

  async startHost(silent) {
    const port = Number($('#inpPort').value) || 4545;
    const btn = $('#btnHost');
    btn.classList.add('loading');
    const res = await window.lanchat.startServer({ port });
    btn.classList.remove('loading');

    if (!res.ok) {
      if (!silent) toast('Sunucu baslatilamadi', res.error, 'err', 6000);
      return;
    }
    await this.saveSettings({ serverPort: port });
    if (!silent) {
      const hamachi = res.addresses.find((a) => a.hamachi);
      toast('Sunucu calisiyor', hamachi
        ? `Arkadaslarin ${hamachi.address}:${port} adresiyle baglanabilir.`
        : `Port ${port} dinleniyor.`, 'ok', 6000);
    }
    this.refreshHostStatus();
  }

  async refreshHostStatus() {
    const status = await window.lanchat.serverStatus();
    const statusNode = $('#hostStatus');
    const addrNode = $('#hostAddresses');
    const btn = $('#btnHost');

    statusNode.classList.toggle('on', status.running);
    statusNode.replaceChildren(
      el('span', { class: 'dot' }),
      el('span', {}, status.running ? `Calisiyor - port ${status.port}` : 'Durduruldu')
    );
    btn.querySelector('.btn-label').textContent = status.running ? 'Sunucuyu durdur' : 'Sunucuyu baslat';
    btn.classList.toggle('danger', status.running);
    btn.classList.toggle('primary', !status.running);

    if (!status.running) { addrNode.replaceChildren(); return; }

    addrNode.replaceChildren(...status.addresses.map((a) =>
      el('div', {
        class: `addr-item${a.hamachi ? ' hamachi' : ''}`,
        onclick: () => {
          navigator.clipboard.writeText(`${a.address}:${status.port}`);
          toast('Kopyalandi', `${a.address}:${status.port}`, 'ok', 1600);
        }
      },
        el('span', {}, `${a.address}:${status.port}`),
        a.hamachi ? el('span', { class: 'tag' }, 'HAMACHI') : el('span', { class: 'nic' }, a.nic)
      )
    ));

    if (status.addresses.length) {
      addrNode.append(el('div', { class: 'hint' }, 'Adrese tikla, panoya kopyalansin. Arkadaslarina bu adresi gonder.'));
    } else {
      addrNode.append(el('div', { class: 'hint' }, 'Ag arayuzu bulunamadi. Hamachi acik mi?'));
    }
  }

  /* =============================== Ag olaylari ============================= */

  bindNet() {
    const net = this.net;

    net.on('ready', (payload) => {
      this.state.self = payload.self;
      this.state.serverName = payload.serverName;
      this.state.channels = payload.channels;
      this.state.users = payload.users;
      this.state.voice = payload.voice || {};
      this.mesh.selfId = payload.self.id;

      this.ui.renderServer();
      this.ui.renderSelf();
      this.ui.renderChannels();
      this.ui.renderMembers();

      const target = this.state.activeChannel && payload.channels.find((c) => c.id === this.state.activeChannel)
        ? this.state.activeChannel
        : (payload.channels.find((c) => c.type === 'text') || {}).id;
      if (target) this.openChannel(target);
      toast('Baglandi', `${payload.serverName} - ${payload.users.length} kisi cevrimici`, 'ok', 2600);

      // Baglanti koptuysa ayni ses kanalina geri don
      if (this.pendingVoiceRejoin) {
        const room = this.pendingVoiceRejoin;
        this.pendingVoiceRejoin = null;
        setTimeout(() => this.voice.rejoin(room), 400);
      }
    });

    net.on('status', ({ status, detail }) => {
      const map = {
        online: null,
        reconnecting: ['Baglanti koptu', 'Yeniden baglanmaya calisiliyor...', 'warn'],
        error: ['Baglanti hatasi', detail, 'err'],
        offline: null
      };
      const t = map[status];
      if (t) toast(t[0], t[1], t[2], 3200);
      if (status === 'reconnecting' && this.voice.inVoice) {
        this.voice.setPanel('connecting');
      } else if (status === 'online' && this.voice.inVoice) {
        this.voice.setPanel('connected');
      }
    });

    net.on('latency', (ms) => this.ui.setLatency(ms));

    net.on('user:join', (user) => {
      this.state.users.push(user);
      this.ui.renderMembers();
      this.chat.addSystem('join', `${user.username} sunucuya katildi`);
    });

    net.on('user:leave', ({ id, username }) => {
      this.state.users = this.state.users.filter((u) => u.id !== id);
      this.mesh.removePeer(id);
      this.ui.renderMembers();
      this.ui.renderChannels();
      this.chat.addSystem('leave', `${username} ayrildi`);
    });

    net.on('user:update', (user) => {
      const i = this.state.users.findIndex((u) => u.id === user.id);
      if (i !== -1) this.state.users[i] = user;
      if (this.state.self && user.id === this.state.self.id) {
        this.state.self = { ...this.state.self, ...user };
        this.ui.renderSelf();
      }
      this.ui.renderMembers();
      this.ui.renderChannels();
    });

    net.on('channel:list', (channels) => {
      this.state.channels = channels;
      this.ui.renderChannels();
      if (!channels.find((c) => c.id === this.state.activeChannel)) {
        const first = channels.find((c) => c.type === 'text');
        if (first) this.openChannel(first.id);
      }
    });

    net.on('chat:message', (msg) => {
      this.chat.onMessage(msg);
      const self = this.state.self;
      if (self && msg.authorId !== self.id) {
        const mentioned = new RegExp(`@${self.username}\\b`, 'i').test(msg.text || '');
        if (mentioned) {
          this.audio.beep('mention');
          window.lanchat.flash();
          toast(`${msg.author} senden bahsetti`, msg.text.slice(0, 90), 'warn', 5000);
        }
      }
    });

    net.on('chat:update', (msg) => this.chat.onUpdate(msg));
    net.on('chat:delete', (payload) => this.chat.onDelete(payload));
    net.on('chat:typing', (payload) => this.chat.onTyping(payload));

    net.on('voice:snapshot', (snapshot) => {
      this.state.voice = snapshot;
      this.ui.renderChannels();
      this.ui.renderMembers();
      this.voice.renderTiles();
    });

    net.on('voice:peerJoined', ({ id, channelId, user }) => {
      if (this.voice.channelId !== channelId) return;
      // yeni gelen bize teklif gonderecek; biz sadece bekliyoruz
      this.audio.beep('join');
      this.chat.addSystem('join', `${user.username} ses kanalina katildi`);
    });

    net.on('voice:peerLeft', ({ id, channelId }) => {
      if (this.voice.channelId !== channelId) return;
      const name = this.userName(id);
      this.mesh.removePeer(id);
      this.voice.onRemoteVideo({ peerId: id, stream: null, active: false });
      this.audio.beep('leave');
      this.chat.addSystem('leave', `${name} ses kanalindan ayrildi`);
    });

    // voice:state ve voice:stateLite yalnizca degisen alanlari tasir;
    // anlik goruntuyu yerinde guncelleyip sadece gerektiginde yeniden ciziyoruz.
    net.on('voice:state', (patch) => {
      if (this.applyVoicePatch(patch)) {
        this.voice.renderTiles();
        this.ui.renderChannels();
      }
    });

    net.on('voice:stateLite', (patch) => {
      if (this.applyVoicePatch(patch)) this.ui.renderMembers();
    });

    net.on('rtc:signal', ({ from, data }) => this.mesh.handleSignal(from, data));

    net.on('disconnected', () => {
      // Kopan baglantida socket id'leri gecersizlesir; tum eslesmeleri kapat
      if (this.voice.inVoice) this.pendingVoiceRejoin = this.voice.channelId;
      this.mesh.closeAll();
    });
  }

  bindMesh() {
    this.mesh.on('peer:video', (payload) => this.voice.onRemoteVideo(payload));
    this.mesh.on('peer:stats', () => { /* kutucuklar dongude guncelleniyor */ });
    this.mesh.on('peer:state', ({ peerId, state }) => {
      if (state === 'failed') toast('Baglanti sorunu', `${this.userName(peerId)} ile eslesme basarisiz`, 'warn');
    });
  }

  bindAudio() {
    this.audio.on('speaking', (on) => {
      this.ui.setSpeaking(on);
      this.net.emitTo('voice:state', { speaking: on });
    });
    this.audio.on('warning', (msg) => toast('Ses uyarisi', msg, 'warn', 5000));
    this.audio.on('denoise:state', ({ rnnoise, mode }) => {
      if (mode === 'rnnoise' && rnnoise) console.log('[audio] RNNoise aktif');
    });
  }

  bindMainProcess() {
    window.lanchat.onPttChange((down) => {
      this.audio.setPtt(undefined, down);
      this.ui.setSpeaking(down && !this.state.muted);
    });

    // Guncelleme bildirimi: kullaniciyi ayarlari aramaya zorlamadan,
    // dogrudan eyleme donusen bir cubuk gosteriyoruz.
    $('#updateBarClose').addEventListener('click', () => {
      $('#updateBar').classList.add('hidden');
      this._updateBarDismissed = true;
    });
    $('#updateBarAction').addEventListener('click', async () => {
      const st = await window.lanchat.updateState();
      if (st.canAutoInstall && st.status === 'ready') await window.lanchat.installUpdate();
      else await window.lanchat.openReleases();
    });

    window.lanchat.onUpdateState((st) => this.renderUpdateBar(st));
    window.lanchat.updateState().then((st) => this.renderUpdateBar(st));

    window.lanchat.onTrayAction((action) => {
      if (action === 'toggleMute') this.toggleMute();
      if (action === 'toggleDeafen') this.toggleDeafen();
    });

    window.lanchat.onWindowState(({ maximized }) => {
      $('#winMax').title = maximized ? 'Eski boyut' : 'Buyut';
    });
  }

  /** Guncelleme durumunu ustteki cubuga yansit */
  renderUpdateBar(st) {
    const bar = $('#updateBar');
    if (!bar || !st) return;

    const show = st.status === 'available' || st.status === 'downloading' || st.status === 'ready';
    if (!show) { bar.classList.add('hidden'); return; }

    // Kullanici kapattiysa, yeni bir surum gelene kadar tekrar acma
    if (this._updateBarDismissed && this._dismissedVersion === st.version) return;
    if (st.version !== this._dismissedVersion) {
      this._updateBarDismissed = false;
      this._dismissedVersion = st.version;
    }

    const action = $('#updateBarAction');
    if (st.status === 'downloading') {
      $('#updateBarMsg').textContent = `v${st.version} indiriliyor... %${st.progress || 0}`;
      action.classList.add('hidden');
    } else if (st.status === 'ready') {
      $('#updateBarMsg').textContent = `LanChat v${st.version} kuruluma hazir`;
      action.textContent = 'Kur ve yeniden baslat';
      action.classList.remove('hidden');
    } else {
      $('#updateBarMsg').textContent = `LanChat v${st.version} yayinlandi`;
      action.textContent = st.canAutoInstall ? 'Indir' : 'Indirme sayfasini ac';
      action.classList.remove('hidden');
    }
    bar.classList.remove('hidden');
  }

  /* =============================== Kisayollar ============================= */

  /** Olay bir yazi alanindan mi geliyor? (bas-konus tusu harf olabilir) */
  isTyping(e) {
    const t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.shiftKey && e.code === 'KeyM') { e.preventDefault(); this.toggleMute(); }
      else if (e.shiftKey && e.code === 'KeyD') { e.preventDefault(); this.toggleDeafen(); }
      else if (e.shiftKey && e.code === 'KeyE') { e.preventDefault(); this.voice.toggleScreenShare(); }
      else if (e.shiftKey && e.code === 'KeyH') { e.preventDefault(); this.voice.leave(); }
      else if (e.code === 'Comma') { e.preventDefault(); this.settingsUI.open(); }
      else if (e.code === 'KeyU') { e.preventDefault(); this.ui.toggleMembers(); }
    });

    // Pencere odakli push-to-talk (global kisayoldan daha hassas).
    // Mesaj yazarken tetiklenmemeli: bas-konus tusu duz bir harf olabilir.
    document.addEventListener('keyup', (e) => {
      if (!this.settings.pttEnabled) return;
      if (this.matchesPtt(e)) this.audio.setPtt(undefined, false);
    });
    document.addEventListener('keydown', (e) => {
      if (!this.settings.pttEnabled || this.isTyping(e)) return;
      if (this.matchesPtt(e)) this.audio.setPtt(undefined, true);
    });
  }

  matchesPtt(e) {
    const key = this.settings.pttKey || '';
    const parts = key.split('+');
    const main = parts[parts.length - 1];
    const want = {
      Control: parts.includes('Control'),
      Alt: parts.includes('Alt'),
      Shift: parts.includes('Shift'),
      Command: parts.includes('Command')
    };
    if (want.Control !== e.ctrlKey || want.Alt !== e.altKey ||
        want.Shift !== e.shiftKey || want.Command !== e.metaKey) return false;
    if (main === 'Space') return e.code === 'Space';
    return e.key.toUpperCase() === main.toUpperCase();
  }

  /* ============================== Ses kontrolleri ========================== */

  toggleMute() {
    this.state.muted = !this.state.muted;
    this.audio.setMuted(this.state.muted);
    this.audio.beep(this.state.muted ? 'mute' : 'unmute');
    this.pushVoiceState();
    this.ui.renderSelf();
    window.lanchat.updateTray({ muted: this.state.muted, deafened: this.state.deafened, inVoice: this.voice.inVoice });
  }

  toggleDeafen() {
    this.state.deafened = !this.state.deafened;
    this.audio.setDeafened(this.state.deafened);

    if (this.state.deafened) {
      // Kulakligi kapatirken mikrofonu da kapatiyoruz, ama onceki
      // durumu hatirla ki geri acinca kullanici sessiz kalmasin.
      this._mutedBeforeDeafen = this.state.muted;
      if (!this.state.muted) {
        this.state.muted = true;
        this.audio.setMuted(true);
      }
    } else if (this._mutedBeforeDeafen === false) {
      this.state.muted = false;
      this.audio.setMuted(false);
      this._mutedBeforeDeafen = undefined;
    }
    this.pushVoiceState();
    this.ui.renderSelf();
    window.lanchat.updateTray({ muted: this.state.muted, deafened: this.state.deafened, inVoice: this.voice.inVoice });
  }

  pushVoiceState() {
    this.net.emitTo('voice:state', {
      muted: this.state.muted,
      deafened: this.state.deafened,
      screensharing: !!this.voice.screenStream
    });
  }

  async setNoiseMode(mode) {
    await this.saveSettings({ noiseMode: mode });
    const needsRestart = this.audio.updateConfig({ noiseMode: mode });
    if (needsRestart && this.audio.micNode) await this.restartMic();
    this.voice.updateNoiseButton();
  }

  async restartMicIfNeeded(patch) {
    const needs = this.audio.updateConfig(patch);
    if (needs && this.audio.rawStream) await this.restartMic();
  }

  async restartMic() {
    try {
      const stream = await this.audio.startMic();
      await this.mesh.setLocalAudioTrack(stream.getAudioTracks()[0]);
      this.audio.setMuted(this.state.muted);
    } catch (err) {
      toast('Mikrofon yeniden baslatilamadi', err.message, 'err');
    }
  }

  async setPushToTalk(enabled) {
    await this.saveSettings({ pttEnabled: enabled });
    this.audio.setPtt(enabled, false);
    if (enabled) {
      const res = await window.lanchat.registerPtt(this.settings.pttKey);
      if (!res.ok) toast('Global kisayol atanamadi', res.error, 'warn', 5000);
    } else {
      await window.lanchat.unregisterPtt();
    }
    this.ui.renderSelf();
  }

  async setPttKey(accel) {
    await this.saveSettings({ pttKey: accel });
    if (this.settings.pttEnabled) return window.lanchat.registerPtt(accel);
    return { ok: true };
  }

  setAlwaysOnTop(v) {
    this.alwaysOnTop = v;
    window.lanchat.setAlwaysOnTop(v);
    $('#btnAlwaysOnTop').classList.toggle('active', v);
  }

  /* ================================ Yardimci ============================== */

  openChannel(channelId) {
    this.state.activeChannel = channelId;
    this.ui.renderChannels();
    this.ui.renderHeader();
    this.chat.openChannel(channelId);
    this.bumpBadge();
  }

  channelName(id) {
    const c = this.state.channels.find((x) => x.id === id);
    return c ? c.name : '-';
  }

  userName(id) {
    const u = this.state.users.find((x) => x.id === id);
    if (u) return u.username;
    for (const list of Object.values(this.state.voice)) {
      const m = list.find((x) => x.id === id);
      if (m) return m.username;
    }
    return 'Bilinmeyen';
  }

  userColor(id) {
    const u = this.state.users.find((x) => x.id === id);
    return u ? u.color : '#5b8cff';
  }

  /**
   * Sunucudan gelen kismi ses durumunu anlik goruntuye isle.
   * Yalnizca gorsel olarak onemli bir alan degistiyse true doner
   * (speaking her saniye birkac kez gelebilir; onu yerel analizor cizer).
   */
  applyVoicePatch(patch) {
    if (!patch || !patch.id) return false;
    const visualKeys = ['muted', 'deafened', 'screensharing'];
    let changed = false;

    for (const [channelId, list] of Object.entries(this.state.voice)) {
      const member = list.find((m) => m.id === patch.id);
      if (!member) continue;
      if (patch.channelId && patch.channelId !== channelId) continue;
      for (const key of visualKeys) {
        if (key in patch && member[key] !== patch[key]) {
          member[key] = patch[key];
          changed = true;
        }
      }
      if ('speaking' in patch) member.speaking = patch.speaking;
      if (patch.username) member.username = patch.username;
      if (patch.color) member.color = patch.color;
    }
    return changed;
  }

  voiceStateOf(userId) {
    for (const [channelId, list] of Object.entries(this.state.voice)) {
      const m = list.find((x) => x.id === userId);
      if (m) return { ...m, channelId };
    }
    return {};
  }

  bumpBadge() {
    let total = 0;
    for (const [id, n] of this.chat.unread) if (id !== this.state.activeChannel) total += n;
    this.unreadTotal = total;
    window.lanchat.setBadge(total);
  }

  async leaveServer() {
    await this.voice.leave(true);
    this.net.disconnect();
    this.mesh.closeAll();
    this.audio.detachAll();
    this.state.users = [];
    this.state.channels = [];
    this.state.voice = {};
    $('#app').classList.add('hidden');
    $('#connectScreen').classList.remove('hidden');
    this.renderRecentServers();
  }
}

/* --------------------------------- Baslat --------------------------------- */

const app = new App();
window.app = app;
app.init().catch((err) => {
  console.error('Baslatma hatasi:', err);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#e7ecf7">
    <h2>Uygulama baslatilamadi</h2><pre style="color:#ff9ea0">${err.stack}</pre></div>`;
});

window.addEventListener('beforeunload', () => {
  app.net.disconnect();
  app.audio.destroy();
});
