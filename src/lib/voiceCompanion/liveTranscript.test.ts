import { expect, test } from "bun:test";
import { LiveTranscript } from "./liveTranscript";

test("each speaker accumulates independently; provider timeline pauses split display messages", () => {
  const transcript = new LiveTranscript();
  const first = transcript.fragment("operator", "Please ", 0, 500);
  const next = transcript.fragment("operator", "review it", 700, 1_000);
  expect(next.at(-1)).toMatchObject({ itemId: first.at(-1)!.itemId, text: "Please review it", final: false });
  transcript.fragment("companion", "Sure", 800, 1_100); // overlap leaves operator open
  expect(transcript.fragment("operator", ".", 1_100, 1_200).at(-1)!.itemId).toBe(first.at(-1)!.itemId);
  const paused = transcript.fragment("operator", "Another thought", 2_700, 3_000);
  expect(paused[0]).toMatchObject({ text: "Please review it.", final: true });
  expect(paused.at(-1)!.itemId).not.toBe(first.at(-1)!.itemId);
});

test("an answer after input and a tool boundary seal only preceding input; late fragments repair their own segment", () => {
  const transcript = new LiveTranscript();
  const item = transcript.fragment("operator", "Ask ", 100, 300).at(-1)!.itemId;
  const answer = transcript.fragment("companion", "Okay", 400, 600);
  expect(answer[0]).toMatchObject({ speaker: "operator", itemId: item, final: true });
  expect(transcript.fragment("operator", "the orchestrator", 300, 350).at(-1)).toMatchObject({ itemId: item, text: "Ask the orchestrator", final: true });
  const newInput = transcript.fragment("operator", "Also", 700, 900).at(-1)!;
  expect(newInput.itemId).not.toBe(item);
  expect(transcript.boundary(800)).toEqual([]); // overlapping speech is still open
  expect(transcript.boundary(1_000)[0]).toMatchObject({ itemId: newInput.itemId, final: true });
});
