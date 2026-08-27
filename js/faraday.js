// Faraday waves: GPU free-surface solver with an oscillating effective gravity.
//
// Model (shallow water plus capillarity, linearised, with cubic saturation):
//   dh/dt   = -H * lap(phi)
//   dphi/dt = -g(t)*h + S*lap(h) + nu*lap(phi) - gamma*(1 + beta*h^2)*phi
//   g(t)    = g0 * (1 + F*cos(Omega*t))
//
// Dispersion relation: omega(k)^2 = H*(g0*k^2 + S*k^4).
// With a periodic g(t) every mode obeys a Mathieu equation, and the leading
// instability tongue is the SUBHARMONIC one, omega(k) = Omega/2. That is why water
// responds at half the frequency you shake the container at, and why raising the
// pitch shortens the pattern wavelength.
//
// The nu*lap(phi) term is viscous dissipation: it damps at rate nu*k^2, so it hits
// short waves far harder. Without it the instability threshold F_c = 2(gamma +
// nu k^2)/omega(k) would fall as k rises and the pattern would collapse to grid
// scale, which is numerical noise rather than physics. With it there is a genuine
// preferred k.
//
// Symplectic integration (semi-implicit Euler) in two ping-pong passes.

import { getContext, program, quadVAO, pingpong } from './glutil.js';

const N = 256;
const DT = 0.05;
// The instability takes tens of simulation time units to grow out of the noise. With
// too few substeps per frame the pattern never forms before the music changes pitch
// and detunes the resonance tongue.
const SUBSTEPS = 24;
const G0 = 1.0;
const DEPTH = 1.0;
const BETA = 4.0;
const GAMMA0 = 0.008;   // residual damping, independent of k

const COMMON = `
const float PI = 3.141592653589793;

float shapeMask(vec2 uv, int shape) {
  if (shape == 0) {
    return length(uv * 2.0 - 1.0) < 0.965 ? 1.0 : 0.0;
  }
  float m = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  return m > 0.02 ? 1.0 : 0.0;
}

// Absorbing layer next to the wall, about eight cells wide. A hard wall on a
// Cartesian grid is a staircase of pixels: it reflects short waves and fills the rim
// with numerical speckle. This soft profile eats them before they bounce.
float sponge(vec2 uv, int shape) {
  if (shape == 0) {
    return 1.0 - smoothstep(0.90, 0.965, length(uv * 2.0 - 1.0));
  }
  float m = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  return smoothstep(0.018, 0.060, m);
}

float hash(vec2 p, float seed) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + seed);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z) * 2.0 - 1.0;
}

// Isotropic 9-point Laplacian (2/3 on edges, 1/6 on corners). The 5-point stencil
// carries order-k^2 anisotropy and aligns stripes with the grid axes, which is a
// numerical artefact rather than a direction the fluid chose.
vec2 lap9(sampler2D tex, ivec2 ij, ivec2 sz, vec2 c) {
  ivec2 lo = ivec2(0), hi = sz - 1;
  vec2 e = texelFetch(tex, clamp(ij + ivec2(-1,  0), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2( 1,  0), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2( 0, -1), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2( 0,  1), lo, hi), 0).rg;
  vec2 d = texelFetch(tex, clamp(ij + ivec2(-1, -1), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2( 1, -1), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2(-1,  1), lo, hi), 0).rg
         + texelFetch(tex, clamp(ij + ivec2( 1,  1), lo, hi), 0).rg;
  return (2.0 / 3.0) * e + (1.0 / 6.0) * d - (10.0 / 3.0) * c;
}`;

const SEED_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform int uShape;
uniform float uSeed;
${COMMON}
void main() {
  float m = shapeMask(vUV, uShape);
  float h = hash(gl_FragCoord.xy, uSeed) * 0.02;
  fragColor = vec4(h * m, 0.0, 0.0, 1.0);
}`;

const STEP_PHI_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uState;
uniform float uDt, uG, uF, uPhase, uS, uNu, uGamma, uBeta, uNoise, uSeed;
uniform int uShape;
${COMMON}
void main() {
  ivec2 sz = textureSize(uState, 0);
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(ij) + 0.5) / vec2(sz);
  float m = sponge(uv, uShape);
  if (m <= 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec2 c = texelFetch(uState, ij, 0).rg;
  float h = c.r, phi = c.g;

  vec2 lap = lap9(uState, ij, sz, c);
  float lapH = lap.x, lapPhi = lap.y;

  // Oscillating effective gravity: the Faraday parametric drive.
  float g = uG * (1.0 + uF * cos(uPhase));
  // Saturation: dissipation grows with amplitude and halts the exponential growth of
  // the instability tongue. Applied to the full dissipation.
  float sat = 1.0 + uBeta * h * h;

  phi += uDt * (-g * h + uS * lapH + sat * (uNu * lapPhi - uGamma * phi));
  phi += uNoise * hash(gl_FragCoord.xy, uSeed);

  fragColor = vec4(h * m, phi * m, 0.0, 1.0);
}`;

