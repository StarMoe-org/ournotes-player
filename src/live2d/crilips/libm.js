// Float math routines reproducing Android bionic's aarch64 libm bit for bit.
//
// CRI Lips evaluates its analysis in float32 and calls the platform libm: the double exp() in the net
// softmaxes and sigmoid, log10f() in the mel log power, and cosf()/sincosf()/logf()/expf() while it
// builds its windows, filter and mel bands. The JS engine's Math.* functions round differently from
// bionic, so the player carries the same algorithms: bionic's aarch64 exp/expf/logf/cosf/sincosf are
// ARM optimized-routines, and its log10f is FreeBSD msun.
//
// optimized-routines (https://github.com/ARM-software/optimized-routines): the algorithms of exp,
// expf, logf, cosf and sincosf and their data tables (exp_data.c, exp2f_data.c, logf_data.c,
// sincosf_data.c) are ported from it.
//   Copyright (c) 2017-2019, Arm Limited.
//   SPDX-License-Identifier: MIT OR Apache-2.0 WITH LLVM-exception
// FreeBSD msun (e_log10f.c, k_logf.h): log10f.
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunPro, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
//   distribute this software is freely granted, provided that this notice is preserved.
// Keep these notices. Only math library code is ported here.
//
// The Android build compiles optimized-routines with -ffp-contract=fast, so the compiler fuses many
// a*b+c into one fused multiply-add (single rounding). JS has no fma, so `fma` below is an exact
// emulation (error-free transforms plus round-to-odd, Boldo and Melquiond 2008, with an exact BigInt
// fallback outside its range), and each routine fuses exactly the operations the device build fuses.
// The FreeBSD log10f is built without fusion and runs in float32 (Math.fround after every step).

const F = Math.fround;

const f64 = new Float64Array(1), w64 = new Uint32Array(f64.buffer);   // w64[0] low word, w64[1] high
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), i32 = new Int32Array(f32.buffer);
const hd = (h) => { w64[1] = parseInt(h.slice(0, 8), 16); w64[0] = parseInt(h.slice(8), 16); return f64[0]; };
const hf = (h) => { u32[0] = parseInt(h, 16); return f32[0]; };
const words = (s) => s.trim().split(/\s+/);

// --- exact fused multiply-add -------------------------------------------------------------------
const SPLIT = 134217729;                 // 2^27 + 1 (Veltkamp)
const P2_996 = 2 ** 996, P2_M900 = 2 ** -900;

// round-to-odd of a + b (a, b finite): the RN sum, moved one ulp toward the exact sum when it is
// inexact and its last significand bit is even.
const addRoundOdd = (a, b) => {
  const s = a + b;
  const bv = s - a, av = s - bv;
  const e = (a - av) + (b - bv);
  if (e === 0) return s;
  f64[0] = s;
  if (w64[0] & 1) return s;
  if ((e > 0) === (s > 0)) { if (w64[0] === 0xffffffff) { w64[0] = 0; w64[1]++; } else w64[0]++; }
  else { if (w64[0] === 0) { w64[0] = 0xffffffff; w64[1]--; } else w64[0]--; }
  return f64[0];
};

// exact decomposition of a finite double: [sign, BigInt significand, exponent] with x = s * m * 2^e
const decomp = (x) => {
  f64[0] = x;
  const hi = w64[1], lo = w64[0], ex = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (ex) m |= 1n << 52n;
  return [hi >>> 31 ? -1n : 1n, m, ex ? ex - 1075 : -1074];
};
const bitLength = (m) => m.toString(2).length;

