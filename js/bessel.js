// Bessel functions of the first kind and their zeros.
// Needed for the eigenmodes of a circular membrane:
//   u_nm(r, th) = J_n(alpha_nm * r / R) * cos(n*th + phase)
// where alpha_nm is the m-th positive zero of J_n.
//
// J0/J1: classic rational approximations (Abramowitz & Stegun 9.4).
// J_n with n>=2: Miller downward recurrence, stable for every x.

export function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax < 8.0) {
    const y = x * x;
    const p = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7 +
      y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))));
    const q = 57568490411.0 + y * (1029532985.0 + y * (9494680.718 +
      y * (59272.64853 + y * (267.8532712 + y))));
    return p / q;
  }
  const z = 8.0 / ax;
  const y = z * z;
  const xx = ax - 0.785398164;
  const p = 1.0 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 +
    y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const q = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 +
    y * (0.7621095161e-6 + y * -0.934935152e-7)));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
}

export function besselJ1(x) {
  const ax = Math.abs(x);
  let ans;
  if (ax < 8.0) {
    const y = x * x;
    const p = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 +
      y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))));
    const q = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 +
      y * (99447.43394 + y * (376.9991397 + y))));
    ans = p / q;
  } else {
    const z = 8.0 / ax;
    const y = z * z;
    const xx = ax - 2.356194491;
    const p = 1.0 + y * (0.183105e-2 + y * (-0.3516396496e-4 +
      y * (0.2457520174e-5 + y * -0.240337019e-6)));
    const q = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 +
      y * (-0.88228987e-6 + y * 0.105787412e-6)));
    ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
    if (x < 0.0) ans = -ans;
  }
  return ans;
}

const ACC = 40.0;
const BIGNO = 1.0e10;
const BIGNI = 1.0e-10;

export function besselJ(n, x) {
  if (n === 0) return besselJ0(x);
  if (n === 1) return besselJ1(x);
  if (n < 0) return (n % 2 === 0 ? 1 : -1) * besselJ(-n, x);

  const ax = Math.abs(x);
  if (ax === 0.0) return 0.0;

  let ans;
  if (ax > n) {
    // Upward recurrence: stable when x > n.
    const tox = 2.0 / ax;
    let bjm = besselJ0(ax);
    let bj = besselJ1(ax);
    for (let j = 1; j < n; j++) {
      const bjp = j * tox * bj - bjm;
      bjm = bj;
      bj = bjp;
    }
    ans = bj;
  } else {
    // Miller: start high with zero and normalise with the sum identity.
    const tox = 2.0 / ax;
    const m = 2 * Math.floor((n + Math.floor(Math.sqrt(ACC * n))) / 2);
    let jsum = false;
    let sum = 0.0;
    let bjp = 0.0;
    let bj = 1.0;
    ans = 0.0;
    for (let j = m; j > 0; j--) {
      const bjm = j * tox * bj - bjp;
      bjp = bj;
      bj = bjm;
      if (Math.abs(bj) > BIGNO) {
        bj *= BIGNI;
        bjp *= BIGNI;
        ans *= BIGNI;
        sum *= BIGNI;
      }
      if (jsum) sum += bj;
      jsum = !jsum;
      if (j === n) ans = bjp;
    }
    sum = 2.0 * sum - bj;
    ans /= sum;
  }
  return (x < 0.0 && n % 2 === 1) ? -ans : ans;
}

// m-th positive zero of J_n (m starts at 1).
// Coarse scan for sign changes, then bisection.
export function besselZeros(n, count, xmax = 200) {
  const zeros = [];
  const step = 0.02;
  // The first zero of J_n grows like n + 1.86 n^(1/3); starting close saves scanning.
  let x = n === 0 ? step : Math.max(step, n - 1);
  let prev = besselJ(n, x);
  while (zeros.length < count && x < xmax) {
    const x2 = x + step;
    const cur = besselJ(n, x2);
    if (prev === 0) {
      zeros.push(x);
    } else if (prev * cur < 0) {
      let a = x, b = x2, fa = prev;
      for (let i = 0; i < 60; i++) {
        const mid = 0.5 * (a + b);
        const fm = besselJ(n, mid);
        if (fa * fm <= 0) { b = mid; } else { a = mid; fa = fm; }
      }
      zeros.push(0.5 * (a + b));
    }
    x = x2;
    prev = cur;
  }
  return zeros;
}

// One row per order, holding J_n(x) sampled over [0, xmax].
// Returns {data: Float32Array, width, height, xmax}, ready to upload as R16F/R32F.
export function besselTable(maxOrder, width = 1024, xmax = 60) {
  const height = maxOrder + 1;
  const data = new Float32Array(width * height);
  for (let n = 0; n <= maxOrder; n++) {
    for (let i = 0; i < width; i++) {
      const x = (i / (width - 1)) * xmax;
      data[n * width + i] = besselJ(n, x);
    }
  }
  return { data, width, height, xmax };
}
