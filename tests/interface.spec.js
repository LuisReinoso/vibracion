// The interface: that simple mode stays simple and that audio really gets in.

import { test, expect } from '@playwright/test';
import { openApp, releaseContexts } from './helpers.js';

// Release WebGL contexts after each test: piling them up makes the browser discard the
// oldest and other test files silently read zeros.
test.afterEach(releaseContexts);

test('boots with no console errors and both simulations alive', async ({ page }) => {
  const errores = await openApp(page);
  await page.waitForTimeout(2000);
  expect(errores).toEqual([]);

  const estado = await page.evaluate(() => ({
    chladni: !!window.vibracion.chladni?.gl,
    faraday: !!window.vibracion.faraday?.gl,
    modos: window.vibracion.chladni.circular.length,
  }));
  expect(estado.chladni).toBe(true);
  expect(estado.faraday).toBe(true);
  expect(estado.modos).toBeGreaterThan(100);
});

test('simple mode hides the physics and expert mode shows it', async ({ page }) => {
  await openApp(page);

  const faradayPanel = page.locator('.group.expert', { hasText: 'Faraday waves' });
  await expect(faradayPanel).toBeHidden();
  await expect(page.locator('#btn-mode')).toHaveText('Expert mode');

  // What must be within reach without touching anything.
  await expect(page.locator('button.demo').first()).toBeVisible();
  await expect(page.locator('#s-detail')).toBeVisible();
  await expect(page.locator('#view-seg')).toBeVisible();

  await page.click('#btn-mode');
  await expect(faradayPanel).toBeVisible();
  await expect(page.locator('#btn-mode')).toHaveText('Simple mode');
});

// Regression: the mode switch used to live in a class on <body>, and <body> then
// matched the `.expert { display: none }` rule itself. Pressing "Expert mode" made the
// whole page vanish. What matters is not where the state is stored but that entering
// expert mode still leaves a page behind.
test('entering expert mode does not wipe the page', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-mode');

  const geo = await page.evaluate(() => {
    const alto = sel => document.querySelector(sel).getBoundingClientRect().height;
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      body: alto('body'), header: alto('header'), main: alto('main'), controles: alto('#controls'),
    };
  });
  expect(geo.bodyDisplay).not.toBe('none');
  expect(geo.body).toBeGreaterThan(200);
  expect(geo.header).toBeGreaterThan(20);
  expect(geo.main).toBeGreaterThan(200);
  expect(geo.controles).toBeGreaterThan(200);

  await expect(page.locator('#panel-chladni')).toBeVisible();
  await expect(page.locator('#cv-faraday')).toBeVisible();
});

test('the chosen mode survives a reload', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-mode');
  await expect(page.locator('#s-nu')).toBeVisible();

  await page.reload();
  await page.waitForFunction(() => window.vibracion);
  await expect(page.locator('#s-nu')).toBeVisible();
  await expect(page.locator('#btn-mode')).toHaveText('Simple mode');
});

test('the detail knob moves the parameters of both simulations', async ({ page }) => {
  await openApp(page);
  const leer = () => page.evaluate(() => ({
    f0: window.vibracion.chladni.f0,
    omax: window.vibracion.faraday.omegaMax,
    etiqueta: document.getElementById('o-detail').textContent,
  }));

  const mover = v => page.locator('#s-detail').evaluate((el, x) => {
    el.value = String(x); el.dispatchEvent(new Event('input'));
  }, v);

  await mover(0);
  const grueso = await leer();
  await mover(1);
  const fino = await leer();

  // Fine = lower f0 (higher-order modes) and higher Omega (larger wavenumber).
  expect(fino.f0).toBeLessThan(grueso.f0);
  expect(fino.omax).toBeGreaterThan(grueso.omax);
  expect(grueso.etiqueta).toBe('coarse');
  expect(fino.etiqueta).toBe('fine');

  // And it leaves the expert sliders consistent rather than out of sync.
  await page.click('#btn-mode');
  await expect(page.locator('#s-f0')).toHaveValue(String(fino.f0));
});

