import { F } from "../../engine/core.js";
import { exp as expd } from "./libm.js";

// The three neural nets of CRI Lips (CriWare's CriLipsCore, `criwareLNn_Predict_*`). Each is a small
// fully-connected / convolutional net over the 24-band mel log-power feature of three consecutive
// 10 ms hops. The game evaluates them in float32 with no fused multiply-add; F (Math.fround) is
// applied at every point the ARM64 code produces a float32, and accumulation is in source order
// (per input i, add x[i] * w[i*OUT + o] to acc[o]). The softmax exponentials use the double libm
// exp() (expd), matching the native `exp` calls.
//
// Weights come only from the data object (nnnotes reads them from the user's own APK at export
// time); nothing here embeds game data. Layouts (input-major dense weight w[in*OUT + out], conv
// weight w[ch*9 + kr*3 + kc]) match criwareLNn_Predict_* exactly.

const relu = (a) => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; };

// dense: out[o] = bias[o] + sum_i in[i] * w[i*OUT + o]  (float32, source order, no FMA)
const dense = (inp, w, bias, IN, OUT, out) => {
  for (let o = 0; o < OUT; o++) out[o] = 0;
  for (let i = 0; i < IN; i++) {
    const x = inp[i], base = i * OUT;
    for (let o = 0; o < OUT; o++) out[o] = F(out[o] + F(x * w[base + o]));
  }
  for (let o = 0; o < OUT; o++) out[o] = F(out[o] + bias[o]);
  return out;
};

// softmax over n with the double exp() and the native denominator floor (DBL_MIN)
const softmax = (a, n, out) => {
  let sum = 0;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { e[i] = expd(a[i]); sum += e[i]; }   // exp in double, sum in double
  if (sum <= 2.2250738585072014e-308) sum = 2.2250738585072014e-308;
  for (let i = 0; i < n; i++) out[i] = F(e[i] / sum);
  return out;
};

// Net1 — criwareLNn_Predict_a1fb4fa55a3a86ed4d5f556ca53475c1 (InternalClassPosteriorProbability).
// input: 72 floats = 3 frames x 24 mel (frame stride 24). Conv 3x3 -> 10 channels over 22 band
// positions -> flatten 220 -> dense 220-128-128-128-24 (ReLU between) -> softmax(24).
export const net1 = (input, W, scratch) => {
  const conv = scratch.conv;                       // Float32Array(220), [ch*22 + t]
  for (let t = 0; t < 22; t++) {
    for (let ch = 0; ch < 10; ch++) {
      let acc = 0;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        acc = F(acc + F(input[r * 24 + (t + c)] * W["net1.conv.w"][ch * 9 + r * 3 + c]));
      conv[ch * 22 + t] = F(acc + W["net1.conv.b"][ch]);
    }
  }
  const h1 = dense(conv, W["net1.d1.w"], W["net1.d1.b"], 220, 128, scratch.h128a); relu(h1);
  const h2 = dense(h1, W["net1.d2.w"], W["net1.d2.b"], 128, 128, scratch.h128b); relu(h2);
  const h3 = dense(h2, W["net1.d3.w"], W["net1.d3.b"], 128, 128, scratch.h128a); relu(h3);
  const h4 = dense(h3, W["net1.d4.w"], W["net1.d4.b"], 128, 24, scratch.h24);
  return softmax(h4, 24, scratch.out24);
};

// Net2 — criwareLNn_Predict_e87dfdf230de6abc3c761ac122d68f2f (RawLipParameter).
// input 72 -> *0.01 -> average the 3 frames per band -> 24 -> dense 24-32-32-32-2 (ReLU) ->
// sigmoid*0.9 + 0.1. Returns 2 raw lip params.
export const net2 = (input, W, scratch) => {
  const x = scratch.n2in;                           // Float32Array(24)
  for (let b = 0; b < 24; b++) {
    let s = 0;
    for (let f = 0; f < 3; f++) s = F(s + F(input[f * 24 + b] * F(0.01)));
    x[b] = F(s / F(3));
  }
  const h1 = dense(x, W["net2.d1.w"], W["net2.d1.b"], 24, 32, scratch.h32a); relu(h1);
  const h2 = dense(h1, W["net2.d2.w"], W["net2.d2.b"], 32, 32, scratch.h32b); relu(h2);
  const h3 = dense(h2, W["net2.d3.w"], W["net2.d3.b"], 32, 32, scratch.h32a); relu(h3);
  const h4 = dense(h3, W["net2.d4.w"], W["net2.d4.b"], 32, 2, scratch.n2out);
  for (let o = 0; o < 2; o++) {
    const y = F(expd(h4[o]));                        // exp(double) -> float32
    let s;
    if (y < F(3.4028235e38) && y > F(1.1754944e-38)) s = F(1 / F(F(1 / y) + 1));
    else s = y < F(3.4028235e38) ? 0 : 1;
    h4[o] = F(F(s * F(0.9)) + F(0.1));
  }
  return h4;
};

// Net3 — criwareLNn_Predict_d724f6b98297c327ba94f2eef735d8f1 (DiscreteTargetPosteriorProbabilityJapanese).
// input 72 -> dense 72-40 + BatchNorm + ReLU -> dense 40-20 + BN + ReLU -> dense 20-5 -> softmax(5).
// Returns the 5 Japanese AIUEO posteriors.
const batchnorm = (a, n, beta, gamma, mean, varr) => {
  for (let i = 0; i < n; i++)
    a[i] = F(beta[i] + F(F(gamma[i] * F(a[i] - mean[i])) / F(Math.fround(Math.sqrt(F(varr[i] + F(0.0001)))))));
};
export const net3 = (input, W, scratch) => {
  const h1 = dense(input, W["net3.d1.w"], W["net3.d1.b"], 72, 40, scratch.h40);
  batchnorm(h1, 40, W["net3.bn1.beta"], W["net3.bn1.gamma"], W["net3.bn1.mean"], W["net3.bn1.var"]); relu(h1);
  const h2 = dense(h1, W["net3.d2.w"], W["net3.d2.b"], 40, 20, scratch.h20);
  batchnorm(h2, 20, W["net3.bn2.beta"], W["net3.bn2.gamma"], W["net3.bn2.mean"], W["net3.bn2.var"]); relu(h2);
  const h3 = dense(h2, W["net3.d3.w"], W["net3.d3.b"], 20, 5, scratch.h5);
  return softmax(h3, 5, scratch.out5);
};

export const makeNetScratch = () => ({
  conv: new Float32Array(220), h128a: new Float32Array(128), h128b: new Float32Array(128),
  h24: new Float32Array(24), out24: new Float32Array(24),
  n2in: new Float32Array(24), h32a: new Float32Array(32), h32b: new Float32Array(32),
  n2out: new Float32Array(2),
  h40: new Float32Array(40), h20: new Float32Array(20), h5: new Float32Array(5), out5: new Float32Array(5),
});