// correctly rounded a*b + c by exact integer arithmetic (slow; only for extreme magnitudes)
const fmaExact = (a, b, c) => {
  const [sa, ma, ea] = decomp(a), [sb, mb, eb] = decomp(b), [sc, mc, ec] = decomp(c);
  const mp = sa * sb * ma * mb, ep = ea + eb;
  const E = Math.min(ep, ec);
  let M = (mp << BigInt(ep - E)) + ((sc * mc) << BigInt(ec - E));
  if (M === 0n) return a * b + c;        // exact zero: a*b == -c is exact, IEEE zero sign
  const neg = M < 0n; if (neg) M = -M;
  let e = E, shift = bitLength(M) - 53;
  if (e + shift < -1074) shift = -1074 - e;
  if (shift > 0) {
    const sh = BigInt(shift), rem = M & ((1n << sh) - 1n), half = 1n << (sh - 1n);
    M >>= sh;
    if (rem > half || (rem === half && (M & 1n))) M += 1n;
    e += shift;
  } else if (shift < 0) { M <<= BigInt(-shift); e += shift; }
  let r = Number(M);
  if (e > 960) { r *= 2 ** 960; e -= 960; }
  r *= 2 ** e;
  return neg ? -r : r;
};

// fma(a, b, c) = RN(a*b + c) with a single rounding, as the AArch64 FMADD instruction.
export const fma = (a, b, c) => {
  const p = a * b;
  if (!(Math.abs(p) >= P2_M900 && Math.abs(p) < P2_996 && Math.abs(c) < P2_996
        && Math.abs(a) < P2_996 && Math.abs(b) < P2_996)) {
    if (p !== p || c !== c || Math.abs(a) === Infinity || Math.abs(b) === Infinity || Math.abs(c) === Infinity)
      return p + c;
    if (a === 0 || b === 0) return p + c;
    return fmaExact(a, b, c);
  }
  // p + pe = a*b exactly (Shewchuk Two_Product with a Veltkamp split)
  let t = SPLIT * a; const ah = t - (t - a), al = a - ah;
  t = SPLIT * b; const bh = t - (t - b), bl = b - bh;
  const pe = (al * bl) - (((p - ah * bh) - al * bh) - ah * bl);
  // th + tl = c + p exactly (Knuth TwoSum)
  const th = c + p, bv = th - c, av = th - bv;
  const tl = (c - av) + (p - bv);
  return th + addRoundOdd(tl, pe);
};

// round half away from zero (AArch64 FRINTA / FCVTAS) for |z| < 2^52
const roundAway = (z) => { const t = Math.trunc(z); return Math.abs(z - t) >= 0.5 ? t + Math.sign(z) : t; };

