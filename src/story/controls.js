import { storyStrings } from "./strings.js";
import { SimpleStorySession } from "./simple/session.js";

// Control bar of a StoryPlayer, with visible labels in the page's language. The story menu's items with the game's
// semantics (AdvPlayerUIEventHandler): Auto, Fast-forward (×1 -> ×1.5 -> ×1.7 -> ×2 -> ×1; a speed other than ×1 turns
// auto on, turning auto off resets it to ×1), Skip (with its confirmation; the playback and a playing video wait while
// it is open) and the next button (a tap on the story screen, as a click on the story itself); the app's music, sound
// effect and voice volumes (a video's own sound has no volume option in the game). Apart from them, the player's own
// items: play / pause, and the position: the line with its bar (a seek restarts at that line, StoryPlayer.seekToLine)
// and, while a Movie or Clip row plays a video, the video's time with a bar of its own (a movie can be seeked; a clip's
// bar only shows, as the rows under a clip follow its frames). The bars are range inputs (arrow keys, Home / End); they
// rest while the skip confirmation is open. Keyboard (while the player has the focus): Space / Enter next, A auto, F
// fast-forward, K play / pause. Every element lives in the player's shadow root. An Overlay episode (the simple player:
// no auto button, no fast-forward) shows neither Auto nor Fast-forward.

export const STORY_PLAYER_CSS = `
:host { all: initial; visibility: inherit; }   /* hidden with its host element */
.stage { position: absolute; left: 0; top: 0; right: 0; bottom: var(--bar-h, 0px); }
.canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; touch-action: manipulation; }
.status { position: absolute; left: 12px; bottom: 12px; color: #aaa; font: 12px/1.4 system-ui, sans-serif;
          white-space: pre-wrap; pointer-events: none; }
.status[hidden] { display: none; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; min-height: 44px; display: flex; flex-wrap: wrap;
       align-items: center; gap: 6px 10px; padding: 6px 10px calc(6px + env(safe-area-inset-bottom, 0px));
       box-sizing: border-box; background: #111; color: #eee; font: 13px/1.2 system-ui, sans-serif;
       user-select: none; -webkit-user-select: none; }
.btn, .sel { height: 30px; border: 0; border-radius: 6px; background: rgba(255,255,255,.14); color: inherit;
             font: inherit; cursor: pointer; padding: 0 10px; }
.btn:disabled { opacity: .35; cursor: default; }
.btn[aria-pressed="true"] { background: rgba(255,255,255,.34); }
.sel option { color: #000; }
.field { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.vol { width: 72px; accent-color: #fff; }
.pos { font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .8; }
.track { flex: 1 1 200px; display: flex; align-items: center; gap: 10px; min-width: 0; }
.seek { flex: 1 1 0; min-width: 60px; margin: 0; accent-color: #fff; cursor: pointer; }
.seek:disabled { opacity: .35; cursor: default; }
.vid { flex: 1 1 0; min-width: 0; }
.big { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 14px 22px;
       border: 0; border-radius: 10px; background: rgba(0,0,0,.6); color: #fff; font: 16px/1 system-ui, sans-serif;
       cursor: pointer; }
.big[hidden] { display: none; }
[hidden] { display: none !important; }
`;

const speedLabel = (v) => `×${v / 10}`;
const NEXT_SPEED = { 10: 15, 15: 17, 17: 20, 20: 10 };           // AdvPlayerModel.GetNextPlaybackSpeed

