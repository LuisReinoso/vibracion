// Tibetan singing bowl, by modal synthesis.
//
// A singing bowl is an axisymmetric bell. It vibrates in flexural modes (m,0), where m
// is the number of nodal diameters: m=2 gives four sectors, m=3 gives six, and so on.
// For a thin ring the theory gives f_m proportional to m(m^2-1)/sqrt(m^2+1), that is
// 1 : 2.83 : 5.42 : 8.77 relative to the fundamental. A real bowl is not a thin ring and
// departs from that, so the ratios below are the ones measured by Inacio, Henrique and
// Antunes in "The dynamics of Tibetan singing bowls" (Acta Acustica, 2006).
//
// What matters here is that the partials are INHARMONIC. They are not integer multiples
// of the fundamental, so they excite plate eigenmodes that bear no harmonic relation to
// each other, and the Chladni figure that comes out looks nothing like the one a string
// would produce on the same note.
//
// The other signature of a bowl is beating. No bowl is perfectly round, and that
// asymmetry splits every mode in two with almost equal frequencies. Sounding together
// they produce the slow warble that identifies the instrument. On water it shows up as
// the pattern breathing in time with the beat.

const MODES = [
  // ratio, struck amplitude, rubbed amplitude, T60 in seconds
  { ratio: 1.000, struckAmp: 1.00, rubbedAmp: 1.00, t60: 32 },
  { ratio: 2.770, struckAmp: 0.55, rubbedAmp: 0.34, t60: 13 },
  { ratio: 5.180, struckAmp: 0.30, rubbedAmp: 0.16, t60: 6.0 },
  { ratio: 8.120, struckAmp: 0.17, rubbedAmp: 0.07, t60: 3.0 },
  { ratio: 11.53, struckAmp: 0.09, rubbedAmp: 0.03, t60: 1.6 },
];

// Relative split from asymmetry: gives a beat of a couple of hertz on the fundamental,
// which is the right order of magnitude for a real bowl.
const SPLIT = 0.004;

export class SingingBowl {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode[]} outputs nodes to feed (analyser and master)
   */
  constructor(ctx, outputs) {
    this.ctx = ctx;
    this.outputs = outputs;
    this.f0 = 196;
    this.voices = [];     // sustained partials of the rubbed tone
    this.strikes = [];    // per-strike nodes, they clean themselves up
    this.mix = ctx.createGain();
    this.mix.gain.value = 0.9;
    for (const o of outputs) this.mix.connect(o);
  }

  /** Rub the rim: sustained excitation, dominated by the fundamental. */
  rub(f0 = this.f0) {
    this.stop();
    this.f0 = f0;
    const t = this.ctx.currentTime;

    for (const m of MODES) {
      for (const sign of [-1, 1]) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f0 * m.ratio * (1 + sign * SPLIT / 2);
        // Rubbing is stick-slip: the sound is born and grows, it does not just appear.
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(m.rubbedAmp * 0.5, t + 1.8);
        osc.connect(gain).connect(this.mix);
        osc.start();
        this.voices.push({ osc, gain, mode: m, sign });
      }
    }
  }

  /**
   * Strike with the mallet: every mode at once, each with its own decay.
   *
   * @param {number} strength 1 is a real strike. The strike that accompanies the rubbed
   *   tone is softer on purpose: otherwise its peak drives the automatic gain control in
   *   the audio engine, and the sustained tone that follows spends ten seconds below the
   *   Faraday threshold.
   */
  strike(f0 = this.f0, strength = 1) {
    const t = this.ctx.currentTime;
    for (const m of MODES) {
      for (const sign of [-1, 1]) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f0 * m.ratio * (1 + sign * SPLIT / 2);
        const peak = m.struckAmp * 0.5 * strength;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.006);
        // T60 is the time to fall 60 dB, a factor of 1000.
        gain.gain.exponentialRampToValueAtTime(peak / 1000, t + m.t60);
        osc.connect(gain).connect(this.mix);
        osc.start(t);
        osc.stop(t + m.t60 + 0.1);
        osc.onended = () => {
          try { osc.disconnect(); gain.disconnect(); } catch (_) {}
          this.strikes = this.strikes.filter(s => s.osc !== osc);
        };
        this.strikes.push({ osc, gain });
      }
    }
  }

  /** Change the bowl size without cutting the sound. */
  setF0(f0) {
    this.f0 = f0;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      v.osc.frequency.setTargetAtTime(f0 * v.mode.ratio * (1 + v.sign * SPLIT / 2), t, 0.05);
    }
  }

  stop(fadeOut = 0.4) {
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + fadeOut);
      v.osc.stop(t + fadeOut + 0.05);
    }
    this.voices = [];
    for (const s of this.strikes) {
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setValueAtTime(s.gain.gain.value, t);
      s.gain.gain.linearRampToValueAtTime(0, t + fadeOut);
    }
    this.strikes = [];
  }

  get sounding() { return this.voices.length > 0 || this.strikes.length > 0; }

  /** Partial frequencies, so they can be displayed. */
  partials(f0 = this.f0) {
    return MODES.map((m, i) => ({
      // m=2 gives four sectors, m=3 gives six, and so on.
      nodalDiameters: i + 2,
      hz: f0 * m.ratio,
      ratio: m.ratio,
      beatHz: f0 * m.ratio * SPLIT,
    }));
  }
}
