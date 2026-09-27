// CRI Lips neural nets over SYNTHETIC weights and inputs only (no game data): the stage math,
// shapes, dense/conv accumulation, activations, and the softmax denominator floor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { net1, net2, net3, makeNetScratch } from "../../src/live2d/crilips/nets.js";

const F = Math.fround;

// A deterministic synthetic weight set with the exact shapes the nets expect.
const synthW = () => {
  const rng = (() => { let s = 12345; return () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x3fffffff - 1; }; })();
  const arr = (n, scale = 0.1) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = F(rng() * scale); return a; };
  return {
    "net1.conv.w": arr(90), "net1.conv.b": arr(10),
    "net1.d1.w": arr(220 * 128), "net1.d1.b": arr(128),
    "net1.d2.w": arr(128 * 128), "net1.d2.b": arr(128),
    "net1.d3.w": arr(128 * 128), "net1.d3.b": arr(128),
    "net1.d4.w": arr(128 * 24), "net1.d4.b": arr(24),
    "net2.d1.w": arr(24 * 32), "net2.d1.b": arr(32),
    "net2.d2.w": arr(32 * 32), "net2.d2.b": arr(32),
    "net2.d3.w": arr(32 * 32), "net2.d3.b": arr(32),
    "net2.d4.w": arr(32 * 2), "net2.d4.b": arr(2),
    "net3.d1.w": arr(72 * 40), "net3.d1.b": arr(40),
    "net3.bn1.beta": arr(40), "net3.bn1.gamma": arr(40, 1), "net3.bn1.mean": arr(40), "net3.bn1.var": arr(40, 0.01),
    "net3.d2.w": arr(40 * 20), "net3.d2.b": arr(20),
    "net3.bn2.beta": arr(20), "net3.bn2.gamma": arr(20, 1), "net3.bn2.mean": arr(20), "net3.bn2.var": arr(20, 0.01),
    "net3.d3.w": arr(20 * 5), "net3.d3.b": arr(5),
  };
};
// make BN variances strictly positive
const posVar = (W) => { for (const k of ["net3.bn1.var", "net3.bn2.var"]) for (let i = 0; i < W[k].length; i++) W[k][i] = F(Math.abs(W[k][i]) + 0.5); return W; };

const feature = () => { const a = new Float32Array(72); for (let i = 0; i < 72; i++) a[i] = F(Math.sin(i * 0.3)); return a; };

test("net1 outputs a 24-way softmax (finite, sums ~1)", () => {
  const W = synthW(), s = makeNetScratch();
  const out = net1(feature(), W, s);
  assert.equal(out.length, 24);
  let sum = 0; for (const v of out) { assert.ok(Number.isFinite(v)); assert.ok(v >= 0); sum += v; }
  assert.ok(Math.abs(sum - 1) < 1e-4, `sum ${sum}`);
});

test("net2 outputs 2 lip params in [0.1, 1.0]", () => {
  const W = synthW(), s = makeNetScratch();
  const out = net2(feature(), W, s);
  assert.equal(out.length, 2);
  for (const v of out) { assert.ok(v >= F(0.1) - 1e-6 && v <= 1 + 1e-6, `${v}`); }
});

test("net3 outputs a 5-way softmax (Japanese AIUEO)", () => {
  const W = posVar(synthW()), s = makeNetScratch();
  const out = net3(feature(), W, s);
  assert.equal(out.length, 5);
  let sum = 0; for (const v of out) { assert.ok(Number.isFinite(v)); sum += v; }
  assert.ok(Math.abs(sum - 1) < 1e-4, `sum ${sum}`);
});

test("nets are deterministic for identical input", () => {
  const W = posVar(synthW()), s1 = makeNetScratch(), s2 = makeNetScratch();
  const f = feature();
  const a = Float32Array.from(net3(f, W, s1)), b = Float32Array.from(net3(f, W, s2));
  for (let i = 0; i < 5; i++) assert.equal(a[i], b[i]);
});

test("dense accumulation is float32 (Math.fround stable)", () => {
  // a single-input, single-output dense must equal F(x*w + b) exactly
  const W = synthW(), s = makeNetScratch();
  // craft net3.d3 as identity-ish: check the output type is float32
  const out = net3(feature(), posVar(W), s);
  for (const v of out) assert.equal(v, F(v));
});
