import { expect, test } from "bun:test";

import type { FeedEntry } from "./parse";
import { createSpeakableAnswerResolver, speakableAnswer } from "./speakableAnswer";

test("combines the contiguous prose fragments of one assistant answer", () => {
  const entries: FeedEntry[] = [
    { anchorKey: null, key: "a", item: { kind: "prose", ts: "same", engine: "codex", text: "First." } },
    { anchorKey: null, key: "b", item: { kind: "prose", ts: "same", engine: "codex", text: "Second." } },
    { anchorKey: null, key: "c", item: { kind: "raw", text: "tool", err: false } },
    { anchorKey: null, key: "d", item: { kind: "prose", ts: "same", engine: "codex", text: "Later." } },
  ];
  expect(speakableAnswer(entries, 1)).toEqual({ text: "First.\n\nSecond.", firstIndex: 0, lastIndex: 1 });
  expect(speakableAnswer(entries, 3)?.text).toBe("Later.");
});


test("one redacted result serves every fragment; new content and identity get independent projections", () => {
  const entries: FeedEntry[] = Array.from({ length: 1000 }, (_, n) => ({ anchorKey: null, key: String(n), item: { kind: "prose", ts: "one-answer", engine: "claude", text: `Fragment ${n}.` } }));
  const resolve = createSpeakableAnswerResolver(entries);
  const expected = speakableAnswer(entries, 500);
  expect(resolve(500)).toEqual(expected);
  expect(resolve(999)).toBe(resolve(0));
  const changed = [...entries.slice(0, -1), { ...entries[999]!, item: { kind: "prose" as const, ts: "one-answer", engine: "claude" as const, text: "Updated stream output." } }];
  expect(createSpeakableAnswerResolver(changed)(999)?.text).toEndWith("Updated stream output.");
  const other = [{ ...entries[0]!, item: { kind: "prose" as const, ts: "one-answer", engine: "codex" as const, text: "Other conversation." } }];
  expect(createSpeakableAnswerResolver(other)(0)?.text).toBe("Other conversation.");
  expect(resolve(0)?.text).toBe(expected?.text);
});

test("visible selection groups later fragments, favors visible area and freezes text", async () => {
  const { visibleSpeakableAnswer } = await import("./speakableAnswer");
  const entries: FeedEntry[] = [
    { anchorKey: null, key: "a", item: { kind: "prose", ts: "old", engine: "codex", text: "Old first fragment." } },
    { anchorKey: null, key: "b", item: { kind: "prose", ts: "old", engine: "codex", text: "Visible fragment." } },
    { anchorKey: null, key: "c", item: { kind: "prose", ts: "new", engine: "codex", text: "New answer." } },
    { anchorKey: null, key: "d", item: { kind: "prose", ts: "code", engine: "codex", text: "```js\n42\n```" } },
  ];
  const selected = visibleSpeakableAnswer(entries, [{ index: 1, area: 100 }, { index: 2, area: 0 }]);
  expect(selected?.text).toBe("Old first fragment.\n\nVisible fragment.");
  expect(visibleSpeakableAnswer(entries, [{ index: 1, area: 10 }, { index: 2, area: 10 }])?.text).toBe("New answer.");
  expect(visibleSpeakableAnswer(entries, [{ index: 0, area: 6 }, { index: 1, area: 6 }, { index: 2, area: 10 }])?.id).toBe("codex:old:a");
  expect(visibleSpeakableAnswer(entries, [{ index: 3, area: 100 }])).toBeNull();
  entries[1]!.item = { kind: "prose", ts: "old", engine: "codex", text: "Growing answer." };
  expect(selected?.text).toEndWith("Visible fragment.");
});

test("fragment offsets distinguish repeated prose in the loaded answer", async () => {
  const { answerFragmentOffset } = await import("./speakableAnswer");
  const entries: FeedEntry[] = [0, 1, 2].map((index) => ({ anchorKey: null, key: String(index), item: { kind: "prose", ts: "same", engine: "codex", text: index === 1 ? "```js\n42\n```" : "The repeated sentence." } }));
  const answer = speakableAnswer(entries, 2)!;
  expect(answerFragmentOffset(entries, 0, answer)).toBe(0);
  expect(answerFragmentOffset(entries, 1, answer)).toBeUndefined();
  expect(answerFragmentOffset(entries, 2, answer)).toBeGreaterThan(0);
});

test("a tool boundary gives timestamp-sharing answers distinct identities", async () => {
  const { visibleSpeakableAnswer } = await import("./speakableAnswer");
  const entries: FeedEntry[] = [
    { anchorKey: null, key: "before", item: { kind: "prose", ts: "same", engine: "codex", text: "Before the tool." } },
    { anchorKey: null, key: "tool", item: { kind: "raw", text: "tool", err: false } },
    { anchorKey: null, key: "after", item: { kind: "prose", ts: "same", engine: "codex", text: "After the tool." } },
  ];
  expect(visibleSpeakableAnswer(entries, [{ index: 0, area: 1 }])!.id).not.toBe(visibleSpeakableAnswer(entries, [{ index: 2, area: 1 }])!.id);
});
