// The tests that matter: that the physics stays physics.
// Each compares against a value that exists outside the code (Bessel tables, Mathieu
// theory) rather than against whatever the program returned yesterday.

import { test, expect } from '@playwright/test';
import { openApp, playTone, heightField, rms, waitForPattern, dominantWavelength, releaseContexts } from './helpers.js';

// Release WebGL contexts after each test: piling them up makes the browser discard the
// oldest and other test files silently read zeros.
test.afterEach(releaseContexts);

test('Bessel zeros match the published tables', async ({ page }) => {
  await openApp(page);
  const ceros = await page.evaluate(async () => {
    const m = await import('/js/bessel.js');
    const out = {};
    for (const n of [0, 1, 2, 3, 4, 8, 15]) out[n] = m.besselZeros(n, 3);
    return out;
  });

  // Abramowitz & Stegun, tabla 9.5.
  const expected = {
    0: [2.404826, 5.520078, 8.653728],
    1: [3.831706, 7.015587, 10.173468],
    2: [5.135622, 8.417244, 11.619841],
    3: [6.380162, 9.761023, 13.015201],
    4: [7.588342, 11.064709, 14.372537],
    8: [12.225092, 16.037774, 19.554536],
    15: [19.994430, 24.269181, 28.102415],
  };
  for (const [n, vals] of Object.entries(expected)) {
    vals.forEach((v, i) => expect(ceros[n][i], `J${n} cero ${i + 1}`).toBeCloseTo(v, 4));
  }
});

test('J_n takes the known values at reference points', async ({ page }) => {
  await openApp(page);
  const v = await page.evaluate(async () => {
    const m = await import('/js/bessel.js');
    return { j0_1: m.besselJ(0, 1), j1_1: m.besselJ(1, 1), j3_2: m.besselJ(3, 2), j8_9: m.besselJ(8, 9) };
  });
  expect(v.j0_1).toBeCloseTo(0.7651977, 6);
  expect(v.j1_1).toBeCloseTo(0.4400506, 6);
  expect(v.j3_2).toBeCloseTo(0.1289432, 6);
  expect(v.j8_9).toBeCloseTo(0.3050671, 6);
});

