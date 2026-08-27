// Validation against a published experiment.
//
// Everything else in this suite compares the solver against the theory of the model the
// solver itself implements. That shows the code solves its equations correctly, not that
// those equations are water. Here it is compared against numbers measured in a lab.
//
// The experiment is Binks and van de Water (Phys. Rev. Lett. 78, 4043, 1997), as
// summarised by Chen and Vinals: silicone oil with nu = 0.03397 cm^2/s, rho = 0.8924
// g/cm^3 and sigma = 18.3 dyn/cm in a cell far deeper than the wavelength. They observed
// squares above 41 Hz, stable hexagons towards 36 Hz, and a mixed band in between. Chen
// and Vinals' theory puts the transition at 35.4 Hz.

import { test, expect } from '@playwright/test';
import { openApp, releaseContexts } from './helpers.js';
import { ANGULAR_HARMONICS_SRC, classify } from './symmetry.js';

test.afterEach(releaseContexts);

test('the unit change preserves the dimensionless groups', async ({ page }) => {
  await openApp(page);

  const r = await page.evaluate(async () => {
    const { Zakharov } = await import('/js/zakharov.js');
    const { getContext } = await import('/js/glutil.js');
    const { toSolver, BINKS_SILICONE_OIL, faradayK } = await import('/js/units.js');

    const scale = toSolver(BINKS_SILICONE_OIL, { refHz: 38, cellsPerWavelength: 11 });
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const gl = getContext(cv);
    (window.__ctxs ??= []).push(gl);
    const z = new Zakharov(gl, 64);
    z.g0 = scale.gS; z.sigma = scale.sigmaS; z.nu = scale.nuS; z.h = scale.hS;

    const rows = [];
    for (const f0 of [30, 38, 46]) {
      z.omega = scale.omegaFor(f0);
      rows.push({
        f0,
        gammaSolver: z.gamma(), gammaReal: scale.gammaAt(f0),
        sigmaSolver: z.capillarity(), sigmaReal: scale.sigmaAt(f0),
        cellsSolver: 2 * Math.PI / z.selectedK(), cellsReal: scale.cellsAt(f0),
        lambdaCm: 2 * Math.PI / faradayK(f0, BINKS_SILICONE_OIL),
      });
    }
    return { rows, L: scale.L, T: scale.T, boxCm: 256 * scale.L };
  });

  // A conversion error shows up here: gamma and Sigma are dimensionless and must come
  // out identical whether computed in centimetres or in cells.
  for (const f of r.rows) {
    expect(f.gammaSolver, `gamma at ${f.f0} Hz`).toBeCloseTo(f.gammaReal, 6);
    expect(f.sigmaSolver, `Sigma at ${f.f0} Hz`).toBeCloseTo(f.sigmaReal, 6);
    expect(f.cellsSolver, `lambda at ${f.f0} Hz`).toBeCloseTo(f.cellsReal, 4);
  }

  // And the absolute values must be the experiment's: Chen and Vinals quote gamma
  // between 0.01 and 0.03 over the range studied, and millimetre wavelengths.
  for (const f of r.rows) {
    expect(f.gammaReal).toBeGreaterThan(0.01);
    expect(f.gammaReal).toBeLessThan(0.04);
    expect(f.lambdaCm).toBeGreaterThan(0.5);
    expect(f.lambdaCm).toBeLessThan(1.5);
  }
  // Large aspect-ratio cell, like the one in the experiment.
  expect(r.boxCm).toBeGreaterThan(10);
});

test('reproduces the symmetry transition measured by Binks and van de Water @gpu', async ({ page }) => {
  // Necesita GPU de verdad: con render por software no termina. Se lanza a mano con
  // `npm run test:validacion`, no entra en la suite normal ni en CI.
  test.setTimeout(1_800_000);
  await openApp(page);

  const res = await page.evaluate(async ({ codigo }) => {
    eval(codigo);
    const { Zakharov } = await import('/js/zakharov.js');
    const { getContext } = await import('/js/glutil.js');
    const { toSolver, BINKS_SILICONE_OIL } = await import('/js/units.js');
    const scale = toSolver(BINKS_SILICONE_OIL, { refHz: 38, cellsPerWavelength: 10 });
    const N = 256;

    const points = [];
    for (const f0 of [32, 44]) {
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const gl = getContext(cv);
      (window.__ctxs ??= []).push(gl);
      const z = new Zakharov(gl, N);
      z.g0 = scale.gS; z.sigma = scale.sigmaS; z.nu = scale.nuS; z.h = scale.hS;
      z.dt = 0.02; z.noiseFloor = 0; z.omega = scale.omegaFor(f0);
      const rObj = scale.ringAt(f0, N);
      // 2.2 times threshold. Lower and the selection takes five times longer and the
      // test does not fit in any reasonable time; higher and the amplitude leaves the
      // range where the cubic expansion holds and the solver ends up diverging. The full
      // sweep in the README uses 1.8 and confirms the selected symmetry is the same.
      z.F = z.threshold() * 2.2;
      z.seedRing(rObj, 2.0, 0.08);

      // Transient: amplitude saturates long before the symmetry is decided, and
      // measuring early gives the opposite answer with full confidence and no symptoms.
      for (let b = 0; b < 4; b++) {
        for (let i = 0; i < 10000; i++) z.step();
        await new Promise(r => setTimeout(r, 0));
      }
      const acc = { n1: 0, n2: 0, n3: 0 };
      const VENTANAS = 3;
      for (let b = 0; b < VENTANAS; b++) {
        for (let i = 0; i < 10000; i++) z.step();
        await new Promise(r => setTimeout(r, 0));
        const a = angularHarmonics(z, N, rObj, 3);
        acc.n1 += a.n1 / VENTANAS; acc.n2 += a.n2 / VENTANAS; acc.n3 += a.n3 / VENTANAS;
      }
      points.push({ f0, rms: rmsOf(z), Sigma: scale.sigmaAt(f0), ...acc });
      z.dispose();
    }
    return points;
  }, { codigo: ANGULAR_HARMONICS_SRC });

  console.log('sweep:', JSON.stringify(res, null, 1));
  const low = res.find(p => p.f0 === 32);
  const high = res.find(p => p.f0 === 44);

  // There must be a pattern to classify.
  expect(low.rms).toBeGreaterThan(0.05);
  expect(high.rms).toBeGreaterThan(0.05);

  // What the laboratory measured: hexagons below 36 Hz, squares above 41 Hz. The
  // direction of the change is what gets checked, and that is the falsifiable claim.
  expect(classify(low), `at 32 Hz it came out ${JSON.stringify(low)}`).toBe('hexagons');
  expect(classify(high), `at 44 Hz it came out ${JSON.stringify(high)}`).toBe('squares');
  expect(low.n3 / low.n2, 'hexagons do not win at 32 Hz').toBeGreaterThan(1.5);
  expect(high.n2 / high.n3, 'squares do not win at 44 Hz').toBeGreaterThan(1.5);
});
