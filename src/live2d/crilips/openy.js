import { F } from "../../engine/core.js";

// The mouth-open stage of CRI Lips (CriLipsCore's `criwareLLipsMouthOpen_ProcessForTypeJapaneseAIUEO`):
// it turns the five Japanese AIUEO blend amounts into the single openY the ADV reads. All float32,
// source order, no fused multiply-add. Behaviour parameters (vowel coefficients, anti-shake length,
// anti-flap weights and thresholds, silence coefficient) come from the data object, which nnnotes
// reads from the user's own APK; nothing here embeds game values.

const fminnm = (a, b) => (a <= b ? a : b);   // the ARM fminnm used against 1.0: min, NaN-quiet

// State: prev (anti-flap filtered openY), ring (anti-shake buffer), openY, silence flag.
export class MouthOpen {
  // params: {coef:[a,i,u,e,o], updateRate, antiShakeLenSec, antiShakeEnable, antiFlapEnable,
  //          wLarge, wSmall, thrUpper, thrLower, silenceCoef}
  constructor(params) {
    this.p = params;
    // Ring length = (uint)(antiShakeLenSec * updateRate) with the product in float32 (native casts a
    // float multiply to uint). The snap reads the ring even when anti-shake processing is off.
    this.ringLen = F(params.antiShakeLenSec * params.updateRate) | 0;
    this.ring = new Float32Array(Math.max(1, this.ringLen));
    this.prev = 0;         // anti-flap state
    this.openY = 0;        // the stored openY
    this.silence = 0;      // silence flag
  }

  clear() { this.ring.fill(0); this.prev = 0; this.openY = 0; this.silence = 0; }

  // vowels: Float32Array/[5] = A,I,U,E,O amounts. Returns openY (also stored on this.openY).
  process(vowels) {
    const p = this.p, coef = p.coef;
    // dominant vowel * coefficient (strictly-greater comparisons, A only if > 0)
    let amt = 0, val = 0;
    if (0 < vowels[0]) { amt = F(vowels[0] * coef[0]); val = vowels[0]; }
    if (val < vowels[1]) { amt = F(vowels[1] * coef[1]); val = vowels[1]; }
    if (val < vowels[2]) { amt = F(vowels[2] * coef[2]); val = vowels[2]; }
    if (val < vowels[3]) { amt = F(vowels[3] * coef[3]); val = vowels[3]; }
    if (val < vowels[4]) { amt = F(vowels[4] * coef[4]); }
    let cur = amt;
    if (cur >= 0) { if (cur > 1) cur = 1; } else cur = 0;                     // clamp [0,1]

    // anti-shake: (max + min) / 2 over the ring after inserting cur at the front
    if (p.antiShakeEnable) {
      cur = fminnm(cur, 1);
      if (cur <= 0) cur = 0;
      const n = this.ringLen, ring = this.ring;
      if (n !== 0) {
        let mn;
        if (n === 1) { ring[0] = cur; mn = fminnm(cur, 1); }
        else {
          for (let i = n - 1; i !== 0; i--) ring[i] = ring[i - 1];      // shift right
          mn = fminnm(cur, 1);
          ring[0] = cur;
          let mx = cur;
          for (let i = 1; i < n; i++) {
            const v = ring[i];
            if (!(v <= mx)) mx = v;                                     // running max
            if (!(mn <= v)) mn = v;                                     // running min
          }
          cur = mx;
        }
        cur = F(F(cur + mn) * F(0.5));
      }
    }

    // anti-flap (asymmetric): blend cur with prev by |cur - prev| against the thresholds
    if (p.antiFlapEnable) {
      const prev = this.prev, w1 = p.wLarge, w2 = p.wSmall;
      const c = fminnm(cur, 1);
      const d = F(c - prev), ad = d < 0 ? F(-d) : d;
      if (ad <= p.thrUpper) {
        if (ad < p.thrLower) cur = F(F(F(c * w2) + F(w1 * prev)) / F(w1 + w2));   // small delta
        else cur = F(F(c + prev) * F(0.5));                                        // mid: midpoint
      } else {
        cur = F(F(F(c * w1) + F(w2 * prev)) / F(w1 + w2));                         // large delta
      }
      this.prev = cur;
    }

    // silence snap: if the previous openY, every ring value, and the anti-flap state all round into
    // the tiny band (|x * silenceCoef| <= 1), clear the ring and the anti-flap state and flag silence.
    // The value stored and returned for this hop is still the filtered one.
    let flag = 0;
    const sc = p.silenceCoef;
    if (-1 <= F(this.openY * sc) && F(this.openY * sc) <= 1) {
      const n = this.ringLen; let allSmall = true;
      for (let i = 0; i < n; i++) { const v = F(this.ring[i] * sc); if (v < -1 || 1 < v) { allSmall = false; break; } }
      if (allSmall && -1 <= F(this.prev * sc) && F(this.prev * sc) <= 1) {
        this.ring.fill(0); this.prev = 0; flag = 1;
      }
    }
    this.silence = flag;
    this.openY = cur;
    return cur;
  }
}

// Default behaviour params from the data object (nnnotes writes them per library version).
// data.constants = {silence_coef, antiflap_defaults:[wLarge,wSmall,thrUpper,thrLower]};
// data.frontend.mouth_open = {vowel_coef:[a,i,u,e,o], anti_shake_sec}; update_rate_hz.
export const mouthOpenParams = (data) => {
  const af = data.constants.antiflap_defaults;
  const fe = data.frontend, mo = fe.mouth_open;
  return {
    coef: mo.vowel_coef.map((c) => F(c)),
    updateRate: fe.update_rate_hz,
    antiShakeLenSec: F(mo.anti_shake_sec),
    antiShakeEnable: true,
    antiFlapEnable: true,
    wLarge: F(af[0]), wSmall: F(af[1]), thrUpper: F(af[2]), thrLower: F(af[3]),
    silenceCoef: F(data.constants.silence_coef),
  };
};