test('the demo tracks download, decode and play', async ({ page }) => {
  await openApp(page);
  await page.click('button.demo[data-track$="sun-is-setting-fast.mp3"]');

  await page.waitForFunction(() => window.vibracion.audio.playing, null, { timeout: 30_000 });
  await page.waitForTimeout(3000);

  const a = await page.evaluate(() => ({
    modo: window.vibracion.audio.mode,
    duracion: window.vibracion.audio.buffer?.duration,
    nivel: window.vibracion.audio.level,
    dominante: window.vibracion.audio.dominantHz,
  }));
  expect(a.modo).toBe('file');
  expect(a.duracion).toBeGreaterThan(60);
  expect(a.nivel).toBeGreaterThan(0.01);
  expect(a.dominante).toBeGreaterThan(20);

  await expect(page.locator('#audio-status')).toContainText('The Sun is Setting Fast');
  await expect(page.locator('button.demo').first()).toHaveClass(/on/);
});

test('both tracks are served and are real audio', async ({ request }) => {
  for (const p of ['/audio/sun-is-setting-fast.mp3', '/audio/organic-dissonance.mp3']) {
    const r = await request.get(p);
    expect(r.status(), p).toBe(200);
    const body = await r.body();
    expect(body.length, p).toBeGreaterThan(500_000);
    // MPEG header: "ID3" or a 0xFFEx frame sync.
    const esMp3 = body.subarray(0, 3).toString('latin1') === 'ID3' ||
                  (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
    expect(esMp3, `${p} does not look like an MP3`).toBe(true);
  }
});

// Regression: the browser ships `[hidden] { display: none }`, but `.slider` sets
// `display: grid` and beat it on order. Controls marked hidden were visible anyway, so
// the tone frequency slider was permanently on screen without that source being chosen.
test('the hidden attribute really does hide the conditional controls', async ({ page }) => {
  await openApp(page);
  for (const sel of ['#tone-row', '#bowl-row', '#btn-strike', '#bowl-info']) {
    await expect(page.locator(sel), sel).toBeHidden();
    expect(await page.locator(sel).evaluate(el => getComputedStyle(el).display), sel).toBe('none');
  }
});

test('the bowl is at hand in simple mode and shows its partials', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#btn-bowl')).toBeVisible();
  await expect(page.locator('#bowl-row')).toBeHidden();
  await expect(page.locator('#btn-strike')).toBeHidden();

  await page.click('#btn-bowl');
  await expect(page.locator('#bowl-row')).toBeVisible();
  await expect(page.locator('#btn-strike')).toBeVisible();
  await expect(page.locator('#audio-status')).toContainText('Singing bowl');
  await expect(page.locator('#bowl-info')).toContainText('Inharmonic partials');
  await expect(page.locator('#bowl-info')).toContainText('Fundamental beat');

  // Striking on top of the rubbed tone must not break anything or switch source.
  await page.click('#btn-strike');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.vibracion.audio.mode)).toBe('bowl');
});

test('choosing another source silences the bowl and hides its controls', async ({ page }) => {
  await openApp(page);
  await page.click('#btn-bowl');
  await expect(page.locator('#bowl-row')).toBeVisible();

  await page.click('button.demo[data-track$="sun-is-setting-fast.mp3"]');
  await page.waitForFunction(() => window.vibracion.audio.mode === 'file', null, { timeout: 30_000 });
  await expect(page.locator('#bowl-row')).toBeHidden();
  await expect(page.locator('#bowl-info')).toBeHidden();
  expect(await page.evaluate(() => window.vibracion.audio.bowl.sounding)).toBe(false);
});

test('switching view hides the panel you are not looking at', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#panel-chladni')).toBeVisible();
  await expect(page.locator('#panel-faraday')).toBeVisible();

  await page.click('#view-seg button[data-view="faraday"]');
  await expect(page.locator('#panel-chladni')).toBeHidden();
  await expect(page.locator('#panel-faraday')).toBeVisible();

  await page.click('#view-seg button[data-view="chladni"]');
  await expect(page.locator('#panel-faraday')).toBeHidden();
});

test('the nodes/antinodes toggle changes both render and label', async ({ page }) => {
  await openApp(page);
  await page.click('#matter-seg button[data-powder="anti"]');
  await expect(page.locator('#hint-chladni')).toContainText('antinodes');
  expect(await page.evaluate(() => window.vibracion.chladni.powder)).toBe('anti');

  await page.click('#matter-seg button[data-powder="node"]');
  await expect(page.locator('#hint-chladni')).toContainText('nodes');
});
