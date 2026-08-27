// Chladni plate: superposition of eigenmodes excited by the audio spectrum.
//
// Circular dish (membrane): u_nm = J_n(alpha_nm * r/R) * cos(n*th + phase),
//   f_nm / f_01 = alpha_nm / alpha_01
// Square plate (classic free-edge approximation):
//   u_nm = cos(n*pi*x)*cos(m*pi*y) +- cos(m*pi*x)*cos(n*pi*y),  f ~ sqrt(n^2+m^2)
//
// Fine powder gathers where u = 0, on the nodal lines. A heavy liquid does the
// opposite and gathers on the antinodes. Both render modes are available.

import { besselZeros, besselTable } from './bessel.js';
import { getContext, program, quadVAO, createTexture } from './glutil.js';

const MAX_MODES = 48;
const BESSEL_ORDERS = 16;
const BESSEL_W = 1024;
const BESSEL_XMAX = 70;

const FS = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform vec4  uModes[${MAX_MODES}];   // circular: (n, alpha, amp, phase) | square: (n, m, amp, sign)
uniform int   uCount;
uniform int   uShape;                 // 0 = circle, 1 = square
uniform int   uPowder;                // 0 = powder on nodes, 1 = liquid on antinodes
uniform float uSigma;
uniform sampler2D uBessel;
uniform float uBesselXMax;
uniform float uBesselRows;

const float PI = 3.141592653589793;

