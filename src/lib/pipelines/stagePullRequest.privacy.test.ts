import { expect, test } from "bun:test";
import { ensureStagePullRequest, inspectPullRequestText } from "./stagePullRequest";
import { fs, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported } from "./engine.fixture";
import { REMOTE, isBodyPatch, fixture, originalBudgetBody, fixSummary, finalBudgetFixFixture, unsafeSummary, publicSummary, rewritingFixture, inspectionFixture } from "./stagePullRequest.fixture";


test("a legacy privacy rewrite checkpoint removes the old terminal marker before report delivery and survives restart", async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.worktree, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(f.worktree, "scripts/privacy-publication-gate.ts"), "// Controlled privacy gate fixture.\n");
    const initialExec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")
      ? { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" }
      : initialExec(command, args, cwd, env, options);
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"), path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json"));
    await f.git(f.worktree, "add", "scripts");
    await f.commit(); f.setExisting();
    await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    delete current.publication;
    current.stages[1]!.outputs = ["review.md"];
    current.runs[0]!.attempts[0]!.paneId = null;
    savePipelines([current]);
    f.setMissing();
    await tickPipelines([], f.h.ports);
    fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    const publishedHead = await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`);
    f.setRefused();
    f.setExpectedBody("Review passed.");
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed.", result: "Review result", taskSummary: { headline: "Reviewed", text: "Review complete." } },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const legacyRefusal = loadPipelines().find(p => p.id === f.id)!;
    const owner = legacyRefusal.runs[1]!.attempts[0]!;
    expect(owner.terminalOutputPublication).toMatchObject({ pullRequestHead: publishedHead });
    expect(owner.terminalOutputPublication!.localSha).not.toBe(publishedHead);
    const localReportSha = owner.terminalOutputPublication!.localSha;

    const originalExec = f.h.ports.exec;
    let gateCalls = 0;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) gateCalls++;
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts") && args.at(-1)?.endsWith("body.md"))
        return { code: 1, stdout: "PRIVACY GATE: FAIL\nknown_value: 1\n", stderr: "" };
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts"))
        return { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" };
      return originalExec(command, args, cwd, env, options);
    };
    f.setRefused(false); f.setMissing(); f.setExpectedBody(publicSummary);
    expect(fs.existsSync(path.join(f.worktree, "scripts/privacy-publication-gate.ts"))).toBe(true);
    f.h.ports.resumeSeveredTurn = async () => {
      const report = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
        { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
      expect(report.error).toBeUndefined();
      f.h.setConversationActive(false);
      const checkpoint = loadPipelines().find(p => p.id === f.id)!;
      const saved = checkpoint.runs[1]!.attempts[0]!;
      expect(saved.publicationTextRepair).toMatchObject({ state: "answered", sha: localReportSha });
      expect(saved.report?.result).toBe("Review result");
      expect(saved.report?.taskSummary).toEqual({ headline: "Reviewed", text: "Review complete." });
      expect(saved.terminalOutputPublication).toBeUndefined();
      expect(checkpoint.lastPassedCommit).toBe(localReportSha);
      return true;
    };
    expect((await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);

    const checkpoint = loadPipelines().find(p => p.id === f.id)!;
    const checkpointAttempt = checkpoint.runs[1]!.attempts[0]!;
    expect(gateCalls).toBeGreaterThan(0);
    expect(checkpointAttempt.publicationTextRepair).toMatchObject({ state: "answered", pullRequestHead: publishedHead });
    expect(checkpointAttempt.terminalOutputPublication).toBeUndefined();

    const reload = await realExec(process.execPath, ["-e", `
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { defaultPipelinePorts, settlePendingStageGit } = await import("@/lib/pipelines/engine");
      const { realExec } = await import("@/lib/workflows/provision");
      const lane = loadPipelines().find(item => item.id === ${JSON.stringify(f.id)});
      const attempt = lane.runs[1].attempts[0];
      const head = attempt.publicationTextRepair.pullRequestHead;
      const branch = lane.delivery.target.branch.replace(/^refs\\/heads\\//, "");
      const at = Date.parse(attempt.publicationTextRepair.answeredAt) + 1_000;
      await settlePendingStageGit({ ...defaultPipelinePorts(), now: () => new Date(at).toISOString(),
        conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: { ts: at, text: "Rewrite completed." } }),
        exec: async (command, args, cwd, env, options) => command === "gh"
          ? { code: 0, stdout: JSON.stringify([{ number: 17, headRefName: branch, baseRefName: lane.baseBranch,
            state: "OPEN", isCrossRepository: false, headRefOid: head }]), stderr: "" }
          : realExec(command, args, cwd, env, options) });
      const settled = loadPipelines().find(item => item.id === ${JSON.stringify(f.id)});
      const saved = settled.runs[1].attempts[0];
      console.log(JSON.stringify({ state: settled.state, lastPassedCommit: settled.lastPassedCommit,
        repair: saved.publicationTextRepair, terminalOutputPublication: saved.terminalOutputPublication,
        pullRequest: settled.delivery.target.pr }));
    `], process.cwd(), process.env, { timeoutMs: 15_000 });
    expect(reload.code, reload.stderr).toBe(0);
    const persisted = JSON.parse(reload.stdout.trim());
    expect(persisted.state).toBe("completed");
    expect(persisted.pullRequest).toBe(17);
    expect(persisted.terminalOutputPublication).toBeUndefined();
    expect(persisted.lastPassedCommit).toBe(localReportSha);

    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.state).toBe("completed");
    expect(done.runs[1]!.attempts[0]!.terminalOutputPublication).toBeUndefined();
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`)).toBe(publishedHead);
  } finally { f.close(); }
});


