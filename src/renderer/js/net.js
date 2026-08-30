import { Emitter } from './util.js';

/**
 * Net
 * ---
 * Socket.io istemcisi etrafinda ince bir sarmalayici.
 * Yeniden baglanma, hazir olma durumu ve WebRTC sinyal aktarimi burada.
 */
export class Net extends Emitter {
  constructor() {
    super();
    this.socket = null;
    this.selfId = null;
    this.url = null;
    this.status = 'offline'; // offline | connecting | online | reconnecting | error
    this.latency = null;
    this._pingTimer = null;
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail });
  }

  /** ip:port veya tam URL kabul eder */
  static normalizeUrl(input) {
    let raw = String(input || '').trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
    try {
      const u = new URL(raw);
      if (!u.port) u.port = '4545';
      return `${u.protocol}//${u.hostname}:${u.port}`;
    } catch {
      return null;
    }
  }

  async connect(address, profile) {
    const url = Net.normalizeUrl(address);
    if (!url) throw new Error('Gecersiz sunucu adresi');
    this.disconnect();

    this.url = url;
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const socket = window.io(url, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 800,
        reconnectionDelayMax: 5000,
        timeout: 8000,
        forceNew: true
      });
      this.socket = socket;

      let settled = false;
      const failTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.setStatus('error', 'Sunucuya ulasilamadi');
        socket.close();
        reject(new Error('Sunucuya ulasilamadi. Adresi ve Hamachi baglantisini kontrol et.'));
      }, 9000);

      socket.on('connect', () => {
        this.selfId = socket.id;
        socket.emit('join', profile, () => {});
      });

      socket.on('ready', (payload) => {
        this.selfId = payload.self.id;
        this.setStatus('online');
        this.startPing();
        this.emit('ready', payload);
        if (!settled) {
          settled = true;
          clearTimeout(failTimer);
          resolve(payload);
        }
      });

      socket.on('join:denied', ({ reason } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        this.setStatus('error', reason);
        socket.close();
        const err = new Error(reason === 'password'
          ? 'Bu sunucu sifreli. Dogru sifreyi girmen gerekiyor.'
          : 'Sunucu baglantiyi reddetti.');
        err.code = reason;
        reject(err);
      });

      socket.on('connect_error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(failTimer);
          this.setStatus('error', err.message);
          socket.close();
          reject(new Error(`Baglanti kurulamadi: ${err.message}`));
        } else {
          this.setStatus('reconnecting', err.message);
        }
      });

      socket.on('disconnect', (reason) => {
        this.stopPing();
        this.setStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting', reason);
        this.emit('disconnected', reason);
      });

      socket.io.on('reconnect_attempt', (n) => this.setStatus('reconnecting', `deneme ${n}`));
      socket.io.on('reconnect', () => {
        this.selfId = socket.id;
        socket.emit('join', profile, () => {});
      });

      // Sunucudan gelen tum olaylari disari yay
      const passthrough = [
        'user:join', 'user:leave', 'user:update',
        'chat:message', 'chat:update', 'chat:delete', 'chat:typing',
        'channel:list',
        'voice:snapshot', 'voice:peerJoined', 'voice:peerLeft', 'voice:state', 'voice:stateLite',
        'rtc:signal'
      ];
      passthrough.forEach((evt) => socket.on(evt, (payload) => this.emit(evt, payload)));
    });
  }

  disconnect() {
    this.stopPing();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.selfId = null;
    this.setStatus('offline');
  }

  get connected() {
    return !!(this.socket && this.socket.connected);
  }

  emitTo(event, payload, ack) {
    if (!this.socket) return;
    if (ack) this.socket.emit(event, payload, ack);
    else this.socket.emit(event, payload);
  }

  request(event, payload) {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ ok: false, error: 'Baglanti yok' });
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'Zaman asimi' }); } }, 6000);
      this.socket.emit(event, payload, (res) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(res || { ok: true });
      });
    });
  }

  signal(to, data) {
    this.emitTo('rtc:signal', { to, data });
  }

  startPing() {
    this.stopPing();
    this._pingTimer = setInterval(() => {
      if (!this.socket || !this.socket.connected) return;
      const t0 = performance.now();
      let answered = false;
      this.socket.timeout(4000).emit('ping', null, (err) => {
        if (answered) return;
        answered = true;
        this.latency = err ? null : Math.round(performance.now() - t0);
        this.emit('latency', this.latency);
      });
    }, 3000);
  }

  stopPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }
}
