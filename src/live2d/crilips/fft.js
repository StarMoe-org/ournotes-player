import { F } from "../../engine/core.js";
import { criSin, criCos, criSin4Lane, criCos4Lane } from "./crimath.js";

// CriWare's complex FFT (`criwareLAfxUtl_FFT`), reproduced operation for operation. It is a radix-2
// Stockham transform over an array stored in blocks of four complex values; every stage writes
// dst[i] = A + w*B and dst[i + N/2] = A - w*B, with the product w*B formed as
// (wr*Bre - wi'*Bim, wi'*Bre + wr*Bim), wi' = wi * dir. The twiddle factors come from CriWare's
// polynomial sine/cosine and advance by complex rotation from group to group, so every twiddle is
// rounded exactly as the native code rounds it. Stages:
//   1. log2(N) - 2 stages over whole blocks: A and B are `stride` blocks apart (stride N/8 halving to
//      1), one twiddle per group, w0 = (1, 0), w(j+1) = (c wr - s wi, s wr + c wi) with
//      (c, s) = (cos t, sin t), t = pi / groups.
//   2. a stage inside blocks pairing elements 0,1 with 2,3 (two groups per block), lane twiddles from
//      the 4-lane polynomials at angles (0, 0, a, a), a = pi / (N/4), rotated per block by 2a.
//   3. a stage pairing elements 0,2 with 1,3 (four groups per block), lanes at (0, b, 2b, 3b),
//      b = a / 2, rotated per block by 4b.
// Arrays are in natural element order (element e = 4 * block + lane). N: power of two >= 16.

export class CriFft {
  constructor(n) {
    if (n < 16 || (n & (n - 1))) throw new Error("CriFft: N must be a power of two >= 16");
    this.n = n;
    this.bufs = [[new Float32Array(n), new Float32Array(n)], [new Float32Array(n), new Float32Array(n)]];
    // twiddle sequences, generated exactly as the native recurrences produce them
    const blockStages = Math.log2(n) - 2;
    this.stages = [];
    let theta = F(Math.PI);
    for (let st = 0; st < blockStages; st++) {
      const c = criCos(theta), s = criSin(theta), groups = 1 << st;
      const wr = new Float32Array(groups), wi = new Float32Array(groups);
      let r = 1, i = 0;
      for (let j = 0; j < groups; j++) {
        wr[j] = r; wi[j] = i;
        const nr = F(F(c * r) - F(s * i));
        i = F(F(s * r) + F(c * i)); r = nr;
      }
      this.stages.push({ wr, wi, stride: (n >> 3) >> st });
      theta = F(theta * 0.5);
    }
    const a = theta, b = F(a * 0.5);
    this.lane2 = this._laneTwiddles([0, 0, a, a], F(a + a));
    this.lane3 = this._laneTwiddles([0, b, F(b + b), F(b * 3)], F(b * 4));
  }

  _laneTwiddles(ang, rot) {
    const C = criCos(rot), S = criSin(rot), m = this.n >> 3;
    const wr = new Float32Array(m * 4), wi = new Float32Array(m * 4);
    for (let l = 0; l < 4; l++) {
      let r = criCos4Lane(ang[l]), i = criSin4Lane(ang[l]);
      for (let k = 0; k < m; k++) {
        wr[k * 4 + l] = r; wi[k * 4 + l] = i;
        const nr = F(F(C * r) - F(S * i));
        i = F(F(S * r) + F(C * i)); r = nr;
      }
    }
    return { wr, wi };
  }

  // Transform (inRe, inIm) into (outRe, outIm); dir is the transform sign. Inputs are not modified.
  transform(inRe, inIm, outRe, outIm, dir = -1) {
    const n = this.n, half = n >> 1, d = F(dir);
    let sRe = inRe, sIm = inIm, k = 0;
    const next = () => this.bufs[(k++) & 1];
    for (const { wr, wi, stride } of this.stages) {
      const [dRe, dIm] = next();
      const len = stride * 4;
      for (let j = 0; j < wr.length; j++) {
        const r = wr[j], w = F(wi[j] * d), a0 = 2 * j * len, o0 = j * len;
        for (let e = 0; e < len; e++) {
          const a = a0 + e, b = a + len, o = o0 + e;
          const bre = sRe[b], bim = sIm[b];
          const tre = F(F(r * bre) - F(w * bim)), tim = F(F(w * bre) + F(r * bim));
          const are = sRe[a], aim = sIm[a];
          dRe[o] = F(are + tre); dIm[o] = F(aim + tim);
          dRe[o + half] = F(are - tre); dIm[o + half] = F(aim - tim);
        }
      }
      sRe = dRe; sIm = dIm;
    }
    const [dRe, dIm] = next();
    this._laneStage(sRe, sIm, dRe, dIm, this.lane2, 2, 1, d);
    this._laneStage(dRe, dIm, outRe, outIm, this.lane3, 1, 2, d);
  }

  // Output block i, lane l reads input block 2i + (l >> 1): element (l & 1) * es and its partner + bo.
  _laneStage(sRe, sIm, dRe, dIm, tw, bo, es, d) {
    const half = this.n >> 1, m = this.n >> 3, { wr, wi } = tw;
    for (let i = 0; i < m; i++) {
      for (let l = 0; l < 4; l++) {
        const t = i * 4 + l, a = (2 * i + (l >> 1)) * 4 + (l & 1) * es, b = a + bo;
        const r = wr[t], w = F(d * wi[t]);
        const bre = sRe[b], bim = sIm[b];
        const tre = F(F(r * bre) - F(w * bim)), tim = F(F(w * bre) + F(r * bim));
        const are = sRe[a], aim = sIm[a];
        dRe[t] = F(are + tre); dIm[t] = F(aim + tim);
        dRe[t + half] = F(are - tre); dIm[t + half] = F(aim - tim);
      }
    }
  }
}
