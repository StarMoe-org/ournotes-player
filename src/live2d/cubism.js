// Live2D Cubism Core access and a thin model wrapper (moc3 evaluation only). Behaviour above the Core (motions,
// expressions, blink, physics, ...) lives in character.js and follows the game's build of Cubism SDK for Unity.
//
// The Core is not part of this package: the page loads Live2D's own `live2dcubismcore.min.js` (Cubism SDK for Web,
// under Live2D Inc.'s license), which defines the global `Live2DCubismCore`. Its WebAssembly runtime starts
// asynchronously; cubismCore() waits until it answers.

const CORE_WAIT_MS = 10000;

let ready = null;

// The global Live2DCubismCore once its runtime is up. Throws when the page has not loaded the Core.
export const cubismCore = () => {
  const C = globalThis.Live2DCubismCore;
  if (!C || !C.Moc || !C.Model || !C.Version)
    return Promise.reject(new Error("Live2D Cubism Core is not loaded: the page must load Live2D's live2dcubismcore.min.js " +
                                    "(Cubism SDK for Web) before a model is created; ournotes-player does not include it"));
  if (ready && ready.core === C) return ready.promise;
  const promise = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      let v = 0;
      try { v = C.Version.csmGetVersion(); } catch (_) { /* runtime not started yet */ }
      if (v) { resolve(C); return; }
      if (Date.now() - t0 > CORE_WAIT_MS) { reject(new Error("Live2D Cubism Core did not start")); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
  ready = { core: C, promise };
  return promise;
};

// csmGetDrawableConstantFlags / csmGetDrawableDynamicFlags bits
export const CUBISM = {
  BLEND_ADDITIVE: 1 << 0, BLEND_MULTIPLICATIVE: 1 << 1, IS_DOUBLE_SIDED: 1 << 2, IS_INVERTED_MASK: 1 << 3,
  IS_VISIBLE: 1 << 0, VISIBILITY_DID_CHANGE: 1 << 1, OPACITY_DID_CHANGE: 1 << 2, DRAW_ORDER_DID_CHANGE: 1 << 3,
  RENDER_ORDER_DID_CHANGE: 1 << 4, VERTEX_POSITIONS_DID_CHANGE: 1 << 5, BLEND_COLOR_DID_CHANGE: 1 << 6,
};

// The live models. The Core's parameter, part and drawable arrays are views of its heap, made when a model is
// created; a later allocation (a moc or a model) may grow the heap into a new buffer, and the arrays made before it
// then view the old one: the values written there no longer reach the model and csmUpdateModel's vertices no longer
// show. After each model is created, the arrays of every live model on an old buffer are made again
// (Live2DCubismCore.Parameters / Parts / Drawables over the model's pointer); the Core's data moved with the heap.
const liveModels = new Set();

const rebindable = (C, model) => typeof C.Parameters === "function" && typeof C.Parts === "function" &&
  typeof C.Drawables === "function" && !!model._ptr;

const rebindViews = (C) => {
  let heap = null;
  for (const m of liveModels) {
    const core = m.model;
    if (!rebindable(C, core)) continue;
    const fresh = heap ? null : new C.Parameters(core._ptr);          // the first one tells the current heap
    if (fresh) heap = fresh.values.buffer;
    if (core.parameters.values.buffer === heap) continue;
    core.parameters = fresh || new C.Parameters(core._ptr);
    core.parts = new C.Parts(core._ptr);
    core.drawables = new C.Drawables(core._ptr);
    m.parameters = core.parameters; m.parts = core.parts; m.drawables = core.drawables;
  }
};

// A moc3 and one model instance of it. Call cubismCore() first.
export class CubismModel {
  constructor(mocBytes) {
    const C = globalThis.Live2DCubismCore;
    if (!C) throw new Error("Live2D Cubism Core is not loaded");
    const b = new Uint8Array(mocBytes);
    if (b.length < 8 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "MOC3") throw new Error("not a moc3 file");
    const latest = C.Version.csmGetLatestMocVersion();
    if (b[4] > latest) throw new Error(`moc3 version ${b[4]} is newer than this Cubism Core supports (${latest})`);
    this.moc = C.Moc.fromArrayBuffer(mocBytes);
    if (!this.moc) { rebindViews(C); throw new Error("moc3 rejected by Cubism Core"); }
    this.model = C.Model.fromMoc(this.moc);
    if (!this.model) {
      this.moc._release(); rebindViews(C);
      throw new Error("Cubism Core could not create a model of the moc3");
    }
    this.parameters = this.model.parameters;
    this.parts = this.model.parts;
    this.drawables = this.model.drawables;
    this.canvas = this.model.canvasinfo;
    liveModels.add(this);
    rebindViews(C);
  }

  update() { this.model.update(); }

  resetDynamicFlags() { this.drawables.resetDynamicFlags(); }

  release() {
    if (!this.model) return;
    liveModels.delete(this);
    this.model.release(); this.moc._release();
    this.model = null; this.moc = null;
  }
}
