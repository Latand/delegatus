import type { PrototypeAnswer, PrototypeQuestion } from "./types";

export function recommendedAnswers(questions: readonly PrototypeQuestion[]): PrototypeAnswer[] {
  return questions.map(q => ({ questionId: q.id, options: [q.options.findIndex(o => o.recommended)] }));
}
/** Validate and order answers against an immutable published questionnaire. */
export function normalizePrototypeAnswers(questions: readonly PrototypeQuestion[], raw: unknown, comment: string): PrototypeAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new Error("answer every question exactly once");
  const ids = new Set<string>();
  for (const answer of raw) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer) || typeof answer.questionId !== "string"
      || Object.keys(answer).some(k => !["questionId", "options", "other"].includes(k))
      || (answer.other !== undefined && answer.other !== true) || ids.has(answer.questionId)
      || !questions.some(q => q.id === answer.questionId)) throw new Error("invalid or duplicate question answer");
    ids.add(answer.questionId);
  }
  return questions.map(q => {
    const answer = raw.find(a => a.questionId === q.id)!;
    const options = answer.options;
    if (!Array.isArray(options) || new Set(options).size !== options.length
      || options.some(i => !Number.isInteger(i) || i < 0 || i >= q.options.length)) throw new Error(`${q.id}: choose declared options`);
    if (answer.other && (!q.other || !comment.trim())) throw new Error(`${q.id}: other requires the shared comment and must be offered`);
    const count = options.length + (answer.other ? 1 : 0);
    if (!count || (!q.multiple && count !== 1)) throw new Error(`${q.id}: ${q.multiple ? "choose at least one answer" : "choose exactly one answer"}`);
    return { questionId: q.id, options: [...options].sort((a,b) => a-b), ...(answer.other ? { other: true as const } : {}) };
  });
}
