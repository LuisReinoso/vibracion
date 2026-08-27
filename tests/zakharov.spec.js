// The Zakharov solver, verified against theory rather than against itself.
//
// Order of the checks: first the linear part (dispersion and threshold), which can be
// written out by hand; then the nonlinear part, which is the reason the file exists.

import { test, expect } from '@playwright/test';
import { openApp, releaseContexts } from './helpers.js';

test.afterEach(releaseContexts);

const N = 64;

/** Creates an isolated solver on its own canvas. */
async function mount(page, n = N, params = {}) {
  return page.evaluate(async ({ n, params }) => {
    const { Zakharov } = await import('/js/zakharov.js');
    const { getContext } = await import('/js/glutil.js');
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const gl = getContext(cv);
    (window.__ctxs ??= []).push(gl);
    const z = new Zakharov(gl, n);
    Object.assign(z, params);
    window.__z = z;
    return { sigma: z.sigma, h: z.h, nu: z.nu };
  }, { n, params });
}

test('the numerical dispersion reproduces the theoretical relation', async ({ page }) => {
  await openApp(page);
  await mount(page, N, { nu: 0, F: 0, dt: 0.01, noiseFloor: 0, sigma: 8, h: 6 });

  // For several wavenumbers: seed a wave, measure its period by zero crossings and
  // compare against omega(k) = sqrt((g k + sigma k^3) tanh(k h)).
  const res = await page.evaluate(async () => {
    const z = window.__z, N = z.N;
    const out = [];
    for (const m of [2, 3, 5, 8]) {
      z.seedWave(m, 0, 1e-4);
      const k = 2 * Math.PI * m / N;
      const theoretical = z.omegaOfK(k);
      // Sample eta at a point where the wave has maximum amplitude (x=0).
      const series = [];
      const pasos = Math.ceil((6 * Math.PI / theoretical) / z.dt);   // about 3 periods
      for (let i = 0; i < pasos; i++) {
        z.step();
        series.push(z.readHeights()[0]);
      }
      // Period from upward zero crossings
      const crossings = [];
      for (let i = 1; i < series.length; i++) {
        if (series[i - 1] < 0 && series[i] >= 0) {
          const t = (i - 1 + series[i - 1] / (series[i - 1] - series[i])) * z.dt;
          crossings.push(t);
        }
      }
      let measured = null;
      if (crossings.length >= 2) {
        const T = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
        measured = 2 * Math.PI / T;
      }
      out.push({ m, k: +k.toFixed(4), theoretical: +theoretical.toFixed(4), measured: measured && +measured.toFixed(4) });
    }
    return out;
  });

  console.log('dispersion:', JSON.stringify(res));
  for (const r of res) {
    expect(r.measured, `m=${r.m} gave no measurable oscillation`).not.toBeNull();
    expect(Math.abs(r.measured - r.theoretical) / r.theoretical, `m=${r.m}`).toBeLessThan(0.03);
  }
});

test('with no drive and no viscosity the energy does not run away', async ({ page }) => {
  await openApp(page);
  await mount(page, N, { nu: 0, F: 0, dt: 0.01, noiseFloor: 0, sigma: 8, h: 6 });

  const res = await page.evaluate(() => {
    const z = window.__z;
    z.seedWave(4, 0, 1e-3);
    const rms = () => {
      const e = z.readHeights();
      let s = 0; for (const v of e) s += v * v;
      return Math.sqrt(s / e.length);
    };
    const ini = rms();
    let pico = ini;
    for (let i = 0; i < 1500; i++) { z.step(); pico = Math.max(pico, rms()); }
    return { ini, pico, fin: rms() };
  });

  expect(Number.isFinite(res.fin)).toBe(true);
  // With no dissipation the amplitude should be conserved, not grow: the symplectic
  // scheme admits some numerical pumping but not a large factor.
  expect(res.pico / res.ini).toBeLessThan(1.5);
});

