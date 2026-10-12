import { createHash } from "node:crypto";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound } from "./types";
import { questions } from "./questionnaire.fixture";

export function telegramRound(key = "first"): PrototypeReviewRound {
  return { id: `pr_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`, taskId: "task-prototype", project: "project-a",
    title: "Review layout", createdAt: "2026-10-01T00:00:00Z", source: { conversationId: null }, publicationKey: key, inputDigest: key,
    variants: [1, 2, 3].map(number => ({ number, name: `Choice ${number}`, description: "Keeps controls together.", frames: [], videos: [] })),
    questions: structuredClone(questions) };
}
export function telegramTask(rounds: PrototypeReviewRound[] = [telegramRound()]): BoardTask {
  return { id: "task-prototype", project: "project-a", status: "inbox", placement: "unplaced", text: "Review layout", assignments: [],
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", prototypeReviews: rounds };
}
