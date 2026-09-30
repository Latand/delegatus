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

/** Largest visible prose area wins; ties favor the later loaded answer. */
export function visibleSpeakableAnswer(entries: FeedEntry[], visible: readonly { index: number; area: number }[], resolve = createSpeakableAnswerResolver(entries)): (NonNullable<ReturnType<typeof speakableAnswer>> & { id: string }) | null {
  const candidates = new Map<number, { answer: NonNullable<ReturnType<typeof speakableAnswer>>; area: number }>();
  for (const fragment of visible) {
    if (!(fragment.area > 0)) continue;
    const answer = resolve(fragment.index);
    if (!answer) continue;
    const previous = candidates.get(answer.firstIndex);
    candidates.set(answer.firstIndex, { answer, area: (previous?.area ?? 0) + fragment.area });
  }
  const selected = [...candidates.values()].sort((a, b) => b.area - a.area || b.answer.firstIndex - a.answer.firstIndex)[0];
  if (!selected) return null;
  const item = entries[selected.answer.firstIndex]!.item;
  return item.kind === "prose" ? { ...selected.answer, id: `${item.engine}:${item.ts}:${entries[selected.answer.firstIndex]!.key}` } : null;
}

const fragmentOffsets = new WeakMap<object, Map<number, number>>();
/** Offsets come from the frozen sanitized answer, including earlier fragments
 * outside the rendered window. Unmatched markup fragments remain unmapped. */
export function answerFragmentOffset(entries: FeedEntry[], index: number, answer: NonNullable<ReturnType<typeof speakableAnswer>>): number | undefined {
  let offsets = fragmentOffsets.get(answer);
  if (!offsets) {
    offsets = new Map(); let cursor = 0;
    for (let at = answer.firstIndex; at <= answer.lastIndex; at++) {
      const item = entries[at]!.item;
      const fragment = item.kind === "prose" ? spokenAnswerText(item.text) : "";
      if (!fragment) continue;
      const start = answer.text.indexOf(fragment, cursor);
      if (start < 0) continue;
      offsets.set(at, start); cursor = start + fragment.length;
    }
    fragmentOffsets.set(answer, offsets);
  }
  return offsets.get(index);
}