test('a tone excites the eigenmode it should', async ({ page }) => {
  await openApp(page);
  // Circular dish, f0 = 90 Hz. Mode (2,1) sits at alpha_21/alpha_01 * 90 = 192 Hz.
  await playTone(page, 192);
  await page.locator('#s-f0').evaluate(el => { el.value = '90'; el.dispatchEvent(new Event('input')); });
  await page.locator('#s-q').evaluate(el => { el.value = '140'; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(2500);

  const top = await page.evaluate(() => window.vibracion.chladni.top);
  expect(top.length).toBeGreaterThan(0);
  expect(top[0].label).toBe('(2,1)');
  expect(top[0].hz).toBeCloseTo(192, 0);
});

test('lowering f0 shifts excitation to higher-order modes', async ({ page }) => {
  await openApp(page);
  await playTone(page, 400);
  await page.locator('#s-q').evaluate(el => { el.value = '90'; el.dispatchEvent(new Event('input')); });

  const modoCon = async f0 => {
    await page.locator('#s-f0').evaluate((el, v) => {
      el.value = String(v); el.dispatchEvent(new Event('input'));
    }, f0);
    await page.waitForTimeout(2500);
    return page.evaluate(() => window.vibracion.chladni.top[0]);
  };

  const grave = await modoCon(250);
  const agudo = await modoCon(50);
  // Same note, "larger" plate: the ratio f/f0 rises and with it the mode order.
  expect(agudo.hz / 50).toBeGreaterThan(grave.hz / 250);
});

test('water responds at half the drive frequency @heavy', async ({ page }) => {
  await openApp(page);
  await playTone(page, 440);
  const rmsFinal = await waitForPattern(page);
  expect(rmsFinal, 'the pattern never grew').toBeGreaterThan(0.15);

  const razon = await page.evaluate(() => new Promise(res => {
    const f = window.vibracion.faraday, gl = f.gl;
    f.locked = true;                      // Omega fixed: if it moves there is no period to measure
    // Averaged over a 5x5 patch instead of a single pixel: background noise adds spurious
    // zero crossings near the signal zeros and corrupts the period.
    const px = new Float32Array(5 * 5 * 4);
    const muestras = [];
    const tick = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.state.read.fbo);
      gl.readPixels(118, 128, 5, 5, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let media = 0;
      for (let i = 0; i < 25; i++) media += px[i * 4];
      muestras.push([f.phase, media / 25]);
      if (muestras.length < 300) return requestAnimationFrame(tick);
      let cAgua = 0, cForzado = 0;
      for (let i = 1; i < muestras.length; i++) {
        if (muestras[i - 1][1] * muestras[i][1] < 0) cAgua++;
        if (Math.cos(muestras[i - 1][0]) * Math.cos(muestras[i][0]) < 0) cForzado++;
      }
      res(cAgua / cForzado);
    };
    requestAnimationFrame(tick);
  }));

  // The Faraday signature: exact subharmonic response.
  expect(razon).toBeGreaterThan(0.42);
  expect(razon).toBeLessThan(0.58);
});

test('the wavelength follows the Mathieu prediction @heavy', async ({ page }) => {
  await openApp(page);
  await playTone(page, 440);
  expect(await waitForPattern(page)).toBeGreaterThan(0.15);

  await page.evaluate(() => { window.vibracion.faraday.locked = true; });
  await page.waitForTimeout(3000);

  const campo = await heightField(page);
  const measured = dominantWavelength(campo);
  const predicha = await page.evaluate(() => 2 * Math.PI / window.vibracion.faraday.selectedK());

  // omega(k) = Omega/2 with omega^2 = H(g k^2 + S k^4). The drive is strongly
  // supercritical, so linear theory does not nail the value: 25% is honest slack.
  expect(Math.abs(measured - predicha) / predicha).toBeLessThan(0.25);
});

test('raising the pitch shortens the selected wavelength', async ({ page }) => {
  await openApp(page);
  const lambdaCon = async hz => page.evaluate(h => {
    const f = window.vibracion.faraday;
    f.setFromAudio(h, 0.3);
    for (let i = 0; i < 400; i++) f.setFromAudio(h, 0.3);  // let the tracking converge
    return 2 * Math.PI / f.selectedK();
  }, hz);

  const grave = await lambdaCon(80);
  const agudo = await lambdaCon(3000);
  expect(agudo).toBeLessThan(grave);
});

test('below the Mathieu threshold the surface stays flat @heavy', async ({ page }) => {
  await openApp(page);
  await playTone(page, 440);

  // Viscosity at maximum and drive at zero: F ends up far below F_c.
  await page.locator('#s-nu').evaluate(el => { el.value = '0.12'; el.dispatchEvent(new Event('input')); });
  await page.locator('#s-force').evaluate(el => { el.value = '0'; el.dispatchEvent(new Event('input')); });
  await page.evaluate(() => window.vibracion.faraday.reset());
  await page.waitForTimeout(6000);

  const { F, Fc } = await page.evaluate(() => ({
    F: window.vibracion.faraday.force,
    Fc: window.vibracion.faraday.threshold(),
  }));
  expect(F).toBeLessThan(Fc);
  expect(rms(await heightField(page))).toBeLessThan(0.02);
});

// Regression: Omega used to follow the highest-amplitude bin. In real music that bin
// jumps from kick to cymbal every frame, Omega jumped with it and the parametric drive
// never accumulated coherent phase: with a pure tone the water grew, with a song it
// stayed flat. The spectral centroid moves slowly and fixes the real case.
test('the centroid is far steadier than the peak bin on music', async ({ page }) => {
  await openApp(page);
  await page.click('button.demo[data-track$="organic-dissonance.mp3"]');
  await page.waitForFunction(() => window.vibracion.audio.playing, null, { timeout: 30_000 });

  // Restart playback so the measurement window is always the same stretch of the track.
  // Otherwise it lands wherever the track happens to be and the result swings with it.
  await page.evaluate(() => window.vibracion.audio.play());
  await page.waitForTimeout(2000);

  // Sampled on a fixed wall clock rather than on requestAnimationFrame. This measures a
  // property of the audio, and tying the window to the frame rate makes it mean
  // something different on a machine that renders slowly: under software rendering the
  // same number of frames spans a completely different stretch of music. update() is
  // deliberately NOT called here, because doing so would advance the centroid's
  // smoothing at twice its normal rate and make it look less steady than it is.
  const series = await page.evaluate(() => new Promise(res => {
    const a = window.vibracion.audio, out = [];
    const id = setInterval(() => {
      out.push([a.dominantHz, a.centroidHz]);
      if (out.length >= 150) { clearInterval(id); res(out); }
    }, 20);
  }));

  const disp = i => {
    const v = series.map(s => s[i]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m;
  };
  const peakDisp = disp(0);
  const cenDisp = disp(1);
  // The claim is the comparison: the centroid moves far less than the peak bin. The
  // absolute number depends on which stretch of the track the window lands on, so it is
  // only kept as a sanity ceiling, not as the assertion.
  // Measured repeatably at about 2.7x on this window; 2x leaves margin without
  // weakening the claim, which is that one of them is far steadier than the other.
  expect(cenDisp, `centroid ${cenDisp.toFixed(3)} vs peak ${peakDisp.toFixed(3)}`)
    .toBeLessThan(peakDisp / 2);
  expect(cenDisp, 'the centroid is wandering too much to steer Omega').toBeLessThan(0.4);
});

// Regression: on the quiet track the drive fell below threshold in every soft passage,
// the pattern dissolved, and regrowing from noise took far longer than the passage
// lasted. The dish was flat for most of the piece. It is not enough that the pattern
// appears once: it has to hold.
for (const track of ['sun-is-setting-fast', 'organic-dissonance']) {
  test(`the pattern holds through the whole ${track} track @heavy`, async ({ page }) => {
    await openApp(page);
    await page.click(`button.demo[data-track$="${track}.mp3"]`);
    await page.waitForFunction(() => window.vibracion.audio.playing, null, { timeout: 30_000 });

    expect(await waitForPattern(page), 'it never formed').toBeGreaterThan(0.15);

    // Twenty seconds of sampling: rms oscillates with the subharmonic, so the maximum
    // inside each window is taken and no window is allowed to come out dead.
    const windows = [];
    for (let i = 0; i < 10; i++) {
      let pico = 0;
      for (let j = 0; j < 4; j++) {
        pico = Math.max(pico, rms(await heightField(page)));
        await page.waitForTimeout(500);
      }
      windows.push(+pico.toFixed(3));
    }
    const dead = windows.filter(v => v < 0.05);
    expect(dead.length, `windows with no pattern: ${JSON.stringify(windows)}`).toBe(0);
  });
}

test('a real music track clears the threshold and forms a pattern @heavy', async ({ page }) => {
  await openApp(page);
  await page.click('button.demo[data-track$="organic-dissonance.mp3"]');
  await page.waitForFunction(() => window.vibracion.audio.playing, null, { timeout: 30_000 });

  // The automatic gain control has to compensate for a mix spreading its energy over
  // many bins and never reaching the raw level of a pure tone.
  await page.waitForTimeout(4000);
  // Over a window, not an instant: a song's level fluctuates and what feeds the
  // instability is the peaks clearing the threshold.
  const { norm, razon } = await page.evaluate(() => new Promise(res => {
    const a = window.vibracion.audio, f = window.vibracion.faraday;
    let norm = 0, razon = 0, n = 0;
    const tick = () => {
      norm = Math.max(norm, a.levelNorm);
      razon = Math.max(razon, f.force / f.threshold());
      if (++n < 150) requestAnimationFrame(tick); else res({ norm, razon });
    };
    requestAnimationFrame(tick);
  }));
  expect(norm).toBeGreaterThan(0.5);
  expect(razon).toBeGreaterThan(2);

  expect(await waitForPattern(page), 'with music the water never moved').toBeGreaterThan(0.15);
});

test('the normalised level falls to zero when the music stops @heavy', async ({ page }) => {
  await openApp(page);
  await page.click('button.demo[data-track$="sun-is-setting-fast.mp3"]');
  await page.waitForFunction(() => window.vibracion.audio.playing, null, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.vibracion.audio.levelNorm)).toBeGreaterThan(0.3);

  await page.click('#btn-stop');
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => window.vibracion.audio.levelNorm)).toBeLessThan(0.05);

  // The gate must close the drive completely: the floor that stops the pattern from
  // dissolving between musical phrases must not keep the water moving in silence.
  expect(await page.evaluate(() => window.vibracion.faraday.force)).toBe(0);
  await page.waitForTimeout(15_000);
  expect(rms(await heightField(page)), 'the water did not settle after stopping').toBeLessThan(0.05);
});