test("C: summary fingerprint inspection lets an independent scheduler advance", async () => {
  const { pipelinePublicationTextSafe } = await import("./git");
  let progressed = 0;
  let heartbeat: ReturnType<typeof setImmediate>;
  const tick = () => { progressed++; heartbeat = setImmediate(tick); };
  heartbeat = setImmediate(tick);
  try {
    const inspected = await pipelinePublicationTextSafe("Public implementation detail. ".repeat(100));
    expect(progressed).toBeGreaterThan(1);
    expect(inspected).not.toBeNull();
  } finally { clearImmediate(heartbeat); }
});



test.each(["fork", "head", "ambiguous"] as const)("C: an unrelated PR result is refused (%s)", async shape => {
  const f = await fixture();
  try {
    await f.commit(); f.setPrShape(shape);
    const p = await f.finish();
    expect(p.state).toBe("needs_decision"); expect(p.delivery?.target.pr).toBeUndefined();
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(0);
  } finally { f.close(); }
}, 40_000);



test("C: a publishing delivery without a supported PR service cannot pass", async () => {
  const f = await fixture();
  try {
    const p = loadPipelines().find(p => p.id === f.id)!;
    p.lastPassedCommit = "1".repeat(40);
    p.delivery!.target.remote = "https://forge.invalid/example/widgets.git";
    const { ensureStagePullRequest } = await import("./stagePullRequest");
    const result = await ensureStagePullRequest(p, p.runs[0]!.attempts[0]!, realExec);
    expect(result.ok).toBe(false);
  } finally { f.close(); }
});



test.each(([
  ["body", "/home/" + "private-user/evidence", "absolute-path"],
  ["title", ["someone", "private.invalid"].join("@"), "email"],
  ["body", "ghp_" + "A".repeat(36), "credential"],
  ["body", "%" + "25".repeat(20) + "41", "decode"],
  ["body", "", "size"],
  ["body", "a".repeat(60 * 1024 + 1), "size"],
] as const).map(([part, value, kind], index) => ({ part, value, kind, index })))("PR text diagnostic redacts $part/$kind ($index)", async ({ part, value, kind }) => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const result = await inspectPullRequestText(part, value);
  expect(result).toMatchObject({ ok: false, privacy: { part, kind } });
  if (!result.ok) {
    expect(result.error).toContain("[redacted]");
    if (value) expect(result.error).not.toContain(value);
  }
});


test("PR summary rewrite preserves attempt, accepted SHA, verdict and provenance", async () => {
  const f = await rewritingFixture();
  try {
    const initial = f.initial;
    expect(initial.state).toBe("running");
    expect(initial.stateDetail).toContain("absolute-path");
    expect(initial.runs[0]!.attempts[0]!.error).toContain("body [redacted]");
    const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
    const events = projectPipelineEvents([initial]);
    const refusal = events.find(event => event.key.includes("summary-rewrite:"))!;
    const { isTerminalHighSignalEvent } = await import("@/lib/lifecycle/vocabulary");
    expect(refusal.summary).toContain("absolute-path");
    expect(isTerminalHighSignalEvent(refusal.type)).toBe(true); // The seat's actual wake filter.
    const answered = structuredClone(initial);
    answered.runs[0]!.attempts[0]!.publicationTextRepair!.state = "answered";
    expect(projectPipelineEvents([answered]).find(event => event.key === refusal.key)?.summary).toBe(refusal.summary);
    const exhausted = structuredClone(initial);
    exhausted.runs[0]!.attempts[0]!.publicationTextRepair!.state = "exhausted";
    const exhaustedRefusal = projectPipelineEvents([exhausted]).find(event => event.key.includes("summary-rewrite:"))!;
    expect(exhaustedRefusal.key).not.toBe(refusal.key);
    expect(isTerminalHighSignalEvent(exhaustedRefusal.type)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(unsafeSummary);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.text).toContain("absolute-path");
    expect(f.sends[0]!.text).not.toContain(unsafeSummary);
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
    const original = structuredClone(initial.runs[0]!.attempts[0]!.report!);
    f.setExpectedBody(publicSummary);
    const done = await f.answer(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.lastPassedCommit).toBe(initial.lastPassedCommit);
    expect(done.runs[0]!.attempts).toHaveLength(1);
    const report = done.runs[0]!.attempts[0]!.report!;
    expect(report.verdict).toEqual(original.verdict);
    expect(report.provenance).toEqual(original.provenance);
    expect(report.summary).toBe(publicSummary);
    expect(f.calls.filter(call => call[1] === "create")).toHaveLength(1);
  } finally { f.close(); }
});


test("two refused summary rewrites park with the class; retry-stage asks again on the same attempt", async () => {
  const f = await rewritingFixture();
  try {
    await f.answer(unsafeSummary);
    expect(f.sends).toHaveLength(2);
    const exhausted = await f.answer(unsafeSummary);
    expect(exhausted.state).toBe("needs_decision");
    expect(exhausted.stateDetail).toContain("absolute-path");
    expect(exhausted.stateDetail).toContain("budget exhausted");
    expect(f.sends).toHaveLength(2);
    const retried = await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports);
    expect(retried.error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(3);
    expect(f.sends[2]!.clientMessageId).not.toBe(f.sends[0]!.clientMessageId);
    f.setExpectedBody(publicSummary);
    const done = await f.answer(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.runs[0]!.attempts).toHaveLength(1);
    expect(done.lastPassedCommit).toBe(exhausted.lastPassedCommit);
  } finally { f.close(); }
});


