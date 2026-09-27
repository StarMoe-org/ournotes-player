// StoryPlayer's handling of its session without a page: the player's pause holds the session's videos with the frames,
// a session started while paused starts held, a language switch after a seek before the first play restarts at the
// seek's line, a seek within a clip plays a new session on to the last target asked for, and the control labels
// follow the story's language unless the host sets one. Stand-in sessions only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StoryPlayer } from "../../src/story/player.js";
import { StorySession } from "../../src/story/session.js";

const fakeSession = (lineCount = 10, line = -1) => ({
  lang: "ja", lineCount, line, started: false, held: [],
  audio: { suspend: async () => {}, resume: async () => {} },
  setVolume() {}, resize() {}, render() {}, play() { this.started = true; }, setPaused(on) { this.held.push(on); },
});

// a StoryPlayer without its DOM: the members _startSession, play, pause and setLanguage read
const bare = () => Object.assign(Object.create(StoryPlayer.prototype), {
  opts: {}, gl: null, store: {}, _lang: "ja", _auto: false, _speed: 10, _volumes: { Bgm: 1 }, _paused: false,
  disposed: false, controls: null, session: null, _audioContext: null, _manifest: {}, _abort: new AbortController(),
  _pixelSize: () => [130, 60], _emit() {}, _loadStore: async () => ({}), _replace: async (fn) => fn(),
});

const withSessions = async (sessions, fn) => {
  const create = StorySession.create, opts = [];
  StorySession.create = async (gl, store, o) => { opts.push(o); return sessions.shift(); };
  try { await fn(opts); } finally { StorySession.create = create; }
};

test("the player's pause holds the session's videos; its play lets them go on", () => {
  const p = bare(), s = fakeSession();
  p.session = s;
  p.play();
  assert.deepEqual(s.held, []);                                          // not paused: nothing to let go
  p.pause();
  p.pause();
  assert.deepEqual([p.paused, s.held], [true, [true]]);
  p.play();
  assert.deepEqual([p.paused, s.held], [false, [true, false]]);
});

test("a seek before the first play, then a language: the new language starts at the seek's line", () => withSessions(
  [fakeSession(10, 4), fakeSession(10, 4), fakeSession(10, 4), fakeSession(10, 9)], async (opts) => {
    const p = bare();
    p._paused = true;
    await p._startSession(5, false);                                     // the session reports line 4 until line 5 shows
    assert.deepEqual([opts[0].line, p._startLine, p.line, p.session.held], [5, 5, 4, [true]]);   // held while paused
    await p.setLanguage("en");
    assert.equal(opts[1].line, 5);
    p.session.line = 7;                                                  // played on: the current line
    await p.setLanguage("ko");
    assert.equal(opts[2].line, 7);
    await p._startSession(99, false);
    assert.equal(p._startLine, 9);                                        // the session's clamp
  }));

test("a seek within a clip: a session at the clip's row played on to the target; later seeks move it, one back starts over", () => {
  const clipAt = { kind: "clip", time: 10, duration: 100, row: 7, seekable: true };
  const runs = [];
  // the sessions of the seek: the first sees the target move back while it runs, the second reaches it
  const ffSession = (moveBack) => Object.assign(fakeSession(), {
    video: null,
    async fastForwardClip(target, o) {
      const run = { first: target() };
      runs.push(run);
      await new Promise((r) => setTimeout(r, 0));
      if (moveBack) { p.seekVideo(30); p.seekVideo(20); }
      run.last = target();
      run.paused = o.paused();
      return { time: target(), back: target() < run.first };
    },
  });
  const p = bare();
  return withSessions([ffSession(true), ffSession(false)], async (opts) => {
    p.session = Object.assign(fakeSession(), { started: true, video: clipAt });
    const first = p.seekVideo(40);
    assert.deepEqual(p.video, { kind: "clip", time: 40, duration: 100, row: 7, seekable: true });   // the target shows
    const later = p.seekVideo(60);                                        // a later seek moves the target
    assert.equal(p.video.time, 60);
    assert.deepEqual(await Promise.all([first, later]), [true, true]);
    assert.deepEqual(runs, [{ first: 60, last: 20, paused: false }, { first: 20, last: 20, paused: false }]);
    assert.deepEqual(opts.map((o) => [o.row, o.autoplay]), [[7, false], [7, false]]);
    assert.equal(p.video, null);                                          // done: the session's own position again
  });
});

test("the control labels: the language the story plays in, after a language switch too, unless the host sets one", () => withSessions(
  [Object.assign(fakeSession(), { lang: "zh-Hant" }), fakeSession(), Object.assign(fakeSession(), { lang: "en" })], async () => {
    const langs = [];
    const p = Object.assign(bare(), { controls: { setLanguage: (l) => langs.push(l), update() {}, showStart() {} } });
    p._lang = null; p._manifest = { manifest: { language: "zh-Hant" } };
    p._labels();                                                          // the manifest read: its language
    await p._startSession(0, false);
    await p.setLanguage("ja");                                            // the session's language
    p.setUiLanguage("ko");
    await p.setLanguage("en");                                            // the host's language stays
    p.setUiLanguage(null);
    assert.deepEqual(langs, ["zh-Hant", "zh-Hant", "ja", "ko", "ko", "en"]);
  }));
