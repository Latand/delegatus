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

test("a credential is masked across the whole stream of segments, and an earlier segment is published again once it is recognised", () => {
  const key = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-"); // synthetic, built from parts
  const transcript = new LiveTranscript([key]);
  const shown: Array<{ itemId: string; text: string }> = [];
  for (const [at, piece] of key.match(/.{1,5}/g)!.entries()) shown.push(...transcript.fragment("companion", piece, at * 2_000, at * 2_000 + 100));
  const latest = new Map(shown.map(row => [row.itemId, row.text]));
  expect([...latest.values()].join("")).not.toContain("AbCdE");
  expect([...latest.values()].every(text => text === "[redacted]")).toBe(true);
  expect(transcript.record().map(row => row.text.replaceAll("[redacted]", "")).join("")).toBe("");
});

test("operator speech between two companion answers or delegations is one turn", () => {
  const transcript = new LiveTranscript();
  const first = transcript.fragment("operator", "Ask the orchestrator", 0, 400).at(-1)!.itemId;
  transcript.fragment("companion", "Mm-hm.", 2_000, 2_300);
  const second = transcript.fragment("operator", "to review the plan.", 2_600, 3_000).at(-1)!.itemId;
  const third = transcript.fragment("operator", "Also the tests.", 5_000, 5_400).at(-1)!.itemId;
  expect([transcript.turnOf(first), transcript.turnOf(second), transcript.turnOf(third)]).toEqual([1, 2, 2]);
  transcript.boundary(6_000);
  expect(transcript.turnOf(transcript.fragment("operator", "Thanks.", 7_000, 7_200).at(-1)!.itemId)).toBe(3);
});

test("a credential said in pieces with a space, a tab or a line break before each stays masked, and its beginning never shows again", () => {
  const key = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-"); // synthetic, built from parts
  for (const speaker of ["operator", "companion"] as const) for (const gap of [" ", "\t", "\n", " \r\n ", "\u00a0", "\u200b"]) {
    const transcript = new LiveTranscript([key]);
    const shown: Array<{ itemId: string; text: string }> = [];
    for (const [at, piece] of key.match(/.{1,10}/g)!.entries()) shown.push(...transcript.fragment(speaker, (at ? gap : "") + piece, at * 2_300, at * 2_300 + 400));
    shown.push(...transcript.finish());
    const latest = new Map(shown.map(row => [row.itemId, row.text]));
    const put = (texts: string[]) => texts.join("").replace(/\s|\u200b/gu, "");
    expect(put([...latest.values()]), JSON.stringify(gap)).not.toContain(key.slice(3, 13));
    expect(put(shown.map(row => row.text)), JSON.stringify(gap)).not.toContain(key.slice(0, 10));
    expect(put(transcript.record().map(row => row.text)).replaceAll("[redacted]", ""), JSON.stringify(gap)).toBe("");
  }
  // Ordinary words keep their spaces.
  const plain = new LiveTranscript([key]);
  expect(plain.fragment("operator", "Ask the orchestrator to review the plan", 0, 400).at(-1)!.text).toBe("Ask the orchestrator to review the plan");
});