// --- tables (optimized-routines data, as bit patterns) ------------------------------------------
// exp_data.c: __exp_data.tab (N = 128), {tail, sbits} pairs as 64-bit words
const EXP_TAB_HEX = `
  0000000000000000 3ff0000000000000 3c9b3b4f1a88bf6e 3feff63da9fb3335
  bc7160139cd8dc5d 3fefec9a3e778061 bc905e7a108766d1 3fefe315e86e7f85
  3c8cd2523567f613 3fefd9b0d3158574 bc8bce8023f98efa 3fefd06b29ddf6de
  3c60f74e61e6c861 3fefc74518759bc8 3c90a3e45b33d399 3fefbe3ecac6f383
  3c979aa65d837b6d 3fefb5586cf9890f 3c8eb51a92fdeffc 3fefac922b7247f7
  3c3ebe3d702f9cd1 3fefa3ec32d3d1a2 bc6a033489906e0b 3fef9b66affed31b
  bc9556522a2fbd0e 3fef9301d0125b51 bc5080ef8c4eea55 3fef8abdc06c31cc
  bc91c923b9d5f416 3fef829aaea92de0 3c80d3e3e95c55af 3fef7a98c8a58e51
  bc801b15eaa59348 3fef72b83c7d517b bc8f1ff055de323d 3fef6af9388c8dea
  3c8b898c3f1353bf 3fef635beb6fcb75 bc96d99c7611eb26 3fef5be084045cd4
  3c9aecf73e3a2f60 3fef54873168b9aa bc8fe782cb86389d 3fef4d5022fcd91d
  3c8a6f4144a6c38d 3fef463b88628cd6 3c807a05b0e4047d 3fef3f49917ddc96
  3c968efde3a8a894 3fef387a6e756238 3c875e18f274487d 3fef31ce4fb2a63f
  3c80472b981fe7f2 3fef2b4565e27cdd bc96b87b3f71085e 3fef24dfe1f56381
  3c82f7e16d09ab31 3fef1e9df51fdee1 bc3d219b1a6fbffa 3fef187fd0dad990
  3c8b3782720c0ab4 3fef1285a6e4030b 3c6e149289cecb8f 3fef0cafa93e2f56
  3c834d754db0abb6 3fef06fe0a31b715 3c864201e2ac744c 3fef0170fc4cd831
  3c8fdd395dd3f84a 3feefc08b26416ff bc86a3803b8e5b04 3feef6c55f929ff1
  bc924aedcc4b5068 3feef1a7373aa9cb bc9907f81b512d8e 3feeecae6d05d866
  bc71d1e83e9436d2 3feee7db34e59ff7 bc991919b3ce1b15 3feee32dc313a8e5
  3c859f48a72a4c6d 3feedea64c123422 bc9312607a28698a 3feeda4504ac801c
  bc58a78f4817895b 3feed60a21f72e2a bc7c2c9b67499a1b 3feed1f5d950a897
  3c4363ed60c2ac11 3feece086061892d 3c9666093b0664ef 3feeca41ed1d0057
  3c6ecce1daa10379 3feec6a2b5c13cd0 3c93ff8e3f0f1230 3feec32af0d7d3de
  3c7690cebb7aafb0 3feebfdad5362a27 3c931dbdeb54e077 3feebcb299fddd0d
  bc8f94340071a38e 3feeb9b2769d2ca7 bc87deccdc93a349 3feeb6daa2cf6642
  bc78dec6bd0f385f 3feeb42b569d4f82 bc861246ec7b5cf6 3feeb1a4ca5d920f
  3c93350518fdd78e 3feeaf4736b527da 3c7b98b72f8a9b05 3feead12d497c7fd
  3c9063e1e21c5409 3feeab07dd485429 3c34c7855019c6ea 3feea9268a5946b7
  3c9432e62b64c035 3feea76f15ad2148 bc8ce44a6199769f 3feea5e1b976dc09
  bc8c33c53bef4da8 3feea47eb03a5585 bc845378892be9ae 3feea34634ccc320
  bc93cedd78565858 3feea23882552225 3c5710aa807e1964 3feea155d44ca973
  bc93b3efbf5e2228 3feea09e667f3bcd bc6a12ad8734b982 3feea012750bdabf
  bc6367efb86da9ee 3fee9fb23c651a2f bc80dc3d54e08851 3fee9f7df9519484
  bc781f647e5a3ecf 3fee9f75e8ec5f74 bc86ee4ac08b7db0 3fee9f9a48a58174
  bc8619321e55e68a 3fee9feb564267c9 3c909ccb5e09d4d3 3feea0694fde5d3f
  bc7b32dcb94da51d 3feea11473eb0187 3c94ecfd5467c06b 3feea1ed0130c132
  3c65ebe1abd66c55 3feea2f336cf4e62 bc88a1c52fb3cf42 3feea427543e1a12
  bc9369b6f13b3734 3feea589994cce13 bc805e843a19ff1e 3feea71a4623c7ad
  bc94d450d872576e 3feea8d99b4492ed 3c90ad675b0e8a00 3feeaac7d98a6699
  3c8db72fc1f0eab4 3feeace5422aa0db bc65b6609cc5e7ff 3feeaf3216b5448c
  3c7bf68359f35f44 3feeb1ae99157736 bc93091fa71e3d83 3feeb45b0b91ffc6
  bc5da9b88b6c1e29 3feeb737b0cdc5e5 bc6c23f97c90b959 3feeba44cbc8520f
  bc92434322f4f9aa 3feebd829fde4e50 bc85ca6cd7668e4b 3feec0f170ca07ba
  3c71affc2b91ce27 3feec49182a3f090 3c6dd235e10a73bb 3feec86319e32323
  bc87c50422622263 3feecc667b5de565 3c8b1c86e3e231d5 3feed09bec4a2d33
  bc91bbd1d3bcbb15 3feed503b23e255d 3c90cc319cee31d2 3feed99e1330b358
  3c8469846e735ab3 3feede6b5579fdbf bc82dfcd978e9db4 3feee36bbfd3f37a
  3c8c1a7792cb3387 3feee89f995ad3ad bc907b8f4ad1d9fa 3feeee07298db666
  bc55c3d956dcaeba 3feef3a2b84f15fb bc90a40e3da6f640 3feef9728de5593a
  bc68d6f438ad9334 3feeff76f2fb5e47 bc91eee26b588a35 3fef05b030a1064a
  3c74ffd70a5fddcd 3fef0c1e904bc1d2 bc91bdfbfa9298ac 3fef12c25bd71e09
  3c736eae30af0cb3 3fef199bdd85529c 3c8ee3325c9ffd94 3fef20ab5fffd07a
  3c84e08fd10959ac 3fef27f12e57d14b 3c63cdaf384e1a67 3fef2f6d9406e7b5
  3c676b2c6c921968 3fef3720dcef9069 bc808a1883ccb5d2 3fef3f0b555dc3fa
  bc8fad5d3ffffa6f 3fef472d4a07897c bc900dae3875a949 3fef4f87080d89f2
  3c74a385a63d07a7 3fef5818dcfba487 bc82919e2040220f 3fef60e316c98398
  3c8e5a50d5c192ac 3fef69e603db3285 3c843a59ac016b4b 3fef7321f301b460
  bc82d52107b43e1f 3fef7c97337b9b5f bc892ab93b470dc9 3fef864614f5a129
  3c74b604603a88d3 3fef902ee78b3ff6 3c83c5ec519d7271 3fef9a51fbc74c83
  bc8ff7128fd391f0 3fefa4afa2a490da bc8dae98e223747d 3fefaf482d8e67f1
  3c8ec3bc41aa2008 3fefba1bee615a27 3c842b94c3a9eb32 3fefc52b376bba97
  3c8a64a931d185ee 3fefd0765b6e4540 bc8e37bae43be3ed 3fefdbfdad9cbe14
  3c77893b4d91cd9d 3fefe7c1819e90d8 3c5305c14160cc89 3feff3c22b8f71f1`;
