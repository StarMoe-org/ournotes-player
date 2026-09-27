# CRI Lips analysis (mouth of MotionSync-less story models)

Some story Live2D models have no MotionSync controller. In the game their mouth is driven by CRI
Lips (`CriLipsAtomAnalyzer`), a small neural analysis of the voice PCM that produces one value,
`openY`, per 10 ms. The runtime's mouth path (`Live2DLipSyncController._updateCriLips`) is already
the game's; it just needs an analyzer object. This module reimplements the analysis in float32 so
the player produces `openY` itself from the voice it plays.

The story uses it on two paths (`src/story/commands/talk.js`):

- a voice mapped onto a speaker whose model has no MotionSync controller
  (`AdvTalkVoicePlaybackHelper.StartVoiceLipSync`);
- the speakers that follow another speaker's voice, whatever their model
  (`StartSharedAnalyzerLipSync`): the speakers without a voice of their own on a line with fewer
  voices than speakers, and every showing character in the `EveryoneLipSync` talk mode. On these
  rows a model with a MotionSync controller also takes its mouth from the CRI Lips analysis, as in
  the game.

One analyzer is created per voice and shared by every speaker that follows it. When the story ships
no CRI Lips data (`story.json` `crilips` is null or absent), the character gets the voice's PCM
without an analysis instead: the mouth stays closed and `lipSyncMissing` is `"CRI Lips analysis"`.

## What it is

`src/live2d/crilips/` reproduces CriWare's `CriLipsAtomAnalyzer` / `CriLipsMouth` / `CriLipsCore`
on the path that produces `openY`:

1. **Blocks, low-pass, resample** (`pipeline.js`, `biquad.js`, `resample.js`) — the voice PCM
   (48 kHz in the game) is cut into the analyzer's blocks (the input the resampler needs for the next
   10 ms, rounded up to 8 samples), low-passed by CriWare's biquad (RBJ low-pass, evaluated eight
   samples at a time in its block form) and resampled to 16 kHz by CriWare's fixed-point linear
   resampler.
2. **Two mel analyzers** (`mel.js`, `fft.js`, `crimath.js`) — 30 ms frames at a 10 ms hop centred in a
   512-point buffer, a Hamming window for the internal-class features and a Blackman-Harris window for
   the vowel features, CriWare's own complex FFT (Stockham radix-2 with twiddles from CriWare's
   polynomial sine and cosine), the power spectrum, a 24-band mel filter bank with a sine-squared band
   weighting, `log10` and removal of the mean over the bands. The frame loudness (`10 log10` of the
   frame variance) is compared with the silence threshold.
3. **Analysis core** (`lipscore.js`, `nets.js`, `discretizer.js`) — over the last three frames:
   - the internal-class net (3x3 conv, 4 dense, softmax over 24 classes) when the frame is loud
     enough; its class maps to a motion class, and a short history of motion classes can start a
     closed-mouth hold;
   - the Japanese AIUEO net (dense + batch-norm twice, softmax over 5);
   - the discretizer: the class decides whether the net output, the closed mouth or a wildcard blend
     is fed in; each target is smoothed over the last hops and only the strongest vowel and a
     suppressed runner-up are kept.
   The raw lip-parameter net only feeds the lip width and height, which the story does not read, so
   it is not evaluated.
