import { F } from "../../engine/core.js";

// The CRI Lips data object: the descriptor (crilips.json) and the float32 blob (crilips.bin) that
// nnnotes extracts from the user's own APK at export time. This module only parses them into typed
// arrays keyed by block name; it embeds no game values.
//
// descriptor = { version, core_version, dtype:"float32", order:"LE", total_floats,
//   blocks:[{name, offset, count, shape, kind, sha256}], constants:{...}, frontend:{...} }
// blob = Float32Array little-endian, blocks concatenated at their `offset` (in floats).

export class CriLipsData {
  // descriptor: parsed crilips.json; blob: ArrayBuffer / Float32Array of crilips.bin
  constructor(descriptor, blob) {
    if (!descriptor || descriptor.dtype !== "float32" || descriptor.order !== "LE")
      throw new Error("CRI Lips data: expected float32 LE descriptor");
    const floats = blob instanceof Float32Array ? blob
      : new Float32Array(blob.buffer || blob, blob.byteOffset || 0,
                         (blob.byteLength || blob.length) / 4);
    this.version = descriptor.version;
    this.constants = descriptor.constants;
    this.frontend = descriptor.frontend;
    this.shapes = {};
    this.W = {};
    for (const b of descriptor.blocks) {
      this.W[b.name] = floats.subarray(b.offset, b.offset + b.count);
      this.shapes[b.name] = b.shape;
      if (this.W[b.name].length !== b.count)
        throw new Error(`CRI Lips data: block ${b.name} truncated`);
    }
  }

  // Coefficients the constants imply, as float32.
  get silenceCoef() { return F(this.constants.silence_coef); }
}
