// Faraday waves with the real free-surface nonlinearity.
//
// WHY THIS FILE EXISTS
//
// faraday.js solves shallow water with a local cubic saturation. Its linear part is
// correct (Mathieu threshold, subharmonic response, wavelength), but its nonlinear term
// is isotropic. In the amplitude equation of Chen and Vinals (Phys. Rev. E 60, 559,
// 1999)
//
//     dB_n/dT = alpha B_n - g0 B_n^3 - SUM_m g(theta_mn) B_m^2 B_n
//
// what decides the shape of the pattern is g(theta), the coupling between two waves
// whose vectors meet at angle theta. A local saturation gives a constant g(theta), and
// with cross-coupling above self-coupling N=1 always wins: stripes. Hence that solver
// producing labyrinths in every regime, even where theory and experiment give squares
// (capillary) or hexagons (mixed, Sigma near 1/3).
//
// THE MODEL
//
// Zakharov's potential formulation with the Dirichlet-Neumann operator expanded after
// Craig and Sulem (J. Comp. Phys. 108, 73, 1993):
//
//   d(eta)/dt = G(eta) psi + 2 nu lap(eta)
//   d(psi)/dt = -g(t) eta + sigma kappa(eta) - |grad psi|^2 / 2
//               + (G(eta)psi + grad eta . grad psi)^2 / (2 (1 + |grad eta|^2))
//               + 2 nu lap(psi)
//
//   G0    = |k| tanh(|k| h)
//   G1(n) = D . n D - G0 n G0
//   G2(n) = -1/2 ( G0 n^2 D^2 + D^2 n^2 G0 - 2 G0 n G0 n G0 ),   D = -i grad
//
// kappa is the exact curvature div( grad eta / sqrt(1+|grad eta|^2) ), untruncated.
// Dissipation follows the model of Dias, Dyachenko and Zakharov (2008).
//
// HOW IT IS ORGANISED
//
// The state lives in Fourier space. That makes dispersion, linear capillarity and
// dissipation exact multipliers, and only ONE evaluation of the nonlinear part is
// needed per step. Integration is symplectic Euler: psi first, then eta with the
// already-updated psi. Twelve transforms per step, and products are dealiased with the
// two-thirds rule, without which the harmonics the products generate fold straight back
// onto the band that matters.

import { program, quadVAO, createTexture, createFBO } from './glutil.js';
import { FFT2D } from './fft.js';

const COMMON = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform float uN;
uniform float uH;
uniform float uSigma;
uniform float uG;
uniform float uNu;
uniform float uDt;

vec2 imul(vec2 a) { return vec2(-a.y, a.x); }

vec2 kOf(ivec2 ij, float N) {
  vec2 m = vec2(ij);
  if (m.x > N * 0.5) m.x -= N;
  if (m.y > N * 0.5) m.y -= N;
  return 6.283185307179586 * m / N;
}

float antialias(ivec2 ij, float N) {
  float mx = float(ij.x); if (mx > N * 0.5) mx -= N;
  float my = float(ij.y); if (my > N * 0.5) my -= N;
  return (abs(mx) < N / 3.0 && abs(my) < N / 3.0) ? 1.0 : 0.0;
}

