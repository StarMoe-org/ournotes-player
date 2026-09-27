// The state of a story session that playing makes, not what drawing makes of it, hashed per part: for checks that two
// ways of reaching a frame agree (a fast-forward and the same steps drawn, two runs with one seed).
//   core        the interpreter: frame, time, row, line, speaker, text, auto, speed, pause, next step
//   characters  each loaded character's simulation: parameters, part opacities, motions, expressions, physics, eye
//               blink, breath, lip sync, look, transform, random stream (its meshes, masks and Core are drawing's)
//   ui          every UI node's activity, rect settings, colours, sprites and texts with their visible counts; the UI's
//               Animators and running tweens
//   audio       every playing sound: cue, category, loop, volume, fade, speed and its position at the context's time
//               (in the loop region for a looped one); the category and movie volumes
//   video       the current video's clock and state, the video timeline, the flow flags
//   scene       camera, character stages, the field renderer's per-slot values, the volume stack
//
//   import { storyState } from "./lib/story-state.mjs";
//   storyState(session)        // {core, characters, ui, audio, video, scene}: a hash each (null for a missing part)
//   storyStateParts(session)   // the same parts unhashed (to find what differs)
import crypto from "node:crypto";
import { storyVideo } from "../../src/story/features/video.js";

export const stateHash = (x) => crypto.createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 16);

const num = (x) => (Number.isFinite(x) ? x : String(x));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// members that are drawing's (meshes, masks, the Cubism model and its renderers), static data (clips, motions,
// expressions), or references to the rest of the session
const SKIP = new Set([
  "renderers", "junctions", "maskDirty", "core", "dyn", "multiplyTexture", "rim", "shadowIntensity", "lightingEnabled",
  "disableLightingForMultiply", "postCompositeBrightness",
  "prefab", "clips", "fadeById", "motion", "fadeMotions", "expressions", "motionSyncCore",
  "loop", "ch", "parent", "children", "node", "ui", "ctx", "gl", "assets", "store", "promise", "_resolve", "apply",
  "onMotion", "onEvent", "onFinished"]);

// a plain copy of a simulation object: numbers, strings, booleans, typed arrays, arrays, maps and objects (own
// enumerable members but SKIP); a clip or a motion by its name; a sound by its ids
const plain = (v, depth = 10, seen = new Set()) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return num(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v !== "object") return undefined;
  if (ArrayBuffer.isView(v)) return Array.from(v, num);
  if (depth <= 0 || seen.has(v)) return "...";
  if (v.curves && typeof v.name === "string") return `clip ${v.name}`;
  if ("soundId" in v && "gain" in v) return `sound ${v.id} ${v.soundId}`;
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => plain(x, depth - 1, seen));
    if (v instanceof Map) return [...v].map(([k, x]) => [plain(k, 1, seen), plain(x, depth - 1, seen)]);
    if (v instanceof Set) return [...v].map((x) => plain(x, depth - 1, seen));
    const o = {};
    for (const k of Object.keys(v)) {
      if (SKIP.has(k)) continue;
      const x = plain(v[k], depth - 1, seen);
      if (x !== undefined) o[k] = x;
    }
    return o;
  } finally { seen.delete(v); }
};

const coreState = (c) => c && [c.currentEpisodeListIndex, c.lineIndex, c.isAutoPlay, c.playbackSpeed, c.isPause,
                               c.nextStep, c.shortCutIndex, c.coverBlack];

const characterState = (ch) => {
  const { params, parts, model, ...rest } = ch;
  return [ch.name, params && Array.from(params.value, num), parts && Array.from(parts, num),
          model && [model.ignore, model.lastTick, model.wasJustEnabled, model.didExecute],
          plain(rest, 10, new Set([ch]))];
};

