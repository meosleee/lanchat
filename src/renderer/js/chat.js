import { $, el, formatTime, formatDay, formatBytes, renderMarkdown, isOnlyEmoji, debounce, throttle } from './util.js';
import { avatarNode, contextMenu, lightbox, toast, QUICK_REACTIONS, emojiPicker } from './ui-kit.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTACH = 6 * 1024 * 1024;

export class Chat {
  constructor(app) {
    this.app = app;
    this.listNode = $('#messages');
    this.inputNode = $('#inpMessage');
    this.typingNode = $('#typingRow');
    this.replyBar = $('#replyBar');
    this.attachBar = $('#attachBar');

    this.channelId = null;
    this.messages = [];
    this.systemLog = [];       // {kind, text, ts} - yerel, sunucuda saklanmaz
    this.replyTo = null;
    this.editing = null;
    this.attachment = null;
    this.searchTerm = '';
    this.typingUsers = new Map();
    this.unread = new Map();
    this.atBottom = true;

    this.bindComposer();
    this.bindList();

    setInterval(() => this.pruneTyping(), 1000);
  }

  /* ------------------------------- Kanal ------------------------------- */

  async openChannel(channelId) {
    this.channelId = channelId;
    this.unread.set(channelId, 0);
    this.listNode.replaceChildren(el('div', { class: 'empty-state' }, el('div', { class: 'es-mark' }, '...')));

    const res = await this.app.net.request('chat:history', { channelId });
    if (this.channelId !== channelId) return;
    this.messages = res.ok ? res.messages : [];
    this.render();
    this.scrollToBottom(true);
    this.inputNode.focus();
  }

  addSystem(kind, text) {
    this.systemLog.push({ kind, text, ts: new Date().toISOString(), channelId: this.channelId });
    if (this.systemLog.length > 60) this.systemLog.shift();
    this.render();
  }

  onMessage(msg) {
    if (msg.channelId !== this.channelId) {
      this.unread.set(msg.channelId, (this.unread.get(msg.channelId) || 0) + 1);
      this.app.ui.renderChannels();
      this.app.bumpBadge();
      return;
    }
    this.messages.push(msg);
    const wasBottom = this.atBottom;
    this.render();
    if (wasBottom) this.scrollToBottom();
  }

  onUpdate(msg) {
    const i = this.messages.findIndex((m) => m.id === msg.id);
    if (i === -1) return;
    this.messages[i] = msg;
    this.render();
  }

  onDelete({ channelId, messageId }) {
    if (channelId !== this.channelId) return;
    this.messages = this.messages.filter((m) => m.id !== messageId);
    this.render();
  }

  /* ------------------------------- Cizim -------------------------------- */

  render() {
    const term = this.searchTerm.trim().toLowerCase();
    const items = [];

    const msgs = term
      ? this.messages.filter((m) =>
          (m.text || '').toLowerCase().includes(term) || (m.author || '').toLowerCase().includes(term))
      : this.messages;

    const sys = term ? [] : this.systemLog.filter((s) => s.channelId === this.channelId);
    const merged = [...msgs.map((m) => ({ kind: 'msg', ts: m.ts, data: m })),
                    ...sys.map((s) => ({ kind: 'sys', ts: s.ts, data: s }))]
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    if (!merged.length) {
      this.listNode.replaceChildren(this.emptyState(term));
      return;
    }

    let lastDay = null;
    let prev = null;

    for (const item of merged) {
      const day = new Date(item.ts).toDateString();
      if (day !== lastDay) {
        items.push(el('div', { class: 'day-sep' }, formatDay(item.ts)));
        lastDay = day;
        prev = null;
      }

      if (item.kind === 'sys') {
        items.push(el('div', { class: `sys-msg ${item.data.kind}` },
          el('span', { class: 'sdot' }),
          el('span', {}, item.data.text),
          el('span', { class: 'msg-time' }, formatTime(item.ts))
        ));
        prev = null;
        continue;
      }

      const m = item.data;
      const grouped = prev &&
        prev.authorId === m.authorId &&
        new Date(m.ts) - new Date(prev.ts) < GROUP_WINDOW_MS &&
        !m.replyTo;

      items.push(this.messageNode(m, grouped));
      prev = m;
    }

    this.listNode.replaceChildren(...items);
  }

