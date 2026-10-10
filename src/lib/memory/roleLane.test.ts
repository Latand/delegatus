import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* The acceptance path of role memory through the real pipeline engine, every
   port a mock and the state directory private to this file: a review finds a
   defect, its fixer is asked for a lesson and leaves an abstract rule, a fresh
   builder of the same project starts with that rule, reviewers get nothing,
   and the installation's kill switch stops both writing and injection. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-lane-"));
const { createPipelineFromRequest, reportStageCompletion, tickPipelines } = await import("@/lib/pipelines/engine");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
const { leaveLessonForConversation, lessonRequestForReport } = await import("./roleStage");
type PipelinePorts = import("@/lib/pipelines/engine").PipelinePorts;
type SpawnInput = Parameters<PipelinePorts["spawnAgent"]>[0];

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const HEAD = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
const PROJECT = "role-memory-trial";
const RULE = "When a change adds a branch for empty or missing input, write the test for that branch in the same commit as the branch.";
const agent = (conversationId: string) => ({ kind: "agent", role: "builder", conversationId }) as const;

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: PROJECT, title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

const spawned: SpawnInput[] = [];
const messages = new Map<string, { text: string; ts: number }>();
let clock = 1_000_000;
const ports: PipelinePorts = {
  exec: async (command, args) => {
    if (command === "timeout") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "https://forge.example/repo.git\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  },
  preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
  roleLookup: (roleId) => roleId === "builder"
    ? { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" }
    : roleId === "reviewer" ? { engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-only", promptScaffold: "Reviewer guidance" }
    : null,
  spawnReceipt: () => null,
  claimSpawnRetry: () => "claimed",
  spawnAgent: async (input, onReserved) => {
    spawned.push(input as SpawnInput);
    const n = spawned.length;
    onReserved({ launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, accountId: "account-a" });
    return { launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, sessionId: `session-${n}`, transcript: `/codex/stage-${n}.jsonl`, paneId: `%${n}`, accountId: "account-a" };
  },
  paneAgentAlive: async () => false,
  stopStageAgent: async () => ({ outcome: "not-running" }),
  stopStagePane: async () => ({ outcome: "stopped" }),
  stageHostResident: async () => false,
  monotonicNow: () => Date.now(),
  worktreePresent: () => true,
  conversationAgentActive: async () => null,
  durableTurnEvidence: async (_engine, pathname) => {
    const message = messages.get(pathname);
    return message ? { turn: "terminal", message, lastRecordAt: message.ts } : null;
  },
  headCwd: () => loadPipelines().at(-1)?.worktreeDir ?? null,
  lastMessage: (item) => messages.get(item.path) ?? null,
  pathForConversation: (id) => {
    const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
    return n ? `/codex/stage-${n}.jsonl` : null;
  },
  sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
  conversationIdForPath: (pathname) => {
    if (pathname === "/codex/creator.jsonl") return "conversation_creator";
    const n = /stage-(\d+)\.jsonl$/.exec(pathname)?.[1];
    return n ? `conversation_stage_${n}` : null;
  },
  pipelineAdoptionCandidates: () => [],
  createFlow: async () => ({ error: "no review flows in this suite" }),
  patchFlow: () => ({}),
  closeFlow: async () => ({}),
  getFlow: () => null,
  findFlow: () => null,
  projectForCwd: () => PROJECT,
  now: () => new Date((clock += 1_000)).toISOString(),
};

const conversation = (n: number) => `conversation_stage_${n}`;
const lane = (id: string) => loadPipelines().find((pipeline) => pipeline.id === id)!;
/** Stage `n` reports and its turn ends. */
async function settle(n: number, verdict: "pass" | "fail", findings: { severity: "P1" | "P2"; text: string }[] = []) {
  const reported = await reportStageCompletion({ verdict, summary: `${verdict} from ${n}`, ...(findings.length ? { findings } : {}) }, agent(conversation(n)), ports);
  expect(reported.error).toBeUndefined();
  return reported;
}
async function endTurn(n: number, text = "Done.") {
  const pathname = `/codex/stage-${n}.jsonl`;
  messages.set(pathname, { text, ts: clock + 100_000 });
  await tickPipelines([entry(pathname)], ports);
}
async function create(stages: unknown[]): Promise<string> {
  const created = await createPipelineFromRequest({ task: "Role memory trial", publication: "internal", spec: "parseSize returns null for empty input", repoDir: "/repo", stages: stages as never, src: "/codex/creator.jsonl" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  return created.pipeline.id;
}
const builderLane = () => create([{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Add parseRate", next: null }]);

test("a review's finding becomes the fixer's abstract rule, a fresh builder starts with it, reviewers stay clean, and the kill switch stops both", async () => {
  savePipelines([]);
  const first = await create([
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review src/size.ts", next: null, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "Fix the findings below.\n\n{{prev.output}}", next: "recheck" },
    { id: "recheck", kind: "run", role: { roleId: "reviewer" }, prompt: "Review src/size.ts again", next: null },
  ]);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn the review

  /* The reviewer starts clean, is asked for nothing, and cannot leave a lesson. */
  expect(spawned[0]!.role.roleId).toBe("reviewer");
  expect(spawned[0]!.learnedRules ?? null).toBeNull();
  expect(spawned[0]!.cleanMemory).toBe(true);
  await settle(1, "fail", [{ severity: "P2", text: "parseSize(\"\") throws instead of returning null, and the branch has no test." }]);
  expect(lessonRequestForReport(lane(first), "review", 1, conversation(1))).toBeNull();
  expect(() => leaveLessonForConversation(loadPipelines(), conversation(1), { lessons: [{ scope: "project", rule: RULE, why: "x" }] })).toThrow(/stays clean/);
  await endTurn(1);
  await tickPipelines([], ports);

  /* The fixer starts with the (still empty) block that tells it a lesson will be asked for. */
  expect(spawned[1]!.role.roleId).toBe("builder");
  expect(spawned[1]!.cleanMemory).toBeUndefined();
  expect(spawned[1]!.learnedRules).toContain("none yet");
  expect(spawned[1]!.learnedRules).toContain("leave_lesson");
  await settle(2, "pass");
  const requestLines = lessonRequestForReport(lane(first), "fix", 1, conversation(2));
  expect(requestLines?.join("\n")).toContain("This attempt was handed 1 finding from stage review (P2 ×1). Start there.");
  expect(requestLines?.join("\n")).toContain("abstract rule");
  expect(lessonRequestForReport(lane(first), "fix", 1, conversation(2))).toBeNull();
  const left = leaveLessonForConversation(loadPipelines(), conversation(2), { lessons: [{ scope: "role", rule: RULE, why: "Review failed on an untested empty-input path." }] });
  expect(left).toMatchObject({ pipelineId: first, stageId: "fix", attempt: 1, left: [{ scope: `role:${PROJECT}:builder`, state: "active" }] });
  await endTurn(2);
  await tickPipelines([], ports);

  /* The recheck is a reviewer: no block, and no rule text anywhere in its launch. */
  expect(spawned[2]!.role.roleId).toBe("reviewer");
  expect(spawned[2]!.learnedRules ?? null).toBeNull();
  expect(spawned[2]!.prompt).not.toContain(RULE);

  /* A fresh builder of the same project starts with the rule, labelled as learned. */
  savePipelines([]);
  await builderLane();
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  const fresh = spawned.at(-1)!;
  expect(fresh.role.roleId).toBe("builder");
  expect(fresh.learnedRules).toContain("Learned rules (Delegatus role memory)");
  expect(fresh.learnedRules).toContain("Role rules · Builder on this project");
  /* Role, project and machine rules arrive together, as three labelled groups. */
  expect(fresh.learnedRules).toContain("Project rules · every role on this project");
  expect(fresh.learnedRules).toContain("Machine rules · every project on this machine");
  expect(fresh.learnedRules).toContain(RULE);
  /* The text reaches the launch only: no persisted pipeline record holds it. */
  expect(fresh.prompt).not.toContain(RULE);
  expect(JSON.stringify(loadPipelines())).not.toContain(RULE);

  /* The installation's kill switch: the next builder gets nothing, and nothing more is written. */
  process.env.LLV_ROLE_MEMORY = "off";
  savePipelines([]);
  const third = await builderLane();
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  const off = spawned.at(-1)!;
  expect(off.role.roleId).toBe("builder");
  expect(off.learnedRules ?? null).toBeNull();
  const n = spawned.length;
  await settle(n, "pass");
  expect(lessonRequestForReport(lane(third), "build", 1, conversation(n))).toBeNull();
  expect(() => leaveLessonForConversation(loadPipelines(), conversation(n), { lessons: [{ scope: "role", rule: RULE, why: "x" }] })).toThrow(/switched off/);
  delete process.env.LLV_ROLE_MEMORY;
});

test("a stored lesson the fixer quotes never reaches the review gate it relays to, and a gate of any role is clean", async () => {
  /* The rule stored by the test above; the pipeline keeps the report as written. */
  savePipelines([]);
  const id = await create([
    { id: "gate", kind: "run", role: { roleId: "builder" }, prompt: "Judge src/size.ts. Earlier work:\n\n{{prev.output}}", next: null, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "Fix the findings below.\n\n{{prev.output}}", next: null },
  ]);
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  /* A builder-named stage that routes a fail edge is a review gate: clean like a reviewer. */
  const gate = spawned.at(-1)!;
  expect(gate.role.roleId).toBe("builder");
  expect(gate.cleanMemory).toBe(true);
  expect(gate.learnedRules ?? null).toBeNull();
  let n = spawned.length;
  await settle(n, "fail", [{ severity: "P2", text: "parseSize(\"\") still throws." }]);
  expect(lessonRequestForReport(lane(id), "gate", 1, conversation(n))).toBeNull();
  await endTurn(n);
  await tickPipelines([], ports);

  n = spawned.length;
  const quoted = `Fixed. Following ${RULE.toUpperCase().replaceAll(" ", "  ")} as the learned rule says.`;
  const reported = await reportStageCompletion({ verdict: "pass", summary: quoted }, agent(conversation(n)), ports);
  expect(reported.error).toBeUndefined();
  await endTurn(n, `${quoted}\n\nThe rule was: ${RULE}`);
  await tickPipelines([], ports);

  /* The gate judges the fix with the fixer's report relayed into its prompt. */
  const recheck = spawned.at(-1)!;
  expect(spawned.length).toBe(n + 1);
  expect(recheck.role.roleId).toBe("builder");
  expect(recheck.cleanMemory).toBe(true);
  expect(recheck.learnedRules ?? null).toBeNull();
  expect(recheck.prompt).toContain("[learned rule]");
  expect(recheck.prompt.toLowerCase()).not.toContain("write the test for that branch");
  /* The local record keeps what the fixer wrote. */
  expect(JSON.stringify(lane(id))).toContain(RULE.toUpperCase().replaceAll(" ", "  "));
});
