import { expect, test } from "bun:test";
import { matchPrototypeAnswer, parsePrototypeAnswer, prototypeCopyLine, prototypeReference } from "./telegramAnswer";
import { ownerTelegramReply, telegramRound, telegramTask } from "./telegram.fixture";
import { normalizePrototypeAnswers } from "./questions";

test("the owner's recommended answer keeps the reservation verbatim", () => {
  const round = telegramRound();
  round.id = "pr_20fbd832000000000000000000000000";
  const text = ownerTelegramReply;
  const match = parsePrototypeAnswer(round, text);
  expect(match).toHaveProperty("input");
  expect(match.input).toMatchObject({ chosen: [], originalReply: text,
    comment: ", але по тому що показувати в кадрі- є питання. нам ж треба реальний інтерфейс телеги",
    recommendedWithReservation: true,
    answers: round.questions!.map(q => ({ questionId: q.id, options: [0] })) });
  expect(match.input?.skip).toBeUndefined();
});

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
  expect(parsePrototypeAnswer(round, text)).toHaveProperty("input");
  const escaped = text.replace("#proto-", "\\#proto\\-").replace(/ · /g, "   ·   ").replace("Відповіді", "ВІДПОВІДІ");
  expect(parsePrototypeAnswer(round, `${escaped}\n My other answer.\nKeep this line.`)).toMatchObject({ input: {
    chosen: [1, 2], comment: "My other answer.\nKeep this line.", answers: [
      { questionId: "place", options: [1] }, { questionId: "scope", options: [0, 1] }, { questionId: "timing", options: [], other: true }],
  } });
});

test("known rounds accept partial choices and free comments while conflicting shorthand asks back", () => {
  const round = telegramRound();
  const line = prototypeCopyLine(round, 2);
  for (const text of [line.replace("1a 2a 3a", "1a 2a"), line.replace("Варіант 2", "Варіант 9"),
    line.replace("Варіант 2", "Варіанти 2, 2"), `${line} · Extra`, `${line} · Відповіді рекомендовані`,
    ]) expect(parsePrototypeAnswer(round, text)).toHaveProperty("input");
  for (const text of [line.replace("1a 2a 3a", "1a 1b 3a"), line.replace("1a 2a 3a", "1ab 2a 3a"), line.replace("1a", "1f")])
    expect(parsePrototypeAnswer(round, text)).toHaveProperty("error");
  expect(parsePrototypeAnswer(round, `${line} · ${prototypeReference(round)}`)).toHaveProperty("error");
});

test("wholly custom answers are attached by question number even when Other was not offered", () => {
  const round = telegramRound();
  const words = "1: Тут  залишаємо.\n2 — Власний набір поверхонь.\n3: Почнемо завтра.";
  const input = parsePrototypeAnswer(round, `${prototypeReference(round)} · Відповіді ${words}`).input!;
  expect(input.answers).toEqual(round.questions!.map((q, i) => ({ questionId: q.id, options: [], other: true, customText: words.split("\n")[i] })));
  expect(input.comment).toBe(words);
});

test("free text without an Answers segment covers every unanswered question", () => {
  const round = telegramRound();
  const text = `Моя  відповідь ${prototypeReference(round)}\nБеремо справжній інтерфейс.`;
  const input = parsePrototypeAnswer(round, text).input!;
  expect(input.originalReply).toBe(text);
  expect(input.comment).toBe("Моя  відповідь\nБеремо справжній інтерфейс.");
  expect(input.answers).toEqual(round.questions!.map(q => ({ questionId: q.id, options: [], other: true })));
});

test("mixed shorthand and words keep selected options and the addressed custom answer", () => {
  const round = telegramRound();
  const input = parsePrototypeAnswer(round, `${prototypeReference(round)} · Відповіді 1a 2 — свій варіант поверхонь\n3b`).input!;
  expect(input.answers).toEqual([
    { questionId: "place", options: [0] },
    { questionId: "scope", options: [], other: true, customText: "2 — свій варіант поверхонь" },
    { questionId: "timing", options: [1] },
  ]);
  expect(parsePrototypeAnswer(round, `${prototypeReference(round)} · Відповіді 1a 2a 3a · 1: Власне доповнення`).input!.answers![0])
    .toEqual({ questionId: "place", options: [0], other: true, customText: "1: Власне доповнення" });
});

