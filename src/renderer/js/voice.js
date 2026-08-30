import { $, el, formatDuration } from './util.js';
import { avatarNode, contextMenu, modal, toast, confirmDialog } from './ui-kit.js';

const QUALITY_PRESETS = {
  '720p15':  { width: 1280, height: 720,  fps: 15, bitrate: 1_200_000, label: '720p 15fps - dusuk bant genisligi' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 2_500_000, label: '1080p 30fps - dengeli' },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 4_000_000, label: '1080p 60fps - akici oyun' },
  '1440p30': { width: 2560, height: 1440, fps: 30, bitrate: 5_000_000, label: '1440p 30fps - keskin metin' }
};

export class Voice {
  constructor(app) {
    this.app = app;
    this.channelId = null;
    this.joinedAt = 0;
    this.screenStream = null;
    this.remoteVideos = new Map();  // peerId -> stream
    this.activeShare = null;        // odakta olan peerId ("self" olabilir)
    this.levelTimer = null;
    this.durationTimer = null;

    this.stage = $('#stage');
    this.stageGrid = $('#stageGrid');
    this.voiceStage = $('#voiceStage');
    this.panel = $('#voicePanel');

    this.bind();
  }

  bind() {
    $('#btnLeaveVoice').addEventListener('click', () => this.leave());
    $('#btnShareScreen').addEventListener('click', () => this.toggleScreenShare());
    $('#btnNoiseToggle').addEventListener('click', () => this.cycleNoiseMode());
    $('#btnVoiceStats').addEventListener('click', () => this.showStats());
    $('#railStats').addEventListener('click', () => this.showStats());

    $('#btnStageClose').addEventListener('click', () => this.closeStage());
    $('#btnStageFit').addEventListener('click', () => {
      this.stageGrid.querySelectorAll('.share-frame').forEach((f) => f.classList.toggle('fit'));
    });
    $('#btnStagePopout').addEventListener('click', () => this.popoutShare());
  }

  get inVoice() {
    return !!this.channelId;
  }

  /* ------------------------------ Katil / ayril ---------------------------- */

  async join(channelId) {
    if (this.channelId === channelId) return;
    const app = this.app;

    if (this.channelId) await this.leave(true);

    this.setPanel('connecting', channelId);

    try {
      const perm = await window.lanchat.micPermission();
      if (perm.status === 'denied') {
        toast('Mikrofon izni yok', 'Sistem Ayarlari > Gizlilik bolumunden LanChat icin mikrofon iznini ac.', 'err', 8000);
        window.lanchat.openSystemPrefs('microphone');
        this.setPanel(null);
        return;
      }

      // Mikrofon acilamazsa kanali tamamen kaybetme: dinleyici olarak katil
      let stream = null;
      try {
        stream = await app.audio.startMic();
      } catch (err) {
        const listenOnly = await confirmDialog({
          title: 'Mikrofon acilamadi',
          message: `${err.message}\n\nYine de sadece dinlemek icin katilmak ister misin? ` +
                   'Ekran paylasimi ve digerlerini duymak calisir, sadece konusamazsin.',
          confirmText: 'Dinleyici olarak katil'
        });
        if (!listenOnly) { this.setPanel(null); return; }
        this.listenOnly = true;
      }

      if (stream) {
        this.listenOnly = false;
        await app.mesh.setLocalAudioTrack(stream.getAudioTracks()[0]);
      } else {
        await app.mesh.setLocalAudioTrack(null);
      }

      const res = await app.net.request('voice:join', { channelId });
      if (!res.ok) {
        toast('Katilamadi', res.error || 'Bilinmeyen hata', 'err');
        app.audio.stopMic();
        this.setPanel(null);
        return;
      }

      if (stream) {
        app.audio.setMuted(app.state.muted);
        app.audio.setPtt(app.settings.pttEnabled, false);
      }

      this.channelId = channelId;
      this.joinedAt = Date.now();

      // Odada bulunanlara biz teklif goturuyoruz
      for (const peerId of res.peers || []) app.mesh.createPeer(peerId, true);

      app.mesh.startStats(2000);
      this.startLevelLoop();
      this.setPanel('connected', channelId);
      app.audio.beep('join');
      app.pushVoiceState();
      app.ui.renderChannels();
      this.renderTiles();
      app.chat.addSystem('join', `Ses kanalina katildin: ${app.channelName(channelId)}`);
    } catch (err) {
      console.error(err);
      toast('Mikrofon acilamadi', err.message, 'err', 6000);
      this.setPanel(null);
    }
  }

