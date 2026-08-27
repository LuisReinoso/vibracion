// Audio engine: file, microphone or synthetic tone/sweep -> FFT spectrum.
// Exposes a linear-amplitude spectrum, the interpolated dominant frequency and the RMS level.

import { SingingBowl } from './singing-bowl.js';

const FFT_SIZE = 8192;
const FLOOR_DB = -95;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.master = null;
    this.source = null;      // current node feeding the analyser
    this.buffer = null;      // AudioBuffer of the loaded file
    this.osc = null;
    this.bowl = null;
    this.bowlHz = 196;
    this.micStream = null;
    this.mode = 'none';      // none | file | mic | tone
    this.playing = false;
    this.volume = 0.7;

    this.dbData = null;
    this.spectrum = null;    // linear amplitude per bin
    this.binHz = 0;
    this.bins = 0;
    this.dominantHz = 0;
    this.centroidHz = 0;
    this.level = 0;
    this.levelRef = 0;
    this.levelNorm = 0;
    this.sweep = null;
    this.onstate = () => {};
  }

  ensureCtx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = FLOOR_DB;
    this.analyser.maxDecibels = -10;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    this.bins = this.analyser.frequencyBinCount;
    this.dbData = new Float32Array(this.bins);
    this.spectrum = new Float32Array(this.bins);
    this.binHz = this.ctx.sampleRate / this.analyser.fftSize;
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  disconnectSource() {
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
      if (this.source.stop) { try { this.source.stop(); } catch (_) {} }
      this.source = null;
    }
    if (this.osc) {
      try { this.osc.stop(); this.osc.disconnect(); } catch (_) {}
      this.osc = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    if (this.bowl) this.bowl.stop();
    this.sweep = null;
    this.playing = false;
  }

  async loadFile(file) {
    this.ensureCtx();
    const bytes = await file.arrayBuffer();
    return this.decodeInto(bytes, file.name);
  }

  async loadUrl(url, label) {
    this.ensureCtx();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} al pedir ${url}`);
    return this.decodeInto(await res.arrayBuffer(), label);
  }

  async decodeInto(bytes, label) {
    this.buffer = await this.ctx.decodeAudioData(bytes);
    this.mode = 'file';
    this.fileName = label;
    this.onstate();
    return this.buffer.duration;
  }

  play() {
    if (this.mode !== 'file' || !this.buffer) return;
    this.ensureCtx();
    this.ctx.resume();
    this.disconnectSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.analyser);
    src.connect(this.master);
    src.start();
    this.source = src;
    this.mode = 'file';
    this.playing = true;
    this.onstate();
  }

  stop() {
    this.disconnectSource();
    this.onstate();
  }

  async useMic() {
    this.ensureCtx();
    await this.ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.disconnectSource();
    this.micStream = stream;
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.analyser); // not connected to output: avoids feedback
    this.source = src;
    this.mode = 'mic';
    this.playing = true;
    this.onstate();
  }

  useTone(hz) {
    this.ensureCtx();
    this.ctx.resume();
    this.disconnectSource();
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    osc.connect(this.analyser);
    osc.connect(this.master);
    osc.start();
    this.osc = osc;
    this.toneHz = hz;
    this.mode = 'tone';
    this.playing = true;
    this.onstate();
  }

  /** Synthesised singing bowl: sustained rubbing plus an opening strike. */
  useBowl(hz) {
    this.ensureCtx();
    this.ctx.resume();
    this.disconnectSource();
    if (!this.bowl) this.bowl = new SingingBowl(this.ctx, [this.analyser, this.master]);
    this.bowl.rub(hz);
    this.bowl.strike(hz, 0.4);
    this.bowlHz = hz;
    this.mode = 'bowl';
    this.playing = true;
    this.onstate();
  }

  strikeBowl() {
    if (this.bowl) this.bowl.strike(this.bowlHz);
  }

  setBowlHz(hz) {
    this.bowlHz = hz;
    if (this.bowl) this.bowl.setF0(hz);
  }

  setToneHz(hz) {
    // frequency.value does not reflect scheduled changes, so the requested value is
    // kept separately in order to display it.
    this.toneHz = hz;
    if (this.osc) this.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
  }

  startSweep(fromHz, toHz, seconds) {
    this.useTone(fromHz);
    const t0 = this.ctx.currentTime;
    this.osc.frequency.setValueAtTime(fromHz, t0);
    this.osc.frequency.exponentialRampToValueAtTime(toHz, t0 + seconds);
    this.sweep = { fromHz, toHz, seconds, t0 };
    this.onstate();
  }

  get sweepHz() {
    if (!this.sweep || !this.ctx) return null;
    const t = (this.ctx.currentTime - this.sweep.t0) / this.sweep.seconds;
    if (t >= 1) return null;
    return this.sweep.fromHz * Math.pow(this.sweep.toHz / this.sweep.fromHz, Math.max(0, t));
  }

  // Refreshes spectrum, peak and level. Call once per frame.
  update() {
    if (!this.analyser) return false;
    this.analyser.getFloatFrequencyData(this.dbData);

    const n = this.bins;
    const spec = this.spectrum;
    let sum = 0;
    let peakIdx = 0;
    let peakVal = 0;
    let cenNum = 0;
    let cenDen = 0;

    // Ignore the DC/infrasonic bins: they add noise and drag the peak around.
    const lo = Math.max(2, Math.floor(20 / this.binHz));
    const hi = Math.min(n - 2, Math.floor(6000 / this.binHz));

    for (let i = 0; i < n; i++) {
      const db = this.dbData[i];
      const amp = db <= FLOOR_DB ? 0 : Math.pow(10, db / 20);
      spec[i] = amp;
      if (i >= lo && i <= hi) {
        sum += amp * amp;
        cenNum += amp * i * this.binHz;
        cenDen += amp;
        if (amp > peakVal) { peakVal = amp; peakIdx = i; }
      }
    }

    // Total energy across the audible band, not the mean per bin: a pure tone puts all
    // of its energy in one bin and a mean would make it look like silence.
    this.level = Math.sqrt(sum);

    // Control automatico de ganancia. El nivel absoluto depende de como este
    // masterizada la track, y un playTone puro concentra mucha mas energia por bin que
    // una mezcla. Sin normalizar, una cancion normal se queda por debajo del umbral
    // de Faraday y el water no se mueve. levelRef sigue al pico con ataque rapido y
    // caida lenta, asi que en silencio decae y levelNorm vuelve a cero solo.
    const k = this.level > this.levelRef ? 0.35 : 0.0025;
    this.levelRef += (this.level - this.levelRef) * k;
    this.levelNorm = Math.min(1.2, this.level / Math.max(this.levelRef, 0.02));

    // Parabolic interpolation in dB around the peak -> sub-bin resolution.
    if (peakVal > 0 && peakIdx > 0 && peakIdx < n - 1) {
      const a = this.dbData[peakIdx - 1];
      const b = this.dbData[peakIdx];
      const c = this.dbData[peakIdx + 1];
      const den = a - 2 * b + c;
      const delta = den !== 0 ? 0.5 * (a - c) / den : 0;
      this.dominantHz = (peakIdx + Math.max(-1, Math.min(1, delta))) * this.binHz;
    } else {
      this.dominantHz = 0;
    }

    // Centroide espectral: el "brightness" de lo que suena. En musica real el bin de pico
    // salta entre el bombo y un platillo de un frame al siguiente, y arrastrar Omega
    // detras de el impide que el forzado parametrico acumule fase coherente: el water
    // nunca llega a crecer. El centroide se mueve despacio y es lo que hay que seguir.
    const cen = cenDen > 0 ? cenNum / cenDen : 0;
    this.centroidHz = this.centroidHz ? this.centroidHz * 0.88 + cen * 0.12 : cen;
    return true;
  }

  // Spectral energy weighted by a Lorentzian centred on fHz with quality factor Q.
  // This is the response of a damped oscillator driven by that spectrum.
  resonantEnergy(fHz, Q) {
    if (!this.spectrum || fHz <= 0) return 0;
    const halfWidth = fHz / Q;
    const lo = Math.max(1, Math.floor((fHz - 8 * halfWidth) / this.binHz));
    const hi = Math.min(this.bins - 1, Math.ceil((fHz + 8 * halfWidth) / this.binHz));
    let acc = 0;
    for (let i = lo; i <= hi; i++) {
      const amp = this.spectrum[i];
      if (amp === 0) continue;
      const df = i * this.binHz - fHz;
      acc += amp * (halfWidth * halfWidth) / (df * df + halfWidth * halfWidth);
    }
    return acc;
  }

  describe() {
    if (this.mode === 'none') return 'No source. Load a file or open the microphone.';
    if (this.mode === 'file') {
      return (this.playing ? 'Playing: ' : 'Loaded: ') + (this.fileName || 'audio');
    }
    if (this.mode === 'mic') return 'Live microphone (not routed to the speakers).';
    if (this.mode === 'bowl') return `Singing bowl, fundamental ${this.bowlHz.toFixed(0)} Hz`;
    if (this.mode === 'tone') {
      const s = this.sweepHz;
      return s ? `Sweeping at ${s.toFixed(0)} Hz` : `Pure tone at ${this.toneHz ? this.toneHz.toFixed(0) : '—'} Hz`;
    }
    return '';
  }
}
