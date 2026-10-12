import type { PendingQuestion } from "@/lib/types";

/*
 * The answer to a structured host's native question or plan
 * (docs/design/attention-auto-resolve.md, acceptance 3): a worker's question
 * waits on its project's seat first, and the seat answers it with
 * `conversation_action answer`, naming the exact request it read on its wake.
 * The answer is the one a Claude `can_use_tool` request takes, the same one the
 * conversation's own question card submits: the chosen labels keyed by each
 * question's text, or an allow or a deny of the plan.
 */

export interface NativeAnswerInput {
  /** Per question, the chosen option numbers counted from 1: a number, or a
      list of them for a question that takes several. */
  answers?: unknown;
  /** A free answer to a single question, in place of its options. */
  text?: unknown;
  /** A plan only: approve it, or reject it. */
  approve?: unknown;
  /** A plan only: what the agent is told when its plan is rejected. */
  message?: unknown;
}

export type NativeAnswer = { resolution: unknown; label: string } | { error: string };

const TEXT_MAX = 2_000;
const DEFAULT_REJECTION = "The plan was rejected; revise it before going on.";

function chosenNumbers(raw: unknown): number[] | null {
  const values = Array.isArray(raw) ? raw : [raw];
  const numbers = values.map(Number);
  return numbers.every((value) => Number.isInteger(value)) ? numbers : null;
}

/** The resolution that answers `pending`, or what is wrong with the answer. */
export function nativeAnswerResolution(pending: PendingQuestion, input: NativeAnswerInput): NativeAnswer {
  if (pending.kind === "plan") {
    if (typeof input.approve !== "boolean") return { error: "a plan is answered with approve true or false" };
    if (input.approve) return { resolution: { behavior: "allow" }, label: "approved" };
    const message = typeof input.message === "string" && input.message.trim() ? input.message.trim().slice(0, TEXT_MAX) : DEFAULT_REJECTION;
    return { resolution: { behavior: "deny", message }, label: "rejected" };
  }
  const questions = pending.questions ?? [];
  if (!questions.length) return { error: "the question carries no questions to answer" };
  if (typeof input.text === "string" && input.text.trim()) {
    if (questions.length > 1) return { error: "several questions need an answer each: pass answers, one entry per question" };
    const text = input.text.trim().slice(0, TEXT_MAX);
    return { resolution: { behavior: "allow", updatedInput: { answers: { [questions[0]!.question]: text } } }, label: text };
  }
  if (!Array.isArray(input.answers) || input.answers.length !== questions.length) {
    return { error: `answer each of the ${questions.length} question${questions.length === 1 ? "" : "s"}: answers holds one entry per question, the option numbers counted from 1` };
  }
  const answers: Record<string, string> = {};
  const labels: string[] = [];
  for (const [index, question] of questions.entries()) {
    const numbers = chosenNumbers(input.answers[index]);
    if (!numbers?.length || numbers.some((value) => value < 1 || value > question.options.length)) {
      return { error: `question ${index + 1} has options 1 to ${question.options.length}` };
    }
    if (numbers.length > 1 && !question.multiSelect) return { error: `question ${index + 1} takes one option` };
    const chosen = [...new Set(numbers)].map((value) => question.options[value - 1]!.label);
    answers[question.question] = chosen.join(", ");
    labels.push(...chosen);
  }
  return { resolution: { behavior: "allow", updatedInput: { answers } }, label: labels.join(", ") };
}