  /** Baglanti koptuktan sonra ayni odaya sessizce geri don */
  async rejoin(channelId) {
    this.channelId = null;
    await this.join(channelId);
  }

  async leave(silent) {
    if (!this.channelId) return;
    const app = this.app;
    const wasChannel = this.channelId;

    await this.stopScreenShare(true);
    app.net.emitTo('voice:leave');
    app.mesh.closeAll();
    app.audio.stopMic();
    app.audio.detachAll();

    this.channelId = null;
    this.listenOnly = false;
    this.remoteVideos.clear();
    this.activeShare = null;
    this.stopLevelLoop();
    this.setPanel(null);
    this.closeStage();
    this.voiceStage.classList.add('hidden');
    this.voiceStage.replaceChildren();

    app.ui.renderChannels();
    if (!silent) {
      app.audio.beep('leave');
      app.chat.addSystem('leave', `Ses kanalindan ayrildin: ${app.channelName(wasChannel)}`);
    }
  }

  /* ------------------------------ Panel durumu ----------------------------- */

  setPanel(state, channelId) {
    clearInterval(this.durationTimer);
    if (!state) {
      this.panel.classList.add('hidden');
      return;
    }
    this.panel.classList.remove('hidden', 'connecting', 'bad');
    if (state === 'connecting') this.panel.classList.add('connecting');

    $('#vpState').textContent = state === 'connecting'
      ? 'Baglaniyor...'
      : (this.listenOnly ? 'Dinleyici olarak bagli' : 'Ses baglandi');
    $('#vpRoom').textContent = this.app.channelName(channelId || this.channelId);

    if (state === 'connected') {
      const tick = () => {
        const s = (Date.now() - this.joinedAt) / 1000;
        const label = this.listenOnly ? 'Dinleyici' : 'Ses baglandi';
        $('#vpState').textContent = `${label} - ${formatDuration(s)}`;
      };
      tick();
      this.durationTimer = setInterval(tick, 1000);
    }
    this.updateNoiseButton();
  }

  updateNoiseButton() {
    const btn = $('#btnNoiseToggle');
    const mode = this.app.settings.noiseMode;
    const labels = { off: 'Kapali', browser: 'Standart', rnnoise: 'RNNoise' };
    btn.querySelector('span').textContent = labels[mode] || 'Gurultu';
    btn.classList.toggle('on', mode !== 'off');
    btn.title = {
      off: 'Gurultu engelleme kapali',
      browser: 'WebRTC yerlesik gurultu engelleme',
      rnnoise: 'RNNoise (AI tabanli) - Krisp tarzi agresif filtreleme'
    }[mode];
  }

  async cycleNoiseMode() {
    const order = ['rnnoise', 'browser', 'off'];
    const cur = this.app.settings.noiseMode;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    await this.app.setNoiseMode(next);
    this.updateNoiseButton();
    toast('Gurultu engelleme', {
      rnnoise: 'RNNoise acik - AI tabanli, klavye ve fan sesini keser.',
      browser: 'WebRTC standart filtresi acik.',
      off: 'Filtreleme kapali - ham mikrofon.'
    }[next], 'ok', 2600);
  }

  /* ------------------------------- Kutucuklar ------------------------------ */