test("a refused task title asks the seat to correct it and sends no producer rewrite", async () => {
  const f = await fixture(unsafeSummary);
  try {
    const sends: string[] = [];
    f.h.ports.resumeSeveredTurn = async input => { sends.push(input.text); return true; };
    await f.commit();
    const parked = await f.finish();
    expect(parked.stateDetail).toContain("title [redacted]");
    expect(parked.stateDetail).toContain("pipeline task");
    expect(parked.stateDetail).not.toContain(unsafeSummary);
    expect(sends).toEqual([]);
  } finally { f.close(); }
});


test("summary rewrite rejects verdict changes and cannot accept a new commit", async () => {
  const f = await rewritingFixture();
  try {
    const refused = await engineModule.reportStageCompletion({ verdict: "fail", summary: "Changed outcome" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(refused.code).toBe("STAGE_REPORT_SUMMARY_ONLY");
    const stranger = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
      { kind: "agent", role: "builder", conversationId: "unrelated-conversation" }, f.h.ports);
    expect(stranger.code).toBe("STAGE_REPORT_NOT_AN_ATTEMPT");
    fs.writeFileSync(path.join(f.worktree, "extra.txt"), "Extra change.\n");
    await tickPipelines([], f.h.ports);
    expect(f.read().state).toBe("needs_decision");
    expect(f.read().stateDetail).toContain("unchanged clean accepted head");
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
  } finally { f.close(); }
});


test("ORM identifiers, counts and a full SHA pass every real PR text check", async () => {
  const f = await fixture();
  try {
    const gate = path.join(process.cwd(), "scripts/privacy-publication-gate.ts");
    const fingerprints = path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json");
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Fixture uses the real gate through its exec port.\n");
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"), path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json"));
    await f.git(f.worktree, "add", "scripts");
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")
      ? realExec(process.execPath, [gate, ...args.slice(1)], cwd, { ...env, LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints }, options)
      : exec(command, args, cwd, env, options);
    await f.commit(); f.setExpectedBody(publicSummary);
    const done = await f.finish(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
  } finally { f.close(); }
});



test("a fresh controller process honors the persisted summary rewrite budget", async () => {
  const f = await rewritingFixture();
  try {
    await f.answer(unsafeSummary); // Second request is durable before restart.
    const submitted = await engineModule.reportStageCompletion({ verdict: "pass", summary: unsafeSummary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(submitted.error).toBeUndefined();
    const at = Date.parse(submitted.report!.at) + 1_000;
    const driver = `
      const { defaultPipelinePorts, settlePendingStageGit } = await import("@/lib/pipelines/engine");
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { realExec } = await import("@/lib/workflows/provision");
      const sends = [];
      const ports = { ...defaultPipelinePorts(), now: () => new Date(${at}).toISOString(),
        conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: { ts: ${at}, text: "Rewrite completed." } }),
        resumeSeveredTurn: async input => { sends.push(input.clientMessageId); return true; },
        exec: async (command, args, cwd, env, options) => command === "gh"
          ? { code: 0, stdout: "[]", stderr: "" }
          : realExec(command, args.map(arg => arg === ${JSON.stringify(REMOTE)} ? ${JSON.stringify(f.origin)} : arg), cwd, env, options) };
      await settlePendingStageGit(ports);
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(f.id)});
      console.log(JSON.stringify({ state: lane.state, rounds: lane.runs[0].attempts[0].publicationTextRepair.rounds, sends }));
    `;
    const result = await realExec(process.execPath, ["-e", driver], process.cwd(), {
      ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1",
    }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ state: "needs_decision", rounds: 2, sends: [] });
    expect(f.read().stateDetail).toContain("absolute-path");
    expect(f.read().lastPassedCommit).toBe(f.initial.lastPassedCommit);
  } finally { f.close(); }
});


test.each(["known-value", "unavailable"] as const)("repository PR text refusal identifies its class (%s) and withholds raw output", async mode => {
  const f = await fixture();
  try {
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Controlled gate fixture.\n");
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"), path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json"));
    await f.git(f.worktree, "add", "scripts");
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) {
        if (mode === "unavailable") throw Object.assign(new Error("private diagnostic"), { code: "ENOENT" });
        if (args.at(-1)?.endsWith("body.md")) return { code: 1,
          stdout: "PRIVACY GATE: FAIL\nknown_value: 1\n" + unsafeSummary, stderr: unsafeSummary };
        return { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" };
      }
      return exec(command, args, cwd, env, options);
    };
    await f.commit();
    const parked = await f.finish();
    expect(parked.stateDetail).toContain(mode === "known-value" ? "body [redacted]" : "inspection-error for title");
    expect(parked.stateDetail).toContain(mode === "known-value" ? "known-value" : "inspection-error");
    expect(parked.stateDetail).not.toContain(unsafeSummary);
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
  } finally { f.close(); }
});


