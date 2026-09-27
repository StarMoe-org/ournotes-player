// UnityProgram.apply's sampler binding (src/engine/glsl.js): a cube sampler takes a cube map, every other sampler a 2D
// texture, and a texture of the other kind is refused. Synthetic inputs only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UnityProgram } from "../../src/engine/glsl.js";
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
