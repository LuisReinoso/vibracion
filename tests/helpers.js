// Shared test helpers. Anything touching the simulation goes through window.vibracion,
// which app.js exposes on purpose.

export const SIM_N = 256;

/** Opens the app and fails if the console emits anything other than the favicon error. */
export async function openApp(page) {
  const errores = [];
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errores.push(m.text());
  });
  page.on('pageerror', e => errores.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.vibracion?.faraday && window.vibracion?.chladni);
  // Contexts created by the app itself are registered too, so they can be released at
  // the end of the test instead of waiting for the browser to recycle them.
  await page.evaluate(() => {
    window.__ctxs ??= [];
    for (const id of ['cv-chladni', 'cv-faraday', 'cv-faithful']) {
      const gl = document.getElementById(id)?.getContext('webgl2');
      if (gl) window.__ctxs.push(gl);
    }
  });
  return errores;
}

/** Starts the internal oscillator at a given frequency. */
export async function playTone(page, hz) {
  await page.click('#btn-mode');                       // the generator lives in expert mode
  await page.waitForSelector('#btn-tone', { state: 'visible' });
  await page.click('#btn-tone');
  await page.locator('#s-tone').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input'));
  }, hz);
  await page.waitForFunction(h => Math.abs(window.vibracion.audio.dominantHz - h) < 15, hz);
}

/** Reads the full height field from the Faraday solver. */
export async function heightField(page) {
  return page.evaluate(n => {
    const f = window.vibracion.faraday, gl = f.gl;
    const buf = new Float32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.state.read.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const h = new Array(n * n);
    for (let i = 0; i < n * n; i++) h[i] = buf[i * 4];
    return h;
  }, SIM_N);
}

export function rms(campo) {
  let s = 0;
  for (const v of campo) s += v * v;
  return Math.sqrt(s / campo.length);
}

/** Waits for the instability to saturate, or gives up. */
export async function waitForPattern(page, umbral = 0.15, msMax = 60_000) {
  const t0 = Date.now();
  let ultimo = 0;
  while (Date.now() - t0 < msMax) {
    ultimo = rms(await heightField(page));
    if (ultimo > umbral) return ultimo;
    await page.waitForTimeout(700);
  }
  return ultimo;
}

/**
 * Dominant wavenumber via a radial DFT over a central patch.
 * Returns the wavelength in grid cells.
 */
export function dominantWavelength(campo, n = SIM_N, M = 128) {
  const off = (n - M) >> 1;
  const p = new Float64Array(M * M);
  let media = 0;
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const v = campo[(y + off) * n + x + off];
      p[y * M + x] = v;
      media += v;
    }
  }
  media /= M * M;
  for (let i = 0; i < M * M; i++) p[i] -= media;

  const bandas = new Float64Array(40);
  for (let ky = -20; ky <= 20; ky++) {
    for (let kx = -20; kx <= 20; kx++) {
      if (!kx && !ky) continue;
      let re = 0, im = 0;
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < M; x++) {
          const ph = -2 * Math.PI * (kx * x + ky * y) / M;
          const v = p[y * M + x];
          re += v * Math.cos(ph);
          im += v * Math.sin(ph);
        }
      }
      const kr = Math.round(Math.hypot(kx, ky));
      if (kr > 0 && kr < 40) bandas[kr] += re * re + im * im;
    }
  }
  let mejor = 1, valor = 0;
  for (let i = 1; i < 40; i++) if (bandas[i] > valor) { valor = bandas[i]; mejor = i; }
  return M / mejor;
}

/**
 * Releases the WebGL contexts a test registered in window.__ctxs.
 *
 * A browser keeps only a handful of WebGL contexts alive. Past that it discards the
 * oldest, and from then on their reads silently return zeros. Since the tests run
 * serially in the same browser, a file that abandons contexts does not fail itself: it
 * makes the following files fail.
 */
export async function releaseContexts({ page }) {
  await page.evaluate(() => {
    for (const gl of window.__ctxs ?? []) {
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {}
    }
    window.__ctxs = [];
  }).catch(() => {});
}