test.each([", але 2: Потрібна телега.", " — 2: Потрібна телега.", "! 2: Потрібна телега."])("recommendation reservations accept punctuation and attach numbered notes: %s", note => {
  const round = telegramRound();
  const input = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}${note}`).input!;
  expect(input.recommendedWithReservation).toBe(true);
  expect(input.skip).toBeUndefined();
  expect(input.answers![1]).toEqual({ questionId: "scope", options: [0], customText: "2: Потрібна телега." });
  expect(input.comment).toBe(note);
});

test("question wording attaches a reservation only when it names one question", () => {
  const round = telegramRound();
  const note = ", але Which surfaces? Потрібна телега.";
  const input = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}${note}`).input!;
  expect(input.answers![1]!.customText).toBe(note);
  expect(input.answers![0]!.customText).toBeUndefined();
  const ambiguous = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}, Where should this live? Which surfaces?`).input!;
  expect(ambiguous.answers!.every(a => a.customText === undefined)).toBe(true);
});

test("shorthand inside a recommendation reservation remains the owner's exact note", () => {
  const round = telegramRound();
  const note = ", але 2b треба обговорити.";
  const input = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}${note}`).input!;
  expect(input.comment).toBe(note);
  expect(input.answers).toEqual(round.questions!.map(q => ({ questionId: q.id, options: [0] })));
  expect(input.recommendedWithReservation).toBe(true);
  const nextLine = parsePrototypeAnswer(round, `${prototypeCopyLine(round)}\n2b треба обговорити.`).input!;
  expect(nextLine.comment).toBe("2b треба обговорити.");
  expect(nextLine.answers![1]!.options).toEqual([0]);
  expect(nextLine.recommendedWithReservation).toBe(true);
  const suffix = ", але 2b  треба обговорити · Додаткові  слова.\nЩе один рядок.";
  expect(parsePrototypeAnswer(round, `${prototypeCopyLine(round)}${suffix}`).input!.comment).toBe(suffix);
});

test("a recommendation continuation that resembles a variant stays owner text", () => {
  const round = telegramRound();
  const text = `${prototypeCopyLine(round)}\nВаріант 2`;
  expect(parsePrototypeAnswer(round, text).input).toMatchObject({
    originalReply: text,
    chosen: [],
    comment: "Варіант 2",
    recommendedWithReservation: true,
    answers: round.questions!.map(q => ({ questionId: q.id, options: [0] })),
  });
  expect(parsePrototypeAnswer(round, text).input!.skip).toBeUndefined();
  expect(parsePrototypeAnswer(round, `${prototypeCopyLine(round, 2)}`).input!.chosen).toEqual([2]);
});

test.each([" · Відповіді рекомендовані", "\nВідповіді рекомендовані"])("an Other answer before the recommendation marker stays recorded verbatim (%s)", separator => {
  const round = telegramRound();
  const text = `${prototypeReference(round)} · Відповіді 1a 2a 3+${separator}`;
  const parsed = parsePrototypeAnswer(round, text);
  expect(parsed).toHaveProperty("input");
  expect(parsed.input).toMatchObject({
    originalReply: text,
    chosen: [],
    comment: "3+",
    recommendedWithReservation: true,
    answers: [
      { questionId: "place", options: [0] },
      { questionId: "scope", options: [0] },
      { questionId: "timing", options: [0], other: true },
    ],
  });
  expect(parsed.input!.skip).toBeUndefined();
});

test("numbered custom answer boundaries after punctuation keep each question attribution", () => {
  const round = telegramRound();
  const custom = `${prototypeReference(round)} · 1: Мій гайд;2: Реальна телега;3: Перший ролик`;
  const parsed = parsePrototypeAnswer(round, custom).input!;
  expect(parsed.answers!.map(answer => answer.customText)).toEqual([
    "1: Мій гайд", "2: Реальна телега", "3: Перший ролик",
  ]);
  const mixed = `${prototypeCopyLine(round)};2: Потрібен реальний Telegram UI.`;
  const reservation = parsePrototypeAnswer(round, mixed).input!;
  expect(reservation.answers![1]!.customText).toBe("2: Потрібен реальний Telegram UI.");
  expect(reservation.comment).toBe(";2: Потрібен реальний Telegram UI.");
});

test("unknown dot segments are custom text and every reply retains original whitespace after NFC and escaping", () => {
  const round = telegramRound();
  const text = `  ${prototypeCopyLine(round, 1)} · Extra  words.\r\n  Keep  these.  `;
  const input = parsePrototypeAnswer(round, text).input!;
  expect(input.originalReply).toBe(text);
  expect(input.comment).toBe("Extra  words.\nKeep  these.");
  const escaped = `${prototypeReference(round).replace("#", "\\#")} · И\u0306  текст.`;
  expect(parsePrototypeAnswer(round, escaped).input!.originalReply).toBe(`${prototypeReference(round)} · Й  текст.`);
});

test("identity across the entire reply and the full 20000-character limit remain enforced", () => {
  const round = telegramRound();
  const ref = prototypeReference(round);
  for (const text of ["без посилання", `${ref}\n${ref}`, `${ref}\n#proto-aaaaaaaa`, "#proto-aaaaaaaa"])
    expect(parsePrototypeAnswer(round, text)).toHaveProperty("error");
  expect(parsePrototypeAnswer(round, ref + "a".repeat(20_000 - ref.length))).toHaveProperty("error");
  const text = `${ref} ${"я".repeat(20_000 - ref.length - 1)}`;
  expect(parsePrototypeAnswer(round, text).input!.originalReply).toBe(text);
  expect(parsePrototypeAnswer(round, text + "я")).toHaveProperty("error");
  delete round.questions;
  expect(parsePrototypeAnswer(round, `${ref} · Мій власний варіант`).input).toMatchObject({ chosen: [], comment: "Мій власний варіант" });
});