// the rect settings a layout drives are drawing's too (the layout runs before each draw, from the rest): the anchors,
// position and size of a layout group's child, the size of a node with a content size fitter
const uiState = (ui) => {
  if (!ui || !ui.nodes) return null;
  const nodes = [...ui.nodes].map(([path, n]) => {
    const driven = !!(n.parent && n.parent.layoutGroup), fitted = driven || !!n.contentSizeFitter;
    const img = n.image, raw = n.rawImage, t = n.text;
    return [path, n.activeSelf,
            driven ? null : [plain(n.anchoredPosition), plain(n.anchorMin), plain(n.anchorMax)],
            fitted ? null : plain(n.sizeDelta), plain(n.pivot), plain(n.localScale), num(n.rotationZ), plain(n.canvasGroup),
            img ? [img.m_Enabled, plain(img.m_Color), img.spriteObj ? img.spriteObj.name || null : null, num(img.m_FillAmount)]
              : null,
            raw ? [raw.m_Enabled, plain(raw.m_Color), plain(raw.m_UVRect)] : null,
            t ? [t.enabled, t.text, t.maxVisibleCharacters, t.maxVisibleLines, plain(t.fontColor32), plain(t.margin),
                 num(t.fontSize)] : null];
  });
  const animators = (ui.animators || []).map((a) => [a.name, a.si, num(a.time), a.speed, a.enabled, plain(a.fade, 2),
                                                     plain(a.params, 3)]);
  const tweens = ui.tweens && ui.tweens.active
    ? [...ui.tweens.active].map((w) => [num(w.elapsed), num(w.position), num(w.duration), w.done]) : null;
  return [nodes, animators, tweens];
};

// a sound's position in its cue at the context's time; a looped one within its loop region
const soundPosition = (i, now) => {
  let at = i.startOffsetSec + (now - i.startCtx) * (i.rate || 1);
  const src = i.src;
  if (src && src.loop) {
    const ls = src.loopStart || 0, le = src.loopEnd || (i.playBuf ? i.playBuf.duration : Infinity);
    if (at >= le && le > ls) at = ls + ((at - ls) % (le - ls));
  }
  return round6(at);
};

const audioState = (a) => {
  if (!a || !a.playing) return null;
  const now = a.ctx ? a.ctx.currentTime : 0;
  const sounds = [...a.playing.values()].map((i) => [i.id, i.soundId, i.category, i.cue ? [i.cue.sheet, i.cue.cue] : null,
    !!(i.src && i.src.loop), i.gain ? num(i.gain.gain.value) : null, i.fade, num(i.fadeStart), num(i.fadeDur), i.rate,
    i.stopped, soundPosition(i, now)]);
  return [sounds, a.categoryVolumes ? plain(a.categoryVolumes.volumes) : null, num(a.movieVolume), a.nextId];
};

const videoState = (v) => {
  if (!v) return null;
  const c = v.current;
  return [c ? [c.uniqueVideoId, c.masterVideoId, c.row, c.status, num(c.time), c.paused, c.speed, c.seekHold] : null,
          plain(v.timeline, 1), plain(v.flow, 1), v.seekRespeeding, v.seekRespeedAdvancedFrames, v.held];
};

const sceneState = (sc) => {
  if (!sc || !sc.camera) return null;
  const cam = sc.camera;
  return [Array.from(cam.transform.localToWorld(), num), num(cam.fov),
          sc.field ? sc.field.stages.map((t) => Array.from(t.localToWorld(), num)) : null,
          sc.fieldRenderer ? sc.fieldRenderer.entries.map((e) => [num(e.alpha), num(e.brightness), num(e.blur)]) : null,
          sc.volume ? plain(sc.volume.stack, 4) : null];
};

// s: a StorySession, or a stand-in with the same members ({ctx, loop, core, characters, ui, audio, scene}; the video
// system is the context's) -> the parts as plain values (null for a missing part)
export const storyStateParts = (s) => {
  const loop = s.loop;
  return {
    core: [loop ? [loop.frameCount, num(loop.time)] : null, coreState(s.core), s.speaker ?? null, s.text ?? null],
    characters: s.characters ? [...s.characters.values()].map(characterState) : null,
    ui: uiState(s.ui),
    audio: audioState(s.audio),
    video: videoState(s.ctx ? storyVideo(s.ctx) : null),
    scene: sceneState(s.scene),
  };
};

// -> the parts hashed
export const storyState = (s) =>
  Object.fromEntries(Object.entries(storyStateParts(s)).map(([k, v]) => [k, v === null ? null : stateHash(v)]));
