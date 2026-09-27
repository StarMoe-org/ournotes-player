// UnityProgram.apply's sampler binding (src/engine/glsl.js): a cube sampler takes a cube map, every other sampler a 2D
// texture, and a texture of the other kind is refused. UnityProgram.reads names the program's inputs. passState /
// applyState: a pass's Stencil block (stencilOp) drives both faces from the material's stencil properties. Synthetic
// inputs only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GL, UnityProgram, applyState, passState } from "../../src/engine/glsl.js";
import { headlessGL } from "../../scripts/lib/headless.mjs";

const program = (gl, samplers) => Object.assign(Object.create(UnityProgram.prototype), {
  gl, label: "p", program: gl.createProgram(), uniforms: [], blocks: [],
  samplers: samplers.map(([name, type], unit) => ({ name, loc: { name }, unit, type: gl[type] })),
});

test("UnityProgram.apply: cube samplers bind TEXTURE_CUBE_MAP, other samplers TEXTURE_2D, a mismatch is refused", () => {
  const calls = [];
  const gl = headlessGL({ onCall: (n, a) => calls.push([n, ...a]) });
  const cube = { glTexture: gl.createTexture(), target: gl.TEXTURE_CUBE_MAP }, flat = { glTexture: gl.createTexture() };
  const p = program(gl, [["_Env", "SAMPLER_CUBE"], ["_MainTex", "SAMPLER_2D"]]);
  calls.length = 0;
  p.apply([{ _Env: cube, _MainTex: flat }]);
  const binds = calls.filter(([n]) => n === "bindTexture");
  assert.deepEqual(binds, [["bindTexture", gl.TEXTURE_CUBE_MAP, cube.glTexture], ["bindTexture", gl.TEXTURE_2D, flat.glTexture]]);
  assert.throws(() => p.apply([{ _Env: flat, _MainTex: flat }]), /p: sampler _Env needs a cube map/);
  assert.throws(() => p.apply([{ _Env: cube, _MainTex: cube }]), /p: sampler _MainTex needs a 2D texture/);
});

test("UnityProgram.reads: an active uniform, uniform block member (matrix name without hlslcc_mtx4x4) or sampler", () => {
  const gl = headlessGL();
  const p = Object.assign(program(gl, [["_MainTex", "SAMPLER_2D"]]), {
    uniforms: [{ name: "_WorldSpaceCameraPos" }],
    blocks: [{ name: "UnityPerDraw", members: [{ name: "hlslcc_mtx4x4unity_ObjectToWorld" }, { name: "unity_SpriteColor" }] }],
  });
  for (const name of ["_WorldSpaceCameraPos", "unity_ObjectToWorld", "unity_SpriteColor", "_MainTex"]) assert.ok(p.reads(name), name);
  for (const name of ["unity_SpriteProps", "hlslcc_mtx4x4unity_ObjectToWorld", "unity_OrthoParams"]) assert.ok(!p.reads(name), name);
});

// a UI pass state as packed: Stencil { Ref [_Stencil] ReadMask [_StencilReadMask] WriteMask [_StencilWriteMask]
// Comp [_StencilComp] Pass [_StencilOp] }, ColorMask [_ColorMask], ZTest [unity_GUIZTestMode], blend One OneMinusSrcAlpha
const V = (val, name = "<noninit>") => ({ val, name });
const KEEP_ALWAYS = () => ({ pass: V(0), fail: V(0), zFail: V(0), comp: V(8) });
const uiPass = (extra = {}) => ({
  rtBlend0: { srcBlend: V(1), destBlend: V(10), srcBlendAlpha: V(1), destBlendAlpha: V(10), blendOp: V(0), blendOpAlpha: V(0),
              colMask: V(0, "_ColorMask") },
  zTest: V(0, "unity_GUIZTestMode"), zWrite: V(0), culling: V(0), offsetFactor: V(0), offsetUnits: V(0),
  stencilRef: V(0, "_Stencil"), stencilReadMask: V(0, "_StencilReadMask"), stencilWriteMask: V(0, "_StencilWriteMask"),
  stencilOp: { pass: V(0, "_StencilOp"), fail: V(0), zFail: V(0), comp: V(0, "_StencilComp") },
  stencilOpFront: KEEP_ALWAYS(), stencilOpBack: KEEP_ALWAYS(), rtSeparateBlend: false, alphaToMask: V(0), ...extra,
});
const floats = (stencil, comp, op, read, write, colorMask) => ({ _Stencil: stencil, _StencilComp: comp, _StencilOp: op,
  _StencilReadMask: read, _StencilWriteMask: write, _ColorMask: colorMask, unity_GUIZTestMode: 4 });

test("passState / applyState: the Stencil block's properties set the stencil test of both faces", () => {
  const calls = [];
  const gl = headlessGL({ onCall: (n, a) => calls.push([n, ...a]) });
  GL.init(gl);
  const stencilCalls = (f) => {
    calls.length = 0;
    applyState(gl, passState(uiPass(), f));
    return calls.filter(([n, a]) => /^stencil/.test(n) || ((n === "enable" || n === "disable") && a === gl.STENCIL_TEST));
  };
  // a mask graphic: Always, Replace with 1, colour writes off
  const mask = floats(1, 8, 2, 255, 255, 0);
  assert.deepEqual(passState(uiPass(), mask).stencilFront, [8, 2, 0, 0]);
  assert.deepEqual(stencilCalls(mask), [
    ["enable", gl.STENCIL_TEST],
    ["stencilFuncSeparate", gl.FRONT, gl.ALWAYS, 1, 255], ["stencilOpSeparate", gl.FRONT, gl.KEEP, gl.KEEP, gl.REPLACE],
    ["stencilFuncSeparate", gl.BACK, gl.ALWAYS, 1, 255], ["stencilOpSeparate", gl.BACK, gl.KEEP, gl.KEEP, gl.REPLACE],
    ["stencilMask", 255]]);
  // a graphic drawn where the mask bit is clear: Equal against 2 & 1, no stencil writes
  const outside = floats(2, 3, 0, 1, 0, 15);
  assert.deepEqual(stencilCalls(outside), [
    ["enable", gl.STENCIL_TEST],
    ["stencilFuncSeparate", gl.FRONT, gl.EQUAL, 2, 1], ["stencilOpSeparate", gl.FRONT, gl.KEEP, gl.KEEP, gl.KEEP],
    ["stencilFuncSeparate", gl.BACK, gl.EQUAL, 2, 1], ["stencilOpSeparate", gl.BACK, gl.KEEP, gl.KEEP, gl.KEEP],
    ["stencilMask", 0]]);
  // the shader defaults (Always, Keep) and CompareFunction.Disabled leave the test off
  assert.deepEqual(stencilCalls(floats(0, 8, 0, 255, 255, 15)), [["disable", gl.STENCIL_TEST]]);
  assert.deepEqual(stencilCalls(floats(1, 0, 2, 255, 255, 15)), [["disable", gl.STENCIL_TEST]]);
  // per-face ops are refused
  const back = { ...KEEP_ALWAYS(), comp: V(3) };
  assert.throws(() => passState(uiPass({ stencilOpBack: back }), mask), /per-face stencil ops not implemented/);
  assert.throws(() => passState(uiPass({ stencilOpFront: { ...KEEP_ALWAYS(), pass: V(0, "_StencilOpFront") } }), mask),
                /per-face stencil ops not implemented/);
});
