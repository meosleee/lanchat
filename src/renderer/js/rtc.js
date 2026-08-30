import { Emitter } from './util.js';

/**
 * MeshManager
 * -----------
 * 3-4 kisilik gruplar icin tam mesh WebRTC.
 * Her katilimci digerleriyle ayri bir RTCPeerConnection kurar.
 *
 * Tasarim notlari:
 *  - Yalnizca teklifi baslatan taraf sabit sirada iki transceiver acar
 *    (once audio, sonra video). Yanit veren taraf bunlari kendi olusturmaz;
 *    gelen tekliften dogan transceiver'lari "sendrecv"e cevirip sahiplenir.
 *    Iki taraf da kendi transceiver'ini onceden acarsa Chromium bunlari
 *    eslestirmeyip ayri m-line'lar uretir (2 yerine 4) - bu yuzden boyle.
 *  - Medya duzeni sabit oldugundan ekran paylasimi acilip kapanirken
 *    replaceTrack yeterlidir; yeniden pazarlik gerekmez.
 *  - "Perfect negotiation" deseni ile ayni anda teklif gonderme (glare) durumu
 *    guvenle cozulur.
 *  - LAN/Hamachi icin STUN gerekmez (host adaylari yeterli), istege bagli acilir.
 */
export class MeshManager extends Emitter {
  constructor({ net, audio }) {
    super();
    this.net = net;
    this.audio = audio;
    this.selfId = null;
    this.peers = new Map();     // peerId -> PeerEntry
    this.localAudioTrack = null;
    this.localVideoTrack = null;
    this.iceServers = [];
    this.videoQuality = { maxBitrate: 2_500_000, maxFramerate: 30 };
    this._statsTimer = null;
  }

  setIceServers(list) {
    this.iceServers = Array.isArray(list) ? list : [];
  }

  /* ------------------------------- Baglantilar ----------------------------- */

