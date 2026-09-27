// AnimRecords: controllers and clips written once per data file resolve across prefabs; animRecordProblems lists the
// references that do not resolve (the data validator's check). Synthetic inputs only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnimRecords, animRecordProblems } from "../../src/story/features/clips.js";

const FLT_MIN = -3.4028234663852886e+38;
const clip = (name, to) => ({ clip: name, sampleRate: 60, wrapMode: 0, startTime: 0, stopTime: 1, loopTime: false, cycleOffset: 0,
  events: [], bindings: [{ path: "", typeID: 225, class: "CanvasGroup", attribute: "m_Alpha" }],
  streamed: { curveCount: 1, frames: [[FLT_MIN, [[0, 0, 0, 0, 0]]], [0, [[0, 0, 0, to, 0]]], [1, [[0, 0, 0, 0, to]]]] },
  dense: { curveCount: 0 }, constant: [] });
const ctrl = (name, clips) => ({ controller: name, name, parameters: [], defaultValues: [],
  layers: [{ name: "Base Layer", stateMachine: 0 }],
  clips, stateMachines: [{ defaultState: 0, anyStateTransitions: [], states: clips.map((c, i) => ({
    name: `s${i}`, speed: 1, cycleOffset: 0, loop: false, writeDefaultValues: true, mirror: false, speedParam: "", timeParam: "",
    blendTrees: [[{ clip: i, children: [] }]], transitions: [] })) }] });

test("AnimRecords: a controller or clip reference resolves to the file's full record; ambiguous names raise", () => {
  const doc = { frames: {
    a: { nodes: [{ components: [{ type: "Animator", m_Controller: ctrl("c", [clip("in", 1), { clip: "in" }]) }] }] },
    b: { nodes: [{ components: [{ type: "Animator", m_Controller: { controller: "c" } }] }] },
    d: { nodes: [{ components: [{ type: "Animator", m_Controller: ctrl("d", [{ clip: "in" }]) }] }] },
  } };
  const r = new AnimRecords(doc);
  const full = doc.frames.a.nodes[0].components[0].m_Controller;
  assert.equal(r.controller({ controller: "c" }, "b"), full);
  assert.equal(r.controller(null, "x"), null);
  assert.throws(() => r.controller({ object: "AnimatorOverrideController" }, "x"), /not exported/);
  assert.throws(() => r.controller({ controller: "nope" }, "x"), /controller nope not in the data/);
  const c = r.controllerOf(full, "a");
  assert.equal(c.states[0].clip, c.states[1].clip);                       // the repeated clip is one clip
  const d = r.controllerOf(doc.frames.d.nodes[0].components[0].m_Controller, "d");
  assert.equal(d.states[0].clip.length, 1);                               // a clip of another prefab's controller
  const two = new AnimRecords({ x: [clip("in", 1), clip("in", 2)] });
  assert.throws(() => two.controllerOf(ctrl("e", [{ clip: "in" }]), "e"), /two different clips named in/);
});

test("animRecordProblems: references without a full record, or with two different ones, in the file", () => {
  const animator = (c) => ({ nodes: [{ components: [{ type: "Animator", m_Controller: c }] }] });
  // a letterbox-like file: the second frame names the first one's controller; a later controller reuses its clip
  const ok = { frames: { black: animator(ctrl("lb", [clip("in", 1), { clip: "in" }])), white: animator({ controller: "lb" }),
                         other: animator(ctrl("o", [{ clip: "in" }])), none: animator(null) } };
  assert.deepEqual(animRecordProblems(ok), []);
  // the controller only as a reference (its full record left out of the file), a clip reference without its clip
  assert.deepEqual(animRecordProblems({ frames: { white: animator({ controller: "lb" }), o: animator(ctrl("o", [{ clip: "gone" }])) } }),
                   ["controller lb: referenced, not in the file", "clip gone: referenced, not in the file"]);
  // two different full clips under one name: a reference through the file is ambiguous; a controller's own full clip
  // resolves its own reference first
  const two = { a: animator(ctrl("a", [clip("in", 1), { clip: "in" }])), b: animator(ctrl("b", [clip("in", 2)])),
                c: animator(ctrl("c", [{ clip: "in" }])) };
  assert.deepEqual(animRecordProblems(two), ["clip in: referenced, two different full records in the file"]);
  assert.deepEqual(animRecordProblems({ a: animator(ctrl("a", [clip("in", 1), clip("in", 2)])) }),
                   ["controller a: two different clips named in"]);
});
