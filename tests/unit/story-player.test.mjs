// StoryPlayer's handling of its session without a page: the player's pause holds the session's videos with the frames,
// a session started while paused starts held, and a language switch after a seek before the first play restarts at
// the seek's line. Stand-in sessions only.
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
