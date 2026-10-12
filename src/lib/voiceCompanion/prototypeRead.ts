import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRead, PrototypeRoundRead } from "@/lib/prototypeReview/types";
import type { SpeechReadResult } from "./boardReads";

type Variant = PrototypeRoundRead["variants"][number];
export interface ReviewCandidate { task: BoardTask; read: PrototypeReviewRead; round: PrototypeRoundRead }
const firstLine = (task: BoardTask) => task.text.split("\n")[0].slice(0, 120);
const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(word => word.length >= 2);
const matches = (text: string, query: string) => words(query).every(word => words(text).join(" ").includes(word));
export function captionHead(caption: string): string { return caption.split(". ")[0]; }
const screenParts = (caption: string) => captionHead(caption).split(" · ").filter(part => !/^\d{3,4}\s?px$/.test(part) && !["uk", "en"].includes(part));
export function roundViews(variant: Variant): string[] {
  const groups = new Map<string, typeof variant.frames>();
  for (const frame of variant.frames) {
    const screen = screenParts(frame.caption)[0];
    groups.set(screen, [...(groups.get(screen) ?? []), frame]);
  }
  const views = [...groups].map(([screen, frames]) => {
    const widths = [...new Set(frames.flatMap(frame => frame.width ? [frame.width] : []))];
    const langs = ["uk", "en"].filter(lang => frames.some(frame => frame.lang === lang));
    const variations = [...new Set(frames.flatMap(frame => screenParts(frame.caption).slice(1)))].sort();
    // Keep the familiar light/dark order stable across publication ordering.
    if (variations.includes("light") && variations.includes("dark")) variations.sort((a, b) => a === "light" ? -1 : b === "light" ? 1 : a.localeCompare(b));
    return [screen + `: ${frames.length} frames`, widths.length ? `${widths.join("/")} px` : "", langs.join("/"), variations.join("/"),
      frames.some(frame => frame.original) ? `${frames.filter(frame => frame.original).length} with original` : ""].filter(Boolean).join(" · ");
  });
  return views.length <= 12 ? views : [...views.slice(0, 12), `+${views.length - 12} more views`];
}
const state = ({ read, round }: ReviewCandidate) => round.supersededBy ? "superseded" : round.decision ? "decided" : read.waitingReviewId === round.id ? "waiting" : "undecided";
export function compactRound(candidate: ReviewCandidate) {
  const { task, read, round } = candidate;
  const frames = round.variants.flatMap(v => v.frames);
  const notes = [...new Set(frames.flatMap(frame => frame.caption.includes(". ") ? [frame.caption.slice(frame.caption.indexOf(". ") + 2)] : []))].slice(0, 3).map(note => byteShort(note, 300));
  const decision = round.decision;
  return { taskId: task.id, reviewId: round.id, task: firstLine(task), title: round.title, state: state(candidate), createdAt: round.createdAt,
    frames: frames.length, unavailableFrames: frames.filter(frame => !frame.image.available).length,
    variants: round.variants.map(v => ({ number: v.number, name: v.name, description: v.description, frames: v.frames.length,
      ...(v.videos.length ? { videos: v.videos.length } : {}), views: roundViews(v) })), ...(notes.length ? { notes } : {}),
    questions: (round.questions ?? []).map(q => ({ id: q.id, text: q.text, options: q.options.map(o => o.label), recommended: q.options.findIndex(o => o.recommended),
      ...(q.multiple ? { multiple: true } : {}), ...(q.other ? { other: true } : {}) })),
    ...(decision ? { decision: { chosen: decision.chosen.map(number => ({ number, name: round.variants.find(v => v.number === number)?.name ?? "" })),
      ...(decision.answers ? { answers: decision.answers.map(answer => { const question = round.questions?.find(q => q.id === answer.questionId);
        return { question: question?.text ?? answer.questionId, options: answer.options.map(index => question?.options[index]?.label ?? String(index)), ...(answer.other ? { other: true } : {}) }; }) } : {}),
      ...(decision.skipped ? { skipped: true } : {}), comment: decision.comment, at: decision.at, delivery: decision.delivery.state } } : {}),
    ...(read.rounds.length > 1 ? { otherRounds: read.rounds.filter(r => r.id !== round.id).slice().reverse().slice(0, 5).map(r => ({ reviewId: r.id, title: r.title, createdAt: r.createdAt, state: state({ task, read, round: r }) })) } : {}),
    ...(read.unavailable ? { unavailable: read.unavailable } : {}) };
}
export function byteShort(text: string, max: number): string {
  let result = ""; for (const char of text) { if (Buffer.byteLength(result + char) > max) break; result += char; } return result;
}
export function matchRounds(tasks: readonly BoardTask[], read: (id: string) => PrototypeReviewRead, args: Record<string, unknown>): ReviewCandidate[] {
  return tasks.filter(task => !args.taskId || task.id === args.taskId).flatMap(task => {
    const review = read(task.id);
    const candidates = review.rounds.filter(round => !args.reviewId || round.id === args.reviewId).filter(round => args.taskId || !args.query || matches([
      task.text.split("\n")[0], round.title, ...round.variants.flatMap(v => [v.name, v.description]), ...(round.questions ?? []).flatMap(q => [q.text, ...q.options.map(o => o.label)]),
    ].join(" "), String(args.query)));
    const preferred = candidates.find(round => round.id === review.waitingReviewId);
    const round = preferred ?? (args.taskId || args.query || args.reviewId ? candidates.at(-1) : undefined);
    return round ? [{ task, read: review, round }] : [];
  }).sort((a, b) => Number(state(b) === "waiting") - Number(state(a) === "waiting") || b.round.createdAt.localeCompare(a.round.createdAt));
}
export function reviewRows(candidates: ReviewCandidate[]) {
  return candidates.slice(0, 6).map(candidate => ({ taskId: candidate.task.id, reviewId: candidate.round.id, title: byteShort(candidate.round.title, 260),
    task: byteShort(firstLine(candidate.task), 160), state: state(candidate), createdAt: candidate.round.createdAt,
    variants: candidate.round.variants.map(v => `${v.number} ${byteShort(v.name, 80)}`), questions: candidate.round.questions?.length ?? 0,
    frames: candidate.round.variants.reduce((count, v) => count + v.frames.length, 0) }));
}
export function reviewAnswer(candidates: ReviewCandidate[], tasks: readonly BoardTask[], waiting: ReviewCandidate[], project: string, args: Record<string, unknown>): SpeechReadResult & { status: string; match?: string } {
  if (candidates.length === 1) {
    const item = compactRound(candidates[0]);
    return { status: "done", match: "single", item, speech: byteShort(`Prototype review «${item.title}» for task «${item.task}»: ${item.variants.map(v => `${v.number} ${v.name}`).join(", ")}; ${item.questions.length} questions; ${item.frames} frames. Read the item; pictures have not been viewed by this read.`, 600), truncated: !!candidates[0].read.historyTruncated };
  }
  const noReview = typeof args.taskId === "string" ? tasks.find(task => task.id === args.taskId) : undefined;
  if (noReview && !args.reviewId) return { status: "no_review", speech: `Task «${firstLine(noReview)}» has no prototype review. Nothing about a prototype was read. This handle names no review: search with taskId null and the operator's words in query.`, truncated: false };
  if (args.reviewId && !candidates.length) return { status: "none", speech: "The requested prototype round was not found. Nothing about a prototype was read. Search again with reviewId null and the operator's words in query.", truncated: false };
  const several = candidates.length > 1;
  const source = several ? candidates : waiting;
  const result = { status: several ? "several" : "none", ...(several ? { match: "several" } : {}), rows: reviewRows(source), total: source.length, shown: Math.min(source.length, 6), more: Math.max(0, source.length - 6),
    speech: several ? `${candidates.length} prototype reviews match «${args.query ?? "waiting"}»: ${candidates.slice(0, 6).map(c => c.round.title).join("; ")}. Ask the operator which one, or read one of these rows by its taskId.`
      : args.query ? `No prototype review in ${project} matches «${args.query}». Nothing about a prototype was read. Say exactly that and what was searched for. The reviews that wait are in rows.`
        : `No prototype review waits on the operator in ${project}. Nothing about a prototype was read. Say exactly that; to read a decided review, ask again with the operator's words in query.`, truncated: source.length > 6 };
  result.speech = byteShort(result.speech, 900);
  // Listings retain complete rows and reduce the number shown to the page budget.
  while (Buffer.byteLength(JSON.stringify(result)) > 4000 && result.rows.length) { result.rows.pop(); result.shown--; result.more++; result.truncated = true; }
  return result;
}
export function selectFrames(candidate: ReviewCandidate, args: Record<string, unknown>) {
  return (args.variants as number[]).map(number => {
    const variant = candidate.round.variants.find(v => v.number === number);
    const frame = variant?.frames.find(frame => (!args.view || matches(captionHead(frame.caption), String(args.view))) && (!args.width || frame.width === args.width) && (!args.lang || frame.lang === args.lang));
    const media = args.original ? frame?.original : frame?.image;
    const reason = !variant ? "variant does not exist" : !frame ? "no frame matches the requested view" : !media ? "this frame has no original" : !media.available ? "stored picture is unavailable" : null;
    return { variant: number, frame, media, reason, views: variant ? roundViews(variant) : [] };
  });
}
