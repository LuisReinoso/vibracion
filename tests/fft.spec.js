// The FFT is the foundation of the Zakharov solver. If it is wrong, everything above
// it lies plausibly, which is the worst way to fail. It is checked against transforms
// that can be written out by hand.

import { test, expect } from '@playwright/test';
import { openApp, releaseContexts } from './helpers.js';

// Each test mounts its own WebGL context. If they are not released they pile up and
// the browser starts discarding the oldest: reads in other test files then return
// zeros without raising any error.
test.afterEach(releaseContexts);

/** Mounts an FFT in the page and returns a helper for transforming arrays. */
async function mount(page, N = 32) {
  return page.evaluate(async n => {
    const { FFT2D } = await import('/js/fft.js');
    const { getContext, quadVAO, createTexture, createFBO } = await import('/js/glutil.js');
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const gl = getContext(cv);
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('sin float render');
    const vao = quadVAO(gl);
    const fft = new FFT2D(gl, n, vao);
    (window.__ctxs ??= []).push(gl);
    const mk = () => { const t = createTexture(gl, n, n, gl.RGBA32F, gl.RGBA, gl.FLOAT); return { tex: t, fbo: createFBO(gl, t) }; };
    window.__fft = { gl, fft, n, input: mk(), output: mk() };
  }, N);
}

/** Transforma un campo real (canal R) y devuelve la output compleja completa. */
async function transform(page, datos, inverse = false) {
  return page.evaluate(({ datos, inverse }) => {
    const { gl, fft, n, input, output } = window.__fft;
    const buf = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) { buf[i * 4] = datos[i * 2]; buf[i * 4 + 1] = datos[i * 2 + 1]; }
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, buf);
    fft.run(input.tex, output, inverse);
    const out = new Float32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const res = new Float32Array(n * n * 2);
    for (let i = 0; i < n * n; i++) { res[i * 2] = out[i * 4]; res[i * 2 + 1] = out[i * 4 + 1]; }
    return Array.from(res);
  }, { datos: Array.from(datos), inverse });
}

const N = 32;

test('a delta transforms into a constant', async ({ page }) => {
  await openApp(page);
  await mount(page, N);

  const d = new Float32Array(N * N * 2);
  d[0] = 1;                                   // delta en el origen
  const F = await transform(page, d);

  // FFT(delta) = 1 en todos los modos.
  for (let i = 0; i < N * N; i++) {
    expect(F[i * 2], `Re en ${i}`).toBeCloseTo(1, 4);
    expect(F[i * 2 + 1], `Im en ${i}`).toBeCloseTo(0, 4);
  }
});

test('a plane wave gives a single pair of peaks at its wavenumber', async ({ page }) => {
  await openApp(page);
  await mount(page, N);

  const kx = 3, ky = 5;
  const d = new Float32Array(N * N * 2);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      d[(y * N + x) * 2] = Math.cos(2 * Math.PI * (kx * x + ky * y) / N);
    }
  }
  const F = await transform(page, d);

  const mag = i => Math.hypot(F[i * 2], F[i * 2 + 1]);
  // cos = (e^{ik} + e^{-ik})/2 -> dos peaks de amplitud N^2/2
  expect(mag(ky * N + kx)).toBeCloseTo(N * N / 2, 1);
  expect(mag(((N - ky) % N) * N + ((N - kx) % N))).toBeCloseTo(N * N / 2, 1);

  // And nothing appreciable anywhere else.
  let fuera = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const esPico = (x === kx && y === ky) || (x === (N - kx) % N && y === (N - ky) % N);
      if (!esPico) fuera = Math.max(fuera, mag(y * N + x));
    }
  }
  expect(fuera, 'energy where there should be none').toBeLessThan(N * N / 2 * 1e-4);
});

test('forward then inverse returns the original field', async ({ page }) => {
  await openApp(page);
  await mount(page, N);

  // Deterministic pseudo-random complex field.
  const d = new Float32Array(N * N * 2);
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < N * N * 2; i++) d[i] = rnd();

  const F = await transform(page, d);
  const back = await transform(page, F, true);

  let peor = 0;
  for (let i = 0; i < N * N * 2; i++) peor = Math.max(peor, Math.abs(back[i] - d[i]));

  // The tolerance comes from the arithmetic, not from whatever happened to come out.
  // Intermediate transform values reach N^2 and the float32 epsilon is 1.2e-7, so the
  // noise floor sits at a few ulps of N^2. A real error would be O(1) and would not
  // slip under this bound however much slack it were given.
  const suelo = 24 * 1.2e-7 * N * N;
  expect(peor, `forward-inverse round trip does not close (float32 floor ≈ ${suelo.toExponential(1)})`)
    .toBeLessThan(suelo);
  // And check it genuinely reconstructs rather than returning small noise.
  let energia = 0;
  for (let i = 0; i < N * N * 2; i++) energia += d[i] * d[i];
  expect(peor).toBeLessThan(0.01 * Math.sqrt(energia / (N * N * 2)));
});

test('the transform is linear', async ({ page }) => {
  await openApp(page);
  await mount(page, N);

  let s = 999;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  const a = new Float32Array(N * N * 2), b = new Float32Array(N * N * 2);
  for (let i = 0; i < N * N * 2; i++) { a[i] = rnd(); b[i] = rnd(); }
  const suma = new Float32Array(N * N * 2);
  for (let i = 0; i < N * N * 2; i++) suma[i] = 2 * a[i] - 3 * b[i];

  const Fa = await transform(page, a);
  const Fb = await transform(page, b);
  const Fs = await transform(page, suma);

  let peor = 0;
  for (let i = 0; i < N * N * 2; i++) peor = Math.max(peor, Math.abs(Fs[i] - (2 * Fa[i] - 3 * Fb[i])));
  expect(peor / (N * N)).toBeLessThan(1e-5);
});

test('the second channel transforms alongside the first without mixing', async ({ page }) => {
  await openApp(page);
  await mount(page, 32);

  // RG lleva una delta, BA lleva una onda plana. Deben salir independientes.
  const res = await page.evaluate(() => {
    const { gl, fft, n, input, output } = window.__fft;
    const buf = new Float32Array(n * n * 4);
    buf[0] = 1;                                        // RG: delta
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) buf[(y * n + x) * 4 + 2] = Math.cos(2 * Math.PI * 4 * x / n);
    }
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, buf);
    fft.run(input.tex, output, false);
    const out = new Float32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let rgConst = true, peorBA = 0;
    for (let i = 0; i < n * n; i++) {
      if (Math.abs(out[i * 4] - 1) > 1e-3 || Math.abs(out[i * 4 + 1]) > 1e-3) rgConst = false;
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const esPico = y === 0 && (x === 4 || x === n - 4);
        if (!esPico) peorBA = Math.max(peorBA, Math.hypot(out[i * 4 + 2], out[i * 4 + 3]));
      }
    }
    const pico = Math.hypot(out[4 * 4 + 2], out[4 * 4 + 3]);
    return { rgConst, pico, peorBA, n };
  });

  expect(res.rgConst, 'RG should be constant and got contaminated').toBe(true);
  expect(res.pico).toBeCloseTo(res.n * res.n / 2, 0);
  expect(res.peorBA).toBeLessThan(res.n * res.n * 1e-4);
});