  renderTiles() {
    const app = this.app;
    if (!this.channelId) {
      this.voiceStage.classList.add('hidden');
      return;
    }
    const members = (app.state.voice[this.channelId] || []);
    this.voiceStage.classList.remove('hidden');

    const tiles = members.map((m) => {
      const isSelf = app.state.self && m.id === app.state.self.id;
      const stats = isSelf ? null : app.mesh.getStats(m.id);

      const av = avatarNode({ username: m.username, color: m.color }, 56);
      const tile = el('div', {
        class: 'vtile',
        dataset: { peer: m.id },
        onclick: () => { if (m.screensharing) this.focusShare(isSelf ? 'self' : m.id); },
        oncontextmenu: (e) => { e.preventDefault(); this.userMenu(m, e.clientX, e.clientY); }
      },
        av,
        el('div', { class: 'vt-name' }, m.username + (isSelf ? ' (sen)' : ''))
      );

      const badges = el('div', { class: 'vt-badges' });
      if (m.muted) badges.append(el('span', { 'data-icon': 'mic-off', title: 'Mikrofon kapali' }));
      if (m.deafened) badges.append(el('span', { 'data-icon': 'headset-off', title: 'Ses kapali' }));
      if (m.screensharing) badges.append(el('span', { class: 'live', 'data-icon': 'screen', title: 'Ekran paylasiyor' }));
      if (badges.children.length) tile.append(badges);

      if (stats && stats.rtt != null) {
        tile.append(el('div', { class: `vt-net ${stats.quality}` }, `${stats.rtt}ms`));
      }

      if (!isSelf) {
        const vol = Math.round(app.audio.getUserVolume(m.id) * 100);
        const slider = el('input', {
          type: 'range', min: 0, max: 200, value: vol,
          oninput: (e) => {
            app.audio.setUserVolume(m.id, Number(e.target.value) / 100);
            app.saveUserVolume(m.id, Number(e.target.value) / 100);
            e.target.style.setProperty('--pct', `${Number(e.target.value) / 2}%`);
          }
        });
        slider.style.setProperty('--pct', `${vol / 2}%`);
        const volWrap = el('div', { class: 'vt-vol', onclick: (e) => e.stopPropagation() }, slider);
        tile.append(volWrap);
      }

      return tile;
    });

    this.voiceStage.replaceChildren(...tiles);
    this.paintSpeaking();
  }

  paintSpeaking() {
    const app = this.app;
    const self = app.state.self;
    const levels = app.audio.remoteLevels();

    this.voiceStage.querySelectorAll('.vtile').forEach((tile) => {
      const id = tile.dataset.peer;
      const isSelf = self && id === self.id;
      const speaking = isSelf ? app.audio.speaking : (levels[id] || 0) > 0.045;
      tile.classList.toggle('speaking', !!speaking);
      const av = tile.querySelector('.avatar');
      if (av) av.classList.toggle('speaking', !!speaking);
    });

    // kenar cubugundaki isimler
    document.querySelectorAll('#voiceChannels .vm').forEach((row) => {
      const id = row.dataset.peer;
      const isSelf = self && id === self.id;
      const speaking = isSelf ? app.audio.speaking : (levels[id] || 0) > 0.045;
      row.classList.toggle('speaking', !!speaking);
      const av = row.querySelector('.avatar');
      if (av) av.classList.toggle('speaking', !!speaking);
    });
  }

  startLevelLoop() {
    this.stopLevelLoop();
    const loop = () => {
      this.paintSpeaking();
      this.levelTimer = requestAnimationFrame(loop);
    };
    this.levelTimer = requestAnimationFrame(loop);
  }

  stopLevelLoop() {
    if (this.levelTimer) cancelAnimationFrame(this.levelTimer);
    this.levelTimer = null;
  }

  userMenu(member, x, y) {
    const app = this.app;
    const isSelf = app.state.self && member.id === app.state.self.id;
    if (isSelf) {
      contextMenu(x, y, [
        { type: 'label', text: member.username },
        { text: app.state.muted ? 'Mikrofonu ac' : 'Mikrofonu kapat', icon: 'mic', onClick: () => app.toggleMute() },
        { text: 'Mikrofon ayarlari', icon: 'gear', onClick: () => app.settingsUI.open('audio') }
      ]);
      return;
    }
    contextMenu(x, y, [
      { type: 'label', text: member.username },
      {
        type: 'slider',
        text: 'Ses seviyesi',
        value: Math.round(app.audio.getUserVolume(member.id) * 100),
        min: 0, max: 200,
        format: (v) => `${v}%`,
        onInput: (v) => { app.audio.setUserVolume(member.id, v / 100); app.saveUserVolume(member.id, v / 100); }
      },
      {
        text: app.audio.getUserVolume(member.id) === 0 ? 'Sesi ac' : 'Bu kisiyi sustur',
        icon: 'volume',
        onClick: () => {
          const next = app.audio.getUserVolume(member.id) === 0 ? 1 : 0;
          app.audio.setUserVolume(member.id, next);
          app.saveUserVolume(member.id, next);
          this.renderTiles();
        }
      },
      { type: 'sep' },
      { text: 'Baglanti durumu', icon: 'pulse', onClick: () => this.showStats(member.id) }
    ]);
  }

