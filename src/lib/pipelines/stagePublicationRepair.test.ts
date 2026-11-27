import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelinePorts } from "./engine";
import { openPublicationRepairFixtures } from "./stagePublicationRepair.fixture";

const { close, fixture, reviewedFixture, defaultPipelinePorts, tickPipelines, settlePendingStageGit, savePipelines, findPipelineRecord } = await openPublicationRepairFixtures();
afterAll(close);

test("an accepted head refused by pre-push repairs once on its branch, republishes through the hook and completes", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\ngit show HEAD:src/work.ts | grep -q 'work = 2' && exit 0\necho 'src/work.ts:1: the accepted fixture needs repair' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.current().state).toBe("running");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.text).toContain("pre-push: eslint");
    expect(h.checkpoints[0]).toMatchObject({ state: "passed", verdict: { status: "pass" },
      publicationRepair: { sha: h.accepted, detail: expect.stringContaining("src/work.ts:1"), sendingAt: expect.any(String) } });
    expect(h.current().lastPassedCommit).toBe(h.accepted);
    await h.tick();
    expect(h.pushes()).toBe(1);
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn();
    await h.tick();
    const repaired = h.git("rev-parse", "HEAD");
    expect(repaired).not.toBe(h.accepted);
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: repaired, publishedCommit: repaired });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.verdict).toEqual({ status: "pass", findings: [] });
    expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`)).toStartWith(repaired);
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

test.each(["declined", "deadline", "second refusal"])("an unrepairable publication (%s) parks once with the named refusal", async (kind) => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\necho 'PRIVACY GATE: FAIL: fixture content' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    if (kind === "deadline") h.advance(20 * 60_000);
    else h.endTurn(kind === "declined" ? '```json\n{"status":"fail","blocked":true,"blockedReason":"outside the producer scope"}\n```' : "no change can answer it");
    await h.tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().runs[0]!.attempts[0]!).toMatchObject({ state: "passed", verdict: { status: "pass" } });
    const detail = h.current().stateDetail!;
    // The first line keeps the cause and the action a person takes.
    expect(detail.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "privacy" phase');
    expect(detail).toContain("PRIVACY GATE: FAIL: fixture content");
    expect(detail).toContain(kind === "declined" ? "outside the producer scope" : kind === "deadline" ? "delivery unknown failed" : "privacy");
    await h.tick();
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(kind === "second refusal" ? 2 : 1);
  } finally { h.cleanup(); }
});

test("publication repair can rewrite its own refused metadata without restoring the refused commit as a parent", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\ntest \"$(git log -1 --format=%s)\" = 'safe metadata' && exit 0\necho 'identity check refused the accepted commit message' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    h.git("commit", "-q", "--amend", "-m", "safe metadata");
    h.endTurn(); await h.tick();
    expect(h.current().state).toBe("completed");
    expect(h.current().lastPassedCommit).toBe(h.git("rev-parse", "HEAD"));
    expect(h.git("rev-list", "HEAD").split("\n")).not.toContain(h.accepted);
    expect(h.git("rev-parse", "HEAD^" )).toBe(h.base);
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

test.each([false, true])("a repaired reviewed tree returns to its exact-head gate and retains its budget activation (%s)", async (budgetRecheck) => {
  const h = fixture();
  try {
    reviewedFixture(h, budgetRecheck);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\ngit show HEAD:src/work.ts | grep -q 'work = 2' && exit 0\necho 'src/work.ts:1: repair required' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.conversationId).toBe("conversation_producer");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn();
    // Settle via the public Git executor without launching the pending gate.
    await settlePendingStageGit(h.ports);
    const ready = h.current();
    expect(ready.cursor).toMatchObject({ stageId: "review", state: "committing" });
    const { publishPipelineBranch } = await import("./git");
    expect((await publishPipelineBranch(ready, h.ports.exec, { acceptedSha: ready.lastPassedCommit })).ok).toBe(true);
    await settlePendingStageGit(h.ports);
    const pending = h.current();
    expect(pending.state).toBe("running");
    expect(pending.cursor).toMatchObject({ stageId: "review", state: "pending",
      activatedBy: { stageId: "build", attempt: 1, edge: "pass", ...(budgetRecheck ? { budgetRecheck: true } : {}) } });
    expect(pending.runs[1]!.attempts[0]!).toMatchObject({ state: "passed", reviewHeadSha: h.accepted, reviewedHead: h.accepted });
    expect(pending.lastPassedCommit).not.toBe(h.accepted);
    expect(pending.publishedCommit).toBe(pending.lastPassedCommit);
  } finally { h.cleanup(); }
});

test("a repair commit refusal remains consumed if final park settlement is lost", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    const commitHook = path.join(h.root, "repo/.git/hooks/pre-commit");
    const marker = path.join(h.root, "commit-calls");
    fs.writeFileSync(commitHook, `#!/bin/sh\necho called >> '${marker}'\necho 'pre-commit: repair still invalid' >&2\nexit 1\n`, { mode: 0o700 });
    // Replay this settlement before a controller tick can start a new producer.
    h.endTurn(); await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().runs[0]!.attempts[0]!.publicationRepair?.outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("repair still invalid") });
    // Bun's toMatchObject writes its matchers into the received object, so clear the park on a fresh read.
    const rejected = h.current();
    rejected.state = "running"; rejected.stateDetail = null;
    rejected.runs[0]!.attempts[0]!.state = "passed";
    savePipelines([rejected]);
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "eslint" phase');
    expect(h.current().stateDetail).toContain("repair still invalid");
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("publication repair refuses a foreign checkout before committing any of its work", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    h.git("checkout", "-q", "-b", "foreign");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    Object.assign(h.ports, { engineReadiness: undefined, resolveProjectSpawn: undefined,
      structuredDeliveryPublication: () => "ready", cpuPressureHold: () => null });
    h.endTurn(); await h.tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    expect(h.git("status", "--porcelain")).toContain("src/work.ts");
    expect(h.current().stateDetail!.split("\n")[0]).toStartWith('publishing the passed stage: the repository\'s pre-push hook failed in its "eslint" phase');
    expect(h.current().stateDetail).toContain("not on its pipeline or delivery branch");
  } finally { h.cleanup(); }
});