test("a summary rewrite that never reports expires with the original named refusal", async () => {
  const f = await rewritingFixture();
  try {
    f.h.advanceWallClock(10 * 60_000);
    f.h.setConversationActive(false);
    await tickPipelines([], f.h.ports);
    expect(f.read().state).toBe("needs_decision");
    expect(f.read().stateDetail).toContain("absolute-path");
    expect(f.read().stateDetail).toContain("ten minutes");
    expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
});



test("a legacy terminal-output PR refusal rewrites the producer summary while its output commit stays local", async () => {
  const f = await fixture();
  try {
    await f.commit(); f.setExisting(); await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    delete current.publication;
    current.stages[1]!.outputs = ["review.md"];
    current.runs[0]!.attempts[0]!.report!.summary = unsafeSummary;
    savePipelines([current]); f.setMissing();
    await tickPipelines([], f.h.ports);
    fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    f.h.setConversationActive(false);
    const sends: string[] = [];
    f.h.ports.resumeSeveredTurn = async input => { sends.push(input.conversationId); f.h.setConversationActive(true); return true; };
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed." },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const rewriting = loadPipelines().find(p => p.id === f.id)!;
    expect(sends).toEqual(["conversation_stage_1"]);
    const accepted = rewriting.lastPassedCommit;
    const remote = await f.git(f.origin, "rev-parse", `refs/heads/${rewriting.branch}`);
    expect(remote).not.toBe(accepted);
    f.setExpectedBody(publicSummary);
    expect((await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports)).error).toBeUndefined();
    f.h.setConversationActive(false);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", publicSummary)], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.state).toBe("completed");
    expect(done.lastPassedCommit).toBe(accepted);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${done.branch}`)).toBe(remote);
  } finally { f.close(); }
});



test("a summary reported during rewrite delivery survives the settlement fence", async () => {
  const f = await fixture();
  try {
    await f.commit();
    const lane = loadPipelines().find(p => p.id === f.id)!;
    lane.runs[0]!.attempts[0]!.paneId = null; savePipelines([lane]);
    let calls = 0;
    f.h.ports.resumeSeveredTurn = async () => {
      calls++;
      const result = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
        { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
      expect(result.error).toBeUndefined();
      return true;
    };
    f.setExpectedBody(publicSummary);
    await f.finish(unsafeSummary);
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.runs[0]!.attempts[0]!.report!.summary).toBe(publicSummary);
    expect(calls).toBe(1);
  } finally { f.close(); }
});



test("a detector match across title and body keeps its actual class", async () => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const title = "password:", body = "a".repeat(20);
  expect(await inspectPullRequestText("title", title)).toEqual({ ok: true });
  expect(await inspectPullRequestText("body", body)).toEqual({ ok: true });
  const combined = await inspectPullRequestText("title/body", title + "\n" + body);
  expect(combined).toMatchObject({ ok: false, privacy: { part: "title/body", kind: "credential", check: "staticSensitiveClasses" } });
  expect(JSON.stringify(combined)).not.toContain(body);
});



test("a static refusal locates its decoded line without quoting the match", async () => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const result = await inspectPullRequestText("body", "Public result.\nEvidence:\n/home/" + "private-user/evidence");
  expect(result).toMatchObject({ ok: false, privacy: { kind: "absolute-path", line: 3 } });
  if (!result.ok) expect(result.error).toContain("decoded line 3");
});


test.each(["timeout", "empty", "signal", "spawn", "spawn-zero", "missing"] as const)("PR inspection %s retries without summary rewrites and recovers", async mode => {
  const f = await inspectionFixture(mode);
  try {
    const waiting = await f.finish();
    const first = waiting.runs[0]!.attempts[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.cursor?.state).toBe("committing");
    expect(first.publicationTextRepair).toBeUndefined();
    expect(first.pullRequestInspection?.failures).toBe(1);
    expect(first.error).toContain('"budgetMs":60000');
    expect(first.error).toMatch(/"elapsedMs":[0-9]+/);
    expect(first.error).toContain(`"cause":"${mode === "empty" ? "exit" : mode === "missing" ? "missing-input" : mode === "spawn-zero" ? "spawn" : mode}"`);
    if (mode === "empty") expect(first.error).toContain('"stderrTail":"gate could not load its input"');
    if (mode === "timeout") expect(first.error).toContain('"stderrTail":"command timed out after 60000ms"');
    expect(first.error).toContain('"body":"available"');
    expect(first.error).toContain(mode === "missing" ? '"fingerprints":"missing"' : '"fingerprints":"available"');
    expect(first.error).toContain(mode === "timeout" ? '"signal":"SIGKILL"' : mode === "spawn" ? '"spawn":"EAGAIN"' : mode === "signal" ? '"signal":"SIGTERM"' : mode === "missing" ? '"exit":0' : mode === "spawn-zero" ? '"spawn":"exception"' : '"exit":1');
    if (mode === "spawn-zero") expect(first.error).toContain('"exit":0');
    expect(first.error).not.toContain(unsafeSummary);
    expect(f.sends).toEqual([]);
    await tickPipelines([], f.h.ports);
    expect(f.checks()).toBe(1); // Repeated ticks respect the due time.
    if (mode === "missing") return;
    f.recover(); f.advance(1_001);
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
    expect(done.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
    expect(f.sends).toEqual([]);
  } finally { f.close(); }
});


test.each(["missing", "signal", "null-exit", "exception", "buffer-exception", "zero-exit"] as const)("PR inspection preserves a content finding with %s even when a matching PR exists", async mode => {
  const f = await inspectionFixture(mode === "missing" ? "missing" : "empty");
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      if (input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")) {
        if (input[1].at(-1)?.endsWith("title.txt")) return { code: 0, stdout: "", stderr: "" };
        f.setExisting();
        const stdout = "known_value: 1\ninspection_error: 1\n";
        if (mode === "exception" || mode === "buffer-exception") throw Object.assign(new Error("input unavailable"), {
          code: "EAGAIN", stdout: mode === "buffer-exception" ? Buffer.from(stdout) : stdout,
        });
        return { code: mode === "signal" || mode === "null-exit" ? null : mode === "zero-exit" ? 0 : 1,
          ...(mode === "signal" ? { signal: "SIGTERM" as const } : {}), stdout, stderr: "input unavailable" };
      }
      return exec(...input);
    };
    const waiting = await f.finish();
    const attempt = waiting.runs[0]!.attempts[0]!;
    expect(waiting.cursor?.stageId).toBe("build");
    expect(waiting.delivery?.target.pr).toBeUndefined();
    expect(attempt.pullRequestInspection).toBeUndefined();
    expect(attempt.error).toContain("known-value");
    expect(attempt.publicationTextRepair?.state).toBe("pending");
    expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
});


test("PR inspection adopts an open PR created during the failed inspection and retains its diagnostic", async () => {
  const f = await inspectionFixture("empty");
  try {
    f.adopt();
    const done = await f.finish();
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
    expect(done.runs[0]!.attempts[0]!.error).toContain('"exit":1');
    expect(done.runs[0]!.attempts[0]!.publicationTextRepair).toBeUndefined();
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
    expect(f.sends).toEqual([]);
  } finally { f.close(); }
});


test.each([false, true])("PR inspection checks its bounded diagnostic after truncation, unsafe boundary=%s", async unsafe => {
  const f = await inspectionFixture("empty");
  try {
    const tail = (unsafe ? ["user", " synthetic fixture words"].join(":") : "gate input unavailable").padEnd(1_000, "x");
    const stderr = "prefix" + tail;
    expect(await inspectPullRequestText("title/body", stderr)).toEqual({ ok: true });
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")
      && input[1].at(-1)?.endsWith("body.md") ? { code: 1, stdout: "", stderr } : exec(...input);
    const waiting = await f.finish();
    const attempt = waiting.runs[0]!.attempts[0]!;
    const diagnostic = JSON.parse(attempt.error!.split("gate diagnostic ")[1]!);
    expect(diagnostic.stderrTail).toBe(unsafe ? "[redacted: transcript-content]" : tail);
    expect(await inspectPullRequestText("title/body", diagnostic.stderrTail)).toEqual({ ok: true });
    expect(attempt.pullRequestInspection?.failures).toBe(1);
    expect(attempt.publicationTextRepair).toBeUndefined();
    expect(f.sends).toEqual([]);
  } finally { f.close(); }
});


test("PR inspection content repair retires its prior counter before a concurrent summary report", async () => {
  const f = await inspectionFixture("empty");
  try {
    const waiting = await f.finish();
    waiting.runs[0]!.attempts[0]!.paneId = null;
    savePipelines([waiting]);
    const exec = f.h.ports.exec;
    let finding = true, reports = 0;
    f.h.ports.exec = async (...input) => {
      if (finding && input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")
        && input[1].at(-1)?.endsWith("body.md")) {
        finding = false;
        return { code: 1, stdout: "known_value: 1\n", stderr: "" };
      }
      return exec(...input);
    };
    f.setExpectedBody(publicSummary);
    f.h.ports.resumeSeveredTurn = async () => {
      reports++;
      const result = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
        { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
      expect(result.error).toBeUndefined();
      return true;
    };
    f.advance(1_001);
    await tickPipelines([], f.h.ports);
    const answered = loadPipelines().find(p => p.id === f.id)!;
    expect(reports).toBe(1);
    expect(answered.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("answered");
    expect(answered.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
    await tickPipelines([], f.h.ports);
    const retried = loadPipelines().find(p => p.id === f.id)!;
    expect(retried.runs[0]!.attempts[0]!.pullRequestInspection?.failures).toBe(1);
    expect(reports).toBe(1);
  } finally { f.close(); }
});


test("PR inspection real content finding still refuses beside an inspection error and withholds its diagnostic", async () => {
  const f = await inspectionFixture("finding");
  try {
    f.adopt();
    const refused = await f.finish();
    const attempt = refused.runs[0]!.attempts[0]!;
    expect(attempt.publicationTextRepair?.state).toBe("pending");
    expect(attempt.pullRequestInspection).toBeUndefined();
    expect(attempt.error).toContain("known-value");
    expect(attempt.error).toContain("stderrTail");
    expect(attempt.error).not.toContain(unsafeSummary);
    expect(f.sends).toHaveLength(1);
    expect(refused.delivery?.target.pr).toBeUndefined();
  } finally { f.close(); }
});



test("PR inspection backoff and exhaustion survive fresh controller processes", async () => {
  const f = await inspectionFixture("empty");
  try {
    let lane = await f.finish();
    const accepted = lane.lastPassedCommit;
    const restart = async (at: number) => {
      const driver = `
        const { defaultPipelinePorts, settlePendingStageGit } = await import("@/lib/pipelines/engine");
        const { loadPipelines } = await import("@/lib/pipelines/store");
        const { realExec } = await import("@/lib/workflows/provision");
        const sends = []; let checks = 0;
        const ports = { ...defaultPipelinePorts(), now: () => new Date(${at}).toISOString(),
          conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
          resumeSeveredTurn: async input => { sends.push(input.clientMessageId); return true; },
          exec: async (command, args, cwd, env, options) => {
            if (command === "gh") return { code: 0, stdout: "[]", stderr: "" };
            if (command === "bun") { checks++; return { code: 1, stdout: "", stderr: "input unavailable" }; }
            return realExec(command, args.map(arg => arg === ${JSON.stringify(REMOTE)} ? ${JSON.stringify(f.origin)} : arg), cwd, env, options);
          } };
        await settlePendingStageGit(ports);
        const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(f.id)});
        console.log(JSON.stringify({ lane, checks, sends }));
      `;
      const result = await realExec(process.execPath, ["-e", driver], process.cwd(), {
        ...process.env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1",
      }, { timeoutMs: 30_000 });
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim());
    };
    const before = await restart(Date.parse(lane.runs[0]!.attempts[0]!.pullRequestInspection!.retryAt) - 1);
    expect(before.checks).toBe(0);
    for (const failures of [2, 3, 4]) {
      const result = await restart(Date.parse(lane.runs[0]!.attempts[0]!.pullRequestInspection!.retryAt) + 1);
      lane = result.lane;
      expect(lane.runs[0]!.attempts[0]!.pullRequestInspection!.failures).toBe(failures);
      expect(result.checks).toBe(2); // Both fields are inspected before adoption is considered.
      expect(result.sends).toEqual([]);
      expect(lane.lastPassedCommit).toBe(accepted);
    }
    expect(lane.state).toBe("needs_decision");
    expect(lane.stateDetail).toContain("inspection retry budget exhausted");
    expect(lane.runs[0]!.attempts[0]!.publicationTextRepair).toBeUndefined();
    const after = await restart(Date.parse(lane.runs[0]!.attempts[0]!.pullRequestInspection!.retryAt) + 60_000);
    expect(after.checks).toBe(0);
    // Recovery can observe the durable budget before the terminal lane write.
    // Reopening that cursor must not grant another automatic inspection.
    const interrupted = loadPipelines().find(p => p.id === f.id)!;
    interrupted.state = "running";
    interrupted.runs[0]!.attempts[0]!.state = "passed";
    savePipelines([interrupted]);
    const held = await restart(Date.parse(lane.runs[0]!.attempts[0]!.pullRequestInspection!.retryAt) + 60_001);
    expect(held.checks).toBe(0);
    expect(held.lane.state).toBe("needs_decision");
    f.advance(120_000); f.recover();
    expect((await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
  } finally { f.close(); }
});



test("PR inspection adopts a matching PR during a final-fix refresh without changing its body", async () => {
  const f = await inspectionFixture("empty");
  try {
    const lane = await f.finish();
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.activatedBy = { stageId: "review", attempt: 1, edge: "fail", budgetSpent: true };
    f.setExisting();
    const result = await ensureStagePullRequest(lane, attempt, f.h.ports.exec);
    expect(result).toEqual({ ok: true });
    expect(lane.delivery?.target.pr).toBe(17);
    expect(attempt.error).toContain("inspection-error");
    expect(f.calls.some(isBodyPatch)).toBe(false);
    expect(f.body()).toBe("");
  } finally { f.close(); }
});


test.each([
  ["body", false], ["body", true], ["title", false], ["title", true],
  ["title/body", false], ["clean", false], ["clean", true],
] as const)("PR inspection checks refreshed %s before fallback adoption (missing companion=%s)", async (part, missing) => {
  const f = await finalBudgetFixFixture();
  try {
    const scripts = path.join(f.worktree, "scripts");
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Controlled infrastructure failure.\n");
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"),
      path.join(scripts, "privacy-known-value-fingerprints.json"));
    await f.git(f.worktree, "add", "scripts");
    await f.commit();
    const exec = f.h.ports.exec;
    let inspectionFailed = false, refreshed = false;
    const title = "api_token:", body = "Z".repeat(16);
    if (part === "title/body") {
      expect(await inspectPullRequestText("title", title)).toEqual({ ok: true });
      expect(await inspectPullRequestText("body", body)).toEqual({ ok: true });
      expect(await inspectPullRequestText("title/body", `${title}\n${body}`)).toMatchObject({ ok: false, privacy: { kind: "credential" } });
    }
    f.h.ports.exec = async (...input) => {
      if (input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")) {
        inspectionFailed = true;
        return { code: 1, stdout: "inspection_error: 1\n", stderr: "gate input unavailable" };
      }
      const result = await exec(...input);
      if (inspectionFailed && input[0] === "gh" && input[1][1] === "view" && result.code === 0) {
        const row = JSON.parse(result.stdout);
        if (part === "body" || part === "title") row[part] = unsafeSummary;
        if (part === "title/body") Object.assign(row, { title, body });
        if (missing) delete row[part === "body" ? "title" : "body"];
        refreshed = true;
        return { ...result, stdout: JSON.stringify(row) };
      }
      return result;
    };
    const lane = await f.finish(fixSummary, 3);
    const attempt = lane.runs[0]!.attempts.at(-1)!;
    expect(refreshed).toBe(true);
    if (part === "clean") {
      expect(lane.cursor?.activatedBy?.budgetRecheck).toBe(true);
      expect(attempt.error).toContain("inspection-error");
      expect(lane.delivery?.target.pr).toBe(17);
    } else {
      expect(lane.cursor?.stageId).toBe("build");
      expect(attempt.error).toContain(part === "title/body" ? "credential" : "absolute-path");
      expect(attempt.error).not.toContain(unsafeSummary);
      expect(attempt.pullRequestInspection).toBeUndefined();
    }
    expect(f.calls.some(isBodyPatch)).toBe(false);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


for (const [part, missing, content] of [
  ["body", false, true], ["body", true, true], ["title", false, true], ["title", true, true],
  ["body", false, false], ["body", true, false], ["title", false, false], ["title", true, false],
] as const) test(`PR inspection runs the repository gate on refreshed ${part} (missing companion=${missing}, content finding=${content})`, async () => {
  const f = await finalBudgetFixFixture();
  try {
    const marker = "RepositoryPrivacyReviewSentinel";
    expect(await inspectPullRequestText(part, marker)).toEqual({ ok: true });
    const scripts = path.join(f.worktree, "scripts");
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Controlled infrastructure failure.\n");
    const { createHash } = await import("node:crypto");
    const catalog = { schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
      fingerprints: [{ length: marker.length, sha256: createHash("sha256").update(marker.toLowerCase()).digest("hex") }] };
    fs.writeFileSync(path.join(scripts, "privacy-known-value-fingerprints.json"), JSON.stringify(catalog));
    const gateEnv = { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(scripts, "privacy-known-value-fingerprints.json"),
      LLV_PRIVACY_KNOWN_VALUES: undefined, LLV_PRIVACY_KNOWN_VALUES_FILE: undefined, LLV_PRIVACY_KNOWN_VALUES_FORMAT: undefined };
    await f.git(f.worktree, "add", "scripts");
    await f.commit();
    const sample = path.join(f.root, "sample.md");
    fs.writeFileSync(sample, marker);
    const control = await realExec(process.execPath, [path.join(process.cwd(), "scripts/privacy-publication-gate.ts"),
      "--require-known-values", "--paths", sample], f.worktree,
    gateEnv, { timeoutMs: 30_000 });
    expect(control.code, control.stdout + control.stderr).toBe(1);
    expect(control.stdout, control.stderr).toContain("known_value: 1");
    const exec = f.h.ports.exec;
    let inspectionFailed = false, refreshed = false, contentSeen = false;
    const checkedParts: string[] = [];
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) {
        if (!refreshed) {
          inspectionFailed = true;
          return { code: 1, stdout: "inspection_error: 1\n", stderr: "gate input unavailable" };
        }
        checkedParts.push(path.basename(args.at(-1)!));
        const result = await realExec(process.execPath, [path.join(process.cwd(), "scripts/privacy-publication-gate.ts"),
          ...args.slice(1)], cwd, { ...env, ...gateEnv }, options);
        contentSeen ||= /known_value: 1/m.test(result.stdout);
        return result;
      }
      const result = await exec(command, args, cwd, env, options);
      if (inspectionFailed && command === "gh" && args[1] === "view" && result.code === 0) {
        const row = JSON.parse(result.stdout);
        row[part] = content ? marker : "Public refreshed result.";
        if (missing) delete row[part === "body" ? "title" : "body"];
        refreshed = true;
        return { ...result, stdout: JSON.stringify(row) };
      }
      return result;
    };
    const lane = await f.finish(fixSummary, 3);
    const attempt = lane.runs[0]!.attempts.at(-1)!;
    expect(refreshed).toBe(true);
    if (content) {
      expect(lane.cursor?.stageId).toBe("build");
      expect(lane.state).toBe("needs_decision");
      expect(attempt.error).toContain("repository publication privacy gate (known-value)");
      expect(attempt.error).not.toContain(marker);
      expect(attempt.publicationTextRepair?.part).toBe(part);
    } else {
      expect(lane.cursor?.activatedBy?.budgetRecheck).toBe(true);
      expect(attempt.error).toContain("inspection-error");
      expect(lane.delivery?.target.pr).toBe(17);
    }
    expect(checkedParts).toContain(part === "title" ? "title.txt" : "body.md");
    expect(contentSeen).toBe(content);
    expect(attempt.pullRequestInspection).toBeUndefined();
    expect(f.calls.some(isBodyPatch)).toBe(false);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


test.each([
  ["inspection-error", false], ["inspection-error", true], ["configuration-error", false],
  ["tool-unavailable", false], ["configuration-error, inspection-error", false], ["inspection-error, tool-unavailable", false],
] as const)("PR inspection retires a legacy %s summary wait and adopts the matching PR (prefixed=%s)", async (kind, prefixed) => {
  const f = await rewritingFixture();
  try {
    const lane = loadPipelines().find(p => p.id === f.id)!;
    lane.runs[0]!.attempts[0]!.publicationTextRepair!.detail = `${prefixed ? "publishing the passed stage: " : ""}pull request publication privacy gate refused body [redacted]: repository publication privacy gate (${kind})`;
    savePipelines([lane]);
    f.setExisting();
    const sent = f.sends.length;
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
    expect(done.runs[0]!.attempts[0]!.error).toContain(kind);
    expect(done.runs[0]!.attempts[0]!.publicationTextRepair).toBeUndefined();
    expect(f.sends).toHaveLength(sent);
  } finally { f.close(); }
});


test.each(["current", "legacy-mixed"] as const)("a content finding keeps its %s rewrite wait when stderr mentions a legacy inspection failure", async mode => {
  const f = await inspectionFixture("finding");
  try {
    const resume = f.h.ports.resumeSeveredTurn!;
    f.h.ports.resumeSeveredTurn = async input => {
      const accepted = await resume(input);
      if (accepted) f.h.setConversationActive(true);
      return accepted;
    };
    const initial = loadPipelines().find(p => p.id === f.id)!;
    initial.runs[0]!.attempts[0]!.paneId = null;
    savePipelines([initial]);
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")
      && input[1].at(-1)?.endsWith("body.md")
      ? { code: 1, stdout: "known_value: 1\ninspection_error: 1\n", stderr: "repository publication privacy gate (inspection-error)" }
      : exec(...input);
    const refused = await f.finish();
    expect(refused.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("pending");
    const repair = refused.runs[0]!.attempts[0]!.publicationTextRepair!;
    expect(repair.detail).toContain("known-value");
    if (repair.detail.includes("gate diagnostic"))
      expect(repair.detail).toContain("repository publication privacy gate (inspection-error)");
    if (mode === "legacy-mixed") {
      repair.detail = repair.detail.replace("(known-value)", "(inspection-error, known-value)");
      savePipelines([refused]);
    }
    f.setExisting();
    f.advance(1_001);
    await tickPipelines([], f.h.ports);
    const held = loadPipelines().find(p => p.id === f.id)!;
    expect(held.cursor?.stageId).toBe("build");
    expect(held.cursor?.state).toBe("committing");
    expect(held.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("pending");
    expect(held.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
    expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
});



test.each(["retry-stage", "publish"] as const)("PR inspection %s preserves answered content repairs and grants inspection recovery", async action => {
  const f = await inspectionFixture("empty");
  try {
    await f.finish(unsafeSummary);
    expect(f.sends).toHaveLength(1); // The genuine content finding requests one rewrite.
    f.setExpectedBody(publicSummary);
    const waiting = await f.finish(publicSummary);
    expect(waiting.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("answered");
    expect(waiting.runs[0]!.attempts[0]!.pullRequestInspection?.failures).toBe(1);
    for (const delay of [1_001, 5_001, 15_001]) {
      f.advance(delay);
      await tickPipelines([], f.h.ports);
    }
    const parked = loadPipelines().find(p => p.id === f.id)!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts[0]!.pullRequestInspection?.exhausted).toBe(true);
    f.recover();
    if (action === "retry-stage") f.setExisting();
    const renewed = await engineModule.patchPipeline(f.id, { action }, f.h.ports);
    expect(renewed.error).toBeUndefined();
    expect(renewed.pipeline!.runs[0]!.attempts[0]!.pullRequestInspection?.failures).toBe(0);
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
    expect(done.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("answered");
    expect(done.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
    if (action === "retry-stage") expect(done.runs[0]!.attempts[0]!.error).toContain("inspection-error");
    expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
});


test("PR inspection checks body findings after title inspection fails", async () => {
  const f = await inspectionFixture("empty");
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      if (input[0] === "bun" && input[1][0]?.endsWith("privacy-publication-gate.ts")) {
        f.setExisting();
        return { code: 1, stdout: input[1].at(-1)?.endsWith("body.md") ? "known_value: 1\n" : "inspection_error: 1\n", stderr: "" };
      }
      return exec(...input);
    };
    const lane = await f.finish();
    expect(lane.cursor?.stageId).toBe("build");
    expect(lane.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("pending");
    expect(lane.runs[0]!.attempts[0]!.pullRequestInspection).toBeUndefined();
    expect(lane.delivery?.target.pr).toBeUndefined();
  } finally { f.close(); }
});


test("PR inspection preserves a real repository finding after a companion input disappears", async () => {
  const f = await inspectionFixture("empty");
  try {
    const marker = "CatalogReviewSentinel";
    const catalog = path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json");
    const data = JSON.parse(fs.readFileSync(catalog, "utf8"));
    const { createHash } = await import("node:crypto");
    data.fingerprints.push({ length: marker.length, sha256: createHash("sha256").update(marker.toLowerCase()).digest("hex") });
    fs.writeFileSync(catalog, JSON.stringify(data));
    await f.git(f.worktree, "add", "scripts");
    await f.commit();
    f.setExpectedBody(marker);
    const exec = f.h.ports.exec;
    let contentSeen = false;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) {
        const result = await realExec(process.execPath, [path.join(process.cwd(), "scripts/privacy-publication-gate.ts"), ...args.slice(1)], cwd, env, options);
        if (args.at(-1)?.endsWith("title.txt")) {
          expect(result.code, result.stdout + result.stderr).toBe(0);
          fs.unlinkSync(args.at(-1)!);
        } else {
          contentSeen = /known_value: 1/m.test(result.stdout);
          f.setExisting();
        }
        return result;
      }
      return exec(command, args, cwd, env, options);
    };
    const lane = await f.finish(marker);
    expect(contentSeen).toBe(true);
    expect(lane.cursor?.stageId).toBe("build");
    expect(lane.runs[0]!.attempts[0]!.publicationTextRepair?.state).toBe("pending");
  } finally { f.close(); }
});