  /* ----------------------------- Ekran paylasimi --------------------------- */

  async toggleScreenShare() {
    if (this.screenStream) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  async startScreenShare() {
    if (!this.inVoice) {
      toast('Once ses kanalina katil', 'Ekran paylasimi ses baglantisi uzerinden gonderilir.', 'warn');
      return;
    }

    const perm = await window.lanchat.screenPermission();
    if (perm.status !== 'granted' && window.lanchat.platform === 'darwin') {
      const go = await confirmDialog({
        title: 'Ekran kaydi izni gerekli',
        message: 'macOS ekran paylasimi icin izin istiyor. Sistem Ayarlari acilsin mi? Izni verdikten sonra uygulamayi yeniden baslatman gerekebilir.',
        confirmText: 'Ayarlari ac'
      });
      if (go) window.lanchat.openSystemPrefs('screen');
      return;
    }

    const source = await this.pickSource();
    if (!source) return;

    const preset = QUALITY_PRESETS[this.app.settings.screenShareQuality] || QUALITY_PRESETS['1080p30'];
    const videoConstraint = {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps }
    };
    const wantSystemAudio = window.lanchat.platform === 'win32'
      && this.app.settings.shareSystemAudio !== false;

    /** Bir kez dene: sistem sesiyle veya sessiz */
    const grab = async (withAudio) => {
      await window.lanchat.selectScreenSource(source.id, { audio: withAudio });
      return navigator.mediaDevices.getDisplayMedia({ video: videoConstraint, audio: withAudio });
    };

    let stream = null;
    let audioDropped = false;
    try {
      stream = await grab(wantSystemAudio);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        await window.lanchat.selectScreenSource(null);
        return;
      }
      if (wantSystemAudio) {
        // Bazi Windows ses surucilerinde loopback acilamaz; goruntuyle devam et
        console.warn('[ekran] sistem sesiyle acilamadi, sessiz deneniyor:', err.name, err.message);
        try {
          stream = await grab(false);
          audioDropped = true;
          // Bu makinede loopback calismiyor; bir daha deneyip beklemeyelim
          this.app.saveSettings({ shareSystemAudio: false });
        } catch (err2) {
          await window.lanchat.selectScreenSource(null);
          toast('Ekran paylasilamadi', `${err2.name}: ${err2.message}`, 'err', 7000);
          return;
        }
      } else {
        await window.lanchat.selectScreenSource(null);
        toast('Ekran paylasilamadi', `${err.name}: ${err.message}`, 'err', 7000);
        return;
      }
    }

