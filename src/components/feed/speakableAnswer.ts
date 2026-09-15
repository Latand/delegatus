import { spokenAnswerText } from "@/lib/tts";

import type { FeedEntry } from "./parse";

function sameAnswer(a: FeedEntry["item"], b: FeedEntry["item"]): boolean {
  return a.kind === "prose" && b.kind === "prose" && a.engine === b.engine && String(a.ts) === String(b.ts);
}

function answerProjection(entries: FeedEntry[], index: number): { text: string; firstIndex: number; lastIndex: number } | null {
  const selected = entries[index]?.item;
  if (selected?.kind !== "prose") return null;
  let firstIndex = index;
  let lastIndex = index;
  while (firstIndex > 0 && sameAnswer(entries[firstIndex - 1]!.item, selected)) firstIndex -= 1;
  while (lastIndex + 1 < entries.length && sameAnswer(entries[lastIndex + 1]!.item, selected)) lastIndex += 1;
  const text = spokenAnswerText(
    entries.slice(firstIndex, lastIndex + 1).map((entry) => entry.item.kind === "prose" ? entry.item.text : "").join("\n\n"),
  );
  return { text, firstIndex, lastIndex };
}


export function speakableAnswer(entries: FeedEntry[], index: number): ReturnType<typeof answerProjection> {
  const answer = answerProjection(entries, index);
  return answer?.text ? answer : null;
}


/** Lazy, feed-local answer projection. Each contiguous answer is selected and
 * redacted once per immutable feed revision, including fragments outside the
 * visible window. Cache size is bounded by that window's retained entries;
 * neither raw text nor answers are shared between conversations/accounts. */
export function createSpeakableAnswerResolver(entries: FeedEntry[]): (index: number) => ReturnType<typeof speakableAnswer> {
  const answers = new Map<number, ReturnType<typeof speakableAnswer>>();
  return (index) => {
    if (answers.has(index)) return answers.get(index)!;
    const answer = answerProjection(entries, index);
    if (!answer) {
      answers.set(index, null);
      return null;
    }
    const result = answer.text ? answer : null;
    for (let i = answer.firstIndex; i <= answer.lastIndex; i++) answers.set(i, result);
    return result;
  };
}
