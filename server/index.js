'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { startBeacon } = require('./discovery.js');

const MAX_MESSAGES_PER_CHANNEL = 500;
const MAX_TEXT_LENGTH = 4000;
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // base64 gomulu gorsel siniri

const DEFAULT_CHANNELS = [
  { id: 'genel', name: 'genel', type: 'text', topic: 'Herkese acik sohbet' },
  { id: 'oyun', name: 'oyun', type: 'text', topic: 'Oyun planlari' },
  { id: 'lobi', name: 'Lobi', type: 'voice', limit: 8 },
  { id: 'oyun-odasi', name: 'Oyun Odasi', type: 'voice', limit: 8 }
];

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9ğüşöçıİ\-\s]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 24) || makeId('ch');
}

function localAddresses() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nics)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ nic: name, address: a.address, hamachi: a.address.startsWith('25.') });
      }
    }
  }
  // Hamachi adresleri (25.x.x.x) once gelsin
  out.sort((a, b) => Number(b.hamachi) - Number(a.hamachi));
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                 Kalici depo                                 */
/* -------------------------------------------------------------------------- */

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'lanchat-data.json');
    this.dataDir = dataDir;
    this.data = { channels: DEFAULT_CHANNELS.map((c) => ({ ...c })), messages: {}, serverName: 'LanChat Sunucusu' };
    this._dirty = false;
    this.load();
    this._timer = setInterval(() => this.flush(), 4000);
    if (this._timer.unref) this._timer.unref();
  }

  load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && Array.isArray(raw.channels)) {
          this.data.channels = raw.channels;
          this.data.messages = raw.messages || {};
          this.data.serverName = raw.serverName || this.data.serverName;
        }
      }
    } catch (err) {
      console.warn('[store] okunamadi, varsayilanlar kullanilacak:', err.message);
    }
  }

  markDirty() {
    this._dirty = true;
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch (err) {
      console.warn('[store] yazilamadi:', err.message);
    }
  }

  close() {
    clearInterval(this._timer);
    this.flush();
  }

  channels() {
    return this.data.channels;
  }

  channel(id) {
    return this.data.channels.find((c) => c.id === id);
  }

  addChannel(ch) {
    this.data.channels.push(ch);
    this.markDirty();
    return ch;
  }

  removeChannel(id) {
    const i = this.data.channels.findIndex((c) => c.id === id);
    if (i === -1) return false;
    this.data.channels.splice(i, 1);
    delete this.data.messages[id];
    this.markDirty();
    return true;
  }

  messages(channelId) {
    return this.data.messages[channelId] || (this.data.messages[channelId] = []);
  }

  pushMessage(channelId, msg) {
    const list = this.messages(channelId);
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
    this.markDirty();
    return msg;
  }

  findMessage(channelId, id) {
    return this.messages(channelId).find((m) => m.id === id);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Sunucu                                    */
/* -------------------------------------------------------------------------- */

function createServer(options = {}) {
  const port = options.port || 4545;
  const dataDir = options.dataDir || path.join(os.homedir(), '.lanchat');
  const log = options.log || ((...a) => console.log('[lanchat]', ...a));
  const password = String(options.password || '');

  const store = new Store(dataDir);
  const app = express();
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e7,
    pingInterval: 10000,
    pingTimeout: 20000
  });

  /** socketId -> user */
  const users = new Map();
  /** channelId -> Set<socketId> */
  const voiceRooms = new Map();
  /** socketId -> voice durumu */
  const voiceStates = new Map();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: store.data.serverName,
      users: users.size,
      uptime: process.uptime(),
      locked: !!password,
      version: 1
    });
  });

  function publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      color: u.color,
      status: u.status,
      joinedAt: u.joinedAt
    };
  }

  function userList() {
    return [...users.values()].map(publicUser);
  }

  function voiceSnapshot() {
    const snap = {};
    for (const [channelId, set] of voiceRooms) {
      snap[channelId] = [...set].map((sid) => ({
        id: sid,
        ...(voiceStates.get(sid) || {})
      }));
    }
    return snap;
  }

  function broadcastVoice() {
    io.emit('voice:snapshot', voiceSnapshot());
  }

  function leaveVoice(socket, silent) {
    const state = voiceStates.get(socket.id);
    if (!state || !state.channelId) return;
    const channelId = state.channelId;
    const set = voiceRooms.get(channelId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) voiceRooms.delete(channelId);
    }
    socket.leave(`voice:${channelId}`);
    voiceStates.set(socket.id, { ...state, channelId: null, screensharing: false });
    io.to(`voice:${channelId}`).emit('voice:peerLeft', { id: socket.id, channelId });
    if (!silent) broadcastVoice();
  }

  io.on('connection', (socket) => {
    log('baglanti:', socket.id);

    socket.on('join', (payload = {}, ack) => {
      // Sunucu internete aciksa sifre tek koruma katmanidir
      if (password && String(payload.password || '') !== password) {
        socket.emit('join:denied', { reason: 'password' });
        if (typeof ack === 'function') ack({ ok: false, error: 'Sunucu sifresi hatali' });
        log(`sifre hatali, baglanti reddedildi: ${socket.id}`);
        setTimeout(() => socket.disconnect(true), 250);
        return;
      }

      const username = String(payload.username || '').trim().slice(0, 24) || `Misafir-${socket.id.slice(0, 4)}`;
      const color = /^#[0-9a-f]{6}$/i.test(payload.color || '') ? payload.color : '#5b8cff';

      const user = {
        id: socket.id,
        username,
        color,
        status: 'online',
        joinedAt: nowISO()
      };
      users.set(socket.id, user);
      voiceStates.set(socket.id, {
        channelId: null,
        muted: false,
        deafened: false,
        speaking: false,
        screensharing: false,
        username,
        color
      });

      socket.emit('ready', {
        self: publicUser(user),
        serverName: store.data.serverName,
        channels: store.channels(),
        users: userList(),
        voice: voiceSnapshot()
      });
      socket.broadcast.emit('user:join', publicUser(user));
      broadcastVoice();
      if (typeof ack === 'function') ack({ ok: true, id: socket.id });
      log(`${username} katildi (${users.size} kisi cevrimici)`);
    });

    socket.on('ping', (_payload, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('user:update', (payload = {}) => {
      const user = users.get(socket.id);
      if (!user) return;
      if (payload.username) user.username = String(payload.username).trim().slice(0, 24) || user.username;
      if (/^#[0-9a-f]{6}$/i.test(payload.color || '')) user.color = payload.color;
      if (['online', 'idle', 'dnd', 'invisible'].includes(payload.status)) user.status = payload.status;
      const vs = voiceStates.get(socket.id);
      if (vs) {
        vs.username = user.username;
        vs.color = user.color;
      }
      io.emit('user:update', publicUser(user));
      broadcastVoice();
    });

    /* ------------------------------ Metin sohbet ----------------------------- */

    socket.on('chat:history', ({ channelId } = {}, ack) => {
      if (typeof ack !== 'function') return;
      const ch = store.channel(channelId);
      if (!ch || ch.type !== 'text') return ack({ ok: false, error: 'Kanal bulunamadi' });
      ack({ ok: true, channelId, messages: store.messages(channelId) });
    });

    socket.on('chat:send', (payload = {}, ack) => {
      const user = users.get(socket.id);
      if (!user) return;
      const ch = store.channel(payload.channelId);
      if (!ch || ch.type !== 'text') return;

      const text = String(payload.text || '').slice(0, MAX_TEXT_LENGTH);
      let attachment = null;
      if (payload.attachment && typeof payload.attachment.data === 'string') {
        const approxBytes = Math.ceil((payload.attachment.data.length * 3) / 4);
        if (approxBytes <= MAX_ATTACHMENT_BYTES) {
          attachment = {
            name: String(payload.attachment.name || 'dosya').slice(0, 120),
            type: String(payload.attachment.type || 'application/octet-stream').slice(0, 80),
            size: approxBytes,
            data: payload.attachment.data
          };
        } else if (typeof ack === 'function') {
          return ack({ ok: false, error: 'Dosya cok buyuk (max 6 MB)' });
        }
      }
      if (!text && !attachment) return;

      const msg = {
        id: makeId('m'),
        channelId: ch.id,
        authorId: user.id,
        author: user.username,
        color: user.color,
        text,
        attachment,
        replyTo: payload.replyTo || null,
        ts: nowISO(),
        reactions: {}
      };
      store.pushMessage(ch.id, msg);
      io.emit('chat:message', msg);
      if (typeof ack === 'function') ack({ ok: true, id: msg.id });
    });

    socket.on('chat:edit', ({ channelId, messageId, text } = {}) => {
      const user = users.get(socket.id);
      const msg = user && store.findMessage(channelId, messageId);
      if (!msg || msg.authorId !== user.id) return;
      msg.text = String(text || '').slice(0, MAX_TEXT_LENGTH);
      msg.editedAt = nowISO();
      store.markDirty();
      io.emit('chat:update', msg);
    });

    socket.on('chat:delete', ({ channelId, messageId } = {}) => {
      const user = users.get(socket.id);
      if (!user) return;
      const list = store.messages(channelId);
      const i = list.findIndex((m) => m.id === messageId);
      if (i === -1 || list[i].authorId !== user.id) return;
      list.splice(i, 1);
      store.markDirty();
      io.emit('chat:delete', { channelId, messageId });
    });

    socket.on('chat:react', ({ channelId, messageId, emoji } = {}) => {
      const user = users.get(socket.id);
      const msg = user && store.findMessage(channelId, messageId);
      if (!msg || !emoji) return;
      const key = String(emoji).slice(0, 8);
      const set = new Set(msg.reactions[key] || []);
      if (set.has(user.id)) set.delete(user.id);
      else set.add(user.id);
      if (set.size) msg.reactions[key] = [...set];
      else delete msg.reactions[key];
      store.markDirty();
      io.emit('chat:update', msg);
    });

    socket.on('chat:typing', ({ channelId } = {}) => {
      const user = users.get(socket.id);
      if (!user) return;
      socket.broadcast.emit('chat:typing', { channelId, userId: user.id, username: user.username });
    });

    /* ------------------------------- Kanallar -------------------------------- */

    socket.on('channel:create', ({ name, type, topic } = {}, ack) => {
      if (!users.has(socket.id)) return;
      const kind = type === 'voice' ? 'voice' : 'text';
      const base = slugify(name || (kind === 'voice' ? 'yeni-oda' : 'yeni-kanal'));
      let id = base;
      let n = 2;
      while (store.channel(id)) id = `${base}-${n++}`;
      const ch = store.addChannel({
        id,
        name: kind === 'voice' ? String(name || 'Yeni Oda').slice(0, 24) : id,
        type: kind,
        topic: String(topic || '').slice(0, 120),
        limit: kind === 'voice' ? 8 : undefined
      });
      io.emit('channel:list', store.channels());
      if (typeof ack === 'function') ack({ ok: true, channel: ch });
    });

    socket.on('channel:delete', ({ id } = {}) => {
      if (!users.has(socket.id)) return;
      if (DEFAULT_CHANNELS.some((c) => c.id === id)) return; // varsayilanlar silinemez
      if (store.removeChannel(id)) io.emit('channel:list', store.channels());
    });

    /* -------------------------------- Ses/WebRTC ------------------------------ */

    socket.on('voice:join', ({ channelId } = {}, ack) => {
      const user = users.get(socket.id);
      const ch = store.channel(channelId);
      if (!user || !ch || ch.type !== 'voice') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Ses kanali bulunamadi' });
        return;
      }
      const set = voiceRooms.get(channelId) || new Set();
      if (ch.limit && set.size >= ch.limit && !set.has(socket.id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Oda dolu' });
        return;
      }

      leaveVoice(socket, true);

      set.add(socket.id);
      voiceRooms.set(channelId, set);
      socket.join(`voice:${channelId}`);

      const prev = voiceStates.get(socket.id) || {};
      voiceStates.set(socket.id, {
        ...prev,
        channelId,
        username: user.username,
        color: user.color,
        muted: !!prev.muted,
        deafened: !!prev.deafened,
        speaking: false,
        screensharing: false
      });

      // Odadaki mevcut kisiler -> yeni gelen bunlara offer gonderecek
      const peers = [...set].filter((id) => id !== socket.id);
      socket.to(`voice:${channelId}`).emit('voice:peerJoined', {
        id: socket.id,
        channelId,
        user: publicUser(user)
      });
      broadcastVoice();
      if (typeof ack === 'function') ack({ ok: true, channelId, peers });
      log(`${user.username} -> ses kanali "${ch.name}" (${set.size} kisi)`);
    });

    socket.on('voice:leave', () => leaveVoice(socket));

    socket.on('voice:state', (patch = {}) => {
      const state = voiceStates.get(socket.id);
      if (!state) return;
      for (const key of ['muted', 'deafened', 'speaking', 'screensharing', 'videoOn']) {
        if (key in patch) state[key] = !!patch[key];
      }
      const payload = { id: socket.id, ...state };
      if (state.channelId) io.to(`voice:${state.channelId}`).emit('voice:state', payload);
      io.emit('voice:stateLite', { id: socket.id, channelId: state.channelId, muted: state.muted, deafened: state.deafened, screensharing: state.screensharing, speaking: state.speaking });
    });

    socket.on('rtc:signal', ({ to, data } = {}) => {
      if (!to || !data || !users.has(to)) return;
      io.to(to).emit('rtc:signal', { from: socket.id, data });
    });

    /* ------------------------------- Ayrilma --------------------------------- */

    socket.on('disconnect', (reason) => {
      const user = users.get(socket.id);
      leaveVoice(socket, true);
      users.delete(socket.id);
      voiceStates.delete(socket.id);
      if (user) {
        io.emit('user:leave', { id: socket.id, username: user.username });
        log(`${user.username} ayrildi (${reason})`);
      }
      broadcastVoice();
    });
  });

  let beacon = null;

  return {
    io,
    port,
    addresses: localAddresses,
    start() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '0.0.0.0', () => {
          const addrs = localAddresses();
          log(`dinleniyor: http://0.0.0.0:${port}`);
          addrs.forEach((a) => log(`  -> ${a.address}:${port}${a.hamachi ? '  (Hamachi)' : ''} [${a.nic}]`));

          // Agdaki istemcilerin bizi kendiliginden bulmasi icin duyuru yap
          if (options.discovery !== false) {
            beacon = startBeacon({
              port,
              log,
              describe: () => ({ name: store.data.serverName, users: users.size, locked: !!password })
            });
          }
          resolve({ port, addresses: addrs });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (beacon) { beacon.stop(); beacon = null; }
        store.close();
        io.close(() => httpServer.close(() => resolve()));
      });
    }
  };
}

module.exports = { createServer, localAddresses, DEFAULT_CHANNELS };