// exp2f_data.c: __exp2f_data.tab (N = 32), 64-bit words
const EXP2F_TAB_HEX = `
  3ff0000000000000 3fefd9b0d3158574 3fefb5586cf9890f 3fef9301d0125b51
  3fef72b83c7d517b 3fef54873168b9aa 3fef387a6e756238 3fef1e9df51fdee1
  3fef06fe0a31b715 3feef1a7373aa9cb 3feedea64c123422 3feece086061892d
  3feebfdad5362a27 3feeb42b569d4f82 3feeab07dd485429 3feea47eb03a5585
  3feea09e667f3bcd 3fee9f75e8ec5f74 3feea11473eb0187 3feea589994cce13
  3feeace5422aa0db 3feeb737b0cdc5e5 3feec49182a3f090 3feed503b23e255d
  3feee89f995ad3ad 3feeff76f2fb5e47 3fef199bdd85529c 3fef3720dcef9069
  3fef5818dcfba487 3fef7c97337b9b5f 3fefa4afa2a490da 3fefd0765b6e4540`;
// logf_data.c: __logf_data.tab (N = 16), {invc, logc} pairs as doubles
const LOGF_TAB_HEX = `
  3ff661ec79f8f3be bfd57bf7808caade 3ff571ed4aaf883d bfd2bef0a7c06ddb
  3ff49539f0f010b0 bfd01eae7f513a67 3ff3c995b0b80385 bfcb31d8a68224e9
  3ff30d190c8864a5 bfc6574f0ac07758 3ff25e227b0b8ea0 bfc1aa2bc79c8100
  3ff1bb4a4a1a343f bfba4e76ce8c0e5e 3ff12358f08ae5ba bfb1973c5a611ccc
  3ff0953f419900a7 bfa252f438e10c1e 3ff0000000000000 0000000000000000
  3fee608cfd9a47ac 3faaa5aa5df25984 3feca4b31f026aa0 3fbc5e53aa362eb4
  3feb2036576afce6 3fc526e57720db08 3fe9c2d163a1aa2d 3fcbc2860d224770
  3fe886e6037841ed 3fd1058bc8a07ee1 3fe767dcf5534862 3fd4043057b6ee09`;
