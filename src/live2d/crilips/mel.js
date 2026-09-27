import { F } from "../../engine/core.js";
import { cosf, logf, expf, log10f } from "./libm.js";
import { criSin } from "./crimath.js";
import { CriFft } from "./fft.js";

// CriWare's mel filter-bank analyzer (`criwareLAfxMelFilterBankAnalyzer`) as CRI Lips configures it:
// a frame of `frameLen` samples centred in an N-point buffer (N = next power of two), a Hamming or
// Blackman-Harris window of length N, CriWare's complex FFT, the power spectrum of bins 0..N/2-1,
// a triangular mel filter bank with a sine-squared band weighting, then optionally log10 and removal
// of the mean over the bands. `power()` gives the log10 variance of the frame (the loudness the
// silence threshold is compared with). Samples are kept in a queue of `frameLen`; `shift()` drops
// one hop. Every step is float32 in the native order; the libm calls are the device's (libm.js).

const FLT_MIN = F(1.1754943508222875e-38);
const PI = F(Math.PI), TWO_PI = F(2 * Math.PI), FOUR_PI = F(4 * Math.PI), SIX_PI = F(6 * Math.PI);
const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

const hammingWindow = (n) => {
  const w = new Float32Array(n), den = F(n - 1);
  for (let i = 0; i < n; i++)
    w[i] = F(F(cosf(F(F(F(i + i) * PI) / den)) * F(-0.46)) + F(0.54));
  return w;
};

// cos of an angle first wrapped into (-pi, pi] by steps of 2 pi (only when above pi)
const wrappedCos = (a) => {
  if (a > PI) {
    do a = F(a + F(-TWO_PI)); while (a > PI);
    while (a <= F(-PI)) a = F(a + TWO_PI);
  }
  return cosf(a);
};
const blackmanHarrisWindow = (n) => {
  const w = new Float32Array(n), fn = F(n);
  for (let i = 0; i < n; i++) {
    const t = F(i / fn);
    const c1 = wrappedCos(F(t * TWO_PI)), c2 = wrappedCos(F(t * FOUR_PI)), c3 = wrappedCos(F(t * SIX_PI));
    w[i] = F(F(F(F(c1 * F(-0.48829)) + F(0.35875)) + F(c2 * F(0.14128))) + F(c3 * F(-0.01168)));
  }
  return w;
};

export class CriMelAnalyzer {
  // cfg: {frameLen, hop, bands, sampleRate, highHz, window: "hamming" | "blackman-harris",
  //       sineWeighting: boolean}
  constructor(cfg) {
    const n = nextPow2(cfg.frameLen);
    this.n = n; this.frameLen = cfg.frameLen; this.hop = cfg.hop; this.bands = cfg.bands;
    this.win = cfg.window === "blackman-harris" ? blackmanHarrisWindow(n) : hammingWindow(n);
    this.fft = new CriFft(n);
    this._buildBands(F(cfg.sampleRate), F(cfg.highHz), !!cfg.sineWeighting);
    this.queue = new Float32Array(cfg.frameLen);   // oldest first
    this.count = 0;                                // samples queued
    this.debt = 0;                                 // hop samples still to drop
    this.frame = new Float32Array(n);
    this.zero = new Float32Array(n);
    this.re = new Float32Array(n); this.im = new Float32Array(n);
    this.pow = new Float32Array(n >> 1);
  }

  // band edges on the bin axis (HTK mel, equal steps up to highHz) and the weights of each band
  _buildBands(sr, high, sine) {
    const n = this.n, nb = this.bands, binw = F(sr / F(n)), halfBins = F(n >> 1);
    const melHigh = F(logf(F(F(high / F(700)) + 1)) * F(1127.0105));
    const den = F(nb + 1), K = F(1127.0105);
    const edge = (i) => F(F(F(expf(F(F(F(F(i) * melHigh) / den) / K)) + -1) * F(700)) / binw);
    this.lo = new Int32Array(nb); this.w = [];
    for (let m = 0; m < nb; m++) {
      const lo = edge(m), c = edge(m + 1);
      let hi = edge(m + 2);
      if (halfBins < hi) hi = halfBins;
      const kLo = Math.floor(lo), count = Math.ceil(hi) - kLo;
      const w = new Float32Array(count);
      const dl = F(c - lo), dh = F(hi - c);
      for (let j = 0; j < count; j++) {
        const k = F(kLo + j);
        let v = 0;
        if (lo >= k) v = 0;
        else if (k < c) v = F(F(k - lo) / dl);
        else if (k <= hi) v = F(1 - F(F(k - c) / dh));
        if (sine) {
          const s = criSin(F(F(F(F(binw * k) * 0.5) / high) * PI));
          const s2 = F(s + s);
          v = F(v * F(s2 * s2));
        }
        w[j] = v;
      }
      this.lo[m] = kLo; this.w.push(w);
    }
  }

  clear() { this.count = 0; this.debt = 0; }
  // fill the free space with zeros (the analyzer starts from a full frame of silence)
  fillZero() { this.queue.fill(0, this.count); this.count = this.frameLen; this.debt = 0; }
  get ready() { return this.count >= this.frameLen; }

  _drop(k) {
    const d = Math.min(k, this.count);
    this.queue.copyWithin(0, d, this.count); this.count -= d;
    return d;
  }
  // queue samples; returns the number accepted minus the hop debt settled (native return value)
  put(pcm) {
    const n = Math.min(pcm.length, this.frameLen - this.count);
    this.queue.set(n === pcm.length ? pcm : pcm.subarray(0, n), this.count); this.count += n;
    const d = this._drop(this.debt); this.debt -= d;
    return n - d;
  }
  shift() { const d = this._drop(this.hop); this.debt += this.hop - d; }

  // mel coefficients of the current frame into out[bands]; meanSub / log10 per the runtime config
  coefficients(out, meanSub, log10) {
    const n = this.n, f = this.frame, off = (n - this.frameLen) >> 1;
    f.set(this.zero); f.set(this.queue.subarray(0, this.frameLen), off);
    const win = this.win, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) f[i] = F(win[i] * f[i]);
    this.fft.transform(f, this.zero, re, im, -1);
    const pw = this.pow;
    for (let k = 0; k < (n >> 1); k++) {
      const p = F(F(re[k] * re[k]) + F(im[k] * im[k]));
      pw[k] = p <= FLT_MIN ? FLT_MIN : p;
    }
    const nb = this.bands;
    for (let m = 0; m < nb; m++) {
      const w = this.w[m], k0 = this.lo[m];
      let acc = 0;
      for (let j = 0; j < w.length; j++) acc = F(acc + F(w[j] * pw[k0 + j]));
      out[m] = acc;
    }
    if (log10) for (let m = 0; m < nb; m++) out[m] = log10f(out[m] <= FLT_MIN ? FLT_MIN : out[m]);
    if (meanSub) {
      let sum = 0;
      for (let m = 0; m < nb; m++) sum = F(sum + out[m]);
      const mean = F(sum / F(nb));
      for (let m = 0; m < nb; m++) out[m] = F(out[m] - mean);
    }
    return out;
  }

  // log10 of the frame variance (about its mean)
  power() {
    const q = this.queue, n = this.frameLen, fn = F(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum = F(sum + q[i]);
    const mean = F(sum / fn);
    let acc = 0;
    for (let i = 0; i < n; i++) { const d = F(q[i] - mean); acc = F(acc + F(d * d)); }
    let v = F(acc / fn);
    if (v <= FLT_MIN) v = FLT_MIN;
    return log10f(v);
  }
}