// THE reason the solver exists. Chen and Vinals (PRE 60, 559) predict squares in the
// capillary regime at low dissipation. The shallow-water solver with a local saturation
// cannot produce them: its g(theta) coupling is constant and N=1 always wins.
//
// Symmetry is measured through the angular harmonics of the energy in the resonant ring,
// with theta folded onto [0,180) because +k and -k are the same standing wave:
// n=1 dominates for stripes, n=2 for squares, n=3 for hexagons.
test('selects squares in the capillary regime and does not in gravity @slow', async ({ page }) => {
  test.setTimeout(600_000);
  await openApp(page);

  const res = await page.evaluate(async () => {
    const { Zakharov } = await import('/js/zakharov.js');
    const { getContext } = await import('/js/glutil.js');
    // A 128 grid with the ring at r=20. Dropping to 64 leaves so few modes in the ring
    // that angular resolution degrades and the symmetry measurement loses contrast, even
    // though the pattern itself is the same.
    const N = 128, rObj = 20;

    const run = async (sigma, mult) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const gl0 = getContext(cv);
      (window.__ctxs ??= []).push(gl0);
      const z = new Zakharov(gl0, N);
      z.sigma = sigma; z.h = 6; z.nu = 0.01; z.dt = 0.03; z.noiseFloor = 0;
      z.omega = 2 * z.omegaOfK(2 * Math.PI * rObj / N);
      // Six times threshold: the growth rate goes as (F/Fc - 1), so raising it shortens
      // the experiment a lot without changing which symmetry is selected.
      z.F = z.threshold() * mult;
      z.seedRing(rObj, 1.5, 0.02);
      // The thread is yielded every few thousand steps: a synchronous loop of tens of
      // thousands of iterations makes the browser treat the tab as hung.
      const blocks = mult > 4 ? 12 : 24;      // less drive, more time to grow
      for (let bloque = 0; bloque < blocks; bloque++) {
        for (let i = 0; i < 1000; i++) z.step();
        await new Promise(r => setTimeout(r, 0));
      }

      const gl = z.gl, b = new Float32Array(N * N * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, z.spec.fbo);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, b);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const NB = 180, bins = new Float64Array(NB);
      let total = 0;
      for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
        const mx = ix <= N / 2 ? ix : ix - N, my = iy <= N / 2 ? iy : iy - N;
        const r = Math.hypot(mx, my);
        if (Math.abs(r - rObj) > 3 || r < 0.5) continue;
        const i = (iy * N + ix) * 4, e = b[i] ** 2 + b[i + 1] ** 2;
        let th = Math.atan2(my, mx); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
        bins[Math.min(NB - 1, Math.floor(th / Math.PI * NB))] += e; total += e;
      }
      const arm = n => {
        let re = 0, im = 0;
        for (let i = 0; i < NB; i++) {
          const th = (i + 0.5) / NB * Math.PI;
          re += bins[i] * Math.cos(2 * n * th); im += bins[i] * Math.sin(2 * n * th);
        }
        return Math.hypot(re, im) / total;
      };
      const e = z.readHeights();
      let s = 0; for (const v of e) s += v * v;
      return {
        Sigma: z.capillarity(), gamma: z.gamma(), rms: Math.sqrt(s / e.length),
        n1: arm(1), n2: arm(2), n3: arm(3),
      };
    };
    return { gravity: await run(0.05, 2.0), capillary: await run(8, 6.0) };
  });

  console.log('pattern selection:', JSON.stringify(res, null, 1));

  // Both cases must have grown and stayed finite: otherwise there is no pattern to
  // classify. The slope guard has to keep the solver inside the range where the cubic
  // expansion of the operator is valid.
  expect(Number.isFinite(res.capillary.rms) && Number.isFinite(res.gravity.rms),
    'the solver diverged').toBe(true);
  expect(res.capillary.rms).toBeGreaterThan(0.02);
  expect(res.gravity.rms).toBeGreaterThan(0.02);

  // The right regime for squares according to Chen and Vinals.
  expect(res.capillary.Sigma).toBeGreaterThan(0.7);
  expect(res.capillary.gamma).toBeLessThan(0.05);

  // Squares: the 90-degree harmonic clearly dominates. What gets compared are ratios
  // between harmonics rather than an absolute value: the magnitude depends on how many
  // discrete modes fall in the ring, which is a property of the grid, not the physics.
  expect(res.capillary.n2, 'no square symmetry in the capillary regime').toBeGreaterThan(0.6);
  expect(res.capillary.n2 / res.capillary.n1, 'stripes are competing with squares').toBeGreaterThan(2);
  expect(res.capillary.n2 / res.capillary.n3, 'hexagons are competing with squares').toBeGreaterThan(2);

  // And in gravity it does NOT come out the same. If squares appeared in both regimes
  // the solver would not be selecting anything and the experiment would say nothing.
  expect(res.gravity.n2, 'the solver does not discriminate regime').toBeLessThan(0.5);
});

test('the Faraday threshold lands where Mathieu theory puts it', async ({ page }) => {
  await openApp(page);
  // High nu on purpose: the growth rate goes as lambda = 2 nu k^2, and with small nu the
  // experiment would need hundreds of thousands of steps to be conclusive. gamma is still
  // 0.02, well inside the low-dissipation regime.
  await mount(page, N, { nu: 0.05, dt: 0.01, noiseFloor: 0, sigma: 8, h: 6 });

  const res = await page.evaluate(async () => {
    const z = window.__z, N = z.N;
    const m = 5;
    const k = 2 * Math.PI * m / N;
    const w = z.omegaOfK(k);
    z.omega = 2 * w;                       // drive exactly at subharmonic resonance

    // Threshold written out here by hand, without calling z.threshold(), so the test
    // compares against Landau rather than against the code itself. h_c = 4 lambda / w0,
    // and the drive reaches the mode reduced by g/(g + sigma k^2) because shaking
    // modulates gravity but not surface tension.
    const lambda = 2 * z.nu * k * k;
    const Fc = (4 * lambda / w) / (z.g0 / (z.g0 + z.sigma * k * k));

    const rms = () => { const e = z.readHeights(); let s = 0; for (const v of e) s += v * v; return Math.sqrt(s / e.length); };
    // The wave oscillates, so an instantaneous value depends on which phase you look
    // at. What grows or decays is the ENVELOPE: the maximum over a full period.
    const periodo = Math.ceil((2 * Math.PI / w) / z.dt);
    const envolvente = () => { let p = 0; for (let i = 0; i < periodo; i++) { z.step(); p = Math.max(p, rms()); } return p; };

    const crece = F => {
      z.F = F;
      z.seedWave(m, 0, 1e-5);
      const a = envolvente();
      for (let i = 0; i < 5000; i++) z.step();
      const b = envolvente();
      return b / a;
    };
    return {
      Fc: +Fc.toFixed(5),
      delCodigo: +z.threshold().toFixed(5),
      bajo: crece(Fc * 0.5),
      alto: crece(Fc * 4.0),
    };
  });

  console.log('umbral:', JSON.stringify(res));
  // The threshold the solver computes must agree with Landau's.
  expect(res.delCodigo).toBeCloseTo(res.Fc, 4);
  expect(res.bajo, 'below threshold the wave should decay').toBeLessThan(1);
  expect(res.alto, 'above threshold it should grow').toBeGreaterThan(5);
});
