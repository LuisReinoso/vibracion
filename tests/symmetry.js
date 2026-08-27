// Classify the symmetry of a Faraday pattern from its spectrum.
//
// The trick is to look at how energy is distributed by ANGLE within the ring of
// resonant wavenumbers. With theta folded onto [0,180), because +k and -k are the same
// standing wave, the n-th angular harmonic gives the symmetry away:
//
//   n = 1  ->  a single direction        ->  stripes
//   n = 2  ->  two directions at 90 deg  ->  squares
//   n = 3  ->  three directions at 60    ->  hexagons
//
// All three are returned so their ratios can be compared, which is more robust than a
// fixed absolute threshold: the magnitude depends on how many discrete modes fall in
// the ring, and that is a property of the grid rather than of the physics.

/**
 * Code that runs INSIDE the page. Passed to page.evaluate as a string because it needs
 * the solver's WebGL context.
 */
export const ANGULAR_HARMONICS_SRC = `
function angularHarmonics(z, N, ringR, width) {
  const gl = z.gl;
  const b = new Float32Array(N * N * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, z.spec.fbo);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, b);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const NB = 360;
  const bins = new Float64Array(NB);
  let total = 0, modos = 0;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const mx = ix <= N / 2 ? ix : ix - N;
      const my = iy <= N / 2 ? iy : iy - N;
      const r = Math.hypot(mx, my);
      if (Math.abs(r - ringR) > width || r < 0.5) continue;
      modos++;
      const i = (iy * N + ix) * 4;
      const e = b[i] * b[i] + b[i + 1] * b[i + 1];
      let th = Math.atan2(my, mx);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI) th -= Math.PI;
      bins[Math.min(NB - 1, Math.floor(th / Math.PI * NB))] += e;
      total += e;
    }
  }
  const arm = n => {
    let re = 0, im = 0;
    for (let i = 0; i < NB; i++) {
      const th = (i + 0.5) / NB * Math.PI;
      re += bins[i] * Math.cos(2 * n * th);
      im += bins[i] * Math.sin(2 * n * th);
    }
    return total > 0 ? Math.hypot(re, im) / total : NaN;
  };
  return { n1: arm(1), n2: arm(2), n3: arm(3), modos };
}

function rmsOf(z) {
  const e = z.leerAlturas();
  let s = 0;
  for (const v of e) s += v * v;
  return Math.sqrt(s / e.length);
}
`;

/** Name of the winning symmetry, or null if none stands out. */
export function classify({ n1, n2, n3 }, margin = 1.25) {
  const ranked = [['rayas', n1], ['cuadrados', n2], ['hexagonos', n3]].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!(best[1] > 0)) return null;
  return best[1] > second[1] * margin ? best[0] : null;
}
