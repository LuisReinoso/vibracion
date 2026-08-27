// Panel for the Zakharov solver: wires it to the audio and draws it as water.
//
// The solver itself lives in zakharov.js and knows nothing about audio or screens. Here
// it gets Omega from the spectral centroid and F from the level, the same way faraday.js
// does, and the height field is rendered.

import { program, getContext } from './glutil.js';
import { Zakharov } from './zakharov.js';

const N = 128;

const RENDER_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uField;
uniform float uScale;

// Smooth interpolation done by hand. We cannot ask the texture for LINEAR filtering:
// it is RGBA32F, which is not filterable without OES_texture_float_linear, and asking
// anyway leaves the texture incomplete so every read returns zero.
float heightAt(ivec2 ij, ivec2 sz) {
  return texelFetch(uField, clamp(ij, ivec2(0), sz - 1), 0).r;
}

float height(vec2 uv) {
  ivec2 sz = textureSize(uField, 0);
  vec2 p = uv * vec2(sz) - 0.5;
  ivec2 b = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);            // Hermite smoothing
  float a = mix(heightAt(b + ivec2(0, 0), sz), heightAt(b + ivec2(1, 0), sz), w.x);
  float c = mix(heightAt(b + ivec2(0, 1), sz), heightAt(b + ivec2(1, 1), sz), w.x);
  return mix(a, c, w.y);
}

void main() {
  vec2 d = 1.0 / vec2(textureSize(uField, 0));
  float h  = height(vUV) * uScale;
  float hL = height(vUV - vec2(d.x, 0.0)) * uScale;
  float hR = height(vUV + vec2(d.x, 0.0)) * uScale;
  float hD = height(vUV - vec2(0.0, d.y)) * uScale;
  float hU = height(vUV + vec2(0.0, d.y)) * uScale;

  vec3 n = normalize(vec3(-(hR - hL) * 0.5, -(hU - hD) * 0.5, 0.25));
  vec3 L = normalize(vec3(0.42, 0.55, 0.72));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 Hv = normalize(L + V);

  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(clamp(dot(n, Hv), 0.0, 1.0), 60.0);
  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
  float lap = hL + hR + hD + hU - 4.0 * h;
  float caustic = clamp(-lap * 2.5, -0.6, 1.4);

  vec3 col = mix(vec3(0.015, 0.055, 0.095), vec3(0.06, 0.28, 0.40), clamp(h * 0.5 + 0.5, 0.0, 1.0));
  col += caustic * vec3(0.10, 0.22, 0.26);
  col += diff * vec3(0.06, 0.13, 0.17);
  col += spec * vec3(1.0, 0.96, 0.88) * 0.85;
  col += fres * vec3(0.10, 0.18, 0.26);
  fragColor = vec4(col, 1.0);
}`;

export class FaithfulView {
  constructor(canvas) {
    const gl = getContext(canvas);
    this.gl = gl;
    this.canvas = canvas;
    this.z = new Zakharov(gl, N);
    this.vao = this.z.vao;
    this.pRender = program(gl, RENDER_FS);

    // Capillary regime, low dissipation: where Chen and Vinals predict squares, and
    // where real water in a dish driven at tens of hertz actually sits.
    this.z.sigma = 8;
    this.z.h = 6;
    this.z.nu = 0.01;
    this.z.dt = 0.03;
    this.z.noiseFloor = 6e-4;

    this.targetRing = 13;
    this.stepsPerFrame = 26;
    this.gain = 5.0;
    this.locked = false;
    this.seed();
  }

  seed() {
    this.z.omega = 2 * this.z.omegaOfK(2 * Math.PI * this.targetRing / N);
    this.z.seedRing(this.targetRing, 2.0, 0.02);
  }

  reset() { this.seed(); }

  setFromAudio(hz, level) {
    if (!this.locked && hz > 20) {
      const t = Math.log(Math.min(6000, hz) / 40) / Math.log(6000 / 40);
      const target = 8 + Math.max(0, Math.min(1, t)) * 11;   // 8 to 19 modes across
      this.targetRing += (target - this.targetRing) * 0.02;
      this.z.omega = 2 * this.z.omegaOfK(2 * Math.PI * this.targetRing / N);
    }
    const gate = Math.min(1, Math.max(0, (level - 0.05) / 0.15));
    const drive = gate * (0.45 + 0.55 * Math.min(1, Math.max(0, level)));
    this.z.F = this.z.threshold() * this.gain * drive;
  }

  step() { for (let i = 0; i < this.stepsPerFrame; i++) this.z.step(); }

  render() {
    const gl = this.gl;
    const field = this.z.realField();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.vao);
    this.pRender.use().tex('uField', field.tex).f('uScale', 2.4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  readout(hz) {
    const k = this.z.selectedK();
    const fc = this.z.threshold();
    const ratio = fc > 0 && isFinite(fc) ? this.z.F / fc : 0;
    const src = hz > 20 ? `centroid ${hz.toFixed(0)} Hz` : '—';
    return `${src} → Ω = ${this.z.omega.toFixed(2)} · responds at Ω/2\n`
      + `λ = ${(2 * Math.PI / k).toFixed(1)} cells · Σ = ${this.z.capillarity().toFixed(2)} capillary · γ = ${this.z.gamma().toFixed(3)}\n`
      + `F = ${this.z.F.toFixed(3)} · F_c = ${fc.toFixed(3)} → ${ratio >= 1 ? `${ratio.toFixed(1)}× threshold` : 'below threshold, flat'}`;
  }
}