// sincosf_data.c: __inv_pio4 (4/pi, 192 bits), 32-bit words
const INV_PIO4_HEX = `
  000000a2 0000a2f9 00a2f983 a2f9836e f9836e4e 836e4e44 6e4e4415 4e441529
  441529fc 1529fc27 29fc2757 fc2757d1 2757d1f5 57d1f534 d1f534dd f534ddc0
  34ddc0db ddc0db62 c0db6295 db629599 6295993c 95993c43 993c4390 3c439041`;

const EXP_T = (() => { const w = words(EXP_TAB_HEX), t = new Uint32Array(512);
  for (let i = 0; i < 256; i++) { t[2 * i] = parseInt(w[i].slice(8), 16); t[2 * i + 1] = parseInt(w[i].slice(0, 8), 16); }
  return t; })();                                        // [lo, hi] words of {tail, sbits}[128]
const EXP2F_T = (() => { const w = words(EXP2F_TAB_HEX), t = new Uint32Array(64);
  for (let i = 0; i < 32; i++) { t[2 * i] = parseInt(w[i].slice(8), 16); t[2 * i + 1] = parseInt(w[i].slice(0, 8), 16); }
  return t; })();
const LOGF_T = Float64Array.from(words(LOGF_TAB_HEX), hd);   // invc, logc pairs
const INV_PIO4 = Uint32Array.from(words(INV_PIO4_HEX), (h) => parseInt(h, 16));

// --- double exp (optimized-routines exp.c, EXP_TABLE_BITS 7, EXP_POLY_ORDER 5) -------------------
const InvLn2N = hd("40671547652b82fe"), NegLn2hiN = hd("bf762e42fefa0000"), NegLn2loN = hd("bd0cf79abc9e3b3a");
const EC2 = hd("3fdffffffffffdbd"), EC3 = hd("3fc555555555543c"), EC4 = hd("3fa55555cf172b91"), EC5 = hd("3f81111167a4d017");
const P2_1009 = 2 ** 1009, P2_M1022 = 2 ** -1022;

const asDouble = (hi, lo) => { w64[1] = hi; w64[0] = lo; return f64[0]; };

const expSpecial = (tmp, shi, slo, ki) => {
  if ((ki & 0x80000000) === 0) {                         // k > 0: the scale exponent may overflow
    const scale = asDouble((shi - (1009 << 20)) >>> 0, slo);
    return P2_1009 * fma(scale, tmp, scale);
  }
  const scale = asDouble((shi + (1022 << 20)) >>> 0, slo); // k < 0: care in the subnormal range
  const st = scale * tmp;
  let y = st + scale;
  if (y < 1.0) {
    const hi = y + 1.0;
    let lo = st + (scale - y);
    lo = lo + ((1.0 - hi) + y);
    y = (hi + lo) - 1.0;
    if (y === 0) y = 0;
  }
  return P2_M1022 * y;
};

