import { $, el, clamp } from './util.js';
import { modal, toast, bindRange } from './ui-kit.js';

const NOISE_CHOICES = [
  { id: 'off', title: 'Kapali', desc: 'Ham mikrofon. En dusuk gecikme, hicbir filtre yok.' },
  { id: 'browser', title: 'Standart', desc: 'WebRTC yerlesik filtresi. Hafif, sabit gurultuye iyi gelir.' },
  { id: 'rnnoise', title: 'RNNoise', desc: 'AI tabanli, Krisp tarzi. Klavye, fan ve arka plan konusmalarini keser.' }
];

const THEMES = [
  { id: 'midnight', title: 'Gece', desc: 'Koyu lacivert, goz yormaz.' },
  { id: 'daylight', title: 'Gunduz', desc: 'Aydinlik arayuz.' }
];

const ACCENTS = ['#5b8cff', '#7c3aed', '#3ba55d', '#f97316', '#e91e63', '#06b6d4', '#faa61a', '#ed4245'];

export class SettingsUI {
  constructor(app) {
    this.app = app;
    this.current = 'profile';
    this.handle = null;
    this.meterFill = null;
    this.vadChip = null;
    this._meterOff = null;
  }

  open(pane = 'profile') {
    if (this.handle) { this.select(pane); return; }
    this.current = pane;

    const nav = el('div', { class: 'settings-nav' });
    const paneNode = el('div', { class: 'settings-pane' });

    const panes = [
      ['profile', 'Profil'],
      ['audio', 'Ses ve mikrofon'],
      ['video', 'Ekran paylasimi'],
      ['network', 'Ag ve baglanti'],
      ['appearance', 'Gorunum'],
      ['keys', 'Kisayollar'],
      ['about', 'Hakkinda']
    ];

    this.navButtons = {};
    for (const [id, label] of panes) {
      const b = el('button', { onclick: () => this.select(id) }, label);
      this.navButtons[id] = b;
      nav.append(b);
    }

    this.paneNode = paneNode;
    const layout = el('div', { class: 'settings-layout' }, nav, paneNode);

    this.handle = modal({
      title: 'Ayarlar',
      wide: true,
      body: layout,
      onClose: () => {
        this.handle = null;
        if (this._meterOff) { this._meterOff(); this._meterOff = null; }
        if (this._updateOff) { this._updateOff(); this._updateOff = null; }
        this.app.audio.stopLoopbackTest();
      }
    });
    this.handle.body.style.padding = '0';
    this.select(pane);
  }

  select(id) {
    this.current = id;
    Object.entries(this.navButtons).forEach(([key, b]) => b.classList.toggle('active', key === id));
    if (this._meterOff) { this._meterOff(); this._meterOff = null; }
    if (this._updateOff) { this._updateOff(); this._updateOff = null; }
    this.app.audio.stopLoopbackTest();

    const builder = {
      profile: () => this.profilePane(),
      audio: () => this.audioPane(),
      video: () => this.videoPane(),
      network: () => this.networkPane(),
      appearance: () => this.appearancePane(),
      keys: () => this.keysPane(),
      about: () => this.aboutPane()
    }[id];

    Promise.resolve(builder()).then((node) => {
      if (this.current === id) this.paneNode.replaceChildren(node);
    });
  }

  /* -------------------------------- Profil -------------------------------- */

  profilePane() {
    const app = this.app;
    const name = el('input', { type: 'text', maxlength: 24, value: app.settings.username });
    const color = el('input', { type: 'color', value: app.settings.color });
    const status = el('select', {});
    [['online', 'Cevrimici'], ['idle', 'Bosta'], ['dnd', 'Rahatsiz etmeyin']].forEach(([v, l]) =>
      status.append(el('option', { value: v, selected: app.state.self && app.state.self.status === v }, l)));

    const apply = () => {
      const patch = { username: name.value.trim().slice(0, 24) || app.settings.username, color: color.value };
      app.saveSettings(patch);
      app.net.emitTo('user:update', { ...patch, status: status.value });
      app.ui.renderSelf();
      toast('Profil guncellendi', null, 'ok', 1800);
    };

    name.addEventListener('change', apply);
    color.addEventListener('change', apply);
    status.addEventListener('change', apply);

    return el('div', {},
      el('h3', {}, 'GORUNEN AD'),
      el('div', { class: 'field-row' }, name, color),
      el('div', { class: 'hint' }, 'Bu ad sunucudaki herkese gorunur. Renk, avatarinda ve mesajlarinda kullanilir.'),
      el('h3', {}, 'DURUM'),
      status
    );
  }

