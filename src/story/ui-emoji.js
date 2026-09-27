import { UIError } from "../engine/ugui.js";

// Kyub.EmojiSearch TMP_EmojiSearchEngine.ParseEmojiCharSequence: the emoji sequences of a text (several code points
// that one sprite of a sprite asset stands for) -> <sprite name="..."> tags. `sa` = a sprite asset record
// (engine/uitext.js) with `sequences`: [{name, unicode}], the entries of the asset's sprite list (spriteInfoList, in
// order) whose name holds a '-'.

// TryUpdateSequenceLookupTable (once per asset): per entry, BuildNameInEmojiSurrogateFormat(name) (lower case, each
// '-'-separated part left-padded with '0' to 8 digits) unless it equals unicode.ToString("X8") (ignoring case); each
// 8-digit chunk that is a code point in 1..U+10FFFE outside the surrogates appends its UTF-16 units, any other chunk
// its 4-digit halves as units (StringHexToInt, a non-hex digit counts 15); every prefix after a unit goes into the
// fast lookup set, the whole string maps to the name (the first entry wins).
const tables = new WeakMap();
const hexValue = (s) => {
  let v = 0;
  for (const ch of s) {
    const d = parseInt(ch, 16);
    v = v * 16 + (Number.isNaN(d) ? 15 : d);
  }
  return v;
};
const surrogateFormat = (name) => {
  const n = name.toLowerCase();
  return n.includes("-") ? n.split("-").map((p) => p.padStart(8, "0")).join("") : n;
};
export const emojiSequenceTable = (sa) => {
  let t = tables.get(sa);
  if (t) return t;
  if (!Array.isArray(sa.sequences)) throw new UIError(`${sa.name}: sprite asset without its sequence list`);
  const table = new Map(), fast = new Set();
  for (const s of sa.sequences) {
    if (!s.name || !s.name.includes("-")) continue;
    const key8 = surrogateFormat(s.name), hex = s.unicode.toString(16).toUpperCase().padStart(8, "0");
    if (!key8 || key8.toUpperCase() === hex) continue;
    let sb = "";
    for (let k = 0; k < key8.length; k += 8) {
      const chunk = key8.slice(k, k + 8), v = hexValue(chunk);
      if (v >= 1 && v <= 0x10FFFE && !(v >= 0xD800 && v <= 0xDFFF)) {
        for (const unit of String.fromCodePoint(v).split("")) { sb += unit; fast.add(sb); }
      } else {
        for (let q = 0; q < chunk.length; q += 4) { sb += String.fromCharCode(hexValue(chunk.slice(q, q + 4))); fast.add(sb); }
      }
    }
    if (sb && !table.has(sb)) table.set(sb, s.name);
  }
  t = { table, fast };
  tables.set(sa, t);
  return t;
};

// ParseEmojiCharSequence(sa, ref text): with no asset or an empty table the text as it is. From each position the
// longest run of UTF-16 units whose every prefix is in the fast set (one unit per step, no backtracking); a run that
// is a whole sequence becomes <sprite name="NAME"> and is consumed, else the unit at the position is copied and the
// scan goes on at the next one. The escapes \U######## and \u#### are not implemented (raise).
export const parseEmojiCharSequence = (sa, text) => {
  if (!sa || !text) return text;
  const { table, fast } = emojiSequenceTable(sa);
  if (!table.size) return text;
  let out = "", changed = false;
  for (let i = 0; i < text.length; i++) {
    let seq = "", j = i;
    for (;;) {
      if (j >= text.length) break;
      if (j !== i && !fast.has(seq)) break;
      if (text[j] === "\\" && (text[j + 1] === "U" || text[j + 1] === "u"))
        throw new UIError("escaped code points in an emoji text not implemented");
      seq += text[j];
      j++;
    }
    if (seq.length > 0 && !fast.has(seq)) { seq = seq.slice(0, -1); j--; }
    if (seq.length >= 1 && table.has(seq)) {
      out += `<sprite name="${table.get(seq)}">`;
      if (j > i + 1) i = j - 1;
      changed = true;
    } else out += text[i];
  }
  return changed ? out : text;
};

// characters TmpTextHelper.HasSequenceCharacter looks for: VS15, VS16, ZWJ
const EMOJI_SEQUENCE = /[︎️‍]/;

// Fwk.UI.TmpTextHelper.CombineEmojiSequences(text component, text): a rich text with a VS15 / VS16 / ZWJ goes through
// ParseEmojiCharSequence with the component's sprite asset, else the emoji sprite asset of LocalizeManager; any other
// text is returned as it is. `t` = the TMPText, `emoji` = LocalizeManager's emoji sprite asset (tmpSpriteAsset) or null.
export const combineEmojiSequences = (t, text, emoji = null) => {
  if (!t.richText || !EMOJI_SEQUENCE.test(text)) return text;
  return parseEmojiCharSequence(t.spriteAsset || emoji, text);
};