// seconds -> m:ss
export const formatStoryTime = (sec) => {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export class StoryControls {
  constructor(player, { lang } = {}) {
    this.player = player;
    const doc = player.root.ownerDocument;
    const t = this.t = storyStrings(lang || (doc.documentElement && doc.documentElement.lang) || "en");
    const el = (tag, cls, props = {}) => { const e = doc.createElement(tag); e.className = cls; Object.assign(e, props); return e; };
    const bar = this.bar = el("div", "bar");
    this.btnPlay = el("button", "btn play", { type: "button", textContent: t.pause });
    this.btnNext = el("button", "btn next", { type: "button", textContent: t.next });
    this.btnAuto = el("button", "btn auto", { type: "button", textContent: t.auto });
    this.btnSpeed = el("button", "btn speed", { type: "button" });
    this.btnSkip = el("button", "btn skip", { type: "button", textContent: t.skip });
    this.confirm = el("span", "field confirm", { hidden: true });
    this.btnSkipYes = el("button", "btn", { type: "button", textContent: t.skip });
    this.btnSkipNo = el("button", "btn", { type: "button", textContent: t.cancel });
    this.confirm.append(el("span", "", { textContent: t.skipConfirm }), this.btnSkipYes, this.btnSkipNo);
    this.pos = el("span", "pos");
    const track = el("span", "track");
    const range = (label) => {
      const r = el("input", "seek", { type: "range", min: "0", max: "0", step: "1", value: "0", disabled: true });
      r.setAttribute("aria-label", label);
      return r;
    };
    this.seek = range(t.position);
    this.vid = el("span", "field vid", { hidden: true });
    this.vidTime = el("span", "pos");
    this.vidSeek = range(t.video);
    this.vidSeek.step = "any";
    this.vid.append(this.vidTime, this.vidSeek);
    track.append(this.seek, this.vid);
    this.vols = {};
    const vols = [];
    for (const [cat, label] of [["Bgm", t.music], ["Se", t.effects], ["Voice", t.voice]]) {
      const f = el("label", "field", { textContent: label });
      const r = el("input", "vol", { type: "range", min: "0", max: "1", step: "0.05", value: "1" });
      f.append(r); vols.push(f); this.vols[cat] = r;
    }
    bar.append(this.btnNext, this.btnAuto, this.btnSpeed, this.btnSkip, this.confirm, track, this.btnPlay, this.pos, ...vols);
    this.big = el("button", "big", { type: "button", textContent: t.start, hidden: true });
    player.shadow.append(bar, this.big);

    const on = (target, type, fn) => { target.addEventListener(type, fn); this._off.push(() => target.removeEventListener(type, fn)); };
    this._off = [];
    this._drag = null;                  // the bar held by the pointer: the playback does not move its thumb
    this._want = null;                  // the line of a seek not yet started
    this._goal = null;                  // {line, session}: the last seek's line, shown until its session reaches it
    this._seeking = null;
    this._lineCount = 0;
    this._session = null;
    const focus = () => player.root.focus({ preventScroll: true });
    on(this.btnPlay, "click", () => { focus(); if (player.paused) player.play(); else player.pause(); });
    on(this.btnNext, "click", () => { focus(); player.next(); });
    on(this.btnAuto, "click", () => { focus(); player.setAuto(!player.auto); });
    on(this.btnSpeed, "click", () => { focus(); player.setSpeed(NEXT_SPEED[player.speed]); });
    // OnSkipButtonTapped: the confirmation dialog pauses the playback (AdvPlayer.OnOpenDialog -> Model.SetPause) and
    // a playing video (TryPauseCurrentVideo)
    on(this.btnSkip, "click", () => { focus(); this._confirm(true); });
    on(this.btnSkipYes, "click", () => { focus(); this._confirm(false, false); player.skip(); });
    on(this.btnSkipNo, "click", () => { focus(); this._confirm(false); });
    for (const [cat, r] of Object.entries(this.vols)) on(r, "input", () => player.setVolume(cat, Number(r.value)));
    // a bar's value applies on change (the pointer released, a key) and shows while it is dragged
    for (const r of [this.seek, this.vidSeek]) {
      on(r, "pointerdown", () => { this._drag = r; });
      for (const type of ["pointerup", "pointercancel"]) on(r, type, () => { if (this._drag === r) this._drag = null; });
    }
    on(this.seek, "input", () => this._showLine(Number(this.seek.value)));
    on(this.seek, "change", () => { this._drag = null; this.seekLine(Number(this.seek.value)); });
    on(this.vidSeek, "input", () => this._showVideo(Number(this.vidSeek.value), Number(this.vidSeek.max)));
    on(this.vidSeek, "change", () => { this._drag = null; this.seekVideo(Number(this.vidSeek.value)); });
    on(this.big, "click", () => { this.big.hidden = true; focus(); player.play(); });
    on(player.canvas, "pointerdown", (e) => { if (e.button === 0) player.next(); });
    on(player.root, "keydown", (e) => {
      if (e.target !== player.root || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); player.next(); }
      else if ((e.key === "a" || e.key === "A") && !this._simple()) player.setAuto(!player.auto);
      else if ((e.key === "f" || e.key === "F") && !this._simple()) player.setSpeed(NEXT_SPEED[player.speed]);
      else if (e.key === "k" || e.key === "K") { if (player.paused) player.play(); else player.pause(); }
    });
    const ro = new (doc.defaultView.ResizeObserver || class { observe() {} disconnect() {} })(() => this._barHeight());
    ro.observe(bar);
    this._off.push(() => ro.disconnect());
    this._barHeight();
    this.update();
  }

  // resume false: the skip was confirmed, the video paused for the confirmation stays so until the stop
  _confirm(open, resume = true) {
    this.confirm.hidden = !open;
    this.btnSkip.hidden = open;
    this._pauseForConfirm(resume);
    this.update();
  }

  // the open confirmation holds the playback and pauses a playing video (StorySession.setDialogOpen), also in a
  // session a seek started meanwhile
  _pauseForConfirm(resume = true) {
    const s = this.player.session;
    if (s && typeof s.setDialogOpen === "function") s.setDialogOpen(!this.confirm.hidden, resume);
  }

  _barHeight() { this.player.root.style.setProperty("--bar-h", `${this.bar.offsetHeight || 44}px`); }

  _simple() { return this.player.session instanceof SimpleStorySession; }

  // shows "click to start" until the first play (audio needs a user gesture)
  showStart(on) { this.big.hidden = !on; }

  // restarts at line i (StoryPlayer.seekToLine: playing or not as before); a seek asked for while one runs replaces
  // the one waiting after it
  seekLine(i) {
    this._want = i;
    if (!this._seeking) this._seeking = Promise.resolve().then(() => this._runSeeks());
    this.update();
    return this._seeking;
  }

  async _runSeeks() {
    const p = this.player;
    try {
      while (this._want !== null) {
        const line = this._want;
        this._want = null;
        this._goal = { line, session: undefined };
        try { await p.seekToLine(line); } catch (_) { this._goal = null; break; }   // reported by the player
        this._goal = { line, session: p.session };
      }
    } finally { this._want = null; this._seeking = null; this.update(); }
  }

  // moves the playing movie to `sec` seconds (StoryPlayer.seekVideo)
  seekVideo(sec) {
    const p = this.player;
    if (!p.session) return Promise.resolve(false);
    return p.seekVideo(sec).catch(() => false).then((ok) => { this.tick(); return ok; });
  }

  // the line the bar shows: a seek's line from the request until its session shows that line
  _line() {
    const p = this.player, g = this._goal;
    if (this._want !== null) return this._want;
    if (g && (g.session === undefined || (g.session === p.session && !p.ended && p.line < g.line))) return g.line;
    return Math.max(0, p.line);
  }

  _showLine(i) {
    const t = this.t, n = this._lineCount, text = n ? `${t.line} ${i + 1} / ${n}` : "";
    this.pos.textContent = this.player.ended && this._drag !== this.seek ? t.ended : text;
    this.seek.setAttribute("aria-valuetext", text);
  }

  _showVideo(time, duration) {
    const text = `${formatStoryTime(time)} / ${formatStoryTime(duration)}`;
    if (this.vidTime.textContent !== text) { this.vidTime.textContent = text; this.vidSeek.setAttribute("aria-valuetext", text); }
  }

  update() {
    const p = this.player, t = this.t;
    if (p.session !== this._session) { this._session = p.session; if (!this.confirm.hidden) this._pauseForConfirm(); }
    this.btnPlay.textContent = p.paused ? t.play : t.pause;
    this.btnAuto.setAttribute("aria-pressed", String(!!p.auto));
    this.btnSpeed.textContent = `${t.speed} ${speedLabel(p.speed)}`;
    this.btnSpeed.setAttribute("aria-pressed", String(p.speed !== 10));
    const live = !!p.session && !p.ended;
    for (const b of [this.btnNext, this.btnAuto, this.btnSpeed, this.btnSkip]) b.disabled = !live;
    this.btnAuto.hidden = this.btnSpeed.hidden = this._simple();
    // the line bar; the story's line count stays while a seek replaces the session
    const n = this._lineCount = p.lineCount || (this._seeking ? this._lineCount : 0), last = Math.max(0, n - 1);
    this.seek.max = String(last);
    this.seek.disabled = n < 2 || !this.confirm.hidden || (!p.session && !this._seeking);
    if (this._drag !== this.seek) { const i = Math.min(this._line(), last); this.seek.value = String(i); this._showLine(i); }
    this.tick();
  }

  // the video bar: once per drawn frame while the story plays (StoryPlayer's frame loop), and at every update
  tick() {
    const v = this.player.video;
    if (this.vid.hidden !== !v) {
      // a focused video bar that hides hands the focus back to the player (its keys)
      if (!v && this.player.shadow.activeElement === this.vidSeek) this.player.root.focus({ preventScroll: true });
      this.vid.hidden = !v;
    }
    if (!v) { if (this._drag === this.vidSeek) this._drag = null; return; }
    const off = !v.seekable || !this.confirm.hidden;
    if (this.vidSeek.disabled !== off) this.vidSeek.disabled = off;
    if (this._drag === this.vidSeek) return;
    if (this.vidSeek.max !== String(v.duration)) this.vidSeek.max = String(v.duration);
    this.vidSeek.value = String(v.time);
    this._showVideo(v.time, v.duration);
  }

  dispose() { for (const f of this._off) f(); this.bar.remove(); this.big.remove(); }
}
