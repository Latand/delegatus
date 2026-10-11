import { expect, test } from "bun:test";
import { CodexVoiceTranscript } from "./codexTranscript";
import { LiveTranscript } from "./liveTranscript";

// Transcript shapes and interleaving recorded with Codex 0.162.1. Identifiers
// and words are fixture data; timestamps are notification receipt offsets.
const recorded = [
  [100, "delta", "user", " Send"],
  [120, "delta", "user", " the request."],
  [130, "delta", "assistant", " Okay."],
  [160, "done", "user", " Send the request."],
  [200, "done", "assistant", " Okay."],
  [300, "delta", "user", " Another request."],
  [350, "done", "user", " Another request."],
] as const;

test("recorded deltas and done seal the same segments and turns, without appending full text twice", () => {
  const adapter = new CodexVoiceTranscript();
  const actual = new LiveTranscript();
  const reference = new LiveTranscript();
  for (const [at, kind, role, text] of recorded) {
    for (const event of adapter.notification(`thread/realtime/transcript/${kind}`, { role, [kind === "delta" ? "delta" : "text"]: text }, at)) {
      const speaker = event.type.startsWith("session.input_") ? "operator" : "companion";
      if (event.type.endsWith("delta")) actual.fragment(speaker, event.delta as string, event.start_ms as number, event.end_ms as number);
      else actual.seal(speaker, event.offset_ms as number);
    }
    if (kind === "delta") reference.fragment(role === "user" ? "operator" : "companion", text, at, at);
    else reference.seal(role === "user" ? "operator" : "companion", at);
  }
  expect(actual.record()).toEqual(reference.record());
  expect(actual.record().filter(row => row.speaker === "operator").map(row => row.text)).toEqual([" Send the request.", " Another request."]);
  expect(actual.latestTurn()).toBe(2);
  expect(actual.turnOf("live-operator-1")).toBe(1);
  expect(actual.turnOf("live-operator-3")).toBe(2);
  expect(actual.timingsOf("live-operator-1")).toEqual([[100, 100], [120, 120]]);
  expect(actual.finish()).toEqual([]);
});

test("a done notification separates parts even when a stdio batch shares one receipt millisecond", () => {
  const adapter = new CodexVoiceTranscript();
  const transcript = new LiveTranscript();
  for (const [method, params] of [
    ["delta", { role: "user", delta: "First part." }],
    ["done", { role: "user", text: "First part." }],
    ["delta", { role: "user", delta: "Second part." }],
    ["done", { role: "user", text: "Second part." }],
  ] as const) for (const event of adapter.notification(`thread/realtime/transcript/${method}`, params, 100)) {
    if (event.type.endsWith("delta")) transcript.fragment("operator", event.delta as string, event.start_ms as number, event.end_ms as number);
    else transcript.seal("operator", event.offset_ms as number);
  }
  expect(transcript.record()).toEqual([{ speaker: "operator", text: "First part." }, { speaker: "operator", text: "Second part." }]);
  expect(transcript.latestTurn()).toBe(1);
});