    try {
      this.screenStream = stream;
      const track = stream.getVideoTracks()[0];
      track.contentHint = preset.fps >= 60 ? 'motion' : 'detail';
      track.addEventListener('ended', () => this.stopScreenShare());

      this.app.mesh.setVideoQuality({
        maxBitrate: preset.bitrate,
        maxFramerate: preset.fps,
        preferMotion: preset.fps >= 30
      });
      await this.app.mesh.setLocalVideoTrack(track);

      this.app.net.emitTo('voice:state', { screensharing: true });
      $('#btnShareScreen').classList.add('live');
      this.focusShare('self');

      toast('Ekran paylasiliyor',
        `${source.name} - ${preset.label}` + (audioDropped ? ' (sistem sesi alinamadi)' : ''),
        'ok');
    } catch (err) {
      console.error(err);
      toast('Ekran paylasilamadi', err.message, 'err');
      await this.stopScreenShare(true);
    }
  }

  async stopScreenShare(silent) {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    await this.app.mesh.setLocalVideoTrack(null);
    this.app.net.emitTo('voice:state', { screensharing: false });
    $('#btnShareScreen').classList.remove('live');
    if (this.activeShare === 'self') this.closeStage();
    this.renderStage();
    if (!silent) toast('Ekran paylasimi durdu', null, 'info', 2000);
  }

  async pickSource() {
    const sources = await window.lanchat.getScreenSources();
    if (!sources.length) {
      toast('Kaynak bulunamadi', 'Ekran kaydi izni verilmemis olabilir.', 'err');
      return null;
    }

    return new Promise((resolve) => {
      let selected = null;
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };

      const screens = sources.filter((s) => s.kind === 'screen');
      const windows = sources.filter((s) => s.kind === 'window');

      const makeGrid = (list) => {
        const grid = el('div', { class: 'source-grid' });
        for (const s of list) {
          const card = el('button', {
            class: 'source',
            onclick: () => {
              grid.parentElement.querySelectorAll('.source').forEach((n) => n.classList.remove('active'));
              card.classList.add('active');
              selected = s;
              confirmBtn.disabled = false;
            },
            ondblclick: () => finish(s)
          },
            el('div', { class: 'thumb' }, s.thumbnail ? el('img', { src: s.thumbnail, alt: '' }) : el('span', {}, '-')),
            el('div', { class: 'meta' },
              s.appIcon ? el('img', { src: s.appIcon, alt: '' }) : null,
              el('span', {}, s.name)
            )
          );
          grid.append(card);
        }
        return grid;
      };

      const qualitySelect = el('select', {
        onchange: (e) => this.app.saveSettings({ screenShareQuality: e.target.value })
      });
      for (const [key, p] of Object.entries(QUALITY_PRESETS)) {
        qualitySelect.append(el('option', {
          value: key,
          selected: key === this.app.settings.screenShareQuality
        }, p.label));
      }

      const body = el('div', {});
      if (screens.length) {
        body.append(el('h3', { style: { fontSize: '11.5px', fontWeight: 700, color: 'var(--tx-3)', margin: '0 0 10px', letterSpacing: '0.05em' } }, 'EKRANLAR'));
        body.append(makeGrid(screens));
      }
      if (windows.length) {
        body.append(el('h3', { style: { fontSize: '11.5px', fontWeight: 700, color: 'var(--tx-3)', margin: '20px 0 10px', letterSpacing: '0.05em' } }, 'PENCERELER'));
        body.append(makeGrid(windows));
      }

      const confirmBtn = el('button', { class: 'btn primary', disabled: true, onclick: () => finish(selected) }, 'Paylas');

      const m = modal({
        title: 'Ekran paylas',
        subtitle: 'Paylasmak istedigin ekrani veya pencereyi sec',
        wide: true,
        body,
        footer: [
          el('div', { style: { marginRight: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
            el('span', { style: { fontSize: '12px', color: 'var(--tx-3)' } }, 'Kalite'),
            qualitySelect
          ),
          el('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Vazgec'),
          confirmBtn
        ],
        onClose: () => finish(null)
      });
      qualitySelect.style.width = '230px';
      qualitySelect.style.height = '32px';
    });
  }

  /* --------------------------------- Sahne --------------------------------- */

  onRemoteVideo({ peerId, stream, active }) {
    if (active && stream) {
      this.remoteVideos.set(peerId, stream);
      if (!this.activeShare) this.focusShare(peerId);
      else this.renderStage();
      const name = this.app.userName(peerId);
      toast('Ekran paylasimi', `${name} ekranini paylasiyor`, 'info', 3500);
    } else {
      this.remoteVideos.delete(peerId);
      if (this.activeShare === peerId) {
        const next = [...this.remoteVideos.keys()][0] || (this.screenStream ? 'self' : null);
        this.activeShare = next;
      }
      this.renderStage();
    }
    this.renderTiles();
  }

  focusShare(peerId) {
    this.activeShare = peerId;
    this.renderStage();
  }

  renderStage() {
    const id = this.activeShare;
    if (!id) { this.closeStage(); return; }

    const stream = id === 'self' ? this.screenStream : this.remoteVideos.get(id);
    if (!stream) { this.closeStage(); return; }

    const name = id === 'self' ? 'Senin ekranin' : `${this.app.userName(id)} - ekran`;
    const video = el('video', { autoplay: true, playsinline: true, muted: id === 'self' });
    video.srcObject = stream;
    video.play().catch(() => {});

    const statsNode = el('div', { class: 'sf-stats' }, '');
    const frame = el('div', { class: 'share-frame' },
      video,
      el('div', { class: 'sf-label' }, el('span', { class: 'live-dot' }), el('span', {}, name)),
      statsNode
    );
    frame.addEventListener('dblclick', () => this.stage.classList.toggle('full'));

    this.stageGrid.replaceChildren(frame);
    this.stage.classList.remove('hidden');
    $('#stageLabel').textContent = name;

    // kalite bilgisi
    clearInterval(this._stageStatsTimer);
    this._stageStatsTimer = setInterval(() => {
      if (id === 'self') {
        const s = this.screenStream && this.screenStream.getVideoTracks()[0];
        const st = s ? s.getSettings() : {};
        statsNode.textContent = st.width ? `${st.width}x${st.height} @${Math.round(st.frameRate || 0)}` : '';
      } else {
        const st = this.app.mesh.getStats(id);
        if (st && st.videoIn) statsNode.textContent = `${st.videoIn.w}x${st.videoIn.h} @${st.videoIn.fps} - ${st.inKbps}kbps`;
      }
    }, 1000);
  }

  closeStage() {
    clearInterval(this._stageStatsTimer);
    this.stage.classList.add('hidden');
    this.stage.classList.remove('full');
    this.stageGrid.replaceChildren();
    this.activeShare = null;
  }

  popoutShare() {
    const video = this.stageGrid.querySelector('video');
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else {
      video.requestPictureInPicture().catch((err) => toast('Ayri pencere acilamadi', err.message, 'err'));
    }
  }

  /* ------------------------------ Durum ekrani ----------------------------- */

  showStats(focusPeer) {
    const app = this.app;
    const body = el('div', {});

    const render = () => {
      const rows = [];
      rows.push(el('div', { class: 'stat-grid' },
        el('div', { class: 'stat' },
          el('div', { class: 'sv' }, app.net.latency != null ? `${app.net.latency}` : '--'),
          el('div', { class: 'sl' }, 'SUNUCU ms')
        ),
        el('div', { class: 'stat' },
          el('div', { class: 'sv' }, String(app.mesh.peers.size)),
          el('div', { class: 'sl' }, 'ESLESME')
        ),
        el('div', { class: 'stat' },
          el('div', { class: 'sv' }, app.audio.rnnoiseOk && app.settings.noiseMode === 'rnnoise' ? 'ON' : 'OFF'),
          el('div', { class: 'sl' }, 'RNNOISE')
        ),
        el('div', { class: 'stat' },
          el('div', { class: 'sv' }, this.inVoice ? formatDuration((Date.now() - this.joinedAt) / 1000) : '--'),
          el('div', { class: 'sl' }, 'SURE')
        )
      ));

      const list = el('div', { style: { marginTop: '18px' } });
      if (!app.mesh.peers.size) {
        list.append(el('p', { style: { fontSize: '13px', color: 'var(--tx-4)' } }, 'Henuz eslesme yok.'));
      }
      for (const [peerId, entry] of app.mesh.peers) {
        const s = entry.stats || {};
        const q = s.quality || 'unknown';
        list.append(el('div', { class: 'peer-row' },
          avatarNode({ username: app.userName(peerId), color: app.userColor(peerId) }, 26),
          el('span', { class: 'pn' }, app.userName(peerId)),
          el('span', { class: `pill ${q === 'good' ? 'ok' : q === 'ok' ? 'warn' : q === 'bad' ? 'err' : ''}` },
            entry.pc.connectionState),
          el('span', { class: 'ps' },
            `${s.rtt != null ? s.rtt + 'ms' : '--'} | kayip ${s.loss ?? 0}% | ${s.inKbps || 0}/${s.outKbps || 0} kbps`)
        ));
      }
      rows.push(list);
      body.replaceChildren(...rows);
    };

    render();
    const timer = setInterval(render, 1200);

    const closeBtn = el('button', { class: 'btn ghost' }, 'Kapat');
    const handle = modal({
      title: 'Baglanti durumu',
      subtitle: 'Mesh baglantilarinin anlik olcumleri',
      body,
      footer: [closeBtn],
      onClose: () => clearInterval(timer)
    });
    closeBtn.addEventListener('click', () => handle.close());
    if (focusPeer) body.scrollIntoView({ block: 'nearest' });
  }
}

export { QUALITY_PRESETS };
