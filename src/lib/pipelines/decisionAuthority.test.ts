import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { persistProjectAliases } from "@/lib/projects/aliases";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { continueReviewActorRefusal, decisionAnswerActorRefusal, patchPipeline, type PipelinePorts } from "./engine";
import { buildPipeline, loadPipelines, savePipelines } from "./store";

const AT = "2026-10-02T14:28:00.000Z";
const agent = (conversationId: string | null, role = "builder"): PauseResumeActor => ({ kind: "agent", conversationId, role });
let sandbox: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-decision-authority-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function designate(project: string, conversationId: string) {
  const clientRequestId = `seat-${conversationId}`;
  expect(beginOrchestratorSeatIntent({ project, clientRequestId, mode: "spawn", mandate: "Run the project", now: AT }).kind).toBe("begun");
  expect(completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null, now: AT }).kind).toBe("activated");
}

const cases: { name: string; creator: string | null; actor: PauseResumeActor | null; allowed: boolean }[] = [
  { name: "rotation successor answers predecessor", creator: "conversation_old", actor: agent("conversation_current"), allowed: true },
  { name: "current seat answers its own lane", creator: "conversation_current", actor: agent("conversation_current"), allowed: true },
  { name: "revoked creator is refused", creator: "conversation_old", actor: agent("conversation_old"), allowed: false },
  { name: "worker is refused", creator: "conversation_old", actor: agent("conversation_worker"), allowed: false },
  { name: "another project's seat is refused", creator: "conversation_old", actor: agent("conversation_other"), allowed: false },
  { name: "unidentified caller is refused", creator: "conversation_old", actor: null, allowed: false },
  { name: "unidentified agent is refused", creator: "conversation_old", actor: agent(null), allowed: false },
  { name: "claimed role grants nothing", creator: "conversation_old", actor: agent("conversation_worker", "orchestrator"), allowed: false },
  { name: "current seat cannot take a worker's lane", creator: "conversation_worker", actor: agent("conversation_current"), allowed: false },
  { name: "current seat cannot take another project's creator", creator: "conversation_other", actor: agent("conversation_current"), allowed: false },
  { name: "missing creator grants nothing", creator: null, actor: agent("conversation_current"), allowed: false },
  { name: "ordinary creator retains authority", creator: "conversation_worker", actor: agent("conversation_worker"), allowed: true },
  { name: "direct operator retains authority", creator: "conversation_old", actor: { kind: "operator" }, allowed: true },
];

for (const action of ["resolve-decision", "continue-review", "accept-head"] as const) {
  test.each(cases)(`${action}: $name (aliased project)`, async ({ creator, actor, allowed }) => {
    designate("project-legacy", "conversation_old");
    // Alias after the old seat was recorded, as when a repository gains an origin.
    persistProjectAliases([{ source: "project-legacy", target: "project-current", displayName: "Project" }]);
    designate("project-current", "conversation_current");
    designate("project-other", "conversation_other");
    const pipeline = buildPipeline({ id: "authority-lane", task: "Decision authority", project: "project-legacy", repoDir: "/repo", state: "draft", stages: [], srcPath: null, now: AT, srcConversationId: creator });
    savePipelines([pipeline]);
    const before = loadPipelines();
    // Exercise both the MCP pre-receipt gate and the actual action dispatch.
    const refusal = action === "resolve-decision"
      ? decisionAnswerActorRefusal(pipeline, actor, "answer")
      : continueReviewActorRefusal(pipeline, actor);
    expect(refusal?.status ?? null).toBe(allowed ? null : 403);
    // Missing fences reach validation only for an authorized actor.
    const result = await patchPipeline(pipeline.id, { action }, { now: () => AT } as PipelinePorts, actor);
    expect(result.status).toBe(allowed ? 400 : 403);
    expect(loadPipelines()).toEqual(before);
  });
}

test("unreadable server seat records fail closed for agents", () => {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), "{broken");
  const pipeline = buildPipeline({ id: "p", task: "t", project: "project", repoDir: "/repo", state: "draft", stages: [], srcPath: null, now: AT, srcConversationId: "conversation_creator" });
  expect(decisionAnswerActorRefusal(pipeline, agent("conversation_creator"), "answer")?.status).toBe(403);
  expect(continueReviewActorRefusal(pipeline, agent("conversation_creator"))?.status).toBe(403);
  expect(decisionAnswerActorRefusal(pipeline, { kind: "operator" }, "answer")).toBeNull();
});

test("a creator seat revoked in its project stays refused after taking another project's seat", async () => {
  designate("project-a", "conversation-x");
  designate("project-a", "conversation-y");
  designate("project-b", "conversation-x");
  const pipeline = buildPipeline({ id: "lane-a", task: "Decision", project: "project-a", repoDir: "/repo", state: "draft", stages: [], srcPath: null, now: AT, srcConversationId: "conversation-x" });
  savePipelines([pipeline]);
  const before = loadPipelines();

  for (const action of ["resolve-decision", "continue-review", "accept-head"] as const) {
    expect(await patchPipeline(pipeline.id, { action }, { now: () => AT } as PipelinePorts, agent("conversation-x")).then(result => result.status)).toBe(403);
    expect(loadPipelines()).toEqual(before);
  }
});

test("an alias preserves seat creator lineage after independent project designations", async () => {
  designate("project-legacy", "conversation-x");
  designate("project-current", "conversation-y");
  const pipeline = buildPipeline({ id: "lane-legacy", task: "Decision", project: "project-legacy", repoDir: "/repo", state: "draft", stages: [], srcPath: null, now: AT, srcConversationId: "conversation-x" });
  savePipelines([pipeline]);

  persistProjectAliases([{ source: "project-legacy", target: "project-current", displayName: "Project" }]);
  // A later seat write normalizes the aliased rows on disk; the creator proof
  // must survive that write instead of depending on the old source key.
  designate("project-unrelated", "conversation-unrelated");
  const storedSeats = JSON.parse(fs.readFileSync(path.join(sandbox, "orchestrator-seats.json"), "utf8")) as { seatLineage?: { project: string; conversationId: string }[] };
  expect(storedSeats.seatLineage).toContainEqual(expect.objectContaining({ project: "project-current", conversationId: "conversation-x", seatEpoch: expect.any(Number) }));
  const before = loadPipelines();
  for (const action of ["resolve-decision", "continue-review", "accept-head"] as const) {
    const current = agent("conversation-y");
    expect(await patchPipeline(pipeline.id, { action }, { now: () => AT } as PipelinePorts, current).then(result => result.status)).toBe(400);
    expect(await patchPipeline(pipeline.id, { action }, { now: () => AT } as PipelinePorts, agent("conversation-worker")).then(result => result.status)).toBe(403);
    expect(loadPipelines()).toEqual(before);
  }
});
