import { $, $$, el } from './util.js';
import { avatarNode, contextMenu, promptDialog, confirmDialog, toast } from './ui-kit.js';

export class UI {
  constructor(app) {
    this.app = app;
    this.membersVisible = true;
    this.bind();
  }

  bind() {
    const app = this.app;

    $('#btnAddText').addEventListener('click', () => this.createChannel('text'));
    $('#btnAddVoice').addEventListener('click', () => this.createChannel('voice'));
    $('#btnSettings').addEventListener('click', () => app.settingsUI.open());
    $('#railSettings').addEventListener('click', () => app.settingsUI.open());
    $('#railMic').addEventListener('click', () => app.settingsUI.open('audio'));
    $('#btnMute').addEventListener('click', () => app.toggleMute());
    $('#btnDeafen').addEventListener('click', () => app.toggleDeafen());
    $('#ubInfo').addEventListener('click', () => app.settingsUI.open('profile'));
    $('#btnToggleMembers').addEventListener('click', () => this.toggleMembers());

    $('#btnLeaveServer').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Sunucudan ayril',
        message: 'Baglantiyi kesip giris ekranina donmek istiyor musun?',
        confirmText: 'Ayril',
        danger: true
      });
      if (ok) app.leaveServer();
    });

    // pencere kontrolleri
    $('#winMin').addEventListener('click', () => window.lanchat.minimize());
    $('#winMax').addEventListener('click', () => window.lanchat.maximize());
    $('#winClose').addEventListener('click', () => window.lanchat.close());
    $('#btnAlwaysOnTop').addEventListener('click', () => app.setAlwaysOnTop(!app.alwaysOnTop));
  }

  /* ------------------------------- Kanallar -------------------------------- */

  async createChannel(type) {
    const name = await promptDialog({
      title: type === 'voice' ? 'Ses odasi olustur' : 'Metin kanali olustur',
      label: type === 'voice' ? 'Oda adi' : 'Kanal adi',
      placeholder: type === 'voice' ? 'Oyun Odasi' : 'yeni-kanal'
    });
    if (!name) return;
    const res = await this.app.net.request('channel:create', { name, type });
    if (res.ok && type === 'text') this.app.openChannel(res.channel.id);
  }

  renderChannels() {
    const app = this.app;
    const textList = $('#textChannels');
    const voiceList = $('#voiceChannels');

    /* --- metin --- */
    textList.replaceChildren(...app.state.channels
      .filter((c) => c.type === 'text')
      .map((c) => {
        const unread = app.chat.unread.get(c.id) || 0;
        const active = app.state.activeChannel === c.id;
        const node = el('li', {
          class: `chan${active ? ' active' : ''}${unread ? ' dot' : ''}`,
          onclick: () => app.openChannel(c.id),
          oncontextmenu: (e) => { e.preventDefault(); this.channelMenu(c, e.clientX, e.clientY); }
        },
          el('span', { class: 'glyph' }, '#'),
          el('span', { class: 'name' }, c.name),
          unread && !active ? el('span', { class: 'unread' }, String(unread)) : null
        );
        return node;
      }));

    /* --- ses --- */
    const voiceNodes = [];
    for (const c of app.state.channels.filter((x) => x.type === 'voice')) {
      const members = app.state.voice[c.id] || [];
      const inHere = app.voice.channelId === c.id;

      voiceNodes.push(el('li', {
        class: `chan${inHere ? ' active' : ''}`,
        onclick: () => app.voice.join(c.id),
        oncontextmenu: (e) => { e.preventDefault(); this.channelMenu(c, e.clientX, e.clientY); }
      },
        el('span', { class: 'glyph voice-glyph', 'data-icon': 'volume' }),
        el('span', { class: 'name' }, c.name),
        members.length ? el('span', { class: 'count' }, `${members.length}/${c.limit || 8}`) : null
      ));

      if (members.length) {
        const wrap = el('ul', { class: 'voice-members' });
        for (const m of members) {
          const isSelf = app.state.self && m.id === app.state.self.id;
          const badges = el('span', { class: 'badges' });
          if (m.muted) badges.append(el('span', { 'data-icon': 'mic-off', title: 'Mikrofon kapali' }));
          if (m.deafened) badges.append(el('span', { 'data-icon': 'headset-off', title: 'Ses kapali' }));
          if (m.screensharing) badges.append(el('span', { 'data-icon': 'screen', title: 'Ekran paylasiyor' }));

          wrap.append(el('li', {
            class: 'vm',
            dataset: { peer: m.id },
            onclick: (e) => {
              e.stopPropagation();
              if (m.screensharing && !isSelf) app.voice.focusShare(m.id);
            },
            oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); app.voice.userMenu(m, e.clientX, e.clientY); }
          },
            avatarNode({ username: m.username, color: m.color }, 20),
            el('span', { class: 'vname' }, m.username + (isSelf ? ' (sen)' : '')),
            badges
          ));
        }
        voiceNodes.push(wrap);
      }
    }
    voiceList.replaceChildren(...voiceNodes);
  }

  channelMenu(channel, x, y) {
    const app = this.app;
    const isDefault = ['genel', 'oyun', 'lobi', 'oyun-odasi'].includes(channel.id);
    contextMenu(x, y, [
      { type: 'label', text: channel.name },
      channel.type === 'voice'
        ? { text: 'Kanala katil', icon: 'volume', onClick: () => app.voice.join(channel.id) }
        : { text: 'Kanali ac', icon: 'reply', onClick: () => app.openChannel(channel.id) },
      { text: 'Kanal adini kopyala', icon: 'copy', onClick: () => navigator.clipboard.writeText(channel.name) },
      isDefault ? null : { type: 'sep' },
      isDefault ? null : {
        text: 'Kanali sil', icon: 'trash', danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Kanali sil',
            message: `"${channel.name}" kanali ve icindeki tum mesajlar silinecek. Emin misin?`,
            confirmText: 'Sil', danger: true
          });
          if (ok) app.net.emitTo('channel:delete', { id: channel.id });
        }
      }
    ]);
  }

  /* -------------------------------- Uyeler --------------------------------- */

  renderMembers() {
    const app = this.app;
    const list = $('#memberList');
    const users = [...app.state.users].sort((a, b) => {
      const av = app.voiceStateOf(a.id);
      const bv = app.voiceStateOf(b.id);
      if (!!av.channelId !== !!bv.channelId) return av.channelId ? -1 : 1;
      return a.username.localeCompare(b.username, 'tr');
    });

    $('#onlineHead').textContent = `CEVRIMICI - ${users.length}`;

    list.replaceChildren(...users.map((u) => {
      const isSelf = app.state.self && u.id === app.state.self.id;
      const vs = app.voiceStateOf(u.id);
      const av = avatarNode(u, 32);
      av.append(el('span', { class: `status-dot ${u.status || 'online'}` }));

      const badges = el('div', { class: 'mbadges' });
      if (vs.screensharing) badges.append(el('span', { class: 'live', 'data-icon': 'screen', title: 'Ekran paylasiyor' }));
      if (vs.muted) badges.append(el('span', { class: 'muted', 'data-icon': 'mic-off' }));
      if (vs.deafened) badges.append(el('span', { class: 'muted', 'data-icon': 'headset-off' }));

      return el('li', {
        class: `member${isSelf ? ' self' : ''}`,
        onclick: (e) => this.showUserMenu(u.id, e),
        oncontextmenu: (e) => { e.preventDefault(); this.showUserMenu(u.id, e); }
      },
        av,
        el('div', { class: 'mtext' },
          el('div', { class: 'mname', style: { color: u.color } }, u.username + (isSelf ? ' (sen)' : '')),
          vs.channelId ? el('div', { class: 'msub' }, app.channelName(vs.channelId)) : null
        ),
        badges
      );
    }));
  }

  showUserMenu(userId, e) {
    const app = this.app;
    const user = app.state.users.find((u) => u.id === userId);
    if (!user) return;
    const isSelf = app.state.self && userId === app.state.self.id;
    const x = e.clientX ?? 200;
    const y = e.clientY ?? 200;

    if (isSelf) {
      contextMenu(x, y, [
        { type: 'label', text: user.username },
        { text: 'Profili duzenle', icon: 'edit', onClick: () => app.settingsUI.open('profile') },
        { text: 'Ses ayarlari', icon: 'gear', onClick: () => app.settingsUI.open('audio') }
      ]);
      return;
    }

    const vs = app.voiceStateOf(userId);
    contextMenu(x, y, [
      { type: 'label', text: user.username },
      {
        type: 'slider',
        text: 'Ses seviyesi',
        value: Math.round(app.audio.getUserVolume(userId) * 100),
        min: 0, max: 200,
        format: (v) => `${v}%`,
        onInput: (v) => { app.audio.setUserVolume(userId, v / 100); app.saveUserVolume(userId, v / 100); }
      },
      {
        text: 'Bahset (@)', icon: 'reply',
        onClick: () => {
          app.chat.inputNode.focus();
          document.execCommand('insertText', false, `@${user.username} `);
        }
      },
      vs.screensharing ? { text: 'Ekranini izle', icon: 'screen', onClick: () => app.voice.focusShare(userId) } : null,
      { type: 'sep' },
      { text: 'Kullanici ID kopyala', icon: 'copy', onClick: () => navigator.clipboard.writeText(userId) }
    ]);
  }

  toggleMembers() {
    this.membersVisible = !this.membersVisible;
    $('#app').classList.toggle('no-members', !this.membersVisible);
    $('#btnToggleMembers').classList.toggle('active', this.membersVisible);
  }

  /* ------------------------------ Kendi durumu ----------------------------- */

  renderSelf() {
    const app = this.app;
    const self = app.state.self;
    if (!self) return;

    const avatar = $('#ubAvatar');
    avatar.style.background = self.color;
    avatar.querySelector('span').textContent = self.username.slice(0, 2).toUpperCase();

    $('#ubName').textContent = self.username;

    const parts = [];
    if (app.state.muted) parts.push('mikrofon kapali');
    if (app.state.deafened) parts.push('ses kapali');
    if (app.settings.pttEnabled) parts.push(`bas-konus: ${app.settings.pttKey}`);
    $('#ubSub').textContent = parts.length ? parts.join(' - ') : 'cevrimici';

    const micBtn = $('#btnMute');
    micBtn.setAttribute('data-icon', app.state.muted ? 'mic-off' : 'mic');
    micBtn.classList.toggle('on', app.state.muted);

    const deafBtn = $('#btnDeafen');
    deafBtn.setAttribute('data-icon', app.state.deafened ? 'headset-off' : 'headset');
    deafBtn.classList.toggle('on', app.state.deafened);
  }

  setSpeaking(on) {
    $('#ubAvatar').classList.toggle('speaking', on);
  }

  /* -------------------------------- Baslik --------------------------------- */

  renderHeader() {
    const app = this.app;
    const ch = app.state.channels.find((c) => c.id === app.state.activeChannel);
    $('#chName').textContent = ch ? ch.name : '-';
    $('#chHash').textContent = '#';
    $('#chTopic').textContent = ch && ch.topic ? ch.topic : '';
    $('#tbSub').textContent = ch ? `#${ch.name}` : '';
  }

  renderServer() {
    const app = this.app;
    $('#serverName').textContent = app.state.serverName || 'Sunucu';
    $('#serverAddr').textContent = (app.net.url || '').replace(/^https?:\/\//, '');
  }

  setLatency(ms) {
    const pill = $('#connPill');
    $('#connPing').textContent = ms == null ? '--' : `${ms}ms`;
    pill.classList.remove('good', 'ok', 'bad');
    if (ms == null) return;
    pill.classList.add(ms < 60 ? 'good' : ms < 160 ? 'ok' : 'bad');
  }
}
