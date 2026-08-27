import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
  testDir: './tests',
  // The Faraday tests wait for an instability to grow out of noise: they are slow by
  // nature, not because they are badly written.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Without this the AudioContext starts suspended and there is no spectrum to measure.
            '--autoplay-policy=no-user-gesture-required',
            // WebGL2 with float render targets in headless.
            '--use-gl=angle',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
    {
      // The validation against the experiment runs twelve Fourier transforms per step on
      // a 256 grid for tens of thousands of steps. Under SwiftShader, which is software
      // rendering, it does not finish in half an hour. This profile asks for the real
      // GPU and is only used by hand: CI has no GPU.
      name: 'gpu',
      use: {
        ...devices['Desktop Chrome'],
        // A real window, on purpose. Headless and without a display, Chromium falls back
        // to SwiftShader even when asked for the GPU, and then this validation never
        // finishes.
        headless: false,
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-gpu-blocklist',
            '--enable-gpu-rasterization',
          ],
        },
      },
    },
  ],

  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