  /* --------------------------------- Ses ---------------------------------- */

  async audioPane() {
    const app = this.app;
    const s = app.settings;
    const devices = await app.audio.listDevices();

    const root = el('div', {});

    /* --- cihazlar --- */
    root.append(el('h3', {}, 'CIHAZLAR'));

    const inputSel = el('select', {});
    inputSel.append(el('option', { value: 'default' }, 'Sistem varsayilani'));
    devices.inputs.forEach((d) => inputSel.append(
      el('option', { value: d.deviceId, selected: d.deviceId === s.inputDeviceId }, d.label || 'Mikrofon')));
    inputSel.addEventListener('change', async () => {
      await app.saveSettings({ inputDeviceId: inputSel.value });
      await app.restartMicIfNeeded({ inputDeviceId: inputSel.value });
    });

    const outputSel = el('select', {});
    outputSel.append(el('option', { value: 'default' }, 'Sistem varsayilani'));
    devices.outputs.forEach((d) => outputSel.append(
      el('option', { value: d.deviceId, selected: d.deviceId === s.outputDeviceId }, d.label || 'Hoparlor')));
    outputSel.addEventListener('change', async () => {
      await app.saveSettings({ outputDeviceId: outputSel.value });
      await app.audio.setOutputDevice(outputSel.value);
    });

    root.append(
      this.row('Giris cihazi', 'Konusurken kullanilacak mikrofon', inputSel),
      this.row('Cikis cihazi', 'Diger kisilerin sesinin calinacagi cihaz', outputSel)
    );

    /* --- seviyeler --- */
    root.append(el('h3', {}, 'SEVIYELER'));

    const inVal = el('span', { class: 'val' }, `${Math.round(s.inputVolume * 100)}%`);
    const inRange = el('input', { type: 'range', min: 20, max: 300, value: Math.round(s.inputVolume * 100) });
    bindRange(inRange, (v) => {
      inVal.textContent = `${v}%`;
      app.audio.updateConfig({ inputBoost: v / 100 });
      app.saveSettings({ inputVolume: v / 100 });
    });

    const outVal = el('span', { class: 'val' }, `${Math.round(s.outputVolume * 100)}%`);
    const outRange = el('input', { type: 'range', min: 0, max: 200, value: Math.round(s.outputVolume * 100) });
    bindRange(outRange, (v) => {
      outVal.textContent = `${v}%`;
      app.audio.setMasterVolume(v / 100);
      app.saveSettings({ outputVolume: v / 100 });
    });

    root.append(
      this.rowStack('Mikrofon kazanci', 'Sesin kisik geliyorsa yukselt', inRange, inVal),
      this.rowStack('Ana ses seviyesi', 'Tum katilimcilar icin genel seviye', outRange, outVal)
    );

    /* --- gurultu engelleme --- */
    root.append(el('h3', {}, 'GURULTU ENGELLEME'));

    const grid = el('div', { class: 'choice-grid' });
    const paintChoices = () => {
      grid.querySelectorAll('.choice').forEach((c) =>
        c.classList.toggle('active', c.dataset.mode === app.settings.noiseMode));
    };
    for (const c of NOISE_CHOICES) {
      grid.append(el('button', {
        class: 'choice', dataset: { mode: c.id },
        onclick: async () => {
          await app.setNoiseMode(c.id);
          paintChoices();
          mixRow.style.display = c.id === 'rnnoise' ? '' : 'none';
        }
      },
        el('div', { class: 'ct' }, c.title),
        el('div', { class: 'cd' }, c.desc)
      ));
    }
    paintChoices();
    root.append(grid);

    const mixVal = el('span', { class: 'val' }, `${Math.round((s.suppressionMix ?? 1) * 100)}%`);
    const mixRange = el('input', { type: 'range', min: 0, max: 100, value: Math.round((s.suppressionMix ?? 1) * 100) });
    bindRange(mixRange, (v) => {
      mixVal.textContent = `${v}%`;
      app.audio.updateConfig({ suppressionMix: v / 100 });
      app.saveSettings({ suppressionMix: v / 100 });
    });
    const mixRow = this.rowStack('Filtre siddeti', 'Cok agresif gelirse dusur; ses dogalligini korur', mixRange, mixVal);
    mixRow.style.display = app.settings.noiseMode === 'rnnoise' ? '' : 'none';
    root.append(mixRow);

    root.append(
      this.row('Yanki engelleme', 'Hoparlorden cikan sesin geri donmesini onler',
        this.toggle(s.echoCancellation, async (v) => {
          await app.saveSettings({ echoCancellation: v });
          await app.restartMicIfNeeded({ echoCancellation: v });
        })),
      this.row('Otomatik seviye', 'Sesini otomatik dengeler (AGC)',
        this.toggle(s.autoGainControl, async (v) => {
          await app.saveSettings({ autoGainControl: v });
          await app.restartMicIfNeeded({ autoGainControl: v });
        }))
    );

    /* --- konusma algilama --- */
    root.append(el('h3', {}, 'KONUSMA ALGILAMA'));

    const gateOn = el('div');
    const vadVal = el('span', { class: 'val' }, `${Math.round((s.vadThreshold ?? 0.6) * 100)}%`);
    const vadRange = el('input', { type: 'range', min: 10, max: 95, value: Math.round((s.vadThreshold ?? 0.6) * 100) });
    bindRange(vadRange, (v) => {
      vadVal.textContent = `${v}%`;
      app.audio.updateConfig({ vadThreshold: v / 100 });
      app.saveSettings({ vadThreshold: v / 100 });
      if (this.threshNode) this.threshNode.style.left = `${v}%`;
    });

    gateOn.append(this.row('Sessizken sustur', 'Konusmadigin anlarda mikrofonu tamamen kapatir (gate)',
      this.toggle(s.vadGate, (v) => {
        app.audio.updateConfig({ vadGate: v });
        app.saveSettings({ vadGate: v });
        vadRow.style.display = v ? '' : 'none';
      })));
    const vadRow = this.rowStack('Esik', 'RNNoise konusma olasiligi bu degerin altindaysa susturulur', vadRange, vadVal);
    vadRow.style.display = s.vadGate ? '' : 'none';
    gateOn.append(vadRow);
    root.append(gateOn);

    /* --- push to talk --- */
    root.append(el('h3', {}, 'BAS KONUS (PUSH-TO-TALK)'));

    const keyBtn = el('button', { class: 'btn ghost small' }, s.pttKey || 'Tus ata');
    keyBtn.addEventListener('click', () => this.capturePttKey(keyBtn));
    const pttRow = el('div', { class: 'row' },
      el('div', { class: 'rl' },
        el('div', { class: 'rt' }, 'Kisayol tusu'),
        el('div', { class: 'rd' }, 'Uygulama arka planda olsa bile calisir')
      ),
      el('div', { class: 'rc' }, keyBtn)
    );
    pttRow.style.display = s.pttEnabled ? '' : 'none';

    root.append(this.row('Bas konus modu', 'Mikrofon yalnizca tusa basiliyken acilir',
      this.toggle(s.pttEnabled, async (v) => {
        await app.setPushToTalk(v);
        pttRow.style.display = v ? '' : 'none';
      })), pttRow);

    /* --- mikrofon testi --- */
    root.append(el('h3', {}, 'MIKROFON TESTI'));

    this.meterFill = el('div', { class: 'fill' });
    this.threshNode = el('div', { class: 'thresh', style: { left: `${Math.round((s.vadThreshold ?? 0.6) * 100)}%` } });
    const meter = el('div', { class: 'meter' }, this.meterFill, s.vadGate ? this.threshNode : null);
    this.vadChip = el('div', { class: 'vad-chip' }, el('span', { class: 'vd' }), el('span', {}, 'konusma yok'));

    const testBtn = el('button', { class: 'btn ghost small' }, 'Sesimi dinle');
    let testing = false;
    testBtn.addEventListener('click', async () => {
      if (!app.audio.micNode) {
        try { await app.audio.startMic(); } catch (err) { toast('Mikrofon acilamadi', err.message, 'err'); return; }
        app.mesh.setLocalAudioTrack(app.audio.outputStream.getAudioTracks()[0]);
      }
      testing = !testing;
      if (testing) { await app.audio.startLoopbackTest(); testBtn.textContent = 'Dinlemeyi durdur'; }
      else { app.audio.stopLoopbackTest(); testBtn.textContent = 'Sesimi dinle'; }
    });

    root.append(el('div', { class: 'row stack' },
      el('div', { class: 'rl' },
        el('div', { class: 'rt' }, 'Giris seviyesi'),
        el('div', { class: 'rd' }, 'Konus ve cubugun hareket ettigini gor. RNNoise acikken gurultu bastirildiktan sonraki seviye gosterilir.')
      ),
      el('div', { class: 'rc', style: { flexDirection: 'column', alignItems: 'stretch', width: '100%' } },
        meter,
        el('div', { class: 'meter-legend' },
          el('span', {}, 'sessiz'),
          el('span', {}, 'ideal'),
          el('span', {}, 'kirmizi')
        ),
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' } },
          testBtn, this.vadChip
        )
      )
    ));