// exp(x) for a double x
export const exp = (x) => {
  f64[0] = x;
  const hx = w64[1];
  let abstop = (hx >>> 20) & 0x7ff;
  if (((abstop - 0x3c9) >>> 0) >= 0x3f) {
    if (abstop <= 0x3c8) return 1.0 + x;                 // |x| < 2^-54
    if (abstop >= 0x409) {                               // |x| >= 1024, inf, nan
      if (x === -Infinity) return 0;
      if (abstop >= 0x7ff) return 1.0 + x;
      return hx >>> 31 ? 0 : Infinity;
    }
    abstop = 0;                                          // 512 <= |x| < 1024
  }
  const z = InvLn2N * x;
  const kd = roundAway(z), ki = kd | 0;
  let r = fma(NegLn2hiN, kd, x);
  r = fma(kd, NegLn2loN, r);
  const idx = 2 * (ki & 127);
  const tail = asDouble(EXP_T[2 * idx + 1], EXP_T[2 * idx]);
  const shi = (EXP_T[2 * idx + 3] + (ki << 13)) >>> 0, slo = EXP_T[2 * idx + 2];   // sbits = T + (ki << 45)
  const r2 = r * r;
  const tr = tail + r;
  let p = fma(r, EC3, EC2);
  p = fma(r2, p, tr);
  const q = fma(r, EC5, EC4);
  const tmp = fma(r2 * r2, q, p);
  if (abstop === 0) return expSpecial(tmp, shi, slo, ki);
  const scale = asDouble(shi, slo);
  return fma(tmp, scale, scale);
};

// --- float expf (optimized-routines expf.c, EXP2F_TABLE_BITS 5) ---------------------------------
const EF_InvLn2 = hd("40471547652b82fe");
const EF_C0 = hd("3ebc6af84b912394"), EF_C1 = hd("3f2ebfce50fac4f3"), EF_C2 = hd("3f962e42ff0c52d6");
const EF_OFLOW = hf("42b17217"), EF_UFLOW = hf("c2cff1b4");

export const expf = (xf) => {
  f32[0] = xf;
  const ix = u32[0], abstop = (ix >>> 20) & 0x7ff;
  xf = f32[0];
  if (abstop >= 0x42b) {                                 // |x| >= 88 or nan
    if (ix === 0xff800000) return 0;
    if (abstop >= 0x7f8) return F(xf + xf);
    if (xf > EF_OFLOW) return Infinity;
    if (xf < EF_UFLOW) return 0;
  }
  const z = EF_InvLn2 * xf;
  const kd = roundAway(z), ki = kd | 0;
  const r = z - kd;
  const j = 2 * (ki & 31);
  const s = asDouble((EXP2F_T[j + 1] + (ki << 15)) >>> 0, EXP2F_T[j]);   // T + (ki << 47)
  const zz = fma(EF_C0, r, EF_C1);
  const r2 = r * r;
  let y = fma(r, EF_C2, 1.0);
  y = fma(r2, zz, y);
  return F(y * s);
};

// --- float logf (optimized-routines logf.c, LOGF_TABLE_BITS 4) ----------------------------------
const LF_Ln2 = hd("3fe62e42fefa39ef");
const LF_A0 = hd("bfd00ea348b88334"), LF_A1 = hd("3fd5575b0be00b6a"), LF_A2 = hd("bfdffffef20a4123");

export const logf = (xf) => {
  f32[0] = xf;
  let ix = u32[0];
  xf = f32[0];
  if (ix === 0x3f800000) return 0;
  if (((ix - 0x00800000) >>> 0) >= 0x7f000000) {
    if (((ix << 1) >>> 0) === 0) return -Infinity;
    if (ix === 0x7f800000) return xf;
    if ((ix & 0x80000000) || ((ix << 1) >>> 0) >= 0xff000000) return NaN;
    f32[0] = F(xf * 8388608);                            // subnormal: normalize
    ix = (u32[0] - (23 << 23)) >>> 0;
  }
  const tmp = (ix - 0x3f330000) >>> 0;
  const i = (tmp >>> 19) & 15;
  const k = (tmp | 0) >> 23;
  u32[0] = (ix - (tmp & 0xff800000)) >>> 0;
  const z = f32[0];
  const invc = LOGF_T[2 * i], logc = LOGF_T[2 * i + 1];
  const r = fma(invc, z, -1.0);
  const y0 = fma(LF_Ln2, k, logc);
  let y = fma(LF_A1, r, LF_A2);
  const r2 = r * r;
  const y0r = y0 + r;
  y = fma(LF_A0, r2, y);
  return F(fma(r2, y, y0r));
};