test("an explicit publication retry can recover a declined repair without another repair turn", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"the hook requires an infrastructure fix"}\n```');
    await h.tick();
    expect(h.current().state).toBe("needs_decision");
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.accepted, publishedCommit: h.accepted });
    expect(h.requests).toHaveLength(1);
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
  } finally { h.cleanup(); }
});

test("a refusal of an accepted head that changes no files retries three times and parks without a repair turn", async () => {
  const h = fixture({ emptyAccepted: true });
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: Linux tests' >&2\necho '(fail) x' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    for (const minutes of [1, 5, 15]) {
      expect(h.current().state).toBe("running");
      h.advance(minutes * 60_000);
      await h.tick();
    }
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"nothing to repair"}\n```');
    await h.tick();
    const current = h.current();
    expect(current.state).toBe("needs_decision");
    expect(current.stateDetail!.split("\n")[0]).toBe("publishing the passed stage: the repository's pre-push hook failed in its \"Linux tests\" phase"
      + " (exit 1, 1 failing test, first: x). The stage changed no files; retried 3 times, so the cause is on the base branch or in the hook itself: fix it there, then retry-stage.");
    expect(current.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
    expect(h.requests).toHaveLength(0);
    expect(h.pushes()).toBe(4);
  } finally { h.cleanup(); }
});

