import { F } from "../../engine/core.js";
import { featureState } from "./state.js";

// Waits of the ADV helpers that the loop's UniTask.Delay does not cover.

// AdvPlayerHelper.DelayWithSpeedAdjustment(duration): while time remains, the remaining time is scaled by previous /
// current speed when the playback speed changed, then UniTask.NextFrame, then the frame's unscaled delta time is
// subtracted (the calling frame subtracts nothing). Resolves true when the time has run out, false when the playback
// stopped or stop() became true (observed after the NextFrame, as the cancelled token is). While a video seek
// re-speed runs, WaitWhileVideoSeekRespeedingAsync holds the countdown first (then the loop starts over).
export const delayWithSpeedAdjustment = async (p, duration, stop = null) => {
  const loop = p.ctx.loop, halt = () => p.cancelled || !!(stop && stop());
  let remaining = F(duration), prev = p.speedRate();
  for (;;) {
    if (remaining <= 0) return true;
    if (videoSeekRespeeding(p.ctx)) {
      const w = await waitWhileVideoSeekRespeeding(p, remaining, prev, halt);
      if (!w) return false;
      ({ remaining, previous: prev } = w);
      continue;
    }
    const s = p.speedRate();
    if (s !== prev) { remaining = F(remaining * F(prev / s)); prev = s; }
    await loop.yield("Update");
    if (halt()) return false;
    remaining = F(remaining - F(loop.deltaTime));
  }
};

// UniTask.WaitUntil(predicate) at PlayerLoopTiming.Update: checked once per frame from the next Update on
export const loopWaitUntil = async (loop, predicate, stop = null) => {
  for (;;) {
    await loop.yield("Update");
    if (stop && stop()) return false;
    if (predicate()) return true;
  }
};

export const waitUntil = (p, predicate, stop = null) =>
  loopWaitUntil(p.ctx.loop, predicate, () => p.cancelled || !!(stop && stop()));

// Session.IsVideoSeekRespeeding: WaitWhileVideoSeekRespeedingAsync returns (false, remaining, previous) at once, with
// no await, while it is false
export const videoSeekRespeeding = (ctx) => { const v = featureState(ctx).video; return !!v && v.seekRespeeding; };

// AdvPlayerHelper.WaitWhileVideoSeekRespeedingAsync(ctx, remaining, previousSpeed) while a re-speed runs:
// UniTask.WaitWhile(IsVideoSeekRespeeding) at Update, then the remaining time scaled by previous / current speed when
// the speed changed (Single.Equals) and reduced by the real time of the frames the video advanced in its re-speeds
// meanwhile (VideoSeekRespeedAdvancedFrameTotal). -> {remaining, previous}, null when stop() became true
export const waitWhileVideoSeekRespeeding = async (p, remaining, previous, stop) => {
  const v = featureState(p.ctx).video, before = v.seekRespeedAdvancedFrames;
  if (!await loopWaitUntil(p.ctx.loop, () => !v.seekRespeeding, stop)) return null;
  const now = F(p.speedRate());
  if (!(now === previous || (Number.isNaN(now) && Number.isNaN(previous)))) {
    remaining = F(remaining * F(previous / now)); previous = now;
  }
  return { remaining: F(remaining - calcVideoRealDuration(p, v.seekRespeedAdvancedFrames - before)), previous };
};

// AdvPlayerHelper.CalcVideoRealDuration(frameCount): (float)frames / the current video's frame rate / the speed rate;
// 0 below one frame, without a current video (or its source), or at a frame rate or speed rate <= 0
export const calcVideoRealDuration = (p, frames) => {
  const v = featureState(p.ctx).video, video = v && v.current;
  if (frames < 1 || !video) return 0;
  const fps = video.source ? F(video.frameRate) : 0, speed = F(p.speedRate());
  if (fps <= 0 || speed <= 0) return 0;
  return F(F(F(frames) / fps) / speed);
};