float G0de(float kk) {
  float k = sqrt(kk);
  return k * tanh(k * uH);
}`;

// --- spectral derivatives: each packs two real fields (RG and BA) ---

const GRAD_FS = `${COMMON}
uniform sampler2D uSpec;
uniform int uCual;                       // 0 = psi, 1 = eta
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSpec, ij, 0);
  vec2 f = (uCual == 0) ? s.ba : s.rg;
  vec2 k = kOf(ij, uN);
  fragColor = vec4(imul(f) * k.x, imul(f) * k.y);
}`;

const G0_FS = `${COMMON}
uniform sampler2D uSpec;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 psi = texelFetch(uSpec, ij, 0).ba;
  float kk = dot(kOf(ij, uN), kOf(ij, uN));
  // RG -> G0 psi          BA -> D^2 psi  (D^2 = -lap, in Fourier +|k|^2)
  fragColor = vec4(G0de(kk) * psi, kk * psi);
}`;

const APPLY_G0_FS = `${COMMON}
uniform sampler2D uSrc;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float kk = dot(kOf(ij, uN), kOf(ij, uN));
  fragColor = vec4(G0de(kk) * texelFetch(uSrc, ij, 0).rg, 0.0, 0.0);
}`;

// --- products in real space ---

const PROD1_FS = `${COMMON}
uniform sampler2D uReal;      // R = eta, B = psi
uniform sampler2D uDpsi;      // R = dpsi/dx, B = dpsi/dy
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float eta = texelFetch(uReal, ij, 0).r;
  vec4 d = texelFetch(uDpsi, ij, 0);
  fragColor = vec4(eta * d.r, 0.0, eta * d.b, 0.0);
}`;

const PROD2_FS = `${COMMON}
uniform sampler2D uReal;
uniform sampler2D uGpsi;      // R = G0 psi, B = D^2 psi
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float eta = texelFetch(uReal, ij, 0).r;
  float G0psi = texelFetch(uGpsi, ij, 0).r;
  fragColor = vec4(eta * G0psi, 0.0, eta * eta, 0.0);
}`;

const PROD3_FS = `${COMMON}
uniform sampler2D uReal;
uniform sampler2D uGpsi;      // R = G0 psi, B = D^2 psi
uniform sampler2D uG0C;       // R = G0(eta G0 psi)
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float eta = texelFetch(uReal, ij, 0).r;
  float D2psi = texelFetch(uGpsi, ij, 0).b;
  float g0c = texelFetch(uG0C, ij, 0).r;
  fragColor = vec4(eta * g0c, 0.0, eta * eta * D2psi, 0.0);
}`;

const PROD4_FS = `${COMMON}
uniform sampler2D uReal;
uniform sampler2D uGpsi;
uniform sampler2D uDeta;      // R = deta/dx, B = deta/dy
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float eta = texelFetch(uReal, ij, 0).r;
  float G0psi = texelFetch(uGpsi, ij, 0).r;
  vec4 de = texelFetch(uDeta, ij, 0);
  // Exact curvature: V = grad eta / sqrt(1 + |grad eta|^2); its divergence is kappa.
  float inv = inversesqrt(1.0 + de.r * de.r + de.b * de.b);
  fragColor = vec4(eta * eta * G0psi, 0.0, de.r * inv, 0.0);
}`;

const PROD5_FS = `${COMMON}
uniform sampler2D uDeta;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 de = texelFetch(uDeta, ij, 0);
  float inv = inversesqrt(1.0 + de.r * de.r + de.b * de.b);
  fragColor = vec4(de.b * inv, 0.0, 0.0, 0.0);
}`;

// --- assembling the Dirichlet-Neumann operator and the curvature ---

const ASSEMBLE_FS = `${COMMON}
uniform sampler2D uSpec;
uniform sampler2D uQ1;    // RG: esp(eta dpsi/dx)     BA: esp(eta dpsi/dy)
uniform sampler2D uQ2;    // RG: esp(eta G0psi)       BA: esp(eta^2)
uniform sampler2D uQ3;    // RG: esp(eta G0(eta G0psi))  BA: esp(eta^2 D^2 psi)
uniform sampler2D uQ4;    // RG: esp(eta^2 G0psi)     BA: esp(Vx)
uniform sampler2D uQ5;    // RG: esp(Vy)
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 k = kOf(ij, uN);
  float kk = dot(k, k);
  float G0 = G0de(kk);
  float aa = antialias(ij, uN);

  vec2 psi = texelFetch(uSpec, ij, 0).ba;
  vec4 q1 = texelFetch(uQ1, ij, 0);
  vec4 q2 = texelFetch(uQ2, ij, 0);
  vec4 q3 = texelFetch(uQ3, ij, 0);
  vec4 q4 = texelFetch(uQ4, ij, 0);
  vec2 q5 = texelFetch(uQ5, ij, 0).rg;

  // G1(eta)psi = -div(eta grad psi) - G0(eta G0 psi)
  vec2 divTerm = imul(q1.rg) * k.x + imul(q1.ba) * k.y;
  vec2 G1 = -divTerm - G0 * q2.rg;

  // G2(eta)psi = -1/2 ( G0(eta^2 D^2 psi) + D^2(eta^2 G0 psi) - 2 G0(eta G0(eta G0 psi)) )
  vec2 G2 = -0.5 * (G0 * q3.ba + kk * q4.rg - 2.0 * G0 * q3.rg);

  vec2 Gpsi = (G0 * psi + (G1 + G2) * aa);

  // Exact curvature: kappa = div(V)
  vec2 kappa = (imul(q4.ba) * k.x + imul(q5) * k.y) * aa;

  fragColor = vec4(Gpsi, kappa);
}`;

const ONLY_GPSI_FS = `${COMMON}
uniform sampler2D uEns;
void main() {
  fragColor = vec4(texelFetch(uEns, ivec2(gl_FragCoord.xy), 0).rg, 0.0, 0.0);
}`;

// --- algebraic terms of d(psi)/dt, in real space ---

const NPSI_FS = `${COMMON}
uniform sampler2D uDpsi;
uniform sampler2D uDeta;
uniform sampler2D uGfull;     // R = G(eta) psi
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 dp = texelFetch(uDpsi, ij, 0);
  vec4 de = texelFetch(uDeta, ij, 0);
  float Gp = texelFetch(uGfull, ij, 0).r;

  float gp2 = dp.r * dp.r + dp.b * dp.b;
  float ge2 = de.r * de.r + de.b * de.b;
  float mix = Gp + de.r * dp.r + de.b * dp.b;

  float N = -0.5 * gp2 + (mix * mix) / (2.0 * (1.0 + ge2));

  // Salvaguarda de validez, no de estabilidad numerica.
  //
  // La expansion de Craig y Sulem trunca el operador Dirichlet-Neumann a orden cubico
  // en eta, asi que solo describe el fluid mientras la pendiente de la superficie sea
  // moderada. Muy por encima del threshold la amplitud se sale de ese rango, los terminos
  // truncados dejan de ser pequenos y la solucion se va a infinito. Eso no es fisica:
  // es el modelo aplicado fuera de donde vale. Aqui se atenua el termino no lineal
  // cuando la pendiente pasa de 0.5, que son unos 27 grados, para que el solver se
  // quede en la frontera de validez en vez de explotar sin avisar.
  float pend = sqrt(ge2);
  float validez = 1.0 - smoothstep(0.5, 0.9, pend);
  fragColor = vec4(N * validez, 0.0, 0.0, 0.0);
}`;

// --- time advance, entirely in Fourier space ---

const ADVANCE_FS = `${COMMON}
uniform sampler2D uSpec;
uniform sampler2D uEns;      // RG = G(eta)psi,  BA = kappa
uniform sampler2D uNpsi;     // RG = esp(terminos algebraicos)
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSpec, ij, 0);
  vec2 eta = s.rg, psi = s.ba;
  vec2 k = kOf(ij, uN);
  float kk = dot(k, k);
  float G0 = G0de(kk);
  float aa = antialias(ij, uN);

  vec4 ens = texelFetch(uEns, ij, 0);
  vec2 Gpsi = ens.rg;
  vec2 kappa = ens.ba;
  vec2 Npsi = texelFetch(uNpsi, ij, 0).rg * aa;

  // Linear curvature is sigma * lap(eta), that is -sigma |k|^2 eta. Whatever is left of
  // the exact curvature is nonlinear and goes separately, without double counting.
  vec2 kappaNL = kappa + kk * eta;

  // psi first
  vec2 dpsi = -(uG + uSigma * kk) * eta + Npsi + uSigma * kappaNL - 2.0 * uNu * kk * psi;
  vec2 psiN = psi + uDt * dpsi;

  // eta despues, ya con el psi nuevo: el step es simplectico y no amortigua de mas
  vec2 GpsiNL = Gpsi - G0 * psi;                 // the linear part is recomputed below
  vec2 deta = G0 * psiN + GpsiNL - 2.0 * uNu * kk * eta;
  vec2 etaN = eta + uDt * deta;

  fragColor = vec4(etaN * aa, psiN * aa);
}`;

const SEED_FS = `${COMMON}
uniform float uSeed;
uniform float uAmp;
float hash(vec2 p, float s) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + s);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z) * 2.0 - 1.0;
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  // White noise in Fourier space, restricted to the useful band.
  float aa = antialias(ij, uN);
  float kk = dot(kOf(ij, uN), kOf(ij, uN));
  float vivo = (kk > 1e-6) ? 1.0 : 0.0;
  vec2 e = vec2(hash(gl_FragCoord.xy, uSeed), hash(gl_FragCoord.xy, uSeed + 0.37));
  fragColor = vec4(e * uAmp * aa * vivo, 0.0, 0.0);
}`;

const NOISE_FS = `${COMMON}
uniform sampler2D uSpec;
uniform float uSeed;
uniform float uAmp;
uniform float uKsel;      // numero de onda resonante
uniform float uKanch;
float hash(vec2 p, float s) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + s);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z) * 2.0 - 1.0;
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSpec, ij, 0);
  float aa = antialias(ij, uN);
  float kk = dot(kOf(ij, uN), kOf(ij, uN));
  float vivo = (kk > 1e-6) ? 1.0 : 0.0;
  vec2 e = vec2(hash(gl_FragCoord.xy, uSeed), hash(gl_FragCoord.xy, uSeed + 0.71));
  // El ruido se concentra en la banda inestable. Un ruido plano en k reparte su
  // energia entre miles de modos estables que solo aportan grano, y deja al mode
  // resonante sin seed suficiente justo cuando Omega se mueve con la musica.
  float k = sqrt(kk);
  float d = (k - uKsel) / max(1e-6, uKanch);
  float banda = exp(-d * d);
  fragColor = vec4(s.rg + e * uAmp * aa * vivo * banda, s.ba);
}`;

export class Zakharov {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} N grid size, a power of two
   */
  constructor(gl, N = 128) {
    this.gl = gl;
    this.N = N;
    this.vao = quadVAO(gl);
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('Zakharov needs 32-bit float render targets.');
    }
    this.fft = new FFT2D(gl, N, this.vao);

    const mk = () => {
      const tex = createTexture(gl, N, N, gl.RGBA32F, gl.RGBA, gl.FLOAT);
      return { tex, fbo: createFBO(gl, tex) };
    };
    this.spec = mk();
    this.specB = mk();
    // OJO: nada de filtro LINEAR aqui. Las texturas RGBA32F no son filtrables sin la
    // extension OES_texture_float_linear; con LINEAR la textura queda incompleta y
    // TODAS sus lecturas devuelven cero, incluidas las de texelFetch. Se manifiesta
    // como un field que vale cero nada mas sembrarlo, sin ningun error de por medio.
    this.real0 = mk();
    this.dpsi = mk();
    this.deta = mk();
    this.gpsi = mk();
    this.tmpSpec = mk();
    this.g0c = mk();
    this.q = [mk(), mk(), mk(), mk(), mk()];
    this.ens = mk();
    this.gfull = mk();
    this.npsi = mk();
    this.aux = mk();

    this.pGrad = program(gl, GRAD_FS);
    this.pG0 = program(gl, G0_FS);
    this.pMultG0 = program(gl, APPLY_G0_FS);
    this.pProd = [PROD1_FS, PROD2_FS, PROD3_FS, PROD4_FS, PROD5_FS].map(s => program(gl, s));
    this.pEns = program(gl, ASSEMBLE_FS);
    this.pSoloG = program(gl, ONLY_GPSI_FS);
    this.pNpsi = program(gl, NPSI_FS);
    this.pAvanza = program(gl, ADVANCE_FS);
    this.pSemilla = program(gl, SEED_FS);
    this.pRuido = program(gl, NOISE_FS);

    // Physical parameters, in units where dx = 1 and g0 = 1.
    this.h = 6.0;         // depth: large kh means deep water
    this.sigma = 8.0;     // surface tension over density
    this.nu = 0.004;      // viscosity
    this.g0 = 1.0;
    this.F = 0.0;         // parametric drive amplitude
    this.omega = 1.0;
    this.dt = 0.02;
    this.phase = 0;
    this.seed = 0.123;
    this.noiseFloor = 2e-5;

    this.reset();
  }

  reset(amp = 2e-3) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.N, this.N);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.spec.fbo);
    this.pSemilla.use().f('uN', this.N).f('uSeed', this.seed).f('uAmp', amp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    this.phase = 0;
    this.seed = (this.seed + 0.317) % 1;
  }

  /**
   * Siembra una unica onda plana cos(kx x + ky y) en eta, con psi a cero.
   * Solo se usa para verificar: permite medir la dispersion y el threshold contra la
   * teoria en vez de contra lo que el solver devolvio la vez anterior.
   */
  seedWave(mx, my, amp) {
    const gl = this.gl;
    const N = this.N;
    const buf = new Float32Array(N * N * 4);
    const pon = (ix, iy, re) => {
      const i = (iy * N + ix) * 4;
      buf[i] = re;
    };
    // cos -> half amplitude at +k and -k, both real
    pon(((mx % N) + N) % N, ((my % N) + N) % N, amp * N * N / 2);
    pon(((-mx % N) + N) % N, ((-my % N) + N) % N, amp * N * N / 2);
    gl.bindTexture(gl.TEXTURE_2D, this.spec.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.phase = 0;
  }

  /**
   * Siembra ruido isotropo en un anillo de numeros de onda alrededor de ringR.
   *
   * Sembrar ruido blanco en toda la banda no sirve para estudiar seleccion de patron:
   * los anillos de |k| alto contienen muchos mas modos y su energia total tapa la del
   * mode resonante hasta que este ha crecido varios ordenes. Un anillo estrecho e
   * isotropo deja que el patron elija orientacion y simetria libremente, que es
   * justo lo que se quiere medir.
   */
  seedRing(ringR, width, amp) {
    const gl = this.gl;
    const N = this.N;
    const buf = new Float32Array(N * N * 4);
    let s = 20260826;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const mx = ix <= N / 2 ? ix : ix - N;
        const my = iy <= N / 2 ? iy : iy - N;
        const r = Math.hypot(mx, my);
        if (Math.abs(r - ringR) > width || r < 0.5) continue;
        const i = (iy * N + ix) * 4;
        buf[i] = amp * rnd();
        buf[i + 1] = amp * rnd();
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.spec.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, buf);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.phase = 0;
  }

  /** Exact linear dispersion relation of the model. */
  omegaOfK(k) {
    return Math.sqrt((this.g0 * k + this.sigma * k * k * k) * Math.tanh(k * this.h));
  }

  /** Wavenumber resonant with the subharmonic: omega(k) = Omega/2. */
  selectedK() {
    const objetivo = this.omega / 2;
    let lo = 1e-4, hi = Math.PI;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.omegaOfK(mid) < objetivo) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Peso de la capilaridad frente a la gravedad en el mode seleccionado. */
  capillarity() {
    const k = this.selectedK();
    const cap = this.sigma * k * k;
    return cap / (this.g0 + cap);
  }

  /** Dimensionless viscous damping, the gamma of Chen and Vinals. */
  gamma() {
    const k = this.selectedK();
    return (2 * this.nu * k * k) / Math.max(1e-6, this.omega / 2);
  }

  /**
   * Umbral de la lengua subarmonica principal.
   *
   * Para eta'' + 2 lambda eta' + w0^2 (1 + h cos(2 w0 t)) eta = 0 la resonancia
   * parametrica arranca en h_c = 4 lambda / w0 (Landau y Lifshitz, Mecanica, 27).
   *
   * El detalle que importa: agitar el recipiente modula la GRAVEDAD, no la tension
   * superficial. La frecuencia del mode sale de w0^2 = G0 (g + sigma k^2), asi que la
   * modulacion relativa que llega al mode es F * g / (g + sigma k^2), no F. En regimen
   * capilar sigma k^2 domina y el forzado pierde eficacia: por eso los experimentos
   * capilares necesitan aceleraciones mucho mayores que los de gravedad.
   */
  threshold() {
    const k = this.selectedK();
    const w = this.omega / 2;
    if (w <= 0) return Infinity;
    const lambda = 2 * this.nu * k * k;          // amplitude damping rate
    const hc = 4 * lambda / w;
    const fraccion = this.g0 / (this.g0 + this.sigma * k * k);
    return hc / Math.max(1e-9, fraccion);
  }

  /** Draws the quad into `dst`. The program is already active from #base(). */
  #draw(dst) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  #base(prog) {
    return prog.use()
      .f('uN', this.N).f('uH', this.h).f('uSigma', this.sigma)
      .f('uNu', this.nu).f('uDt', this.dt);
  }

  step() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.N, this.N);

    // 1. state to real space
    this.fft.run(this.spec.tex, this.real0, true);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.N, this.N);

    // 2-4. derivatives
    this.#base(this.pGrad).tex('uSpec', this.spec.tex).i('uCual', 0);
    this.#draw(this.tmpSpec);
    this.fft.run(this.tmpSpec.tex, this.dpsi, true);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    this.#base(this.pGrad).tex('uSpec', this.spec.tex).i('uCual', 1);
    this.#draw(this.tmpSpec);
    this.fft.run(this.tmpSpec.tex, this.deta, true);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    this.#base(this.pG0).tex('uSpec', this.spec.tex);
    this.#draw(this.tmpSpec);
    this.fft.run(this.tmpSpec.tex, this.gpsi, true);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 5-6. first products
    this.#base(this.pProd[0]).tex('uReal', this.real0.tex).tex('uDpsi', this.dpsi.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.q[0], false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    this.#base(this.pProd[1]).tex('uReal', this.real0.tex).tex('uGpsi', this.gpsi.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.q[1], false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 7. G0(eta G0 psi) back to real space, needed for G2
    this.#base(this.pMultG0).tex('uSrc', this.q[1].tex);
    this.#draw(this.tmpSpec);
    this.fft.run(this.tmpSpec.tex, this.g0c, true);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 8-10. remaining products and curvature
    this.#base(this.pProd[2])
      .tex('uReal', this.real0.tex).tex('uGpsi', this.gpsi.tex).tex('uG0C', this.g0c.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.q[2], false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    this.#base(this.pProd[3])
      .tex('uReal', this.real0.tex).tex('uGpsi', this.gpsi.tex).tex('uDeta', this.deta.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.q[3], false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    this.#base(this.pProd[4]).tex('uDeta', this.deta.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.q[4], false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 11. full operator and curvature
    this.#base(this.pEns)
      .tex('uSpec', this.spec.tex)
      .tex('uQ1', this.q[0].tex).tex('uQ2', this.q[1].tex).tex('uQ3', this.q[2].tex)
      .tex('uQ4', this.q[3].tex).tex('uQ5', this.q[4].tex);
    this.#draw(this.ens);

    // 12. G(eta)psi to real space
    this.#base(this.pSoloG).tex('uEns', this.ens.tex);
    this.#draw(this.tmpSpec);
    this.fft.run(this.tmpSpec.tex, this.gfull, true);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 13. algebraic terms of d(psi)/dt
    this.#base(this.pNpsi)
      .tex('uDpsi', this.dpsi.tex).tex('uDeta', this.deta.tex).tex('uGfull', this.gfull.tex);
    this.#draw(this.aux);
    this.fft.run(this.aux.tex, this.npsi, false);
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.N, this.N);

    // 14. advance
    this.phase = (this.phase + this.omega * this.dt) % (2 * Math.PI);
    const gInst = this.g0 * (1 + this.F * Math.cos(this.phase));
    this.#base(this.pAvanza)
      .f('uG', gInst)
      .tex('uSpec', this.spec.tex).tex('uEns', this.ens.tex).tex('uNpsi', this.npsi.tex);
    this.#draw(this.specB);
    const s = this.spec; this.spec = this.specB; this.specB = s;

    // Ruido de fondo: sin el, una vez que el patron se apaga tarda una eternidad en
    // volver a arrancar desde el cero numerico.
    if (this.noiseFloor > 0) {
      this.seed = (this.seed + 0.0611) % 1;
      const kSel = this.selectedK();
      this.#base(this.pRuido)
        .tex('uSpec', this.spec.tex).f('uSeed', this.seed).f('uAmp', this.noiseFloor)
        .f('uKsel', kSel).f('uKanch', Math.max(0.05, kSel * 0.25));
      this.#draw(this.specB);
      const t = this.spec; this.spec = this.specB; this.specB = t;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  /** Devuelve el field de alturas en espacio real (textura con eta en R). */
  realField() {
    this.fft.run(this.spec.tex, this.real0, true);
    return this.real0;
  }

  /**
   * Frees everything the solver allocated and releases the context.
   *
   * A browser only keeps a handful of WebGL contexts alive; past that it discards the
   * oldest and their reads start returning garbage without raising any error. Creating
   * solvers and abandoning them poisons whoever comes next.
   */
  dispose() {
    const gl = this.gl;
    this.fft.dispose();
    const owned = [
      this.spec, this.specB, this.real0, this.dpsi, this.deta, this.gpsi,
      this.tmpSpec, this.g0c, this.ens, this.gfull, this.npsi, this.aux, ...this.q,
    ];
    for (const o of owned) {
      if (!o) continue;
      gl.deleteFramebuffer(o.fbo);
      gl.deleteTexture(o.tex);
    }
    this.q = [];
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  readHeights() {
    const gl = this.gl;
    const t = this.realField();
    const buf = new Float32Array(this.N * this.N * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, this.N, this.N, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const eta = new Float32Array(this.N * this.N);
    for (let i = 0; i < eta.length; i++) eta[i] = buf[i * 4];
    return eta;
  }
}