test("the reply cap counts Unicode code points through parser normalization", () => {
  const round = telegramRound();
  const ref = prototypeReference(round);
  const text = `${ref} ${"🙂".repeat(20_000 - [...ref].length - 1)}`;
  expect([...text]).toHaveLength(20_000);
  expect(parsePrototypeAnswer(round, text).input!.originalReply).toBe(text);
  expect(parsePrototypeAnswer(round, `${text}🙂`)).toMatchObject({ error: "скоротіть відповідь до 20000 символів" });
});

test("custom answer text uses the same code-point cap as owner replies", () => {
  const round = telegramRound();
  const customText = "🙂".repeat(20_000);
  const answers = round.questions!.map((q, i) => i === 0
    ? { questionId: q.id, options: [], other: true as const, customText }
    : { questionId: q.id, options: [0] });
  expect(normalizePrototypeAnswers(round.questions!, answers, "", true)[0]!.customText).toBe(customText);
  expect(() => normalizePrototypeAnswers(round.questions!, [{ ...answers[0]!, customText: `${customText}🙂` }, ...answers.slice(1)], "", true)).toThrow();
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

test("seat and task short references share collision checks while only waiting rounds accept new decisions", () => {
  const round = { ...telegramRound(), taskId: null };
  const text = `${prototypeCopyLine(round)}, але є питання.`;
  expect(matchPrototypeAnswer(text, [], undefined, [round])).toHaveProperty("input");
  expect(matchPrototypeAnswer(text, [telegramTask()], undefined, [round])).toBeNull();
  const decided = { ...round, decision: { chosen: [], comment: "Earlier", at: round.createdAt,
    delivery: { state: "sent" as const, conversationId: "conversation_seat", clientMessageId: "decision", text: "Earlier" } } };
  expect(matchPrototypeAnswer(text, [], undefined, [decided])).toBeNull();
  expect(matchPrototypeAnswer(text, [], round.id, [decided])).toHaveProperty("input");
});

test("owner free text is explicit while ordinary web answer validation keeps its published constraints", () => {
  const round = telegramRound();
  const custom = parsePrototypeAnswer(round, `${prototypeReference(round)} · 1: Моє місце.\n2: Мої поверхні.\n3: Мій час.`).input!;
  expect(() => normalizePrototypeAnswers(round.questions!, custom.answers, custom.comment)).toThrow();
  expect(normalizePrototypeAnswers(round.questions!, custom.answers, custom.comment, true)).toEqual(custom.answers!);
  const plus = parsePrototypeAnswer(round, `${prototypeReference(round)} · Відповіді 1a+ 2a 3a`).input!;
  expect(plus.answers![0]).toEqual({ questionId: "place", options: [0], other: true });
});

test.each(["1b, 2a, 3b", "1: b; 2: a; 3: b", "1b 2a 3b"])("contextual poll numbering maps ordered choices: %s", text => {
  const round = telegramRound();
  const match = matchPrototypeAnswer(text, [telegramTask([round])], undefined, [], `1. Question · ${prototypeReference(round)}`);
  expect(match?.input).toMatchObject({ originalReply: text, comment: "", answers: [
    { questionId: "place", options: [1] }, { questionId: "scope", options: [0] }, { questionId: "timing", options: [1] },
  ] });
});

test("contextual answers preserve recommendations, custom comments, authority boundaries and ambiguous choices", () => {
  const round = telegramRound();
  for (const text of ["рекомендовані", "рекомендованные", "recommended"])
    expect(parsePrototypeAnswer(round, text, true).input).toMatchObject({ originalReply: text, skip: true });
  const comment = "  Мій власний варіант.\n  Збережіть  пробіли.  ";
  expect(parsePrototypeAnswer(round, comment, true).input).toMatchObject({ originalReply: comment, comment: "Мій власний варіант.\nЗбережіть  пробіли." });
  for (const text of ["b", "так", "1", "1a 1b", "1ab", "9a", "1l"])
    expect(parsePrototypeAnswer(round, text, true)).toHaveProperty("error");
  expect(parsePrototypeAnswer(round, "1b, 2a, 2b, 3b", true).input?.answers?.[1]).toEqual({ questionId: "scope", options: [0, 1] });
  expect(matchPrototypeAnswer("1b", [telegramTask([round])], undefined, [])).toBeNull();
  expect(matchPrototypeAnswer("1b", [telegramTask([round])], undefined, [], `${prototypeReference(round)} #proto-aaaaaaaa`)).toBeNull();
});