// The singing bowl is the canonical cymatics case and the most demanding one for the
// audio-physics bridge: sustained inharmonic partials, slow beating, no percussion.
test('the bowl partials land where bell theory says', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-bowl');
  await page.waitForTimeout(6000);

  const { wanted, measured } = await page.evaluate(() => {
    const a = window.vibracion.audio;
    const peaks = [];
    for (let i = 3; i < a.bins - 3; i++) {
      const v = a.spectrum[i];
      if (v > 0.004 && v > a.spectrum[i - 1] && v >= a.spectrum[i + 1]) peaks.push({ hz: i * a.binHz, v });
    }
    peaks.sort((x, y) => y.v - x.v);
    return { wanted: a.bowl.partials(), measured: peaks.slice(0, 5).map(p => p.hz) };
  });

  // Inharmonic ratios measured by Inacio, Henrique and Antunes (2006).
  const ratios = [1.000, 2.770, 5.180, 8.120, 11.53];
  wanted.forEach((p, i) => expect(p.ratio).toBeCloseTo(ratios[i], 2));
  // None is an integer multiple of the fundamental, which is what sets it apart from a note.
  for (const p of wanted.slice(1)) {
    expect(Math.abs(p.ratio - Math.round(p.ratio))).toBeGreaterThan(0.1);
  }

  // And the first three must genuinely show up in the spectrum.
  for (const expected of wanted.slice(0, 3).map(p => p.hz)) {
    const cerca = measured.some(m => Math.abs(m - expected) < expected * 0.02);
    expect(cerca, `no peak near ${expected.toFixed(0)} Hz in ${measured.map(m => m.toFixed(0))}`).toBe(true);
  }
});

