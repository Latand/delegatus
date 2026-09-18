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
