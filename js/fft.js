// Complex 2D FFT on the GPU, Stockham autosort algorithm.
//
// Stockham reorders on every pass instead of doing a separate bit-reversal permutation,
// which is exactly what a shader wants: each output texel reads two input texels and
// that's it. log2(N) passes per axis, ping-ponging between two textures.
//
// The texture is RGBA32F and carries TWO complex fields at once: one in RG, another in
// BA. The butterfly works component-wise, so transforming eta and psi together costs
// the same as transforming one of them. That halves the FFT count in the solver.
//
// Convention: forward is unnormalised, inverse divides by N^2 at the end.

import { program, createTexture, createFBO } from './glutil.js';

const FFT_FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform float uN;        // transform size
uniform float uL;        // 2^stage
uniform float uSign;     // -1 forward, +1 inverse
uniform int   uAxis;     // 0 = rows (x), 1 = columns (y)

const float TAU = 6.283185307179586;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  // o = index along the transformed axis; fixed = the other one
  float o = (uAxis == 0) ? float(ij.x) : float(ij.y);
  int fixedIdx = (uAxis == 0) ? ij.y : ij.x;

  float k = mod(o, uL);
  float b = floor(o / uL);
  float upperHalf = mod(b, 2.0);
  float blk = floor(b / 2.0);

  float i0 = blk * uL + k;
  float i1 = i0 + uN * 0.5;

  ivec2 c0 = (uAxis == 0) ? ivec2(int(i0), fixedIdx) : ivec2(fixedIdx, int(i0));
  ivec2 c1 = (uAxis == 0) ? ivec2(int(i1), fixedIdx) : ivec2(fixedIdx, int(i1));

  vec4 a = texelFetch(uSrc, c0, 0);
  vec4 c = texelFetch(uSrc, c1, 0);

  float ang = uSign * TAU * k / (2.0 * uL);
  vec2 w = vec2(cos(ang), sin(ang));

  // Two independent complex fields: RG and BA.
  vec2 cw0 = cmul(c.rg, w);
  vec2 cw1 = cmul(c.ba, w);

  fragColor = (upperHalf < 0.5)
      ? vec4(a.rg + cw0, a.ba + cw1)
      : vec4(a.rg - cw0, a.ba - cw1);
}`;

const SCALE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform float uK;
void main() { fragColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0) * uK; }`;

export class FFT2D {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} N power of two
   * @param {WebGLVertexArrayObject} vao fullscreen triangle
   */
  constructor(gl, N, vao) {
    if ((N & (N - 1)) !== 0) throw new Error(`FFT2D needs a power of two, got ${N}`);
    this.gl = gl;
    this.N = N;
    this.vao = vao;
    this.stages = Math.log2(N);
    this.prog = program(gl, FFT_FS);
    this.scaleProg = program(gl, SCALE_FS);

    // Two scratch buffers for the internal ping-pong.
    this.tmp = [0, 1].map(() => {
      const tex = createTexture(gl, N, N, gl.RGBA32F, gl.RGBA, gl.FLOAT);
      return { tex, fbo: createFBO(gl, tex) };
    });
  }

  /**
   * Transform `input` into `output`. Both RGBA32F, N x N. Leaves `input` untouched;
   * `output` may be the same texture as `input`.
   *
   * @param {WebGLTexture} input
   * @param {{tex: WebGLTexture, fbo: WebGLFramebuffer}} output
   * @param {boolean} inverse
   */
  run(input, output, inverse = false) {
    const gl = this.gl;
    const sign = inverse ? 1 : -1;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.N, this.N);

    let src = input;
    let scratch = this.tmp[0];
    let spare = this.tmp[1];
    const total = this.stages * 2;
    let done = 0;

    for (const axis of [0, 1]) {
      for (let t = 0; t < this.stages; t++) {
        done++;
        // The last pass writes straight into the requested output.
        const dst = (done === total) ? output : scratch;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        this.prog.use()
          .tex('uSrc', src)
          .f('uN', this.N)
          .f('uL', 1 << t)
          .f('uSign', sign)
          .i('uAxis', axis);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst.tex;
        if (done !== total) { const s = scratch; scratch = spare; spare = s; }
      }
    }

    if (inverse) {
      // 1/N^2 normalisation, done in place through a scratch buffer.
      const aux = (output.tex === this.tmp[0].tex) ? this.tmp[1] : this.tmp[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, aux.fbo);
      this.scaleProg.use().tex('uSrc', output.tex).f('uK', 1 / (this.N * this.N));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo);
      this.scaleProg.use().tex('uSrc', aux.tex).f('uK', 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  /** Frees the scratch textures and framebuffers. */
  dispose() {
    const gl = this.gl;
    for (const t of this.tmp) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.tmp = [];
  }

  /** Signed frequency of index i, in radians per cell. */
  static kOf(i, N) {
    const m = (i <= N / 2) ? i : i - N;
    return (2 * Math.PI * m) / N;
  }
}
