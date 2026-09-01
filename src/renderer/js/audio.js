import { Emitter, clamp } from './util.js';

const SAMPLE_RATE = 48000; // RNNoise sarti

/**
 * AudioEngine
 * -----------
 * Mikrofon zinciri:
 *   getUserMedia -> MediaStreamSource -> [mic-processor worklet] -> Destination
 *   worklet: RNNoise (WASM) + konusma kapisi + metre + yumusak kazanc
 *   Cikan stream WebRTC'ye gonderilir.
 *
 * Uzak kullanicilar:
 *   remoteStream -> MediaStreamSource -> GainNode (kisi basi ses) -> Analyser -> Destination
 *   Cikis <audio> elemani uzerinden calinir (setSinkId ile cihaz secimi mumkun).
 */
export class AudioEngine extends Emitter {
  constructor() {
    super();
    this.ctx = null;
    this.workletReady = false;
    this.rnnoiseOk = false;

    this.rawStream = null;      // ham mikrofon
    this.micSource = null;
    this.micNode = null;        // AudioWorkletNode
    this.micDest = null;        // MediaStreamAudioDestinationNode
    this.outputStream = null;   // WebRTC'ye giden

    this.peers = new Map();     // peerId -> { stream, source, gain, analyser, audioEl, keepAlive }
    this.userVolumes = new Map();

    this.masterVolume = 1;
    this.deafened = false;
    this.muted = false;
    this.pttActive = false;
    this.pttEnabled = false;
    this.outputDeviceId = 'default';

    this.level = 0;
    this.vad = 0;
    this.speaking = false;
    this._speakingSince = 0;

    this.config = {
      noiseMode: 'rnnoise',    // 'off' | 'browser' | 'rnnoise'
      echoCancellation: true,
      autoGainControl: true,
      suppressionMix: 1,
      vadGate: false,
      vadThreshold: 0.6,
      inputBoost: 1,
      inputDeviceId: 'default'
    };
  }

