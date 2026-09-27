import { F } from "../../engine/core.js";

// CriWare's DSP resampler (`criwareLDspResampler`), mono path, as the Atom analyzer uses it from the
// voice rate to the 16 kHz work rate. The read position is fixed point with 12 fractional bits, the
// step is (in << 12) / out, and each output is the linear interpolation of the two neighbouring input
// samples; eight input samples of history carry across calls. Outputs are produced while the position
// stays inside the input given, so the caller must feed the same block lengths as the native analyzer
// (`needNumSamples`). All float32 in the native order.

const K = F(1 / 4096);

export class CriResampler {
  constructor(inRate, outRate) {
    this.hist = new Float32Array(9);              // 8 samples of history + the current first sample
    this.pos = 0;
    this.setRate(inRate, outRate);
  }

  setRate(inRate, outRate) {
    const i = Math.max(1, inRate | 0), o = Math.max(1, outRate | 0);
    const lim = Math.min(i, o * 8);
    let step = Math.floor((lim * 4096) / o);
    if (step < 2) step = 1;
    this.step = step;
    if (step > 0xfff) {
      this.minOut = 0;
      if (step === 0x1000) { this.pos = 0; this.hist.fill(0); }
    } else this.minOut = Math.floor(0x1000 / step);
  }

  get enabled() { return this.step !== 0x1000; }

  // input samples needed to produce nOut outputs from the current position
  needNumSamples(nOut) {
    return this.step === 0x1000 ? nOut : (this.pos + this.step * nOut + 0x8000) >> 12;
  }

  reset() { this.pos = 0; this.hist.fill(0); }

  // Resample nIn samples of x into out[off..off+cap); returns the number of outputs produced.
  process(x, nIn, out, off, cap) {
    const step = this.step;
    let pos = this.pos;
    const avail = Math.trunc((nIn * 4096 - pos) / step) - this.minOut;
    const n = Math.min(cap, avail);
    if (n < 1) return 0;
    const h = this.hist;
    h[8] = x[0];
    let j = 0;
    for (; j < n && pos < 0; j++, pos += step) {                  // inside the history
      const p = pos + 0x8000, idx = p >> 12, a = h[idx];
      out[off + j] = F(a + F(F(F(h[idx + 1] - a) * F(p & 0xfff)) * K));
    }
    const main = ((n - j) & ~3) + j;
    for (; j < main; j++, pos += step) {                           // four per native step
      const idx = pos >>> 12, a = x[idx];
      out[off + j] = F(a + F(F(F(pos & 0xfff) * K) * F(x[idx + 1] - a)));
    }
    for (; j < n; j++, pos += step) {
      const idx = pos >>> 12, a = x[idx];
      out[off + j] = F(a + F(F(F(x[idx + 1] - a) * F(pos & 0xfff)) * K));
    }
    // history: the last 8 input samples
    if (nIn >= 8) h.set(x.subarray(nIn - 8, nIn), 0);
    else { h.copyWithin(0, nIn, 8); for (let k = 8 - nIn; k < 8; k++) h[k] = x[k - 8 + nIn]; }
    this.pos = pos - nIn * 4096;
    return n;
  }
}