const STEP_H_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uState;
uniform float uDt, uH;
uniform int uShape;
${COMMON}
void main() {
  ivec2 sz = textureSize(uState, 0);
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(ij) + 0.5) / vec2(sz);
  float m = sponge(uv, uShape);
  if (m <= 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec2 c = texelFetch(uState, ij, 0).rg;
  float h = c.r, phi = c.g;

  float lapPhi = lap9(uState, ij, sz, c).y;

  h += -uDt * uH * lapPhi;
  h = clamp(h, -8.0, 8.0);

  fragColor = vec4(h * m, phi * m, 0.0, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uState;
uniform float uScale;
uniform int uShape;
${COMMON}
void main() {
  ivec2 sz = textureSize(uState, 0);
  ivec2 ij = ivec2(vUV * vec2(sz));
  ij = clamp(ij, ivec2(0), sz - 1);
  float m = shapeMask(vUV, uShape);

  float h  = texelFetch(uState, ij, 0).r * uScale;
  float hL = texelFetch(uState, clamp(ij + ivec2(-1, 0), ivec2(0), sz - 1), 0).r * uScale;
  float hR = texelFetch(uState, clamp(ij + ivec2( 1, 0), ivec2(0), sz - 1), 0).r * uScale;
  float hD = texelFetch(uState, clamp(ij + ivec2(0, -1), ivec2(0), sz - 1), 0).r * uScale;
  float hU = texelFetch(uState, clamp(ij + ivec2(0,  1), ivec2(0), sz - 1), 0).r * uScale;

  vec3 n = normalize(vec3(-(hR - hL) * 0.5, -(hU - hD) * 0.5, 0.25));
  vec3 L = normalize(vec3(0.42, 0.55, 0.72));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 Hv = normalize(L + V);

  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(n, Hv), 0.0, 1.0), 60.0);
  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);

  // Caustics follow curvature: troughs focus light onto the bottom.
  float lap = lap9(uState, ij, sz, vec2(h, 0.0) / uScale).x * uScale;
  float caustic = clamp(-lap * 2.5, -0.6, 1.4);

  vec3 deep    = vec3(0.015, 0.055, 0.095);
  vec3 shallow = vec3(0.06, 0.28, 0.40);
  vec3 col = mix(deep, shallow, clamp(h * 0.5 + 0.5, 0.0, 1.0));
  col += caustic * vec3(0.10, 0.22, 0.26);
  col += diff * vec3(0.06, 0.13, 0.17);
  col += spec * vec3(1.0, 0.96, 0.88) * 0.85;
  col += fres * vec3(0.10, 0.18, 0.26);

  vec3 wall = vec3(0.05, 0.055, 0.065);
  fragColor = vec4(mix(wall, col, m), 1.0);
}`;

export class FaradayView {
  constructor(canvas) {
    const gl = getContext(canvas);
    this.gl = gl;
    this.canvas = canvas;

    let internal = null;
    if (gl.getExtension('EXT_color_buffer_float')) {
      internal = gl.RGBA32F;
    } else if (gl.getExtension('EXT_color_buffer_half_float')) {
      internal = gl.RGBA16F;
    } else {
      throw new Error('Faltan las extensiones de render a punto flotante (EXT_color_buffer_float).');
    }
    this.type = internal === gl.RGBA32F ? gl.FLOAT : gl.HALF_FLOAT;

    this.vao = quadVAO(gl);
    this.pSeed = program(gl, SEED_FS);
    this.pPhi = program(gl, STEP_PHI_FS);
    this.pH = program(gl, STEP_H_FS);
    this.pRender = program(gl, RENDER_FS);
    this.state = pingpong(gl, N, N, internal, gl.RGBA, this.type);

    this.shape = 'circle';
    this.omega = 1.0;
    this.omegaMin = 0.30;
    this.omegaMax = 1.80;
    this.S = 0.05;
    this.nu = 0.030;
    this.forceGain = 0.30;
    this.force = 0;
    this.phase = 0;
    this.locked = false;
    this.seed = 0.371;

    this.reset();
  }

  reset() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, N, N);
    for (const target of [this.state.read, this.state.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      this.pSeed.use().i('uShape', this.shape === 'circle' ? 0 : 1).f('uSeed', this.seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.seed = (this.seed + 0.317) % 1;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    this.phase = 0;
  }

  setShape(shape) {
    if (shape === this.shape) return;
    this.shape = shape;
    this.reset();
  }

  // Maps the audio brightness (log) onto the useful Omega range.
  setFromAudio(hz, level) {
    if (!this.locked && hz > 20) {
      const t = Math.log(Math.min(6000, hz) / 40) / Math.log(6000 / 40);
      const target = this.omegaMin + Math.max(0, Math.min(1, t)) * (this.omegaMax - this.omegaMin);
      this.omega += (target - this.omega) * 0.06; // seguimiento suave
    }
    // level arrives already normalised by the audio engine gain control.
    //
    // The drive has a floor while anything is playing. Without it a quiet passage takes
    // F below F_c, the pattern dissolves, and regrowing from noise costs tens of
    // seconds, far longer than the passage lasts. The result was a flat dish for most
    // of the track. With a floor, the music modulates amplitude and wavelength instead
    // of switching the instability on and off. The gate still lets the water settle
    // completely when there is no signal.
    const puerta = Math.min(1, Math.max(0, (level - 0.05) / 0.15));
    const drive = puerta * (0.45 + 0.55 * Math.min(1, Math.max(0, level)));
    this.force = this.forceGain * drive;
  }

  step() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, N, N);
    const shape = this.shape === 'circle' ? 0 : 1;

    for (let s = 0; s < SUBSTEPS; s++) {
      this.phase = (this.phase + this.omega * DT) % (2 * Math.PI);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.write.fbo);
      this.pPhi.use()
        .tex('uState', this.state.read.tex)
        .f('uDt', DT).f('uG', G0).f('uF', this.force).f('uPhase', this.phase)
        .f('uS', this.S).f('uNu', this.nu).f('uGamma', GAMMA0).f('uBeta', BETA)
        .f('uNoise', 1.0e-4).f('uSeed', (this.seed + s * 0.0173) % 1)
        .i('uShape', shape);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.state.swap();

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.write.fbo);
      this.pH.use()
        .tex('uState', this.state.read.tex)
        .f('uDt', DT).f('uH', DEPTH)
        .i('uShape', shape);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.state.swap();
    }
    this.seed = (this.seed + 0.0611) % 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  render() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.vao);
    this.pRender.use()
      .tex('uState', this.state.read.tex)
      .f('uScale', 0.40)
      .i('uShape', this.shape === 'circle' ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Selected subharmonic wavenumber: omega(k) = Omega/2.
  selectedK() {
    const target = (this.omega / 2) ** 2 / DEPTH;
    if (this.S < 1e-6) return Math.sqrt(target / G0);
    const disc = G0 * G0 + 4 * this.S * target;
    const k2 = (-G0 + Math.sqrt(disc)) / (2 * this.S);
    return k2 > 0 ? Math.sqrt(k2) : 0;
  }

  // Mathieu threshold for the subharmonic tongue: F_c = 2 * (dissipation rate) / omega.
  // Below it the surface stays flat no matter how far you turn the volume up.
  threshold() {
    const k = this.selectedK();
    const w = this.omega / 2;
    if (w <= 0) return Infinity;
    return 2 * (GAMMA0 + this.nu * k * k) / w;
  }

  readout(hz) {
    const k = this.selectedK();
    const lambdaCells = k > 0 ? (2 * Math.PI) / k : Infinity;
    const across = k > 0 ? (N / lambdaCells).toFixed(1) : '—';
    const src = hz > 20 ? `centroid ${hz.toFixed(0)} Hz` : '—';
    const fc = this.threshold();
    const ratio = fc > 0 && isFinite(fc) ? (this.force / fc) : 0;
    const state = ratio >= 1 ? `${ratio.toFixed(1)}× threshold` : 'below threshold, flat';
    return `${src} → Ω = ${this.omega.toFixed(2)}${this.locked ? ' (fijada)' : ''} · responds at Ω/2 = ${(this.omega / 2).toFixed(2)}\n`
      + `λ = ${lambdaCells.toFixed(1)} cells (${across} waves across)\n`
      + `F = ${this.force.toFixed(3)} · F_c = ${fc.toFixed(3)} → ${state}`;
  }
}

export const FARADAY_N = N;
