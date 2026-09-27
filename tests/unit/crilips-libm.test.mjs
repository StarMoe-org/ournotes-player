// CRI Lips libm port over synthetic inputs (no game data): the exact fused multiply-add emulation,
// the double exp used by the softmaxes and the float routines the front-end uses. Bit-for-bit parity
// with the device libm over the full float range is checked separately against the native reference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fma, exp, expf, logf, log10f, cosf, sincosf, sqrtf } from "../../src/live2d/crilips/libm.js";

const F = Math.fround;

test("fma rounds a*b+c once", () => {
  // (1 + 2^-30)^2 - 1 = 2^-29 + 2^-60: a separate product would drop the 2^-60 term
  const a = 1 + 2 ** -30;
  assert.equal(fma(a, a, -1), 2 ** -29 + 2 ** -60);
  assert.notEqual(a * a - 1, 2 ** -29 + 2 ** -60);
  assert.equal(fma(0.1, 0.2, 0.3), 0.32);
  assert.equal(fma(2, 3, 4), 10);
  assert.ok(Object.is(fma(-0, 1, -0), -0));
  assert.equal(fma(Infinity, 1, 1), Infinity);
  assert.ok(Number.isNaN(fma(Infinity, 0, 1)));
});

test("fma is exact at extreme magnitudes (integer fallback)", () => {
  assert.equal(fma(2 ** 1000, 2 ** -1000, 1), 2);
  assert.equal(fma(2 ** -1000, 2 ** -60, 0), 2 ** -1060);
  assert.equal(fma(2 ** 1023, 2, -(2 ** 1023)), 2 ** 1023);
});

test("exp: exact points and the special ranges", () => {
  assert.equal(exp(0), 1);
  assert.equal(exp(-Infinity), 0);
  assert.equal(exp(Infinity), Infinity);
  assert.ok(Number.isNaN(exp(NaN)));
  assert.equal(exp(1e-300), 1);
  assert.equal(exp(-1100), 0);
  assert.equal(exp(1100), Infinity);
  assert.ok(exp(709) > 8e307 && exp(709) < Infinity);
  assert.ok(exp(-745) > 0);
});

test("exp stays within an ulp of an independent double exp", () => {
  for (let i = -300; i <= 300; i++) {
    const x = i * 0.37;
    const rel = Math.abs(exp(x) - Math.exp(x)) / Math.exp(x);
    assert.ok(rel < 3e-16, `exp(${x}) rel ${rel}`);
  }
});

test("float routines return float32 and exact values where defined", () => {
  for (const f of [expf, logf, log10f, cosf]) {
    const y = f(0.75);
    assert.equal(y, F(y));
  }
  assert.equal(expf(0), 1);
  assert.equal(logf(1), 0);
  assert.equal(log10f(1), 0);
  assert.equal(log10f(1000), 3);
  assert.equal(log10f(0.001), -3);
  assert.equal(log10f(0), -Infinity);
  assert.ok(Number.isNaN(log10f(-1)));
  assert.equal(cosf(0), 1);
  assert.deepEqual(sincosf(0), [0, 1]);
  assert.equal(sqrtf(4), 2);
  assert.equal(sqrtf(2), F(Math.SQRT2));
});

test("float routines agree with the correctly rounded value on a coarse grid", () => {
  // Independent reference: the double Math.* result rounded to float32; the ported routines are
  // within an ulp of it (the device libm is not correctly rounded everywhere, so this is a bound).
  const ulp = (y) => { const a = Math.abs(F(y)); return a === 0 ? 1.4e-45 : F(a * (1 + 2 ** -23)) - a; };
  for (let i = 1; i < 400; i++) {
    const x = F(i * 0.0791);
    assert.ok(Math.abs(logf(x) - Math.log(x)) <= ulp(Math.log(x)), `logf(${x})`);
    assert.ok(Math.abs(log10f(x) - Math.log10(x)) <= ulp(Math.log10(x)), `log10f(${x})`);
    assert.ok(Math.abs(cosf(x) - Math.cos(x)) <= ulp(Math.cos(x)) + 1e-9, `cosf(${x})`);
    const [s, c] = sincosf(x);
    assert.ok(Math.abs(s - Math.sin(x)) <= ulp(Math.sin(x)) + 1e-9, `sinf(${x})`);
    assert.equal(c, cosf(x));
    if (x < 80) assert.ok(Math.abs(expf(x) - Math.exp(x)) <= ulp(Math.exp(x)), `expf(${x})`);
  }
  // large-argument reduction path
  assert.ok(Math.abs(cosf(F(1e30)) - Math.cos(F(1e30))) < 1e-6);
  assert.ok(Math.abs(cosf(F(12345.678)) - Math.cos(F(12345.678))) < 1e-6);
});