// --- float cosf / sincosf (optimized-routines cosf.c, sincosf.c, sincosf.h) ---------------------
// sincos_t: sign[4], hpi_inv, hpi, c0..c4, s1..s3; the second table negates the cosine polynomial.
const SC_SIGN = [1, -1, -1, 1];
const SC_HPI_INV = hd("3fe45f306dc9c883"), SC_HPI = hd("3ff921fb54442d18");
const SC_C = [[hd("3ff0000000000000"), hd("bfdffffffd0c621c"), hd("3fa55553e1068f19"), hd("bf56c087e89a359d"), hd("3ef99343027bf8c3")]];
SC_C.push(SC_C[0].map((c) => -c));
const SC_S1 = hd("bfc555545995a603"), SC_S2 = hd("3f81107605230bc4"), SC_S3 = hd("bf2994eb3774cf24");
const PI63 = hd("3c1921fb54442d18");

// cosine polynomial of the reduced argument (only x^2 is used)
const cosPoly = (x2, c) => {
  const c2 = fma(x2, c[4], c[3]);
  const c1 = fma(x2, c[1], c[0]);
  const x4 = x2 * x2, x6 = x2 * x4;
  return fma(x6, c2, fma(x4, c[2], c1));
};
// sine polynomial of the signed reduced argument xs
const sinPoly = (xs, x2) => {
  const s1 = fma(x2, SC_S3, SC_S2);
  const x3 = x2 * xs, x7 = x2 * x3;
  return fma(x7, s1, fma(x3, SC_S1, xs));
};

// 32x32 -> 64 bit unsigned multiply as [hi, lo] exact doubles
const umul = (a, b) => {
  const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
  const mid = al * bh + ah * bl;
  const t = al * bl + (mid % 65536) * 65536;
  const lo = t % 4294967296;
  return [ah * bh + Math.floor(mid / 65536) + Math.floor(t / 4294967296), lo];
};
// reduce_large: |x| >= 120 by 4/pi to 192 bits; returns the reduced double, the quadrant in redN
let redN = 0;
const reduceLarge = (xi) => {
  const a = (xi >>> 26) & 15, shift = (xi >>> 23) & 7;
  const m = (((xi & 0x7fffff) | 0x800000) << shift) >>> 0;
  const r0 = Math.imul(m, INV_PIO4[a]) >>> 0;                      // 32-bit product
  const [r1h, r1l] = umul(m, INV_PIO4[a + 4]);
  const [r2h] = umul(m, INV_PIO4[a + 8]);
  // res0 = ((r0 << 32) | (r2 >> 32)) + r1, mod 2^64
  let lo = r2h + r1l, hi = r0 + r1h;
  if (lo >= 4294967296) { lo -= 4294967296; hi += 1; }
  hi = hi % 4294967296;
  // n = (res0 + 2^61) >> 62; res0 -= n << 62
  const n = Math.floor(((hi + 0x20000000) % 4294967296) / 0x40000000);
  hi = (hi - n * 0x40000000 + 4294967296) % 4294967296;
  redN = n;
  const hs = hi >= 0x80000000 ? hi - 4294967296 : hi;            // (int64) res0
  return (hs * 4294967296 + lo) * PI63;
};

export const cosf = (yf) => {
  f32[0] = yf;
  const xi = u32[0], at = (xi >>> 20) & 0x7ff;
  const x = f32[0];
  if (at < 0x3f4) {                                      // |x| < pi/4
    if (at < 0x398) return 1;                            // |x| < 2^-12
    return F(cosPoly(x * x, SC_C[0]));
  }
  if (at < 0x42f) {                                      // |x| < 120
    const r = SC_HPI_INV * x;
    const kd = roundAway(r), n = kd | 0;
    const xr = fma(-kd, SC_HPI, x);
    const x2 = xr * xr, c = SC_C[(n & 2) ? 1 : 0];
    return F((n & 1) ? sinPoly(xr * SC_SIGN[n & 3], x2) : cosPoly(x2, c));
  }
  if (at < 0x7f8) {
    const xr = reduceLarge(xi), n = redN, q = n + (xi >>> 31);
    const xs = xr * SC_SIGN[q & 3], x2 = xr * xr, c = SC_C[(q & 2) ? 1 : 0];
    return F((n & 1) ? sinPoly(xs, x2) : cosPoly(x2, c));
  }
  return NaN;
};

