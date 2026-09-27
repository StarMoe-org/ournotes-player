import { F } from "../../engine/core.js";

// CriWare's own float trigonometry (`criwareLMath_Sin/Cos/Sin4/Cos4`): truncated Taylor polynomials,
// not the platform libm. The FFT generates its twiddle factors with these and the mel filter bank its
// band weighting, so they are reproduced operation for operation (float32, no fusion). The 4-lane
// variants are evaluated per lane.

// sin x ~ x (1 - x^2/6 (1 - x^2/20 (1 - x^2/42 (1 - x^2/72))))
export const criSin = (x) => {
  const s = F(x * x);
  let t = F(F(s / -72) + 1);
  t = F(F(F(s / -42) * t) + 1);
  t = F(F(F(s / -20) * t) + 1);
  t = F(F(F(s / -6) * t) + 1);
  return F(t * x);
};

// cos x ~ 1 - x^2/2 (1 - x^2/12 (1 - x^2/30 (1 - x^2/56)))
export const criCos = (x) => {
  const s = F(x * x);
  let t = F(F(s / -56) + 1);
  t = F(F(F(s / -30) * t) + 1);
  t = F(F(F(s / -12) * t) + 1);
  return F(F(F(s * -0.5) * t) + 1);
};

const SIN3 = F(1 / 6), SIN5 = F(1 / 120), SIN7 = F(1 / 5040), SIN9 = F(1 / 362880);
const COS2 = F(0.5), COS4 = F(1 / 24), COS6 = F(1 / 720), COS8 = F(1 / 40320);

// one lane of the 4-lane sine: x - x^3/3! + x^5/5! - x^7/7! + x^9/9!
export const criSin4Lane = (x) => {
  const x2 = F(x * x), x3 = F(x2 * x), x5 = F(x3 * x2), x7 = F(x2 * x5);
  return F(F(F(x2 * x7) * SIN9) + F(F(F(x5 * SIN5) + F(x - F(x3 * SIN3))) - F(x7 * SIN7)));
};

// one lane of the 4-lane cosine: 1 - x^2/2! + x^4/4! - x^6/6! + x^8/8!
export const criCos4Lane = (x) => {
  const x2 = F(x * x), x4 = F(x2 * x2), x6 = F(x4 * x2);
  return F(F(F(x2 * x6) * COS8) + F(F(F(x4 * COS4) + F(1 - F(x2 * COS2))) - F(x6 * COS6)));
};