  emptyState(term) {
    if (term) {
      return el('div', { class: 'empty-state' },
        el('div', { class: 'es-mark' }, '?'),
        el('h3', {}, 'Sonuc yok'),
        el('p', {}, `"${term}" icin mesaj bulunamadi.`)
      );
    }
    const ch = this.app.state.channels.find((c) => c.id === this.channelId);
    return el('div', { class: 'empty-state' },
      el('div', { class: 'es-mark' }, '#'),
      el('h3', {}, `${ch ? ch.name : 'Kanal'} kanalinin baslangici`),
      el('p', {}, 'Ilk mesaji sen yaz. Markdown destekleniyor: **kalin**, `kod`, ```blok```, ||spoiler||')
    );
  }

  messageNode(m, grouped) {
    const self = this.app.state.self;
    const mentioned = self && new RegExp(`@${self.username}\\b`, 'i').test(m.text || '');
    const emojiOnly = !m.attachment && isOnlyEmoji(m.text || '');

    const node = el('div', {
      class: [
        'msg',
        grouped ? 'grouped' : 'first',
        mentioned ? 'mention' : '',
        emojiOnly ? 'emoji-only' : '',
        m.pending ? 'pending' : ''
      ].filter(Boolean).join(' '),
      dataset: { id: m.id }
    });

    // sol sutun
    if (grouped) {
      node.append(el('div', { class: 'msg-time-hover' }, formatTime(m.ts)));
      node.append(el('div', { class: 'msg-avatar' }));
    } else {
      const av = avatarNode({ username: m.author, color: m.color });
      av.addEventListener('click', (e) => this.app.ui.showUserMenu(m.authorId, e));
      node.append(el('div', { class: 'msg-avatar' }, av));
    }

    const body = el('div', { class: 'msg-body' });

    // yanit basligi
    if (m.replyTo) {
      const target = this.messages.find((x) => x.id === m.replyTo);
      body.append(el('div', {
        class: 'msg-reply',
        onclick: () => this.jumpTo(m.replyTo)
      },
        el('span', { class: 'ra', style: { color: target ? target.color : 'var(--tx-3)' } },
          target ? target.author : 'silinmis mesaj'),
        el('span', {}, target ? (target.text || 'ek').slice(0, 90) : '')
      ));
    }

    if (!grouped) {
      body.append(el('div', { class: 'msg-head' },
        el('span', {
          class: 'msg-author',
          style: { color: m.color || 'var(--tx-1)' },
          onclick: (e) => this.app.ui.showUserMenu(m.authorId, e)
        }, m.author),
        el('span', { class: 'msg-time' }, formatTime(m.ts)),
        m.editedAt ? el('span', { class: 'msg-edited' }, '(duzenlendi)') : null
      ));
    }

    if (m.text) {
      const text = el('div', { class: 'msg-text' });
      text.innerHTML = renderMarkdown(m.text);
      text.querySelectorAll('[data-spoiler]').forEach((s) =>
        s.addEventListener('click', () => s.classList.add('revealed')));
      text.querySelectorAll('a').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.lanchat.openExternal(a.href);
        }));
      if (grouped && m.editedAt) text.append(el('span', { class: 'msg-edited' }, ' (duzenlendi)'));
      body.append(text);
    }

    if (m.attachment) body.append(this.attachmentNode(m.attachment));

    // tepkiler
    const reactionKeys = Object.keys(m.reactions || {});
    if (reactionKeys.length) {
      const wrap = el('div', { class: 'reactions' });
      for (const key of reactionKeys) {
        const users = m.reactions[key] || [];
        const mine = self && users.includes(self.id);
        wrap.append(el('button', {
          class: `reaction${mine ? ' mine' : ''}`,
          title: users.map((id) => this.app.userName(id)).join(', '),
          onclick: () => this.app.net.emitTo('chat:react', { channelId: m.channelId, messageId: m.id, emoji: key })
        }, el('span', {}, key), el('span', { class: 'rc' }, String(users.length))));
      }
      body.append(wrap);
    }

    node.append(body);
    node.append(this.toolsNode(m));

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.messageMenu(m, e.clientX, e.clientY);
    });

    return node;
  }

  toolsNode(m) {
    const self = this.app.state.self;
    const tools = el('div', { class: 'msg-tools' });

    QUICK_REACTIONS.slice(0, 3).forEach((emoji) => {
      tools.append(el('button', {
        class: 'icon-btn',
        title: `${emoji} ekle`,
        onclick: () => this.app.net.emitTo('chat:react', { channelId: m.channelId, messageId: m.id, emoji })
      }, el('span', { style: { fontSize: '15px' } }, emoji)));
    });

    tools.append(el('button', {
      class: 'icon-btn', 'data-icon': 'smile', title: 'Tepki sec',
      onclick: (e) => emojiPicker(e.currentTarget.getBoundingClientRect(),
        (emoji) => this.app.net.emitTo('chat:react', { channelId: m.channelId, messageId: m.id, emoji }))
    }));

    tools.append(el('button', {
      class: 'icon-btn', 'data-icon': 'reply', title: 'Yanitla',
      onclick: () => this.startReply(m)
    }));

    if (self && m.authorId === self.id) {
      tools.append(el('button', {
        class: 'icon-btn', 'data-icon': 'edit', title: 'Duzenle',
        onclick: () => this.startEdit(m)
      }));
      tools.append(el('button', {
        class: 'icon-btn danger', 'data-icon': 'trash', title: 'Sil',
        onclick: () => this.app.net.emitTo('chat:delete', { channelId: m.channelId, messageId: m.id })
      }));
    }
    return tools;
  }

  attachmentNode(att) {
    const wrap = el('div', { class: 'msg-attach' });
    const src = `data:${att.type};base64,${att.data}`;

    if (att.type.startsWith('image/')) {
      const img = el('img', { src, alt: att.name, loading: 'lazy' });
      img.addEventListener('click', () => lightbox(src, 'image'));
      wrap.append(img);
    } else if (att.type.startsWith('video/')) {
      wrap.append(el('video', { src, controls: true }));
    } else if (att.type.startsWith('audio/')) {
      wrap.append(el('audio', { src, controls: true, style: { width: '320px' } }));
    } else {
      wrap.append(el('div', {
        class: 'file-chip',
        onclick: () => this.downloadAttachment(att)
      },
        el('div', { style: { fontSize: '22px' } }, '#'),
        el('div', {},
          el('div', { class: 'fname' }, att.name),
          el('div', { class: 'fsize' }, formatBytes(att.size))
        )
      ));
    }
    return wrap;
  }

  downloadAttachment(att) {
    const a = document.createElement('a');
    a.href = `data:${att.type};base64,${att.data}`;
    a.download = att.name;
    a.click();
  }

  messageMenu(m, x, y) {
    const self = this.app.state.self;
    contextMenu(x, y, [
      { text: 'Yanitla', icon: 'reply', onClick: () => this.startReply(m) },
      { text: 'Metni kopyala', icon: 'copy', onClick: () => navigator.clipboard.writeText(m.text || '') },
      self && m.authorId === self.id ? { type: 'sep' } : null,
      self && m.authorId === self.id ? { text: 'Duzenle', icon: 'edit', onClick: () => this.startEdit(m) } : null,
      self && m.authorId === self.id
        ? { text: 'Sil', icon: 'trash', danger: true, onClick: () => this.app.net.emitTo('chat:delete', { channelId: m.channelId, messageId: m.id }) }
        : null
    ]);
  }

  jumpTo(id) {
    const node = this.listNode.querySelector(`[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.style.transition = 'background 900ms';
    node.style.background = 'var(--accent-soft)';
    setTimeout(() => { node.style.background = ''; }, 900);
  }

  /* ----------------------------- Yazi alani ----------------------------- */

  bindList() {
    this.listNode.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.listNode;
      this.atBottom = scrollHeight - scrollTop - clientHeight < 60;
    });
  }

  bindComposer() {
    const input = this.inputNode;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
        return;
      }
      if (e.key === 'Escape') {
        if (this.editing) this.cancelEdit();
        else if (this.replyTo) this.cancelReply();
        return;
      }
      if (e.key === 'ArrowUp' && !input.textContent.trim() && !this.editing) {
        const self = this.app.state.self;
        const mine = [...this.messages].reverse().find((m) => self && m.authorId === self.id);
        if (mine) { e.preventDefault(); this.startEdit(mine); }
      }
    });

    const notifyTyping = throttle(() => {
      if (this.channelId) this.app.net.emitTo('chat:typing', { channelId: this.channelId });
    }, 1500);

    input.addEventListener('input', () => {
      if (input.textContent.trim()) notifyTyping();
    });

    // duz metin yapistir + gorsel yapistir
    input.addEventListener('paste', async (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const fileItem = items.find((i) => i.kind === 'file');
      if (fileItem) {
        e.preventDefault();
        const file = fileItem.getAsFile();
        if (file) await this.setAttachment(file);
        return;
      }
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    $('#btnSend').addEventListener('click', () => this.send());
    $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
    $('#btnCancelReply').addEventListener('click', () => this.cancelReply());
    $('#btnEmoji').addEventListener('click', (e) => {
      emojiPicker(e.currentTarget.getBoundingClientRect(), (emoji) => {
        input.focus();
        document.execCommand('insertText', false, emoji);
      });
    });

    $('#fileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await this.setAttachment(file);
      e.target.value = '';
    });

    // surukle birak
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) =>
      document.addEventListener(ev, stop, false));
    document.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) await this.setAttachment(file);
    });

    $('#inpSearch').addEventListener('input', debounce((e) => {
      this.searchTerm = e.target.value;
      this.render();
    }, 220));
  }

  async setAttachment(file) {
    if (file.size > MAX_ATTACH) {
      toast('Dosya cok buyuk', `${formatBytes(file.size)} - en fazla 6 MB gonderilebilir.`, 'err');
      return;
    }
    const data = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.readAsDataURL(file);
    });
    this.attachment = { name: file.name, type: file.type || 'application/octet-stream', data, size: file.size };
    this.renderAttachBar();
    this.inputNode.focus();
  }

  renderAttachBar() {
    if (!this.attachment) {
      this.attachBar.classList.add('hidden');
      this.attachBar.replaceChildren();
      return;
    }
    const a = this.attachment;
    const chip = el('div', { class: 'attach-chip' });
    if (a.type.startsWith('image/')) chip.append(el('img', { src: `data:${a.type};base64,${a.data}` }));
    chip.append(el('div', {},
      el('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, a.name),
      el('div', { style: { fontSize: '11px', color: 'var(--tx-4)' } }, formatBytes(a.size))
    ));
    this.attachBar.replaceChildren(
      chip,
      el('button', {
        class: 'icon-btn tiny', 'data-icon': 'close',
        onclick: () => { this.attachment = null; this.renderAttachBar(); }
      })
    );
    this.attachBar.classList.remove('hidden');
  }

  startReply(m) {
    this.cancelEdit();
    this.replyTo = m;
    $('#replyText').textContent = `${m.author} kisisine yanit: ${(m.text || 'ek').slice(0, 60)}`;
    this.replyBar.classList.remove('hidden');
    this.inputNode.focus();
  }

  cancelReply() {
    this.replyTo = null;
    this.replyBar.classList.add('hidden');
  }

  startEdit(m) {
    this.cancelReply();
    this.editing = m;
    this.inputNode.textContent = m.text || '';
    this.inputNode.dataset.placeholder = 'Duzenle... (Esc iptal)';
    this.inputNode.focus();
    const range = document.createRange();
    range.selectNodeContents(this.inputNode);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.inputNode.textContent = '';
    this.inputNode.dataset.placeholder = 'Mesaj yaz...';
  }

  send() {
    const text = this.inputNode.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (this.editing) {
      if (text && text !== this.editing.text) {
        this.app.net.emitTo('chat:edit', { channelId: this.channelId, messageId: this.editing.id, text });
      }
      this.cancelEdit();
      return;
    }

    if (!text && !this.attachment) return;

    this.app.net.emitTo('chat:send', {
      channelId: this.channelId,
      text,
      attachment: this.attachment,
      replyTo: this.replyTo ? this.replyTo.id : null
    });

    this.inputNode.textContent = '';
    this.attachment = null;
    this.renderAttachBar();
    this.cancelReply();
    this.scrollToBottom();
  }

  scrollToBottom(instant) {
    requestAnimationFrame(() => {
      this.listNode.scrollTo({ top: this.listNode.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
      this.atBottom = true;
    });
  }

  /* --------------------------- Yaziyor gostergesi ------------------------ */

  onTyping({ channelId, userId, username }) {
    if (channelId !== this.channelId) return;
    if (this.app.state.self && userId === this.app.state.self.id) return;
    this.typingUsers.set(userId, { username, at: Date.now() });
    this.renderTyping();
  }

  pruneTyping() {
    let changed = false;
    for (const [id, v] of this.typingUsers) {
      if (Date.now() - v.at > 3200) { this.typingUsers.delete(id); changed = true; }
    }
    if (changed) this.renderTyping();
  }

  renderTyping() {
    const names = [...this.typingUsers.values()].map((v) => v.username);
    if (!names.length) { this.typingNode.replaceChildren(); return; }
    const label = names.length === 1
      ? `${names[0]} yaziyor`
      : names.length < 4
        ? `${names.join(', ')} yaziyor`
        : 'birden fazla kisi yaziyor';
    this.typingNode.replaceChildren(
      el('span', { class: 'typing-dots' }, el('i'), el('i'), el('i')),
      el('span', {}, label)
    );
  }
}