// sincosf(y): writes [sin, cos] into out (a length-2 array) and returns it
export const sincosf = (yf, out = [0, 0]) => {
  f32[0] = yf;
  const xi = u32[0], at = (xi >>> 20) & 0x7ff;
  const y = f32[0];
  let xs, x2, n, c;
  if (at < 0x3f4) {                                      // |x| < pi/4
    if (at < 0x398) { out[0] = y; out[1] = 1; return out; }
    xs = y; x2 = y * y; n = 0; c = SC_C[0];
  } else if (at < 0x42f) {                               // |x| < 120
    const r = SC_HPI_INV * y;
    const kd = roundAway(r);
    n = kd | 0;
    const xr = fma(-kd, SC_HPI, y);
    xs = xr * SC_SIGN[n & 3]; x2 = xr * xr; c = SC_C[(n & 2) ? 1 : 0];
  } else if (at < 0x7f8) {
    const xr = reduceLarge(xi); n = redN;
    const q = n + (xi >>> 31);
    xs = xr * SC_SIGN[q & 3]; x2 = xr * xr; c = SC_C[(q & 2) ? 1 : 0];
  } else { out[0] = out[1] = NaN; return out; }
  const s = F(sinPoly(xs, x2)), co = F(cosPoly(x2, c));
  if (n & 1) { out[0] = co; out[1] = s; } else { out[0] = s; out[1] = co; }
  return out;
};

// --- float log10f (FreeBSD msun e_log10f.c + k_logf.h; float32, no fusion) ----------------------
const TWO25 = hf("4c000000");
const IVLN10HI = hf("3ede6000"), IVLN10LO = hf("b804ead9"), LOG10_2HI = hf("3e9a2080"), LOG10_2LO = hf("355427db");
const LG1 = hf("3f2aaaaa"), LG2 = hf("3eccce13"), LG3 = hf("3e91e9ee"), LG4 = hf("3e789e26");

export const log10f = (xf) => {
  f32[0] = xf;
  let hx = i32[0], x = f32[0], k = 0;
  if (hx < 0x00800000) {                                 // x < 2^-126
    if ((hx & 0x7fffffff) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 25; x = F(x * TWO25); f32[0] = x; hx = i32[0];
  }
  if (hx >= 0x7f800000) return F(x + x);
  if (hx === 0x3f800000) return 0;
  k += (hx >> 23) - 127;
  hx &= 0x007fffff;
  const i = (hx + 0x4afb0d) & 0x800000;
  i32[0] = hx | (i ^ 0x3f800000); x = f32[0];
  k += i >> 23;
  const yk = F(k);
  const f = F(x - 1);
  const hfsq = F(f * F(f * 0.5));
  // k_log1pf(f)
  const s = F(f / F(f + 2));
  const z = F(s * s), w = F(z * z);
  const t1 = F(w * F(F(LG4 * w) + LG2));
  const t2 = F(z * F(F(LG3 * w) + LG1));
  const r = F(s * F(hfsq + F(t2 + t1)));
  f32[0] = F(f - hfsq); u32[0] = u32[0] & 0xfffff000;
  const hi = f32[0];
  const lo = F(F(F(f - hi) - hfsq) + r);
  return F(F(F(F(F(yk * LOG10_2LO) + F(F(lo + hi) * IVLN10LO)) + F(lo * IVLN10HI)) + F(hi * IVLN10HI))
           + F(yk * LOG10_2HI));
};

// --- sqrtf: FSQRT; the double square root of a float rounds to the correctly rounded float ------
export const sqrtf = (x) => F(Math.sqrt(F(x)));
