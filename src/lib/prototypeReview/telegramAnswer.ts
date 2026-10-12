import { loadTasks } from "@/lib/tasks/store";
import { runsElsewhere } from "@/lib/links/linked";
import { prototypeReviewSummary } from "./model";
import { normalizePrototypeAnswers, recommendedAnswers } from "./questions";
import type { BoardTask } from "@/lib/tasks/types";
import type { DecidePrototypeInput, PrototypeReviewRound } from "./types";

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

export function parsePrototypeAnswer(round: PrototypeReviewRound, text: string): PrototypeAnswerMatch {
  try {
    const lines = normalizeTelegramAnswer(text).split("\n");
    const index = lines.findIndex(line => /#proto-[a-f0-9]{8}\b/i.test(line));
    if (index < 0) throw new Error("додайте посилання на раунд");
    const refs = lines[index]!.match(/#proto-[a-f0-9]{8}\b/gi) ?? [];
    if (refs.length !== 1 || refs[0]!.toLowerCase() !== prototypeReference(round)) throw new Error("вкажіть один раунд");
    const segments = lines[index]!.split("·").slice(1).map(s => s.trim());
    const comment = lines.filter((_, i) => i !== index).join("\n").trim();
    let chosen: number[] = [];
    let choicesSeen = false;
    let answersSeen = false;
    let skip: true | undefined;
    let answers: DecidePrototypeInput["answers"];
    for (const segment of segments) {
      const choice = /^варіант(?:и)?\s+([1-9](?:\s*,\s*[1-9])*)$/i.exec(segment);
      if (choice) {
        if (choicesSeen) throw new Error("вкажіть варіанти один раз");
        choicesSeen = true;
        chosen = choice[1]!.split(",").map(n => Number(n.trim()));
      } else if (/^відповіді\s+/i.test(segment)) {
        if (answersSeen) throw new Error("вкажіть відповіді один раз");
        answersSeen = true;
        const raw = segment.replace(/^відповіді\s+/i, "");
        if (/^рекомендовані$/i.test(raw)) skip = true;
        else answers = raw.split(" ").map(token => {
          const match = /^([1-7])([a-f]+\+?|\+)$/i.exec(token);
          const q = match && round.questions?.[Number(match[1]) - 1];
          if (!match || !q) throw new Error("використайте відповіді на кшталт 1a 2bc 3+");
          return { questionId: q.id, options: [...match[2]!.replace("+", "").toLowerCase()].map(c => c.charCodeAt(0) - 97),
            ...(match[2]!.includes("+") ? { other: true as const } : {}) };
        });
      } else throw new Error("невідомий фрагмент відповіді");
    }
    if (new Set(chosen).size !== chosen.length || chosen.some(n => !round.variants.some(v => v.number === n))
      || (!chosen.length && !round.questions?.length)) throw new Error("оберіть оголошені варіанти");
    if (round.questions?.length) {
      if (!answersSeen) throw new Error("дайте відповідь на кожне питання");
      if (!skip) answers = normalizePrototypeAnswers(round.questions, answers, comment);
    } else if (answersSeen) throw new Error("цей раунд не має питань");
    if (comment.length > 20_000) throw new Error("скоротіть коментар до 20000 символів");
    return { round, input: { reviewId: round.id, chosen, comment, ...(skip ? { skip } : answers ? { answers } : {}) } };
  } catch (error) { return { round, error: (error as Error).message }; }
}

/** Match all retained rounds before filtering: a short-reference collision refuses identity.
    Only the runner's saved request record admits replay of an already recorded decision. */
export function matchPrototypeAnswer(text: string, tasks: readonly BoardTask[] = loadTasks(), replayReviewId?: string): PrototypeAnswerMatch | null {
  const line = normalizeTelegramAnswer(text).split("\n").find(line => /#proto-[a-f0-9]{8}\b/i.test(line));
  const ref = line?.match(/#proto-[a-f0-9]{8}\b/i)?.[0].toLowerCase();
  if (!ref) return null;
  const matches = tasks.flatMap(task => (task.prototypeReviews ?? []).filter(round => prototypeReference(round) === ref).map(round => ({ task, round })));
  if (matches.length !== 1) return null;
  const { task, round } = matches[0]!;
  const replay = replayReviewId === round.id && !!round.decision;
  if (runsElsewhere(task) || (!replay && prototypeReviewSummary(task.prototypeReviews ?? [])?.waitingReviewId !== round.id)) return null;
  return parsePrototypeAnswer(round, text);
}
