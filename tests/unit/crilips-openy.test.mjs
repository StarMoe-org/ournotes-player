// CRI Lips openY stage over SYNTHETIC parameters and inputs only: dominant vowel * coefficient,
// clamp, anti-shake (max/min midpoint over the ring), asymmetric anti-flap, and the silence snap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MouthOpen } from "../../src/live2d/crilips/openy.js";

const F = Math.fround;
const params = (over = {}) => ({
  coef: [1, 1, 1, 1, 1], updateRate: 100, antiShakeLenSec: F(0.03),
  antiShakeEnable: true, antiFlapEnable: true,
  wLarge: F(0.6), wSmall: F(0.4), thrUpper: F(0.2), thrLower: F(0.2),
  silenceCoef: F(10000), ...over,
});

test("silence stays closed (openY 0, silence flagged)", () => {
  const m = new MouthOpen(params());
  let y = 0;
  for (let i = 0; i < 5; i++) y = m.process(new Float32Array([0, 0, 0, 0, 0]));
  assert.equal(y, 0);
  assert.equal(m.silence, 1);
});

test("silence snap clears the ring and anti-flap state but returns the filtered value", () => {
  // 'a' = 5e-5: anti-shake gives (5e-5 + 0) / 2, anti-flap (small delta) gives 0.4 of that. Every
  // state value times 10000 lies in [-1, 1], so the snap fires; the hop's own value is kept.
  const m = new MouthOpen(params());
  const y = m.process(new Float32Array([F(5e-5), 0, 0, 0, 0]));
  const want = F(F(F(F(F(5e-5) + 0) * F(0.5)) * F(0.4)) / F(F(0.6) + F(0.4)));
  assert.equal(y, want);
  assert.ok(y > 0);
  assert.equal(m.silence, 1);
  assert.equal(m.prev, 0);
  assert.deepEqual([...m.ring], [0, 0, 0]);
});

test("dominant vowel drives openY through the smoothers", () => {
  const m = new MouthOpen(params());
  let y = 0;
  for (let i = 0; i < 10; i++) y = m.process(new Float32Array([0.8, 0.1, 0, 0, 0]));  // 'a' dominant
  assert.ok(y > 0.3 && y <= 1, `openY ${y}`);
});

test("ring length truncates the float32 product (uint)(antiShakeLenSec * updateRate) = 3", () => {
  // The float32 product 0.03f * 100f rounds to exactly 3.0f, so the truncation gives 3. The same
  // product in double (2.99999993...) would truncate to 2; the stage must multiply in float32.
  const m = new MouthOpen(params());
  assert.equal(F(F(0.03) * F(100)), 3);
  assert.equal(Math.trunc(F(0.03) * 100), 2);
  assert.equal(m.ringLen, 3);
});

test("coefficient scales the dominant vowel (through the anti-flap blend)", () => {
  // anti-shake off, anti-flap on: frame 1 prev=0, cur=1.0*0.5=0.5, |d|>thrUpper -> 0.5*0.6/(0.6+0.4)=0.3
  const m = new MouthOpen(params({ coef: [0.5, 1, 1, 1, 1], antiShakeEnable: false }));
  const y = m.process(new Float32Array([1, 0, 0, 0, 0]));
  assert.ok(Math.abs(y - F(0.3)) < 1e-6, `openY ${y}`);
});

test("openY clamps the dominant vowel to [0,1] before smoothing", () => {
  // coef 2 -> cur clamped to 1; anti-flap frame 1 -> 1*0.6/(1.0) = 0.6
  const m = new MouthOpen(params({ coef: [2, 1, 1, 1, 1], antiShakeEnable: false }));
  const y = m.process(new Float32Array([1, 0, 0, 0, 0]));
  assert.ok(Math.abs(y - F(0.6)) < 1e-6, `openY ${y}`);
});

test("anti-flap large-delta blend uses w1/w2 over (w1+w2)", () => {
  // no anti-shake; first frame prev=0, cur=1 -> |d|=1 > thrUpper -> (1*0.6 + 0*0.4)/(1.0) = 0.6
  const m = new MouthOpen(params({ antiShakeEnable: false }));
  const y = m.process(new Float32Array([1, 0, 0, 0, 0]));
  assert.ok(Math.abs(y - F(0.6)) < 1e-6, `openY ${y}`);
});

test("outputs are float32", () => {
  const m = new MouthOpen(params());
  const y = m.process(new Float32Array([0.5, 0.2, 0.1, 0, 0]));
  assert.equal(y, F(y));
});

test("determinism: same inputs give the same openY series", () => {
  const seq = [[0.2, 0, 0, 0, 0], [0.6, 0.1, 0, 0, 0], [0.9, 0, 0, 0, 0], [0.1, 0, 0, 0, 0]];
  const run = () => { const m = new MouthOpen(params()); return seq.map((v) => m.process(Float32Array.from(v))); };
  assert.deepEqual(run(), run());
});