  /* ------------------------------ Baslatma ------------------------------- */

  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (this.ctx.sampleRate !== SAMPLE_RATE) {
      console.warn('[audio] beklenen 48kHz degil:', this.ctx.sampleRate, ' RNNoise devre disi kalabilir');
    }
    await this.ctx.audioWorklet.addModule('./worklets/mic-processor.js');
    this.workletReady = true;
    return this.ctx;
  }

  async loadRnnoise() {
    if (this._wasmBytes) return this._wasmBytes;
    try {
      // file:// protokolunde fetch calismadigi icin ikili dosya ana surecten gelir
      const bytes = await window.lanchat.loadRnnoiseWasm();
      if (!bytes) throw new Error('dosya okunamadi');
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this._wasmBytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      return this._wasmBytes;
    } catch (err) {
      console.warn('[audio] rnnoise.wasm yuklenemedi:', err.message);
      this.emit('warning', 'RNNoise modeli yuklenemedi, tarayici gurultu engelleme kullanilacak.');
      return null;
    }
  }

  /* --------------------------- Mikrofon zinciri --------------------------- */

  /**
   * Mikrofonu ac.
   * Windows'ta bazi ses surucileri sabit ornekleme hizi / kanal sayisi
   * istendiginde "Could not start audio source" (NotReadableError) verir.
   * Bu yuzden kisitlari kademeli olarak gevsetip tekrar deniyoruz.
   */
  async startMic(overrides = {}) {
    Object.assign(this.config, overrides);
    await this.ensureContext();

    // RNNoise aktifken tarayici filtresini kapatiyoruz ki iki filtre
    // birbiriyle savasmasin (AGC ve yanki engelleme acik kalabilir).
    const useBrowserNS = this.config.noiseMode === 'browser';
    const processing = {
      echoCancellation: this.config.echoCancellation,
      noiseSuppression: useBrowserNS,
      autoGainControl: this.config.autoGainControl
    };
    const wantId = this.config.inputDeviceId && this.config.inputDeviceId !== 'default'
      ? this.config.inputDeviceId
      : null;

    const attempts = [
      {
        label: 'tam',
        audio: {
          ...processing,
          ...(wantId ? { deviceId: { exact: wantId } } : {}),
          channelCount: 1,
          sampleRate: SAMPLE_RATE
        }
      },
      {
        label: 'ornekleme kisiti olmadan',
        audio: { ...processing, ...(wantId ? { deviceId: { exact: wantId } } : {}) }
      },
      {
        label: 'cihaz tercihi gevsek',
        audio: { ...processing, ...(wantId ? { deviceId: wantId } : {}) }
      },
      // Son careye dusmeden once yanki engellemeyi mutlaka koruyoruz:
      // AEC olmadan hoparlor kullanan biri sonsuz geri besleme dongusu yaratir.
      { label: 'sade (yanki engelleme acik)', audio: { echoCancellation: true } },
      { label: 'varsayilan cihaz', audio: true }
    ];

    this.stopMic(true);

    let stream = null;
    let lastError = null;
    let usedIndex = -1;

    for (let i = 0; i < attempts.length; i++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: attempts[i].audio, video: false });
        usedIndex = i;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[audio] mikrofon denemesi basarisiz (${attempts[i].label}):`, err.name, err.message);
      }
    }

    if (!stream) throw this.describeMicError(lastError);

    if (usedIndex > 0) {
      this.emit('warning',
        `Mikrofon varsayilan ayarlarla acilamadi, "${attempts[usedIndex].label}" ile acildi. ` +
        'Ses cihazi listesinden baska bir mikrofon secmeyi deneyebilirsin.');
      // Kayitli cihaz artik yoksa varsayilana don
      if (usedIndex >= 2 && wantId) this.config.inputDeviceId = 'default';
    }

    this.rawStream = stream;

    const wasmBytes = this.config.noiseMode === 'rnnoise' ? await this.loadRnnoise() : null;

    this.micSource = this.ctx.createMediaStreamSource(this.rawStream);
    this.micNode = new AudioWorkletNode(this.ctx, 'mic-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        wasmBytes: wasmBytes ? wasmBytes.slice(0) : null,
        denoise: this.config.noiseMode === 'rnnoise',
        mix: this.config.suppressionMix,
        vadGate: this.config.vadGate,
        vadThreshold: this.config.vadThreshold,
        boost: this.config.inputBoost
      }
    });

    this.micNode.port.onmessage = (e) => this.onWorkletMessage(e.data);

    this.micDest = this.ctx.createMediaStreamDestination();
    this.micSource.connect(this.micNode);
    this.micNode.connect(this.micDest);

    this.outputStream = this.micDest.stream;
    this.applyGain();

    const track = this.rawStream.getAudioTracks()[0];
    const settings = track ? track.getSettings() : {};

    // Surucu yanki engellemeyi gercekten uygulamis mi? Uygulamadiysa
    // hoparlor kullanan kullanici geri besleme dongusune girer.
    if (this.config.echoCancellation && settings.echoCancellation === false) {
      this.emit('warning',
        'Bu mikrofonda yanki engelleme calismiyor. Hoparlor kullaniyorsan sesin ' +
        'karsi tarafta yankilanip dongyye girebilir - kulaklik kullanmani oneririm.');
    }

    this.emit('mic:started', { label: track ? track.label : 'Mikrofon', settings });

    return this.outputStream;
  }

  /** getUserMedia hatalarini anlasilir mesaja cevir */
  describeMicError(err) {
    const name = err && err.name;
    const detail = err && err.message ? ` (${err.message})` : '';
    const messages = {
      NotReadableError:
        'Mikrofona erisilemedi. Baska bir uygulama (Discord, Teams, OBS, oyun) mikrofonu ' +
        'ozel kullanimda tutuyor olabilir - onu kapatip tekrar dene. Windows ta ayrica ' +
        'Ayarlar > Gizlilik ve guvenlik > Mikrofon bolumunde "Uygulamalarin mikrofonunuza ' +
        'erismesine izin verin" ve "Masaustu uygulamalarinin..." secenekleri acik olmali.',
      NotAllowedError:
        'Mikrofon izni verilmedi. Isletim sistemi ayarlarindan LanChat e mikrofon izni ver.',
      NotFoundError:
        'Mikrofon bulunamadi. Cihazin takili ve sistemde etkin oldugundan emin ol.',
      OverconstrainedError:
        'Secili mikrofon istenen ayarlari desteklemiyor. Ayarlar > Ses ve mikrofon bolumunden ' +
        'baska bir giris cihazi sec.',
      AbortError: 'Ses cihazi baslatilamadi. Cihazi cikarip takmayi veya bilgisayari yeniden baslatmayi dene.'
    };
    const out = new Error((messages[name] || `Mikrofon acilamadi: ${name || 'bilinmeyen hata'}`) + detail);
    out.name = name || 'MicError';
    out.original = err;
    return out;
  }

  onWorkletMessage(msg) {
    if (!msg) return;
    if (msg.type === 'ready') {
      this.rnnoiseOk = !!msg.ok;
      if (!msg.ok && this.config.noiseMode === 'rnnoise') {
        this.emit('warning', `RNNoise baslatilamadi (${msg.error}); tarayici filtresine geciliyor.`);
      }
      this.emit('denoise:state', { rnnoise: this.rnnoiseOk, mode: this.config.noiseMode });
      return;
    }
    if (msg.type === 'meter') {
      this.level = msg.rms;
      this.vad = msg.vad;

      const gated = this.muted || (this.pttEnabled && !this.pttActive);
      const loud = msg.denoising ? msg.vad > 0.35 : msg.rms > 0.02;
      const speakingNow = !gated && loud;

      if (speakingNow) this._speakingSince = performance.now();
      const stillSpeaking = speakingNow || performance.now() - this._speakingSince < 300;

      if (stillSpeaking !== this.speaking) {
        this.speaking = stillSpeaking;
        this.emit('speaking', stillSpeaking);
      }
      this.emit('meter', { rms: msg.rms, peak: msg.peak, vad: msg.vad, gate: msg.gate });
    }
  }

  stopMic(silent) {
    try { this.micSource && this.micSource.disconnect(); } catch {}
    try {
      if (this.micNode) {
        this.micNode.port.postMessage({ type: 'dispose' });
        this.micNode.disconnect();
      }
    } catch {}
    try { this.micDest && this.micDest.disconnect(); } catch {}
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => t.stop());

    this.rawStream = null;
    this.micSource = null;
    this.micNode = null;
    this.micDest = null;
    this.outputStream = null;
    this.speaking = false;
    this.level = 0;
    if (!silent) this.emit('mic:stopped');
  }

  /** Zinciri yeniden kurmadan degistirilebilecek ayarlar */
  updateConfig(patch = {}) {
    const needsRestart =
      ('noiseMode' in patch && patch.noiseMode !== this.config.noiseMode) ||
      ('inputDeviceId' in patch && patch.inputDeviceId !== this.config.inputDeviceId) ||
      ('echoCancellation' in patch && patch.echoCancellation !== this.config.echoCancellation) ||
      ('autoGainControl' in patch && patch.autoGainControl !== this.config.autoGainControl);

    Object.assign(this.config, patch);

    if (this.micNode && !needsRestart) {
      this.micNode.port.postMessage({
        type: 'config',
        denoise: this.config.noiseMode === 'rnnoise',
        mix: this.config.suppressionMix,
        vadGate: this.config.vadGate,
        vadThreshold: this.config.vadThreshold,
        boost: this.config.inputBoost
      });
    }
    return needsRestart;
  }

  applyGain() {
    if (!this.micNode) return;
    const open = !this.muted && (!this.pttEnabled || this.pttActive);
    this.micNode.port.postMessage({ type: 'config', gain: open ? 1 : 0 });
  }

  setMuted(v) {
    this.muted = !!v;
    this.applyGain();
    if (this.muted && this.speaking) {
      this.speaking = false;
      this.emit('speaking', false);
    }
  }

  setPtt(enabled, active) {
    if (enabled !== undefined) this.pttEnabled = !!enabled;
    if (active !== undefined) this.pttActive = !!active;
    this.applyGain();
  }

  /* ---------------------------- Uzak kullanicilar -------------------------- */

  async attachRemote(peerId, stream) {
    await this.ensureContext();
    this.detachRemote(peerId);

    // Chromium'da uzak sesin akmasi icin stream'in bir <audio>'ya bagli olmasi gerekir
    const keepAlive = new Audio();
    keepAlive.srcObject = stream;
    keepAlive.muted = true;
    keepAlive.autoplay = true;
    keepAlive.play().catch(() => {});

    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    const dest = this.ctx.createMediaStreamDestination();

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(dest);

    const audioEl = new Audio();
    audioEl.srcObject = dest.stream;
    audioEl.autoplay = true;
    audioEl.play().catch(() => {});
    await this.applySink(audioEl);

    const entry = { stream, source, gain, analyser, audioEl, keepAlive, data: new Uint8Array(analyser.frequencyBinCount) };
    this.peers.set(peerId, entry);
    this.applyVolume(peerId);
    return entry;
  }

  detachRemote(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try { p.source.disconnect(); } catch {}
    try { p.gain.disconnect(); } catch {}
    try { p.analyser.disconnect(); } catch {}
    try { p.audioEl.pause(); p.audioEl.srcObject = null; } catch {}
    try { p.keepAlive.pause(); p.keepAlive.srcObject = null; } catch {}
    this.peers.delete(peerId);
  }

  detachAll() {
    for (const id of [...this.peers.keys()]) this.detachRemote(id);
  }

  /** Kisi basi ses seviyesi: 0 - 2 (0 = sustur, 1 = normal, 2 = %200) */
  setUserVolume(peerId, volume) {
    this.userVolumes.set(peerId, clamp(volume, 0, 2));
    this.applyVolume(peerId);
  }

  getUserVolume(peerId) {
    return this.userVolumes.has(peerId) ? this.userVolumes.get(peerId) : 1;
  }

  applyVolume(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    const v = this.deafened ? 0 : this.getUserVolume(peerId) * this.masterVolume;
    p.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  applyAllVolumes() {
    for (const id of this.peers.keys()) this.applyVolume(id);
  }

  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 2);
    this.applyAllVolumes();
  }

  setDeafened(v) {
    this.deafened = !!v;
    this.applyAllVolumes();
  }

  /** Uzak kullanicilarin anlik ses seviyeleri (konusma halkasi icin) */
  remoteLevels() {
    const out = {};
    for (const [id, p] of this.peers) {
      p.analyser.getByteTimeDomainData(p.data);
      let sum = 0;
      for (let i = 0; i < p.data.length; i++) {
        const v = (p.data[i] - 128) / 128;
        sum += v * v;
      }
      out[id] = Math.sqrt(sum / p.data.length);
    }
    return out;
  }

  /* ------------------------------- Cihazlar -------------------------------- */

  async listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs: devices.filter((d) => d.kind === 'audioinput'),
        outputs: devices.filter((d) => d.kind === 'audiooutput')
      };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }

  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || 'default';
    for (const p of this.peers.values()) await this.applySink(p.audioEl);
    if (this._testEl) await this.applySink(this._testEl);
  }

  async applySink(audioEl) {
    if (!audioEl.setSinkId || !this.outputDeviceId || this.outputDeviceId === 'default') return;
    try { await audioEl.setSinkId(this.outputDeviceId); } catch (err) {
      console.warn('[audio] cikis cihazi ayarlanamadi:', err.message);
    }
  }

  /* ------------------------------ Bildirim sesleri ------------------------- */

  async beep(kind = 'join') {
    await this.ensureContext();
    const t = this.ctx.currentTime;
    const master = this.ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(this.ctx.destination);

    const notes = {
      join: [523.25, 783.99],
      leave: [783.99, 523.25],
      mention: [880, 1174.66],
      mute: [440],
      unmute: [660],
      error: [220, 180]
    }[kind] || [523.25];

    const vol = this.deafened ? 0 : 0.16 * this.masterVolume;
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t + i * 0.085;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol || 0.0001, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(start + 0.2);
    });
    master.gain.value = 1;
    setTimeout(() => { try { master.disconnect(); } catch {} }, 700);
  }

  /** Mikrofon testi: kendi sesini kisa sure geri dinle */
  async startLoopbackTest() {
    if (!this.micDest) return false;
    this.stopLoopbackTest();
    this._testEl = new Audio();
    this._testEl.srcObject = this.micDest.stream;
    this._testEl.autoplay = true;
    await this.applySink(this._testEl);
    this._testEl.play().catch(() => {});
    return true;
  }

  stopLoopbackTest() {
    if (this._testEl) {
      try { this._testEl.pause(); this._testEl.srcObject = null; } catch {}
      this._testEl = null;
    }
  }

  destroy() {
    this.stopLoopbackTest();
    this.detachAll();
    this.stopMic(true);
    if (this.ctx) { try { this.ctx.close(); } catch {} }
    this.ctx = null;
  }
}
