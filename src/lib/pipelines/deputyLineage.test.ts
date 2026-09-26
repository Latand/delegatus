import { expect, test } from "bun:test";

import { resolvePipelineCreatorLineage } from "./engine";
import { buildPipeline } from "./store";

/* docs/design/ghost-seat.md §4 rule 3: a lane a live deputy creates is the
   seat's lane. The deputy passes its own transcript as `src`; the seat is
   recorded as the creator, so the seat answers the lane's decisions after the
   deputy is gone (`resolve-decision` admits only `srcConversationId`). */

const ports = {
  sourcePathAllowed: () => true,
  conversationIdForPath: (pathname: string) => (pathname === "/t/ghost.jsonl" ? "conversation_ghost" : pathname === "/t/worker.jsonl" ? "conversation_worker" : null),
  deputySeatFor: (conversationId: string) => (conversationId === "conversation_ghost" ? { conversationId: "conversation_seat", path: "/t/seat.jsonl" } : null),
};

test("a lane created by a live deputy has the seat as its creator, and keeps the deputy that made it", () => {
  expect(resolvePipelineCreatorLineage("/t/ghost.jsonl", ports)).toEqual({ lineage: { srcPath: "/t/seat.jsonl", srcConversationId: "conversation_seat", srcDeputyConversationId: "conversation_ghost" } });
});

test("the stored lane names both the seat and the deputy", () => {
  const lineage = resolvePipelineCreatorLineage("/t/ghost.jsonl", ports).lineage!;
  const pipeline = buildPipeline({ id: "p1", task: "t", project: "proj", repoDir: "/repo", stages: [], now: "2026-09-26T12:00:00.000Z", ...lineage });
  expect(pipeline).toMatchObject({ srcConversationId: "conversation_seat", srcDeputyConversationId: "conversation_ghost" });
  /* Anyone else's lane carries no such field. */
  const own = resolvePipelineCreatorLineage("/t/worker.jsonl", ports).lineage!;
  expect("srcDeputyConversationId" in buildPipeline({ id: "p2", task: "t", project: "proj", repoDir: "/repo", stages: [], now: "2026-09-26T12:00:00.000Z", ...own })).toBe(false);
});

test("any other creator keeps its own lineage, and a harness without deputies is unchanged", () => {
  expect(resolvePipelineCreatorLineage("/t/worker.jsonl", ports)).toEqual({ lineage: { srcPath: "/t/worker.jsonl", srcConversationId: "conversation_worker" } });
  const { deputySeatFor: _unused, ...withoutDeputies } = ports;
  expect(resolvePipelineCreatorLineage("/t/ghost.jsonl", withoutDeputies)).toEqual({ lineage: { srcPath: "/t/ghost.jsonl", srcConversationId: "conversation_ghost" } });
});