    // canli metre
    if (!app.audio.micNode) {
      app.audio.startMic().then((stream) => {
        if (app.mesh) app.mesh.setLocalAudioTrack(stream.getAudioTracks()[0]);
      }).catch(() => {});
    }
    this._meterOff = app.audio.on('meter', ({ rms, vad }) => {
      if (!this.meterFill) return;
      const pct = clamp(Math.sqrt(rms) * 220, 0, 100);
      this.meterFill.style.width = `${pct}%`;
      const speaking = app.settings.noiseMode === 'rnnoise' ? vad > 0.35 : rms > 0.02;
      this.vadChip.classList.toggle('on', speaking);
      this.vadChip.lastChild.textContent = speaking
        ? `konusma (${Math.round(vad * 100)}%)`
        : 'konusma yok';
    });

    return root;
  }

  capturePttKey(btn) {
    btn.textContent = 'Bir tusa bas...';
    btn.classList.add('active');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Command');
      let key = e.key;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return;
      if (key === ' ') key = 'Space';
      else if (key.length === 1) key = key.toUpperCase();
      const accel = [...mods, key].join('+');

      document.removeEventListener('keydown', onKey, true);
      btn.classList.remove('active');
      btn.textContent = accel;

      const res = await this.app.setPttKey(accel);
      if (!res.ok) {
        toast('Kisayol atanamadi', res.error, 'err');
        btn.textContent = this.app.settings.pttKey || 'Tus ata';
      } else {
        toast('Kisayol ayarlandi', accel, 'ok', 2000);
      }
    };
    document.addEventListener('keydown', onKey, true);
  }

  /* -------------------------------- Video ---------------------------------- */

  videoPane() {
    const app = this.app;
    const sel = el('select', {});
    const presets = {
      '720p15': '720p 15fps - dusuk bant genisligi',
      '1080p30': '1080p 30fps - dengeli (onerilen)',
      '1080p60': '1080p 60fps - akici oyun',
      '1440p30': '1440p 30fps - keskin metin'
    };
    Object.entries(presets).forEach(([k, v]) =>
      sel.append(el('option', { value: k, selected: k === app.settings.screenShareQuality }, v)));
    sel.addEventListener('change', () => app.saveSettings({ screenShareQuality: sel.value }));

    return el('div', {},
      el('h3', {}, 'PAYLASIM KALITESI'),
      this.row('Cozunurluk ve kare hizi', 'Hamachi uzerinden 1080p30 cogu baglanti icin uygundur', sel),
      el('div', { class: 'hint', style: { marginTop: '10px' } },
        'Mesh yapida her izleyiciye ayri akis gonderilir. 3 kisi izliyorsa yukleme bant genisligin 3 katina cikar. ',
        'Yuklemen dusukse 720p15 sec.'),
      el('h3', {}, 'SISTEM SESI'),
      el('div', { class: 'hint' },
        'Ekran paylasiminda su an yalnizca goruntu gonderiliyor; oyun/sistem sesi ',
        'paylasilmiyor. Konusma sesi normal sekilde mikrofon uzerinden gider.')
    );
  }

  /* --------------------------------- Ag ------------------------------------ */

  networkPane() {
    const app = this.app;
    const root = el('div', {});

    root.append(el('h3', {}, 'NAT GECISI'));

    const modes = [
      { id: 'lan', title: 'Yalnizca yerel ag', desc: 'LAN, Hamachi veya Tailscale uzerinde. En hizli baglanti, disariya hicbir istek gitmez.' },
      { id: 'auto', title: 'Internet (STUN)', desc: 'Modem arkasindaki adresini ogrenmek icin STUN kullanir. Ayni agda degilseniz gerekli.' }
    ];
    const grid = el('div', { class: 'choice-grid', style: { gridTemplateColumns: 'repeat(2, 1fr)' } });
    for (const m of modes) {
      grid.append(el('button', {
        class: `choice${(app.settings.iceMode || 'auto') === m.id ? ' active' : ''}`,
        onclick: () => {
          app.saveSettings({ iceMode: m.id });
          grid.querySelectorAll('.choice').forEach((c, i) => c.classList.toggle('active', modes[i].id === m.id));
        }
      }, el('div', { class: 'ct' }, m.title), el('div', { class: 'cd' }, m.desc)));
    }
    root.append(grid);

    root.append(el('div', { class: 'hint', style: { marginTop: '12px' } },
      'STUN cogu ev baglantisinda yeterlidir. Iki taraf da "simetrik NAT" arkasindaysa ',
      '(bazi mobil ve CGNAT baglantilari) ses kurulamaz; o durumda asagiya bir TURN sunucusu girmen gerekir.'));

    root.append(el('h3', {}, 'TURN SUNUCUSU (ISTEGE BAGLI)'));

    const turnUrl = el('input', { type: 'text', placeholder: 'turn:ornek.com:3478', value: app.settings.turnUrl || '' });
    const turnUser = el('input', { type: 'text', placeholder: 'kullanici', value: app.settings.turnUser || '' });
    const turnPass = el('input', { type: 'password', placeholder: 'sifre', value: app.settings.turnPass || '' });

    const save = () => app.saveSettings({
      turnUrl: turnUrl.value.trim(),
      turnUser: turnUser.value.trim(),
      turnPass: turnPass.value
    }).then(() => toast('Ag ayarlari kaydedildi', 'Yeni baglantilarda gecerli olur.', 'ok', 2200));

    [turnUrl, turnUser, turnPass].forEach((i) => i.addEventListener('change', save));

    root.append(
      el('div', { class: 'row stack' },
        el('div', { class: 'rl' },
          el('div', { class: 'rt' }, 'Sunucu adresi'),
          el('div', { class: 'rd' }, 'Kendi coturn kurulumun veya bir TURN servisi')
        ),
        el('div', { class: 'rc', style: { width: '100%' } }, turnUrl)
      ),
      el('div', { class: 'row stack' },
        el('div', { class: 'rl' }, el('div', { class: 'rt' }, 'Kullanici adi')),
        el('div', { class: 'rc', style: { width: '100%' } }, turnUser)
      ),
      el('div', { class: 'row stack' },
        el('div', { class: 'rl' }, el('div', { class: 'rt' }, 'Sifre')),
        el('div', { class: 'rc', style: { width: '100%' } }, turnPass)
      )
    );

    root.append(el('h3', {}, 'AKTIF ICE SUNUCULARI'));
    const active = app.buildIceServers();
    root.append(active.length
      ? el('pre', {
          class: 'code-block',
          style: { userSelect: 'text', maxHeight: '140px', overflow: 'auto' }
        }, active.map((s2) => [].concat(s2.urls).join('\n')).join('\n'))
      : el('div', { class: 'hint' }, 'Hicbiri - yalnizca yerel adaylar kullanilacak.'));

    return root;
  }

  /* ------------------------------- Gorunum --------------------------------- */

  appearancePane() {
    const app = this.app;
    const root = el('div', {});

    root.append(el('h3', {}, 'TEMA'));
    const themeGrid = el('div', { class: 'choice-grid', style: { gridTemplateColumns: 'repeat(2, 1fr)' } });
    for (const t of THEMES) {
      themeGrid.append(el('button', {
        class: `choice${app.settings.theme === t.id ? ' active' : ''}`,
        onclick: () => {
          app.saveSettings({ theme: t.id });
          app.applyTheme();
          themeGrid.querySelectorAll('.choice').forEach((c, i) =>
            c.classList.toggle('active', THEMES[i].id === t.id));
        }
      }, el('div', { class: 'ct' }, t.title), el('div', { class: 'cd' }, t.desc)));
    }
    root.append(themeGrid);

    root.append(el('h3', {}, 'VURGU RENGI'));
    const swatches = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    for (const c of ACCENTS) {
      const b = el('button', {
        style: {
          width: '34px', height: '34px', borderRadius: '10px', background: c,
          border: app.settings.accent === c ? '2.5px solid var(--tx-1)' : '2.5px solid transparent',
          transition: 'transform 120ms'
        },
        onclick: () => {
          app.saveSettings({ accent: c });
          app.applyTheme();
          swatches.querySelectorAll('button').forEach((n, i) =>
            n.style.border = ACCENTS[i] === c ? '2.5px solid var(--tx-1)' : '2.5px solid transparent');
        }
      });
      swatches.append(b);
    }
    root.append(swatches);

    root.append(el('h3', {}, 'PENCERE'));
    root.append(this.row('Her zaman ustte', 'Pencere diger uygulamalarin ustunde kalir',
      this.toggle(app.alwaysOnTop, (v) => app.setAlwaysOnTop(v))));

    return root;
  }

  /* ------------------------------- Kisayollar ------------------------------ */

  keysPane() {
    const rows = [
      ['Mikrofonu ac/kapat', 'Ctrl/Cmd + Shift + M'],
      ['Kulakligi ac/kapat', 'Ctrl/Cmd + Shift + D'],
      ['Ekran paylas', 'Ctrl/Cmd + Shift + E'],
      ['Ses kanalindan ayril', 'Ctrl/Cmd + Shift + H'],
      ['Ayarlar', 'Ctrl/Cmd + ,'],
      ['Mesaj gonder', 'Enter'],
      ['Alt satir', 'Shift + Enter'],
      ['Son mesaji duzenle', 'Yukari ok'],
      ['Yanit/duzenlemeyi iptal', 'Esc'],
      ['Uye listesini gizle', 'Ctrl/Cmd + U'],
      ['Bas konus', 'Ayarlardan atanir']
    ];
    const root = el('div', {}, el('h3', {}, 'KLAVYE KISAYOLLARI'));
    for (const [label, keys] of rows) {
      root.append(el('div', { class: 'row' },
        el('div', { class: 'rl' }, el('div', { class: 'rt' }, label)),
        el('div', { class: 'rc' }, ...keys.split(' + ').map((k) => el('span', { class: 'kbd' }, k)))
      ));
    }
    return root;
  }

  /* -------------------------------- Hakkinda ------------------------------- */

  async aboutPane() {
    const info = await window.lanchat.appInfo();
    const app = this.app;
    const rnn = app.audio.rnnoiseOk;

    /* ------------------------------ Guncelleme ----------------------------- */

    const statusText = el('div', { class: 'rd' }, 'Kontrol edilmedi');
    const bar = el('div', { class: 'fill' });
    const meter = el('div', { class: 'meter hidden' }, bar);
    const checkBtn = el('button', { class: 'btn ghost small' }, 'Guncelleme ara');
    const actionBtn = el('button', { class: 'btn primary small hidden' }, 'Kur ve yeniden baslat');

    const paint = (st) => {
      const v = st.version ? ` (v${st.version})` : '';
      const map = {
        idle: 'Kontrol edilmedi',
        checking: 'Bakiliyor...',
        available: `Yeni surum var${v}`,
        downloading: `Indiriliyor... %${st.progress || 0}`,
        ready: `Kuruluma hazir${v}`,
        none: 'En guncel surumu kullaniyorsun',
        unsupported: st.error || 'Bu ortamda guncelleme yapilamaz',
        error: `Hata: ${st.error || 'bilinmeyen'}`
      };
      statusText.textContent = map[st.status] || st.status;

      meter.classList.toggle('hidden', st.status !== 'downloading');
      bar.style.width = `${st.progress || 0}%`;

      const showAction = st.status === 'ready' || (st.status === 'available' && !st.canAutoInstall);
      actionBtn.classList.toggle('hidden', !showAction);
      actionBtn.textContent = st.canAutoInstall ? 'Kur ve yeniden baslat' : 'Indirme sayfasini ac';
      checkBtn.disabled = st.status === 'checking' || st.status === 'downloading';
    };

    checkBtn.addEventListener('click', async () => {
      paint({ status: 'checking' });
      const st = await window.lanchat.checkUpdate();
      paint(st);
    });

    actionBtn.addEventListener('click', async () => {
      const st = await window.lanchat.updateState();
      if (st.canAutoInstall && st.status === 'ready') await window.lanchat.installUpdate();
      else await window.lanchat.openReleases();
    });

    if (this._updateOff) this._updateOff();
    this._updateOff = window.lanchat.onUpdateState((st) => paint(st));
    paint(await window.lanchat.updateState());

    const updateRow = el('div', { class: 'row' },
      el('div', { class: 'rl' },
        el('div', { class: 'rt' }, 'Guncellemeler'),
        statusText,
        meter
      ),
      el('div', { class: 'rc' }, checkBtn, actionBtn)
    );

    return el('div', {},
      el('h3', {}, 'GUNCELLEME'),
      updateRow,
      el('div', { class: 'hint', style: { marginTop: '10px' } },
        window.lanchat.platform === 'win32'
          ? 'Windows ta yeni surum bulunca kendiliginden iner; "Kur ve yeniden baslat" dedigin an guncellenir.'
          : 'macOS ta otomatik kurulum icin Apple Developer sertifikasi gerekiyor. Yeni surum ciktiginda haber verilir, indirme sayfasi acilir.'),

      el('h3', {}, 'SURUM'),
      el('div', { class: 'stat-grid' },
        el('div', { class: 'stat' }, el('div', { class: 'sv' }, `v${info.version}`), el('div', { class: 'sl' }, 'LANCHAT')),
        el('div', { class: 'stat' }, el('div', { class: 'sv' }, info.electron), el('div', { class: 'sl' }, 'ELECTRON')),
        el('div', { class: 'stat' }, el('div', { class: 'sv' }, info.chrome.split('.')[0]), el('div', { class: 'sl' }, 'CHROMIUM')),
        el('div', { class: 'stat' }, el('div', { class: 'sv' }, `${info.platform}/${info.arch}`), el('div', { class: 'sl' }, 'PLATFORM'))
      ),
      el('h3', {}, 'SES ISLEME'),
      el('div', { class: 'row' },
        el('div', { class: 'rl' },
          el('div', { class: 'rt' }, 'RNNoise (WASM)'),
          el('div', { class: 'rd' }, 'AudioWorklet icinde calisan yapay sinir agi tabanli gurultu bastirici')
        ),
        el('div', { class: 'rc' }, el('span', { class: `pill ${rnn ? 'ok' : 'warn'}` }, rnn ? 'yuklu' : 'beklemede'))
      ),
      el('div', { class: 'row' },
        el('div', { class: 'rl' },
          el('div', { class: 'rt' }, 'Ses motoru'),
          el('div', { class: 'rd' }, 'Opus - WebRTC varsayilani, 48 kHz mono')
        ),
        el('div', { class: 'rc' }, el('span', { class: 'pill ok' }, 'aktif'))
      ),
      el('h3', {}, 'VERI KONUMU'),
      el('div', { class: 'hint', style: { fontFamily: 'var(--mono)', userSelect: 'text' } }, info.userData)
    );
  }

  /* -------------------------------- Parcalar ------------------------------- */

  row(title, desc, control) {
    return el('div', { class: 'row' },
      el('div', { class: 'rl' },
        el('div', { class: 'rt' }, title),
        desc ? el('div', { class: 'rd' }, desc) : null
      ),
      el('div', { class: 'rc' }, control)
    );
  }

  rowStack(title, desc, control, valueNode) {
    return el('div', { class: 'row stack' },
      el('div', { class: 'rl', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        el('div', {},
          el('div', { class: 'rt' }, title),
          desc ? el('div', { class: 'rd' }, desc) : null
        ),
        valueNode || null
      ),
      el('div', { class: 'rc' }, control)
    );
  }

  toggle(checked, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch' }, input, el('span', { class: 'track' }), el('span', { class: 'thumb' }));
  }
}
