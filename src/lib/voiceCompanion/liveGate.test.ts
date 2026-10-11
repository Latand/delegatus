import { expect, test } from "bun:test";
import { liveProposalRefusal, requestText, VOICE_ASK_MAX_CHARS } from "./liveGate";

const said = (text: string, turn: number) => ({ itemId: `said-${turn}`, text, final: true, turn });

test("one short ask is bounded in Unicode scalars, whatever the script: Cyrillic and emoji count once each, surrounding space not at all", () => {
  expect(VOICE_ASK_MAX_CHARS).toBe(400);
  for (const unit of ["a", "ї", "🎙"]) {
    expect(liveProposalRefusal(` ${unit.repeat(VOICE_ASK_MAX_CHARS)} `, [said("ask", 1)])).toBeNull();
    expect(liveProposalRefusal(unit.repeat(VOICE_ASK_MAX_CHARS + 1), [said("ask", 1)])).toBe("invalid_instruction");
  }
  expect(liveProposalRefusal("   ", [said("ask", 1)])).toBe("invalid_instruction");
});

test("a bundle of earlier questions is refused for its length, in English and Ukrainian, and is never sliced into a send", () => {
  const bundles = {
    en: ["What is the state of the voice review?", "Ask again how the review is going and what happened with the deploy.", "Which model should the voice use?"],
    uk: ["Що зараз з ревʼю голосового каналу?", "Спитай ще раз, як там ревʼю, і що з деплоєм.", "Яку модель обрати для голосу?"],
  };
  for (const questions of Object.values(bundles)) {
    for (const question of questions) expect(liveProposalRefusal(question, [said(question, 1)])).toBeNull();
    const bundle = Array.from({ length: 4 }, () => questions.join(" ")).join(" ");
    expect([...bundle].length).toBeGreaterThan(VOICE_ASK_MAX_CHARS);
    expect(liveProposalRefusal(bundle, [said(bundle, 1)])).toBe("invalid_instruction");
  }
});

test("the same words from an earlier turn are a repeat whatever their spacing or closing stop; a model renewal lets the gate pass them on", () => {
  const earlier = [{ turn: 1, instruction: "Що з ревʼю голосу?" }];
  expect(requestText("  Що  з ревʼю голосу… ")).toBe(requestText("Що з ревʼю голосу?"));
  expect(liveProposalRefusal("Що  з ревʼю голосу", [said("Що з ревʼю голосу", 2)], 2, earlier)).toBe("already_requested");
  // Case names the target wherever it stands, the opening word too: Release and release are two requests.
  expect(requestText("Що змінилося у гілці Release?")).not.toBe(requestText("Що змінилося у гілці release?"));
  for (const [upper, lower] of [["What changed on branch Release?", "What changed on branch release?"], ["Release: what changed?", "release: what changed?"], ["Release: що змінилося?", "release: що змінилося?"]]) {
    expect(requestText(upper)).not.toBe(requestText(lower));
    expect(liveProposalRefusal(lower, [said(lower, 2)], 2, [{ turn: 1, instruction: upper }])).toBeNull();
  }
  // Admission still holds a renewed ask while its report is pending; the gate only judges the words.
  expect(liveProposalRefusal("Що з ревʼю голосу", [said("Що з ревʼю голосу", 2)], 2, earlier, true)).toBeNull();
  expect(liveProposalRefusal("Яку модель обрати для голосу?", [said("Яку модель обрати?", 2)], 2, earlier)).toBeNull();
});
