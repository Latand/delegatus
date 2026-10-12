import { expect, test } from "bun:test";
import { matchPrototypeAnswer, parsePrototypeAnswer, prototypeCopyLine, prototypeReference } from "./telegramAnswer";
import { telegramRound, telegramTask } from "./telegram.fixture";

test("copy lines round trip recommendations and each variant within the clipboard limit", () => {
  const round = telegramRound();
  round.title = "Довга назва · #proto- title «quoted» ".repeat(8);
  expect(prototypeCopyLine(round).length).toBeLessThanOrEqual(256);
  expect(parsePrototypeAnswer(round, prototypeCopyLine(round))).toMatchObject({ input: { chosen: [], skip: true, comment: "" } });
  for (const variant of round.variants) {
    const text = prototypeCopyLine(round, variant.number);
    expect(text.length).toBeLessThanOrEqual(256);
    expect(parsePrototypeAnswer(round, text)).toMatchObject({ input: { chosen: [variant.number], comment: "",
      answers: round.questions!.map(q => ({ questionId: q.id, options: [0] })) } });
  }
  delete round.questions;
  expect(parsePrototypeAnswer(round, prototypeCopyLine(round, 2))).toMatchObject({ input: { chosen: [2] } });
});

test("edited multiple answers, Other, comments, combinations and escaped Markdown survive relay normalization", () => {
  const round = telegramRound();
  const text = prototypeCopyLine(round, 2).replace("Варіант 2", "Варіанти 1, 2").replace("1a 2a 3a", "1b 2ba 3+");
  expect(parsePrototypeAnswer(round, text)).toHaveProperty("error");
  const escaped = text.replace("#proto-", "\\#proto\\-").replace(/ · /g, "   ·   ").replace("Відповіді", "ВІДПОВІДІ");
  expect(parsePrototypeAnswer(round, `${escaped}\n My other answer.\nKeep this line.`)).toMatchObject({ input: {
    chosen: [1, 2], comment: "My other answer.\nKeep this line.", answers: [
      { questionId: "place", options: [1] }, { questionId: "scope", options: [0, 1] }, { questionId: "timing", options: [], other: true }],
  } });
});

test("missing, duplicate and undeclared choices and unknown fragments refuse a known round", () => {
  const round = telegramRound();
  const line = prototypeCopyLine(round, 2);
  for (const text of [line.replace("1a 2a 3a", "1a 2a"), line.replace("1a 2a 3a", "1a 1b 3a"),
    line.replace("1a 2a 3a", "1ab 2a 3a"), line.replace("1a", "1f"), line.replace("Варіант 2", "Варіант 9"),
    line.replace("Варіант 2", "Варіанти 2, 2"), `${line} · Extra`, `${line} · Відповіді рекомендовані`,
    `${line} · ${prototypeReference(round)}`]) expect(parsePrototypeAnswer(round, text)).toHaveProperty("error");
});

test("only an unambiguous newest local waiting round is recognized", () => {
  const first = telegramRound(), next = telegramRound("next");
  const text = prototypeCopyLine(first, 1);
  expect(matchPrototypeAnswer("ordinary owner request", [telegramTask()])).toBeNull();
  expect(matchPrototypeAnswer(text, [])).toBeNull();
  expect(matchPrototypeAnswer(text, [telegramTask([first, next])])).toBeNull();
  expect(matchPrototypeAnswer(text, [telegramTask([first]), { ...telegramTask([first]), id: "task-other" }])).toBeNull();
  expect(matchPrototypeAnswer(text, [telegramTask([first])])).toHaveProperty("input");
  expect(matchPrototypeAnswer(text, [{ ...telegramTask([first]), machine: "remote-installation" }])).toBeNull();
  const decided = { ...first, decision: { chosen: [1], comment: "", at: first.createdAt,
    delivery: { state: "no-orchestrator" as const, conversationId: null, clientMessageId: "decision", text: "decision" } } };
  expect(matchPrototypeAnswer(text, [telegramTask([decided])])).toBeNull();
  expect(matchPrototypeAnswer(text, [telegramTask([first, { ...next, decision: decided.decision }])])).toBeNull();
});