float besselJ(float n, float x) {
  if (x > uBesselXMax) return 0.0;
  return texture(uBessel, vec2(x / uBesselXMax, (n + 0.5) / uBesselRows)).r;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float u = 0.0;
  float mask = 1.0;
  float edge = 0.0;

  if (uShape == 0) {
    float r = length(p);
    mask = 1.0 - smoothstep(0.965, 0.995, r);
    edge = smoothstep(0.93, 0.975, r) * (1.0 - smoothstep(0.985, 1.0, r));
    if (r <= 1.0) {
      float th = atan(p.y, p.x);
      for (int i = 0; i < ${MAX_MODES}; i++) {
        if (i >= uCount) break;
        vec4 md = uModes[i];
        float J = besselJ(md.x, md.y * r);
        u += md.z * J * cos(md.x * th + md.w);
      }
    }
  } else {
    vec2 q = vUV;
    float m = min(min(q.x, q.y), min(1.0 - q.x, 1.0 - q.y));
    mask = smoothstep(0.0, 0.006, m);
    edge = (1.0 - smoothstep(0.0, 0.02, m)) * smoothstep(0.0, 0.004, m);
    for (int i = 0; i < ${MAX_MODES}; i++) {
      if (i >= uCount) break;
      vec4 md = uModes[i];
      float a = cos(md.x * PI * q.x) * cos(md.y * PI * q.y);
      float b = cos(md.y * PI * q.x) * cos(md.x * PI * q.y);
      u += md.z * (a + md.w * b);
    }
  }

  float au = abs(u);
  float dust;
  if (uPowder == 0) {
    // Nodal lines: powder collects where the amplitude vanishes.
    float t = au / max(uSigma, 1e-4);
    dust = exp(-t * t);
  } else {
    // Antinodes: liquid gathers where the plate moves most.
    float t = clamp(au / max(uSigma * 14.0, 1e-4), 0.0, 1.0);
    dust = pow(t, 2.2);
  }

  vec3 plate = mix(vec3(0.035, 0.042, 0.055), vec3(0.075, 0.085, 0.105),
                   0.5 + 0.5 * clamp(u * 2.0, -1.0, 1.0));
  vec3 matter = (uPowder == 0)
      ? mix(vec3(0.55, 0.45, 0.30), vec3(1.0, 0.93, 0.76), dust)
      : mix(vec3(0.10, 0.32, 0.48), vec3(0.62, 0.90, 1.0), dust);

  vec3 col = mix(plate, matter, dust);
  col += edge * vec3(0.10, 0.12, 0.16);
  col *= mask;
  fragColor = vec4(col, 1.0);
}`;

function buildCircularModes() {
  const modes = [];
  const alpha01 = besselZeros(0, 1)[0]; // 2.404826
  for (let n = 0; n < BESSEL_ORDERS; n++) {
    const zs = besselZeros(n, 8);
    for (let m = 0; m < zs.length; m++) {
      const alpha = zs[m];
      if (alpha > BESSEL_XMAX) continue;
      modes.push({
        label: `(${n},${m + 1})`,
        n,
        alpha,
        ratio: alpha / alpha01,
        // Fixed per-mode phase: breaks the cos/sin degeneracy deterministically.
        phase: n === 0 ? 0 : ((n * 2654435761 + m * 40503) % 1000) / 1000 * Math.PI,
        weight: 1,
      });
    }
  }
  modes.sort((a, b) => a.ratio - b.ratio);
  return modes.slice(0, 220);
}

function buildSquareModes() {
  const modes = [];
  const base = Math.sqrt(1 + 4); // mode (1,2)
  for (let n = 1; n <= 12; n++) {
    for (let m = n + 1; m <= 13; m++) {
      const ratio = Math.sqrt(n * n + m * m) / base;
      for (const sign of [-1, 1]) {
        // The two degenerate combinations share a frequency; which one dominates depends
        // on where you drive the plate. Driven from the centre the antisymmetric one
        // wins, and that is what gives the classic Chladni figures. The other remains
        // as a perturbation, which is what breaks perfect symmetry on a real plate.
        const jitter = ((n * 7919 + m * 104729 + (sign > 0 ? 31 : 17)) % 1000) / 1000;
        modes.push({
          label: `(${n},${m})${sign < 0 ? '−' : '+'}`,
          n, m, sign, ratio,
          weight: sign < 0 ? 0.85 + 0.30 * jitter : 0.12 + 0.28 * jitter,
        });
      }
    }
  }
  modes.sort((a, b) => a.ratio - b.ratio);
  return modes;
}

export class ChladniView {
  constructor(canvas) {
    this.gl = getContext(canvas);
    this.canvas = canvas;
    this.prog = program(this.gl, FS);
    this.vao = quadVAO(this.gl);

    const tbl = besselTable(BESSEL_ORDERS - 1, BESSEL_W, BESSEL_XMAX);
    this.besselTex = createTexture(
      this.gl, tbl.width, tbl.height,
      this.gl.R16F, this.gl.RED, this.gl.FLOAT,
      tbl.data, this.gl.LINEAR,
    );
    this.besselRows = tbl.height;

    this.circular = buildCircularModes();
    this.square = buildSquareModes();

    this.shape = 'circle';
    this.powder = 'node';
    this.f0 = 90;
    this.Q = 45;
    this.sigma = 0.045;
    this.persist = 0.82;

    this.amps = new Float32Array(Math.max(this.circular.length, this.square.length));
    this.uniformData = new Float32Array(MAX_MODES * 4);
    this.count = 0;
    this.top = [];
  }

  get modeList() { return this.shape === 'circle' ? this.circular : this.square; }

  setShape(shape) {
    if (shape === this.shape) return;
    this.shape = shape;
    this.amps.fill(0);
  }

  // Excite each mode with the spectral energy near its eigenfrequency.
  excite(audio) {
    const list = this.modeList;
    const a = this.amps;
    const k = this.persist;
    let maxAmp = 0;

    for (let i = 0; i < list.length; i++) {
      const f = this.f0 * list[i].ratio;
      let e = 0;
      if (f < 12000) e = audio.resonantEnergy(f, this.Q) * list[i].weight;
      a[i] = k * a[i] + (1 - k) * e;
      if (a[i] > maxAmp) maxAmp = a[i];
    }
    for (let i = list.length; i < a.length; i++) a[i] = 0;

    // Keep the most excited modes: they are the ones that define the figure.
    const idx = [];
    if (maxAmp > 1e-9) {
      const cut = maxAmp * 0.035;
      for (let i = 0; i < list.length; i++) if (a[i] > cut) idx.push(i);
      idx.sort((x, y) => a[y] - a[x]);
      idx.length = Math.min(idx.length, MAX_MODES);
    }

    // Normalise by total energy: the figure should not pulse with the volume.
    let norm = 0;
    for (const i of idx) norm += a[i] * a[i];
    norm = norm > 0 ? 1 / Math.sqrt(norm) : 0;

    const d = this.uniformData;
    d.fill(0);
    for (let j = 0; j < idx.length; j++) {
      const md = list[idx[j]];
      const amp = a[idx[j]] * norm;
      const o = j * 4;
      if (this.shape === 'circle') {
        d[o] = md.n; d[o + 1] = md.alpha; d[o + 2] = amp; d[o + 3] = md.phase;
      } else {
        d[o] = md.n; d[o + 1] = md.m; d[o + 2] = amp; d[o + 3] = md.sign;
      }
    }
    this.count = idx.length;
    this.top = idx.slice(0, 4).map(i => ({
      label: list[i].label,
      hz: this.f0 * list[i].ratio,
      amp: a[i] * norm,
    }));
  }

  render() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.vao);
    this.prog.use()
      .v4a('uModes', this.uniformData)
      .i('uCount', this.count | 0)
      .i('uShape', this.shape === 'circle' ? 0 : 1)
      .i('uPowder', this.powder === 'node' ? 0 : 1)
      .f('uSigma', this.sigma)
      .f('uBesselXMax', BESSEL_XMAX)
      .f('uBesselRows', this.besselRows)
      .tex('uBessel', this.besselTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  readout() {
    if (!this.top.length) return 'No excitation. Raise the volume or load a source.';
    const modes = this.top
      .map(t => `${t.label} @ ${t.hz.toFixed(0)}Hz ${(t.amp * 100).toFixed(0)}%`)
      .join('   ');
    return `f₀ = ${this.f0} Hz · ${this.count} active modes\n${modes}`;
  }
}
