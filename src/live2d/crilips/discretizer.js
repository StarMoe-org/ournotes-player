import { F } from "../../engine/core.js";

// CRI Lips' discretizer (`criwareLLipsCoreDiscretizer`, Japanese type): turns the five AIUEO
// posteriors of the discrete-target net into blend amounts for the five vowels plus the closed-mouth
// target, smoothing each target over the recent hops and keeping only the strongest vowel and a
// suppressed runner-up. The process type chosen from the internal-class net decides whether the net
// output (type 0), the closed mouth (1, 2, 4) or the wildcard blend (3) is fed in. All float32.

// ring of past values (`criwareLLipsCoreSmoothingBuffer`): rate values per second, maxSec deep
class SmoothingBuffer {
  constructor(rate, maxSec) {
    this.rate = F(rate); this.maxSec = F(maxSec);
    const p = F(this.rate * this.maxSec), n = Math.trunc(p);
    this.len = n + (p !== F(n) ? 1 : 0);
    this.data = new Float32Array(this.len);
    this.pos = 0;
  }
  fill(v) { this.data.fill(v); }
  push(v) { this.data[this.pos] = v; this.pos = (this.pos + 1) % this.len; }
  overwriteLast(v) {
    const i = (this.pos + this.len - 1) % this.len;
    this.data[i] = v; this.pos = (i + 1) % this.len;
  }
  // mean of the newest windowSec * rate values; a fractional oldest value is weighted by its fraction
  smoothed(windowSec) {
    const w = F(1 / this.rate) <= windowSec ? windowSec : F(1 / this.rate);
    const cnt = F(this.rate * w);
    let sum = 0;
    if (cnt > 0) {
      let i = this.pos, rem = cnt, next;
      do {
        i = (this.len - 1 + i) % this.len;
        let v = this.data[i];
        next = F(rem + -1);
        if (rem <= 1) v = F(rem * v);
        sum = F(sum + v);
        rem = next;
      } while (next > 0);
    }
    return F(sum / cnt);
  }
}

export class CriDiscretizer {
  // cfg: {rate (updates per second), maxWindowSec, suppression, smoothingSec, holdSec, releaseSec,
  //       wildcard: Float32Array(6)}
  constructor(cfg) {
    this.n = 6;                                   // A, I, U, E, O, closed
    this.closed = 5;
    this.suppression = F(cfg.suppression);
    this.smoothingSec = F(cfg.smoothingSec);
    this.releaseSec = F(cfg.releaseSec);
    this.holdFrames = Math.trunc(F(F(cfg.rate) * F(cfg.holdSec)));
    this.wildcard = Float32Array.from(cfg.wildcard || new Float32Array(6));
    this.buf = Array.from({ length: 6 }, () => new SmoothingBuffer(cfg.rate, cfg.maxWindowSec));
    this.last = new Float32Array(6);
    this.sm = new Float32Array(6);
    this.clear();
  }

  clear() {
    for (let j = 0; j < this.n; j++) {
      const v = j === this.closed ? 1 : 0;
      this.buf[j].fill(v); this.last[j] = v;
    }
    this.released = 1;
    this.holding = 0;
    this.holdCount = 0;
    this.lastType = 4;
  }

  // posteriors: 5 (or 6) values; type: the discretizer process type. Updates and returns `last`.
  process(post, type) {
    let hold, win, sup = 1;
    if (type === 4) {
      if (this.holdCount < this.holdFrames) {
        hold = 1; this.holding = 1; this.holdCount++;
        win = this.released === 0 ? this.smoothingSec : this.releaseSec;
      } else { hold = 0; this.released = 1; this.holding = 0; win = this.releaseSec; }
    } else {
      this.released = 0; win = this.smoothingSec; this.holding = 0; this.holdCount = 0;
      hold = 0;
      if (type === 0) sup = this.suppression;
      else if (type < 0 || type > 4) return this.last;   // unknown type: no update
    }
    for (let j = 0; j < this.n; j++) {
      let v;
      if (hold) v = this.last[j];
      else if (type === 0) v = j < post.length ? post[j] : 0;
      else if (type === 3) v = this.wildcard[j];
      else v = j === this.closed ? 1 : 0;
      this.buf[j].push(v);
      this.sm[j] = this.buf[j].smoothed(win);
      hold = this.holding;
    }
    // strongest and runner-up among the vowels
    const nv = this.n - 1;
    let top = 0, best = F(-3.4028234663852886e38);
    for (let j = 0; j < nv; j++) if (this.sm[j] > best) { best = this.sm[j]; top = j; }
    let second = 0; best = F(-3.4028234663852886e38);
    for (let j = 0; j < nv; j++) if (j !== top && best < this.sm[j]) { second = j; best = this.sm[j]; }
    for (let j = 0; j < this.n; j++) {
      let v;
      if (j === top || j === nv) v = this.sm[j];
      else if (j === second) v = F(sup * this.sm[second]);
      else { v = 0; this.buf[j].overwriteLast(0); }
      if (this.holding === 0 || this.released !== 0) this.last[j] = v;
    }
    this.lastType = type;
    return this.last;
  }
}