4. **openY stage** (`openy.js`, `criwareLLipsMouthOpen_ProcessForTypeJapaneseAIUEO`): the dominant
   vowel times its coefficient, clamped, then an anti-shake max/min midpoint over the ring and an
   asymmetric anti-flap blend. When the previous value, the ring and the anti-flap state are all
   near zero, a silence snap clears the ring and the anti-flap state (the hop's value is kept).

All arithmetic is float32 in the native order with no fused multiply-add (`Math.fround` at every
native float32 point). The library calls the platform libm for `exp` (the softmaxes), `log10f` (the
mel log) and `cosf`, `sincosf`, `logf`, `expf` (windows, filter and mel bands); `libm.js` carries the
Android device's implementations of these (ARM optimized-routines and FreeBSD msun, including the
device build's fused multiply-adds, which it emulates exactly), not the JS engine's `Math.*`.

## Interface

```js
// src/live2d/crilips/index.js: used by the story player (not a separate package entry point)
import { CriLipsData, CriLipsAnalyzer } from "../src/live2d/crilips/index.js";

const data = new CriLipsData(descriptor, blob);          // crilips.json + crilips.bin (see below)
const analyzer = new CriLipsAnalyzer(data, pcmSource);   // pcmSource = the voice's PCM (audio.js)
character.setLipsAnalyzer(analyzer);
// each frame the mouth path calls:
const { openY } = analyzer.getOpenInfo();                // analyses the samples output so far, then
                                                         // returns the value the game's main thread reads
analyzer.isAvailable;                                    // true while it has data and a source
```

`getOpenInfo` pulls the samples the source has output since its previous call before it answers, so
nothing else has to drive the analyzer; several speakers can read one analyzer in the same frame.
`capture()` feeds the output early, without reading.

`CriLipsPipeline` is the analysis alone: `feed(pcm, onHop)` accepts PCM in any chunking and calls
`onHop(openY, end)` once per 10 ms hop.

The story hands `analyzer` to `Live2DLipSyncController.setLipsAnalyzer` (above). When an episode
ships no CRI Lips data the analyzer is absent and the controller reports
`lipSyncMissing = "CRI Lips analysis"` and keeps the mouth closed.

### Readout

The game runs the analysis on the Atom audio-server thread once per server tick
(`frontend.server_hz`, 60 Hz) and the main thread reads the last stored value; the library's
readout offset defaults to 0. `getOpenInfo` returns the `openY` of the last hop completed by the
latest server tick at or before the played position (`readoutOffsetMs` behind it, 0 by default;
`readoutHops` is the same offset in hops).

## Data section (for the story data format)

The weights are not shipped in code. `nnnotes` reads them from the user's own APK at export time
(`nnnotes/crilips.py`; the library is in the APK or, for an installed app, in the arm64-v8a split
next to `base.apk`) and writes two files into the story directory, `crilips/crilips.json` and
`crilips/crilips.bin`, named by `story.json` `crilips` (`{ "descriptor", "data" }`):

- `crilips.json` — a descriptor: `{ version, core_version, dtype:"float32", order:"LE",
  total_floats, blocks:[{name, offset, count, shape, kind, sha256}], constants:{...}, frontend:{...} }`.
  `constants` holds the tables read from the library (class maps, anti-flap defaults, silence
  coefficient); `frontend` holds the analysis configuration of that library version (frame and hop,
  bands, rates, windows, discretizer and mouth-open defaults, server rate).
- `crilips.bin` — the float32 little-endian weight blob; each block lives at `offset` (in floats)
  for `count` floats.

`nnnotes` identifies the library by its version string and locates every weight block and constant by
scanning the read-only data for a window matching a per-version sha256 (no hard-coded addresses); an
unknown library version is a hard error. A story built with audio carries the data when one of its
voices reaches the analysis: a lip-synced voice row while a model of the episode has no MotionSync
controller, or a Talk row whose voice also drives other speakers (`nnnotes` `story.needs_cri_lips`).
In a site the two files are common files of the story; the site stores its files by content, so the
weights are stored once for every story. See `docs/story-data-format.md` for `story.json`.

## Fidelity

- For identical float input the port equals the game's library on every hop, bit for bit: every
  stage and the end-to-end `openY` are compared against the library itself running under an ARM
  emulator with the device's libm, and the libm routines against the device libm over all float
  inputs. The end-to-end check covers synthetic signals and decoded game voices, both the per-hop
  series and the 60 Hz readout. A mismatch on any hop is a bug, never a tolerance.
- `// ENGINE:` notes mark where the browser cannot match the game exactly:
  - the readout: the game renders (and so analyses) audio slightly ahead of what is audible; the
    player takes the played position as the render position;
  - when the page's AudioContext sample rate differs from 48 kHz, the resampler converts that rate
    to 16 kHz, which changes the pre-net samples (an input deviation);
  - the site audio is AAC (like charts), so the analysed PCM is the decoded voice.

`docs/fidelity.md` is regenerated from the `// ENGINE:` notes by `node scripts/engine-notes.mjs
--write`.
