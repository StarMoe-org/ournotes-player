import { F } from "../../engine/core.js";
import { CriMelAnalyzer } from "./mel.js";
import { net1, net3, makeNetScratch } from "./nets.js";
import { CriDiscretizer } from "./discretizer.js";

// CRI Lips' analysis core (`criwareLLipsCore`) for the openY path, one 10 ms hop of 16 kHz samples
// per `process` call:
//   - general analyzer (Hamming): mel coefficients with the internal-class runtime config (mean
//     removal, log10) into a 3-hop feature ring, and the frame loudness in dB (10 * log10 variance);
//   - loud enough (>= threshold): the internal-class net and its argmax class, else the silence class;
//     the class maps to a motion class kept over the last hops; a principal motion class of 1 starts
//     the labial hold (the closed-mouth process type while it lasts);
//   - vowel analyzer (Blackman-Harris): mel coefficients with the discrete-target config into its own
//     ring -> the discrete-target net -> the discretizer with the process type of the class.
// The feature rings start with two frames computed from silence, as the native clear does. The raw
// lip-parameter net and its motion smoother only feed the lip width/height, which the story does not
// read, so they are not evaluated here.

const NEG_FLT_MAX = F(-3.4028234663852886e38);

// fixed-length ring of motion classes (`criwareLLipsCoreMotionClassBuffer`, priority mode)
class MotionClassBuffer {
  constructor(len) { this.buf = new Int32Array(len); this.clear(); }
  clear() { this.buf.fill(4); this.pos = 0; }
  push(c) { this.buf[this.pos] = c; this.pos = (this.pos + 1) % this.buf.length; }
  // any class 1 wins, then any class 2, else the most frequent (lowest class on ties)
  principal() {
    const cnt = [0, 0, 0, 0, 0];
    for (const c of this.buf) cnt[c]++;
    if (cnt[1]) return 1;
    if (cnt[2]) return 2;
    let best = 0, cls = 5;
    for (let k = 0; k < 5; k++) if (cnt[k] > best) { best = cnt[k]; cls = k; }
    return cls;
  }
}

export class CriLipsCore {
  // data: CriLipsData; the front-end parameters come from data.frontend, the tables from
  // data.constants.
  constructor(data) {
    const fe = data.frontend, rate = fe.resample_hz;
    this.data = data;
    const msToSamples = (ms) => Math.trunc(F(F(F(rate) * F(ms)) / 1000));
    this.hop = msToSamples(fe.hop_ms);
    const frameLen = msToSamples(fe.frame_ms);
    const common = { frameLen, hop: this.hop, bands: fe.mel_bands, sampleRate: rate,
                     highHz: fe.mel_high_hz, sineWeighting: true };
    this.gen = new CriMelAnalyzer({ ...common, window: fe.window_internal_class });
    this.vow = new CriMelAnalyzer({ ...common, window: fe.window_vowel });
    this.nb = fe.mel_bands;
    this.threshold = F(fe.silence_threshold_db);
    this.motionTable = data.constants.motion_class_table;
    this.typeTable = data.constants.discretizer_type_table;
    this.labialHold = Math.trunc(F(F(F(fe.labial_hold_sec) * 1000) / F(fe.hop_ms)));
    const d = fe.discretizer;
    this.disc = new CriDiscretizer({ rate: F(1000 / F(fe.hop_ms)), maxWindowSec: d.max_window_sec,
      suppression: d.suppression, smoothingSec: d.smoothing_sec, holdSec: d.hold_sec,
      releaseSec: d.release_sec, wildcard: d.wildcard });
    this.mcb = new MotionClassBuffer(fe.motion_class_buffer);
    this.scratch = makeNetScratch();
    this.ringG = new Float32Array(3 * this.nb);   // oldest frame first
    this.ringV = new Float32Array(3 * this.nb);
    this.coef = new Float32Array(this.nb);
    this.post = new Float32Array(6);
    this.clear();
  }

  clear() {
    this.lastDb = NEG_FLT_MAX;
    this.lastClass = 24;
    this.hold = 0; this.holdCount = 0;
    const nb = this.nb;
    this.gen.clear(); this.gen.fillZero();
    this.gen.coefficients(this.coef, true, true);
    this.ringG.set(this.coef, nb); this.ringG.set(this.coef, 2 * nb);
    this.gen.shift();
    this.vow.clear(); this.vow.fillZero();
    this.mcb.clear();
    this.vow.coefficients(this.coef, true, true);
    this.ringV.set(this.coef, nb); this.ringV.set(this.coef, 2 * nb);
    this.disc.clear();
    this.vow.shift();
    this.blend = this.disc.last;
  }

  _slide(ring, coef) { ring.copyWithin(0, this.nb); ring.set(coef, 2 * this.nb); }

  // one hop of 16 kHz samples (length hop); updates `blend` (6 discretizer blend amounts)
  process(pcm) {
    if (this.gen.put(pcm) !== this.hop || !this.gen.ready) return false;
    this._slide(this.ringG, this.gen.coefficients(this.coef, true, true));
    const db = F(this.gen.power() * 10);
    this.lastDb = db;
    if (this.hold === 1) {
      if (this.labialHold <= this.holdCount || db < this.threshold) { this.hold = 0; this.holdCount = 0; }
      else this.holdCount++;
    }
    let cls = 24;
    if (this.threshold <= db) {
      const p = net1(this.ringG, this.data.W, this.scratch);
      for (let k = 0; k < 24; k++) if (!Number.isFinite(p[k])) return false;
      let best = p[0]; cls = 0;                   // 25 slots, the last one 0; first maximum wins
      for (let k = 1; k < 25; k++) { const v = k < 24 ? p[k] : 0; if (v > best) { best = v; cls = k; } }
    }
    this.lastClass = cls;
    this.mcb.push(cls < 24 ? this.motionTable[cls] : 4);
    if (this.mcb.principal() === 1 && this.holdCount === 0) this.hold = 1;
    this.gen.shift();
    if (this.vow.put(pcm) !== this.hop || !this.vow.ready) return false;
    this._slide(this.ringV, this.vow.coefficients(this.coef, true, true));
    let type = cls < 25 ? this.typeTable[cls] : 3;
    if (this.hold) type = 2;
    const p5 = net3(this.ringV, this.data.W, this.scratch);
    this.post.set(p5); this.post[5] = 0;
    this.blend = this.disc.process(this.post, type);
    this.vow.shift();
    return true;
  }
}