  createPeer(peerId, initiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0
    });

    const entry = {
      id: peerId,
      pc,
      polite: String(this.selfId) < String(peerId),
      canOffer: !!initiator,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      audioSender: null,
      videoSender: null,
      remoteAudio: null,
      remoteVideo: null,
      stats: {},
      lastStats: null,
      connected: false
    };
    this.peers.set(peerId, entry);

    if (initiator) {
      // Sabit m-line duzeni: once audio, sonra video
      const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
      entry.audioSender = audioTx.sender;
      entry.videoSender = videoTx.sender;
      this.ensureLocalTracks(entry);
    }

    pc.onnegotiationneeded = async () => {
      if (!entry.canOffer) return;
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        this.net.signal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error('[rtc] teklif hatasi', peerId, err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.net.signal(peerId, { candidate });
    };

    pc.ontrack = ({ track, streams, transceiver }) => {
      const stream = streams[0] || new MediaStream([track]);
      if (track.kind === 'audio') {
        entry.remoteAudio = stream;
        this.audio.attachRemote(peerId, stream)
          .then(() => this.emit('peer:audio', { peerId, stream }))
          .catch((err) => console.error('[rtc] uzak ses baglanamadi', err));
      } else {
        entry.remoteVideo = stream;
        const announce = () => this.emit('peer:video', { peerId, stream, active: !track.muted && track.readyState === 'live' });
        track.onmute = () => this.emit('peer:video', { peerId, stream, active: false });
        track.onunmute = announce;
        track.onended = () => this.emit('peer:video', { peerId, stream: null, active: false });
        announce();
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      entry.connected = st === 'connected';
      this.emit('peer:state', { peerId, state: st });
      if (st === 'failed') {
        console.warn('[rtc] baglanti basarisiz, ICE yeniden baslatiliyor:', peerId);
        try { pc.restartIce(); } catch {}
      }
      if (st === 'closed') this.removePeer(peerId);
    };

    pc.oniceconnectionstatechange = () => {
      this.emit('peer:ice', { peerId, state: pc.iceConnectionState });
    };

    this.emit('peer:added', { peerId });
    return entry;
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try { entry.pc.ontrack = null; entry.pc.onicecandidate = null; entry.pc.close(); } catch {}
    this.peers.delete(peerId);
    this.audio.detachRemote(peerId);
    this.emit('peer:removed', { peerId });
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.stopStats();
  }

  /* -------------------------------- Sinyalizm ------------------------------ */

  async handleSignal(from, data) {
    let entry = this.peers.get(from);
    if (!entry) entry = this.createPeer(from, false);
    const { pc } = entry;

    try {
      if (data.description) {
        const desc = data.description;
        const readyForOffer =
          !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
        const offerCollision = desc.type === 'offer' && !readyForOffer;

        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;

        entry.settingRemoteAnswer = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        entry.settingRemoteAnswer = false;

        if (desc.type === 'offer') {
          // Teklifden dogan transceiver'lari sahiplen ve kendi parcalarimizi bagla
          this.adoptTransceivers(entry);
          await pc.setLocalDescription();
          this.net.signal(from, { description: pc.localDescription });
          // Yanit verdikten sonra biz de teklif gonderebiliriz (ICE yeniden baslatma vb.)
          entry.canOffer = true;
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!entry.ignoreOffer) console.warn('[rtc] aday eklenemedi', err.message);
        }
      }
    } catch (err) {
      console.error('[rtc] sinyal islenemedi', from, err);
    }
  }

  /**
   * Gelen tekliften olusan transceiver'lari sahiplen: yonlerini sendrecv yap
   * ve kendi ses/video gondericilerimiz olarak isaretle. Yon degisikligi
   * setLocalDescription'dan once yapildigi icin dogrudan yanita yansir.
   */
  adoptTransceivers(entry) {
    for (const t of entry.pc.getTransceivers()) {
      if (t.stopped) continue;
      const kind = (t.receiver && t.receiver.track && t.receiver.track.kind) ||
                   (t.sender && t.sender.track && t.sender.track.kind);
      if (kind === 'audio' && !entry.audioSender) {
        if (t.direction === 'recvonly' || t.direction === 'inactive') t.direction = 'sendrecv';
        entry.audioSender = t.sender;
      } else if (kind === 'video' && !entry.videoSender) {
        if (t.direction === 'recvonly' || t.direction === 'inactive') t.direction = 'sendrecv';
        entry.videoSender = t.sender;
      }
    }
    this.ensureLocalTracks(entry);
  }

  ensureLocalTracks(entry) {
    if (this.localAudioTrack && entry.audioSender && entry.audioSender.track !== this.localAudioTrack) {
      entry.audioSender.replaceTrack(this.localAudioTrack).catch(() => {});
    }
    if (entry.videoSender && entry.videoSender.track !== this.localVideoTrack) {
      entry.videoSender.replaceTrack(this.localVideoTrack).catch(() => {});
      if (this.localVideoTrack) this.applyVideoParams(entry.videoSender);
    }
  }

  /* --------------------------------- Parcalar ------------------------------ */

  /** Mikrofon parcasini tum baglantilara uygula (yeniden pazarlik gerektirmez) */
  async setLocalAudioTrack(track) {
    this.localAudioTrack = track || null;
    for (const entry of this.peers.values()) {
      // Gonderici henuz yoksa (yanit veren taraf, teklif beklerken)
      // parca adoptTransceivers sirasinda baglanacak.
      if (entry.audioSender) {
        try { await entry.audioSender.replaceTrack(this.localAudioTrack); } catch (err) {
          console.warn('[rtc] ses parcasi degistirilemedi', err.message);
        }
      }
    }
  }

  /** Ekran paylasimi parcasi; null verilirse paylasim durur */
  async setLocalVideoTrack(track) {
    this.localVideoTrack = track || null;
    for (const entry of this.peers.values()) {
      if (!entry.videoSender) continue;
      try {
        await entry.videoSender.replaceTrack(this.localVideoTrack);
        if (this.localVideoTrack) this.applyVideoParams(entry.videoSender);
      } catch (err) {
        console.warn('[rtc] video parcasi degistirilemedi', err.message);
      }
    }
  }

  applyVideoParams(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.videoQuality.maxBitrate;
      params.encodings[0].maxFramerate = this.videoQuality.maxFramerate;
      params.degradationPreference = this.videoQuality.preferMotion ? 'maintain-framerate' : 'balanced';
      sender.setParameters(params).catch(() => {});
    } catch {}
  }

  setVideoQuality(q) {
    this.videoQuality = { ...this.videoQuality, ...q };
    for (const entry of this.peers.values()) {
      if (entry.videoSender && entry.videoSender.track) this.applyVideoParams(entry.videoSender);
    }
  }

  /* ------------------------------- Istatistik ------------------------------ */

  startStats(intervalMs = 2000) {
    this.stopStats();
    this._statsTimer = setInterval(() => this.collectStats(), intervalMs);
  }

  stopStats() {
    clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async collectStats() {
    for (const entry of this.peers.values()) {
      try {
        const report = await entry.pc.getStats();
        const s = { rtt: null, jitter: null, loss: null, inKbps: 0, outKbps: 0, codec: null, videoIn: null };
        let bytesIn = 0;
        let bytesOut = 0;
        let packetsLost = 0;
        let packetsRecv = 0;

        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
            s.rtt = Math.round(r.currentRoundTripTime * 1000);
          }
          if (r.type === 'inbound-rtp' && !r.isRemote) {
            bytesIn += r.bytesReceived || 0;
            packetsLost += r.packetsLost || 0;
            packetsRecv += r.packetsReceived || 0;
            if (r.kind === 'audio' && r.jitter != null) s.jitter = Math.round(r.jitter * 1000);
            if (r.kind === 'video' && r.frameWidth) {
              s.videoIn = { w: r.frameWidth, h: r.frameHeight, fps: Math.round(r.framesPerSecond || 0) };
            }
          }
          if (r.type === 'outbound-rtp' && !r.isRemote) bytesOut += r.bytesSent || 0;
        });

        const now = performance.now();
        if (entry.lastStats) {
          const dt = (now - entry.lastStats.t) / 1000;
          if (dt > 0) {
            s.inKbps = Math.round(((bytesIn - entry.lastStats.bytesIn) * 8) / dt / 1000);
            s.outKbps = Math.round(((bytesOut - entry.lastStats.bytesOut) * 8) / dt / 1000);
          }
        }
        entry.lastStats = { t: now, bytesIn, bytesOut };

        const total = packetsLost + packetsRecv;
        s.loss = total > 0 ? Math.round((packetsLost / total) * 1000) / 10 : 0;
        s.quality = s.rtt == null ? 'unknown' : s.rtt < 60 && s.loss < 2 ? 'good' : s.rtt < 150 && s.loss < 6 ? 'ok' : 'bad';

        entry.stats = s;
        this.emit('peer:stats', { peerId: entry.id, stats: s });
      } catch {}
    }
  }

  getStats(peerId) {
    const e = this.peers.get(peerId);
    return e ? e.stats : null;
  }
}
