// Bridge between a real fluid and the solver's units.
//
// zakharov.js works non-dimensionalised: a grid cell is 1 and time is measured in
// whatever units fall out. That is fine for exploring, but it makes it impossible to
// compare against a published experiment, which is the only thing that separates "the
// code solves its equations correctly" from "the model reproduces water".
//
// The rescaling is x_sim = x_real / L and t_sim = t_real / T, which gives
//
//   g_sim     = g     * T^2 / L
//   sigma_sim = (s/r) * T^2 / L^3
//   nu_sim    = nu    * T   / L^2
//   h_sim     = h     / L
//   omega_sim = omega * T
//
// T is fixed by asking for g_sim = 1, that is T = sqrt(L/g). Only L is left to choose,
// and it is chosen by asking that at a reference frequency the wavelength spans a
// convenient number of cells.
//
// The dimensionless groups (gamma for viscous damping, Sigma for capillary weight) must
// come out identical whether computed on one side or the other. That is the check that
// exposes a conversion error, and it lives in the tests.

/** Gravitational acceleration in cm/s^2. */
export const G_CGS = 981.0;

/**
 * Gravity-capillary dispersion relation for a real fluid.
 * @param {number} k wavenumber in 1/cm
 * @param {{sigma:number, rho:number, h:number}} f properties in CGS
 * @returns {number} angular frequency in rad/s
 */
export function omegaOf(k, f) {
  const cap = (f.sigma / f.rho) * k * k * k;
  return Math.sqrt((G_CGS * k + cap) * Math.tanh(k * f.h));
}

/** Wavenumber that oscillates at `omega`, by bisection. */
export function kOfOmega(omega, f) {
  let lo = 1e-6, hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (omegaOf(mid, f) < omega) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Faraday wavenumber for a drive of f0 hertz.
 * The response is subharmonic, so the water oscillates at f0/2.
 */
export function faradayK(f0Hz, f) {
  return kOfOmega(2 * Math.PI * (f0Hz / 2), f);
}

/**
 * Convert a real fluid into solver parameters.
 *
 * @param {object} fluid  {nu, rho, sigma, h} in CGS
 * @param {object} opts
 * @param {number} opts.refHz             reference drive frequency
 * @param {number} opts.cellsPerWavelength  cells its wavelength should span
 */
export function toSolver(fluid, { refHz, cellsPerWavelength }) {
  const refK = faradayK(refHz, fluid);
  const refLambda = 2 * Math.PI / refK;              // cm
  const L = refLambda / cellsPerWavelength;          // cm per cell
  const T = Math.sqrt(L / G_CGS);                    // s per time unit

  return {
    L, T,
    gS: 1,                                           // by construction
    sigmaS: (fluid.sigma / fluid.rho) * T * T / (L * L * L),
    nuS: fluid.nu * T / (L * L),
    hS: fluid.h / L,

    /** Solver omega for a drive of f0 hertz. */
    omegaFor: f0Hz => 2 * Math.PI * f0Hz * T,
    /** Faraday wavelength, in cells, for that drive. */
    cellsAt: f0Hz => (2 * Math.PI / faradayK(f0Hz, fluid)) / L,
    /** Ring index on an N grid: how many wavelengths fit across. */
    ringAt: (f0Hz, N) => N / ((2 * Math.PI / faradayK(f0Hz, fluid)) / L),

    /** Dimensionless viscous damping, computed in real units. */
    gammaAt: f0Hz => {
      const k = faradayK(f0Hz, fluid);
      return 2 * fluid.nu * k * k / omegaOf(k, fluid);
    },
    /** Capillary weight against gravity, in real units. */
    sigmaAt: f0Hz => {
      const k = faradayK(f0Hz, fluid);
      const cap = (fluid.sigma / fluid.rho) * k * k;
      return cap / (G_CGS + cap);
    },
  };
}

/**
 * The silicone oil of Binks and van de Water (Phys. Rev. Lett. 78, 4043, 1997), as
 * quoted by Chen and Vinals. The depth is not given as a number: the paper says the
 * cell is much deeper than the wavelength, so it is enough that k*h be large and
 * tanh(kh) be effectively one.
 */
export const BINKS_SILICONE_OIL = {
  nu: 0.03397,      // cm^2/s
  rho: 0.8924,      // g/cm^3
  sigma: 18.3,      // dyn/cm
  h: 3.0,           // cm, far larger than the wavelength (~0.1 cm)
};
