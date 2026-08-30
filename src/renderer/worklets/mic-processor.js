/**
 * LanChat mikrofon isleme worklet'i
 * ---------------------------------
 * Tek bir AudioWorkletProcessor icinde:
 *   1) RNNoise (WASM) ile AI tabanli gurultu bastirma  -> Krisp benzeri
 *   2) RNNoise'un dondurdugu VAD olasiligi ile konusma kapisi (gate)
 *   3) Ses seviyesi olcumu (metre + konusma tespiti)
 *   4) Yumusatilmis kazanc (mute / push-to-talk tiklamasini engeller)
 *
 * WASM ikili dosyasi ana is parcacigindan `processorOptions.wasmBytes` ile gelir;
 * worklet icinde fetch olmadigi icin bu sekilde aktarilir.
 *
 * RNNoise 48 kHz, mono, 480 orneklik cerceve bekler; int16 olceginde float.
 */

const FRAME = 480;          // RNNoise cerceve boyutu (10 ms @ 48 kHz)
const RING = 8192;          // cikis halka tamponu
const INT16 = 32768;

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const o = options.processorOptions || {};

    // --- yapilandirma ---
    this.denoise = o.denoise !== false;
    this.mix = typeof o.mix === 'number' ? o.mix : 1;      // 0 = kuru, 1 = tam bastirma
    this.vadGate = !!o.vadGate;
    this.vadThreshold = o.vadThreshold ?? 0.55;
    this.targetGain = 1;
    this.gain = 1;
    this.boost = o.boost ?? 1;

    // --- durum ---
    this.ready = false;
    this.wasm = null;
    this.state = 0;
    this.ptrIn = 0;
    this.ptrOut = 0;

    this.inBuf = new Float32Array(FRAME);
    this.inPos = 0;
    this.dryBuf = new Float32Array(FRAME);

    this.ring = new Float32Array(RING);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;

    this.vad = 0;
    this.gateGain = 1;
    this.meterAcc = 0;
    this.meterCount = 0;
    this.meterPeak = 0;
    this.meterFrames = 0;
    this.silentFrames = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);

    if (o.wasmBytes) this.initWasm(o.wasmBytes);
    else this.port.postMessage({ type: 'ready', ok: false, error: 'wasm-yok' });
  }

  async initWasm(bytes) {
    try {
      const imports = {
        env: {
          __assert_fail: () => { throw new Error('rnnoise assert'); },
          emscripten_resize_heap: () => false
        },
        wasi_snapshot_preview1: { fd_write: () => 0 }
      };
      const { instance } = await WebAssembly.instantiate(bytes, imports);
      const ex = instance.exports;
      if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();

      if (ex.rnnoise_get_frame_size() !== FRAME) {
        throw new Error('beklenmeyen cerceve boyutu');
      }

      this.wasm = ex;
      this.state = ex.rnnoise_create(0);
      this.ptrIn = ex.malloc(FRAME * 4);
      this.ptrOut = ex.malloc(FRAME * 4);
      if (!this.state || !this.ptrIn || !this.ptrOut) throw new Error('bellek ayrilamadi');

      // Yigin buyumedigi icin (emscripten_resize_heap false doner) gorunumu
      // bir kez olusturup saklayabiliriz; cerceve basina tahsis olmaz.
      this.heap = new Float32Array(ex.memory.buffer);
      this.inOff = this.ptrIn >> 2;
      this.outOff = this.ptrOut >> 2;

      this.ready = true;
      this.port.postMessage({ type: 'ready', ok: true, sampleRate });
    } catch (err) {
      this.port.postMessage({ type: 'ready', ok: false, error: String(err && err.message || err) });
    }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'config') {
      if ('denoise' in msg) this.denoise = !!msg.denoise;
      if ('mix' in msg) this.mix = Math.max(0, Math.min(1, msg.mix));
      if ('vadGate' in msg) this.vadGate = !!msg.vadGate;
      if ('vadThreshold' in msg) this.vadThreshold = msg.vadThreshold;
      if ('gain' in msg) this.targetGain = Math.max(0, Math.min(1, msg.gain));
      if ('boost' in msg) this.boost = Math.max(0.1, Math.min(4, msg.boost));
    } else if (msg.type === 'dispose') {
      this.dispose();
    }
  }

  dispose() {
    if (this.wasm && this.state) {
      try {
        this.wasm.rnnoise_destroy(this.state);
        this.wasm.free(this.ptrIn);
        this.wasm.free(this.ptrOut);
      } catch {}
    }
    this.ready = false;
    this.wasm = null;
  }

  /** 480 orneklik cerceveyi RNNoise'dan gecir, halka tampona yaz */
  processFrame() {
    const wet = this.dryBuf; // varsayilan: kuru sinyal
    let vad = this.vad;

    if (this.ready && this.denoise) {
      const heap = this.heap;
      const inOff = this.inOff;
      const outOff = this.outOff;

      for (let i = 0; i < FRAME; i++) heap[inOff + i] = this.inBuf[i] * INT16;
      vad = this.wasm.rnnoise_process_frame(this.state, this.ptrOut, this.ptrIn);

      const m = this.mix;
      const inv = 1 - m;
      for (let i = 0; i < FRAME; i++) {
        const w = heap[outOff + i] / INT16;
        wet[i] = w * m + this.inBuf[i] * inv;
      }
    } else {
      // RNNoise kapali: basit enerji tabanli VAD tahmini
      let energy = 0;
      for (let i = 0; i < FRAME; i++) {
        wet[i] = this.inBuf[i];
        energy += this.inBuf[i] * this.inBuf[i];
      }
      const rms = Math.sqrt(energy / FRAME);
      vad = Math.min(1, rms / 0.05);
    }

    this.vad = vad;

    // --- konusma kapisi (yumusak) ---
    let gateTarget = 1;
    if (this.vadGate) {
      gateTarget = vad >= this.vadThreshold ? 1 : 0;
      if (gateTarget === 0) this.silentFrames++;
      else this.silentFrames = 0;
      // kelime aralarinda kesmesin: ~200 ms tolerans
      if (gateTarget === 0 && this.silentFrames < 20) gateTarget = 1;
    }
    const gateCoef = gateTarget > this.gateGain ? 0.35 : 0.06; // hizli acilis, yavas kapanis
    this.gateGain += (gateTarget - this.gateGain) * gateCoef;

    // --- halka tampona yaz ---
    const g = this.gateGain * this.boost;
    for (let i = 0; i < FRAME; i++) {
      this.ring[this.writeIdx] = wet[i] * g;
      this.writeIdx = (this.writeIdx + 1) % RING;
    }
    this.available = Math.min(this.available + FRAME, RING);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    const n = out.length;

    if (!input || !input[0]) {
      out.fill(0);
      return true;
    }
    const src = input[0];

    // 1) girisi cerceveye topla
    for (let i = 0; i < n; i++) {
      const s = src[i];
      this.inBuf[this.inPos++] = s;

      const a = Math.abs(s);
      this.meterAcc += s * s;
      if (a > this.meterPeak) this.meterPeak = a;
      this.meterCount++;

      if (this.inPos === FRAME) {
        this.inPos = 0;
        this.processFrame();
      }
    }

    // 2) halka tampondan cikisa aktar (yumusatilmis kazancla)
    for (let i = 0; i < n; i++) {
      this.gain += (this.targetGain - this.gain) * 0.02;
      if (this.available > 0) {
        out[i] = this.ring[this.readIdx] * this.gain;
        this.readIdx = (this.readIdx + 1) % RING;
        this.available--;
      } else {
        out[i] = 0;
      }
    }

    // 3) ~20 Hz metre raporu
    this.meterFrames += n;
    if (this.meterFrames >= 2048) {
      const rms = Math.sqrt(this.meterAcc / Math.max(1, this.meterCount));
      this.port.postMessage({
        type: 'meter',
        rms,
        peak: this.meterPeak,
        vad: this.vad,
        gate: this.gateGain,
        denoising: this.ready && this.denoise
      });
      this.meterAcc = 0;
      this.meterCount = 0;
      this.meterPeak = 0;
      this.meterFrames = 0;
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