test.each(["unreserved", "failed", "gone", "unavailable", "completed-gone", "running", "busy", "changed", "conflict"] as const)("retry-stage preserves the accepted head and replaces an unreachable producer: %s", async shape => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: eslint' >&2\necho 'src/work.ts:1: repair required' >&2\nexit 1\n", { mode: 0o700 });
    h.ports.resumeSeveredTurn = async () => false;
    await h.tick();
    h.advance(21 * 60_000);
    // Stop at the publication park; the next full tick now auto-repairs it.
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    const original = structuredClone(h.current().runs[0]!.attempts[0]!);
    if (shape === "gone") h.git("commit", "-q", "--allow-empty", "-m", "producer repair before host loss");
    const retainedHead = h.git("rev-parse", "HEAD");
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "override-stage", stageId: "build", prompt: "Repair the named publication failure using the current instructions." }, h.ports)).error).toBeUndefined();
    const restarted = spawnSync(process.execPath, ["-e", `
      const { defaultPipelinePorts, patchPipeline } = await import("./src/lib/pipelines/engine");
      const ports: PipelinePorts = { ...defaultPipelinePorts(), now: () => "2026-10-11T04:23:00.000Z",
        conversationAgentActive: async () => ${shape === "running" ? "true" : ["gone", "unavailable", "completed-gone", "conflict"].includes(shape) ? "false" : "null"},
        publicationRepairProducerGone: async () => ${["gone", "unavailable", "completed-gone"].includes(shape) ? "true" : "null"},
        conversationTurnInterrupted: async () => ${["gone", "unavailable"].includes(shape) ? JSON.stringify("dead") : "null"},
        conversationDeliveryOutstanding: () => ${shape === "conflict"},
        durableTurnEvidence: async () => ({ turn: "${shape === "busy" ? "busy" : "terminal"}",
          lastRecordAt: Date.parse("${shape === "busy" ? "2026-10-11T04:23:00.000Z" : "2026-10-11T04:01:00.000Z"}"),
          message: { text: "accepted", ts: Date.parse("2026-10-11T04:01:00.000Z") } }),
        stageRepairDelivery: async () => {
          ${shape === "changed" ? `const { findPipelineRecord, savePipelines } = await import("./src/lib/pipelines/store");
          const lane = findPipelineRecord(${JSON.stringify(h.lane.id)});
          lane.runs[0].attempts[0].startedAt = "2026-10-11T04:00:01.000Z";
          savePipelines([lane]);` : ""}
          return { operationId: ${["failed", "conflict"].includes(shape) ? JSON.stringify("failed-repair") : "null"},
            state: "${["failed", "conflict"].includes(shape) ? "failed" : ["gone", "unavailable"].includes(shape) ? "unavailable" : "unreserved"}", safeToReplace: ${shape !== "conflict"} };
        },
      };
      console.log(JSON.stringify(await patchPipeline(${JSON.stringify(h.lane.id)}, { action: "retry-stage" }, ports)));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(restarted.status, restarted.stderr).toBe(0);
    const answer = JSON.parse(restarted.stdout);
    if (shape === "running" || shape === "busy" || shape === "changed" || shape === "conflict") {
      expect(answer.error).toContain("may still be running");
      expect(h.current().cursor?.state).toBe("committing");
      return;
    }
    expect(answer.error).toBeUndefined();
    const next = h.current();
    expect(next.cursor).toMatchObject({ stageId: "build", state: "pending" });
    expect(next.cursor!.input).toContain("src/work.ts:1: repair required");
    expect(next.stages[0]!.prompt).toContain("current instructions");
    expect(next.runs[0]!.attempts).toHaveLength(2);
    expect(next.runs[0]!.attempts[1]!).toMatchObject({ n: 2, state: "pending", input: next.cursor!.input });
    expect(next.lastPassedCommit).toBe(h.accepted);
    expect(h.git("rev-parse", "HEAD")).toBe(retainedHead);
    expect(h.git("merge-base", h.accepted, retainedHead)).toBe(h.accepted);
    expect(next.runs[0]!.attempts[0]!.report).toEqual(original.report);
    expect(next.runs[0]!.attempts[0]!.verdict).toEqual(original.verdict);
    expect(h.pushes()).toBe(1);
    let spawnedPrompt = "";
    const spawnPorts: PipelinePorts = { ...h.ports, engineReadiness: undefined, resolveProjectSpawn: undefined,
      cpuPressureHold: () => null,
      structuredDeliveryPublication: () => "ready",
      spawnAgent: async (input, onReserved) => {
        spawnedPrompt = input.prompt;
        await onReserved({ launchId: "replacement-launch", conversationId: "conversation_replacement", accountId: null });
        return { launchId: "replacement-launch", conversationId: "conversation_replacement", sessionId: "replacement-session",
          paneId: null, transcript: path.join(h.root, "replacement.jsonl"), accountId: null };
      },
    };
    for (let n = 0; n < 3 && !spawnedPrompt; n++) await tickPipelines([], spawnPorts);
    expect(spawnedPrompt, h.current().stateDetail ?? "replacement was not dispatched").toContain("Repair the named publication failure using the current instructions.");
    expect(spawnedPrompt).toContain("src/work.ts:1: repair required");
    expect(h.current().runs[0]!.attempts).toHaveLength(2);
  } finally { h.cleanup(); }
});