test('changing the bowl size scales every partial at once', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-bowl');
  await page.waitForTimeout(2000);

  const leer = () => page.evaluate(() => window.vibracion.audio.bowl.partials().map(p => p.hz));
  const pequeno = await leer();
  await page.locator('#s-bowl').evaluate(el => { el.value = '392'; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(1500);
  const grande = await leer();

  // A bowl is a bell: changing its size rescales the whole spectrum, it does not distort it.
  grande.forEach((hz, i) => expect(hz / pequeno[i]).toBeCloseTo(2, 3));
  expect(await page.evaluate(() => window.vibracion.audio.centroidHz)).toBeGreaterThan(0);
});

test('the bowl sustains the Faraday pattern without detuning @heavy', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-bowl');
  expect(await waitForPattern(page), 'the bowl never moved the water').toBeGreaterThan(0.15);

  // Beating makes the drive breathe, but it must never let the pattern drop, and Omega
  // has to stay put: the bowl partials do not move.
  const omegas = [];
  const peaks = [];
  for (let i = 0; i < 8; i++) {
    omegas.push(await page.evaluate(() => window.vibracion.faraday.omega));
    let pico = 0;
    for (let j = 0; j < 4; j++) {
      pico = Math.max(pico, rms(await heightField(page)));
      await page.waitForTimeout(400);
    }
    peaks.push(+pico.toFixed(3));
  }
  expect(peaks.filter(v => v < 0.05).length, `dead windows: ${JSON.stringify(peaks)}`).toBe(0);

  const media = omegas.reduce((a, b) => a + b, 0) / omegas.length;
  const sd = Math.sqrt(omegas.reduce((a, b) => a + (b - media) ** 2, 0) / omegas.length);
  expect(sd / media, `Omega drifted: ${JSON.stringify(omegas.map(o => +o.toFixed(3)))}`).toBeLessThan(0.05);
});

test('the field stays finite and bounded after minutes of simulation @heavy', async ({ page }) => {
  await openApp(page);
  await playTone(page, 300);
  await waitForPattern(page);
  await page.waitForTimeout(12_000);

  const campo = await heightField(page);
  expect(campo.every(Number.isFinite), 'NaN or Infinity appeared').toBe(true);
  // Cubic saturation must brake before the hard clamp at +-8.
  expect(Math.max(...campo.map(Math.abs))).toBeLessThan(7);
});
