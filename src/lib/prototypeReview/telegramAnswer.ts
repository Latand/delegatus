import { loadTasks } from "@/lib/tasks/store";
import { runsElsewhere } from "@/lib/links/linked";
import { prototypeReviewSummary } from "./model";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import { loadSeatRounds } from "./seatRounds";
import { prototypeTextLength } from "./textLength";
import type { BoardTask } from "@/lib/tasks/types";
import type { DecidePrototypeInput, PrototypeAnswer, PrototypeReviewRound } from "./types";

export function prototypeReference(round: Pick<PrototypeReviewRound, "id">): string {
  return `#proto-${round.id.slice(3, 11)}`;
}

/** Human-readable titles never supply identity or grammar. */
export function prototypeCopyLine(round: PrototypeReviewRound, variant?: number): string {
  const answers = round.questions?.length
    ? variant === undefined ? " · Відповіді рекомендовані"
      : ` · Відповіді ${recommendedAnswers(round.questions).map((a, i) => `${i + 1}${String.fromCharCode(97 + a.options[0]!)}`).join(" ")}`
    : "";
  const tail = `» ${prototypeReference(round)}${variant === undefined ? "" : ` · Варіант ${variant}`}${answers}`;
  const title = round.title.normalize("NFC").replace(/[\r\n·«»<>*_`&#]/g, " ").replace(/\s+/g, " ").trim();
  const budget = 256 - "Прототип «".length - tail.length;
  const cut = title.length > budget ? `${title.slice(0, budget - 1)}…` : title;
  return `Прототип «${cut}${tail}`;
}

export function normalizeTelegramAnswer(text: string): string {
  return text.normalize("NFC").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, "$1")
    .split(/\r?\n/).map(line => line.replace(/[^\S\n]+/g, " ").trim()).join("\n");
}
export type PrototypeAnswerMatch = { round: PrototypeReviewRound; input: DecidePrototypeInput; error?: never }
  | { round: PrototypeReviewRound; error: string; input?: never };

/** Structured choices are conveniences; every remaining word is an owner note. */
export function parsePrototypeAnswer(round: PrototypeReviewRound, text: string): PrototypeAnswerMatch {
  const originalReply = text.normalize("NFC").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, "$1");
  const refs = originalReply.match(/#proto-[a-f0-9]{8}\b/gi) ?? [];
  if (!refs.length) return { round, error: "додайте посилання на раунд" };
  if (refs.length !== 1 || refs[0]!.toLowerCase() !== prototypeReference(round)) return { round, error: "вкажіть один раунд" };
  if (prototypeTextLength(originalReply) > 20_000) return { round, error: "скоротіть відповідь до 20000 символів" };
  const body = originalReply.replace(/^\s*Прототип «[^»]*»\s*/iu, "").replace(/#proto-[a-f0-9]{8}\b/i, "");
  const questions = round.questions ?? [];
  const chosen = new Set<number>();
  const selected = new Map<string, PrototypeAnswer>();
  const notes: string[] = [];
  let recommended = false;
  let reservation: string | undefined;
  let notesBeforeRecommendation = 0;
  for (const part of body.matchAll(/[^·\n]+/g)) {
    const segment = part[0].trim();
    if (!segment) continue;
    // Once the recommendation marker has appeared, every later segment is
    // owner text, even when it happens to look like a copied control.
    if (recommended) { notes.push(segment); continue; }
    const choice = /^варіант(?:и)?\s+([1-9](?:\s*,\s*[1-9])*)$/i.exec(segment);
    if (choice && choice[1]!.split(",").every(n => round.variants.some(v => v.number === Number(n)))) {
      choice[1]!.split(",").forEach(n => chosen.add(Number(n)));
      continue;
    }
    let words = segment.replace(/^відповіді(?:\s+|$)/i, "");
    const recommendation = /^рекомендовані(?=$|[^\p{L}\p{N}_])/iu.exec(words);
    if (recommendation && questions.length) {
      recommended = true;
      words = words.slice(recommendation[0].length);
      notesBeforeRecommendation = notes.length;
      reservation = body.slice(part.index + part[0].indexOf(segment) + segment.length - words.length).replace(/^\r?\n/, "");
      if (words.trim()) notes.push(words);
      continue;
    }
    words = words.replace(/(?<!\S)([1-7])([a-f]+\+?|\+)(?!\S)/gi, (token, number: string, letters: string) => {
      const q = questions[Number(number) - 1];
      const options = [...letters.replace("+", "").toLowerCase()].map(c => c.charCodeAt(0) - 97);
      if (!q || selected.has(q.id) || new Set(options).size !== options.length || options.some(i => i >= q.options.length)
        || (!q.multiple && options.length > 1)) return token;
      selected.set(q.id, { questionId: q.id, options, ...(letters.includes("+") ? { other: true as const } : {}) });
      return "";
    });
    if (words.trim()) notes.push(words.trim());
  }
  const comment = reservation?.trim() && notes.length > notesBeforeRecommendation
    ? [...notes.slice(0, notesBeforeRecommendation), reservation].join("\n") : notes.join("\n");
  const answers = questions.map(q => selected.get(q.id) ?? (recommended ? recommendedAnswers([q])[0]! : { questionId: q.id, options: [], other: true as const }));
  for (const note of notes) {
    const numbered = [...note.matchAll(/(?<![\p{L}\p{N}_])([1-7])\s*[:.)—–-]\s*/gu)];
    const named = questions.filter(q => note.toLowerCase().includes(q.text.toLowerCase()));
    const parts = numbered.length ? numbered.map((match, i) => ({
      question: Number(match[1]) - 1, text: note.slice(match.index, numbered[i + 1]?.index).trim().replace(/[;,]$/, ""),
    })) : named.length === 1 ? [{ question: questions.indexOf(named[0]!), text: note }] : [];
    for (const part of parts) {
      const answer = answers[part.question];
      if (!answer) continue;
      answer.customText = [answer.customText, part.text].filter(Boolean).join("\n");
      if (!recommended) answer.other = true;
    }
  }
  // A bare reference, or a bare Other token, still records exactly what was sent.
  const needsCustom = !recommended && answers.some(a => a.other);
  const input: DecidePrototypeInput = { reviewId: round.id, chosen: [...chosen], originalReply,
    comment: comment || (needsCustom || (!questions.length && !chosen.size) ? originalReply : ""),
    ...(questions.length ? recommended && !comment && !selected.size ? { skip: true as const } : { answers } : {}),
    ...(recommended && comment ? { recommendedWithReservation: true as const } : {}) };
  if (input.answers) input.answers = normalizePrototypeAnswers(questions, input.answers, input.comment, true);
  return { round, input };
}

/** Match all retained rounds before filtering: a short-reference collision refuses identity.
    Only the runner's saved request record admits replay of an already recorded decision. */
export function matchPrototypeAnswer(text: string, tasks: readonly BoardTask[] = loadTasks(), replayReviewId?: string,
  seatRounds: readonly PrototypeReviewRound[] = loadSeatRounds()): PrototypeAnswerMatch | null {
  const line = normalizeTelegramAnswer(text).split("\n").find(line => /#proto-[a-f0-9]{8}\b/i.test(line));
  const ref = line?.match(/#proto-[a-f0-9]{8}\b/i)?.[0].toLowerCase();
  if (!ref) return null;
  const matches: Array<{ task?: BoardTask; round: PrototypeReviewRound }> = [
    ...tasks.flatMap(task => (task.prototypeReviews ?? []).filter(round => prototypeReference(round) === ref).map(round => ({ task, round }))),
    ...seatRounds.filter(round => prototypeReference(round) === ref).map(round => ({ round })),
  ];
  if (matches.length !== 1) return null;
  const { task, round } = matches[0]!;
  const replay = replayReviewId === round.id && !!round.decision;
  if (task ? runsElsewhere(task) || (!replay && prototypeReviewSummary(task.prototypeReviews ?? [])?.waitingReviewId !== round.id)
    : !!round.decision && !replay) return null;
  return parsePrototypeAnswer(round, text);
}
