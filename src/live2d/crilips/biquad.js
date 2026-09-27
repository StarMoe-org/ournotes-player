import { F } from "../../engine/core.js";
import { sincosf } from "./libm.js";

// The low-pass biquad CRI Lips runs on the voice before decimating it (`criwareLLips_CreateAfxLpf`:
// a CriWare biquad of type low-pass, cutoff from the data object, Q 1). The coefficients are the RBJ
// low-pass (`criwareLAfxIir_CalcLowpass`, device sincosf); `criwareLAfxIirSimd_SetCoef` normalizes
// them and expands the recursion over blocks of four samples, and `criwareLAfxIirSimd_Process` runs
// eight samples per step as two such blocks. The state is (x[-2], x[-1], y[-2], y[-1]); after every
// call the output states below 1e-24 in magnitude are flushed to zero, so the caller must present the
// same block lengths as the native analyzer. All float32, no fused multiply-add.

const TWO_PI = F(2 * Math.PI), FLUSH = F(1e-24);

export class CriBiquadLpf {
  constructor(sampleRate, cutoffHz, q = 1) {
    const fs = F(sampleRate);
    let fc = F(cutoffHz);
    const top = F(F(fs * 0.5) + -100);
    if (fc < 10) fc = F(10); else if (fc > top) fc = top;
    q = F(q);
    if (!(q > 0.001)) q = F(0.001);
    const [s, c] = sincosf(F(F(fc * TWO_PI) / fs));
    const alpha = F(s / F(q + q));
    const omc = F(1 - c);
    this._setCoef([F(alpha + 1), F(c * -2), F(1 - alpha)], [F(omc * 0.5), omc, F(omc * 0.5)]);
    this.state = new Float32Array(4);
  }

  // a[0..2], b[0..2] -> the 8 lane vectors V0..V7 (coefficients of x3, x2, x1, x0, x[-2], x[-1],
  // y[-2], y[-1] for the four outputs of a block)
  _setCoef(a, b) {
    const a0 = a[0];
    const a1 = F(a[1] / a0), b0 = F(b[0] / a0), b1 = F(b[1] / a0), b2 = F(b[2] / a0), a2 = F(a[2] / a0);
    const aa = F(a1 * a1), na1 = F(-a1);
    const t7 = F(b1 - F(b0 * a1));
    const t11 = F(F(b2 * aa) - F(b2 * a2));
    const t13 = F(b2 - F(b1 * a1));
    const t15 = F(F(a2 * a2) - F(aa * a2));
    const t12 = F(a1 * a2);
    const t10 = F(aa - a2);
    const t14 = F(F(t13 * na1) - F(b1 * a2));
    const t6 = F(t12 - F(t10 * a1));
    const t9 = F(b2 + F(F(t7 * na1) - F(b0 * a2)));
    const v = new Float32Array(32);
    v.set([0, 0, 0, b0, 0, 0, b0, t7, 0, b0, t7, t9, b0, t7, t9, F(F(t9 * na1) - F(a2 * t7))]);
    v.set([b2, F(b2 * na1), t11, F(F(b2 * t12) - F(t11 * a1)),
           b1, t13, t14, F(F(t14 * na1) - F(a2 * t13)),
           F(-a2), t12, t15, F(F(t15 * na1) - F(a2 * t12)),
           na1, t10, t6, F(F(t6 * na1) - F(a2 * t10))], 16);
    this.v = v;
  }

  reset() { this.state.fill(0); }

  // Filter n samples of x into y (n rounded down to a multiple of 8, as natively), then flush.
  process(x, y, n = x.length) {
    const v = this.v, st = this.state;
    let xm2 = st[0], xm1 = st[1], ym2 = st[2], ym1 = st[3];
    const m = n & ~7;
    for (let i = 0; i < m; i += 8) {
      const x0 = x[i], x1 = x[i + 1], x2 = x[i + 2], x3 = x[i + 3];
      const x4 = x[i + 4], x5 = x[i + 5], x6 = x[i + 6], x7 = x[i + 7];
      for (let l = 0; l < 4; l++) {
        let t = F(F(v[8 + l] * x1) + F(v[12 + l] * x0));
        t = F(F(v[4 + l] * x2) + t);
        t = F(F(v[l] * x3) + t);
        t = F(t + F(v[16 + l] * xm2));
        t = F(t + F(v[20 + l] * xm1));
        t = F(t + F(v[24 + l] * ym2));
        y[i + l] = F(t + F(v[28 + l] * ym1));
      }
      const o2 = y[i + 2], o3 = y[i + 3];
      for (let l = 0; l < 4; l++) {
        let t = F(F(v[8 + l] * x5) + F(v[12 + l] * x4));
        t = F(F(v[4 + l] * x6) + t);
        t = F(F(v[l] * x7) + t);
        t = F(t + F(v[16 + l] * x2));
        t = F(t + F(v[20 + l] * x3));
        t = F(t + F(v[24 + l] * o2));
        y[i + 4 + l] = F(t + F(v[28 + l] * o3));
      }
      xm2 = x6; xm1 = x7; ym2 = y[i + 6]; ym1 = y[i + 7];
    }
    if (Math.abs(ym2) < FLUSH) ym2 = 0;
    if (Math.abs(ym1) < FLUSH) ym1 = 0;
    st[0] = xm2; st[1] = xm1; st[2] = ym2; st[3] = ym1;
    return m;
  }
}
