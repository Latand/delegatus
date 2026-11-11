import { expect, test } from "bun:test";
import { pipelineCorpus } from "./fixtures/corpus";
import { APP_PUSH_RETRY_WINDOW_MS, isPublicationRecovery, mergePublicationRecovery, publicationEnvironmentFailure, publicationFailurePhase, publicationRemoteRefusal, recordPublicationFailure, recoverablePublication } from "./publicationHistory";
import { isStoredPipeline, loadPipelines, savePipelines } from "./store";
import { pipelineCompactRow } from "./listProjection";
import { lockedFixture } from "./fixtures/lockedDependencies";
import { publishPipelineBranch } from "./git";
import { realExec, type ExecPort } from "../workflows/provision";

const SHA = "a".repeat(40);
const DELAYS = [60_000, 300_000, 900_000];

test.each([
  ["pre-push: privacy\nPRIVACY GATE: PASS", null],
  ["pre-push: privacy\nPRIVACY GATE: PASS\npre-push: types", "types"],
  ["pre-push: privacy", "privacy"],
  ["pre-push: privacy\nPRIVACY GATE: PASS\npre-push: privacy", "privacy"],
  ["pre-push: types\npre-push: verified completed checks for this publication; transport admitted", null],
  ["pre-push: privacy\nremote: fatal error in commit_refs_rules", null],
  ["PRIVACY GATE: FAIL\nremote: fatal error in commit_refs_rules", "privacy"],
  ["pre-push: types: failed (1)\nremote: fatal error in commit_refs_rules", "types"],
] as const)("only an unfinished hook phase remains: %s", (outputTail, expected) => {
  expect(publicationFailurePhase({ outputTail })).toBe(expected);
});

test.each(["settled", "executor"])("remote refusals normalize a legacy writer and survive every reader: %s", source => {
  const { pipeline, attempt } = fixture();
  const failure = { step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1, changedFiles: 0,
    outputTail: "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: verified completed checks for this publication; transport admitted\nremote: fatal error in commit_refs_rules" };
  const result = { ok: false as const, error: "remote: fatal error in commit_refs_rules", failure };
  const operation = pipeline.delivery!.operation!;
  if (source === "executor") operation.executor = { pid: 1, identity: null, lock: "fixture.lock", result };
  else operation.result = result;
  expect(publicationRemoteRefusal(failure)).toBe(true);
  expect(recoverablePublication(result)).toBe(false);
  const input = { operationId: operation.id, epoch: 1, at: "2026-11-06T10:00:00.000Z",
    cause: "check-failure" as const, detail: result.error, recoverable: recoverablePublication(result) };
  const record = recordPublicationFailure(pipeline, attempt, input, DELAYS);
  expect(record).toMatchObject({ cause: "remote-refusal", retryAt: null });
  expect(recordPublicationFailure(pipeline, attempt, input, DELAYS)).toEqual(record);
  const reloaded = JSON.parse(JSON.stringify(pipeline));
  expect(isStoredPipeline(reloaded)).toBe(true);
  expect(isPublicationRecovery(reloaded.publicationRecovery)).toBe(true);
  expect(mergePublicationRecovery(undefined, reloaded.publicationRecovery)![SHA]!.history).toEqual([record]);
  expect(pipelineCompactRow(reloaded).publicationRecovery?.history).toEqual([record]);
  expect(reloaded.publicationRecovery[SHA]).toMatchObject({ failures: 0, totalAttempts: 1 });
  // Previously persisted causes are immutable, even if later diagnostics
  // permit a better classification. This change performs no history rewrite.
  pipeline.publicationRecovery![SHA]!.history[0]!.cause = "check-failure";
  expect(recordPublicationFailure(pipeline, attempt, input, DELAYS).cause).toBe("check-failure");
});

test.each(["PRIVACY GATE: FAIL", "pre-push: types: failed (1)", "custom hook refused"])(
  "a local or unclassified refusal retains its existing recovery: %s", outputTail => {
    const failure = { step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1, changedFiles: 1, outputTail };
    expect(publicationRemoteRefusal(failure)).toBe(false);
    expect(recoverablePublication({ error: "refused", failure })).toBe(false);
  });

test.each(["current", "serving-publisher", "hook"])("an environment refusal survives history serialization and takeover: %s", shape => {
  const { pipeline, attempt } = fixture();
  const result = { error: shape === "current" ? "stage environment: dependency preparation failed: ENOSPC" : "preparing publication dependencies: exit 1",
    ...(shape !== "current" ? { failure: { step: "preparing publication dependencies",
      code: 1, signal: null, durationMs: 0, outputTail: shape === "hook" ? "pre-push: frozen install\nEEXIST" : "EEXIST" } } : {}) };
  expect(publicationEnvironmentFailure(result)).toBe(true);
  pipeline.delivery!.operation!.result = { ok: false, ...result };
  const record = recordPublicationFailure(pipeline, attempt, { operationId: "operation-1", epoch: 1,
    at: "2026-10-29T00:00:00.000Z", cause: "check-failure", detail: result.error, recoverable: false }, DELAYS);
  expect(record.cause).toBe("environment");
  expect(record.retryAt).toBeNull();
  const reloaded = JSON.parse(JSON.stringify(pipeline));
  expect(isStoredPipeline(reloaded)).toBe(true);
  expect(mergePublicationRecovery(undefined, reloaded.publicationRecovery)![SHA]!.history).toEqual([record]);
  expect(publicationEnvironmentFailure({ error: "types failed", failure: { step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 0, outputTail: "pre-push: types: failed (1)" } })).toBe(false);
});

test.each([
  "(pass) a case: PRIVACY GATE: FAIL",
  "PRE-EXISTING src/work.test.ts: a case: PRIVACY GATE: FAIL",
  'expected: "PRIVACY GATE: FAIL"',
  "> PRIVACY GATE: FAIL",
  "(pass) a case: pre-push: privacy: failed (1)",
  "PRE-EXISTING src/work.test.ts: pre-push: privacy: refused",
  '"pre-push: privacy: failed (1)"',
])("test output retains the actual publication phase and retry: %s", line => {
  const failure = { step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 0, changedFiles: 0,
    outputTail: `${line}\nNEW src/work.test.ts: named assertion\npre-push: touched tests: failed (1)` };
  expect(publicationFailurePhase(failure)).toBe("touched tests");
  expect(recoverablePublication({ error: "touched tests failed", failure })).toBe(true);
});

test.each(["PRIVACY GATE: FAIL", "pre-push: privacy: failed (1)", "pre-push: privacy: refused",
  "  PRIVACY GATE: FAIL\r"])("a frozen-install marker cannot erase a decisive privacy refusal: %s", line => {
  const failure = { step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 0, changedFiles: 0,
    outputTail: `${line}\npre-push: frozen install\nEEXIST` };
  expect(publicationFailurePhase(failure)).toBe("privacy");
  expect(publicationEnvironmentFailure({ error: "privacy refused publication", failure })).toBe(false);
  expect(recoverablePublication({ error: "privacy refused publication", failure })).toBe(false);
});

test.each(["passed", "passed-phases", "privacy", "privacy-partial", "completed", "boundary", "partial-pass",
  "second-start", "second-fail", "second-pass", "quoted-pass", "quoted-start", "many-phases", "long-fail"])("publication clipping retains diagnostic provenance: %s", async shape => {
  const previous = loadPipelines();
  const f = await lockedFixture();
  try {
    const remote = `${f.root}/origin.git`;
    await f.run(["git", "init", "--bare", "--initial-branch=main", remote]);
    await f.run(["git", "remote", "add", "origin", remote]);
    await f.run(["git", "push", "--set-upstream", "origin", "main"]);
    const marker = "PRIVACY GATE: FAIL";
    const ending = "\nNEW src/work.test.ts: named assertion\npre-push: touched tests: failed (1)";
    const passed = shape.startsWith("passed");
    const earlierPhase = shape === "passed-phases" ? "pre-push: types" : "";
    const limit = 4000 - (earlierPhase ? earlierPhase.length + 3 : 0);
    const padding = limit - marker.length - 1 - ending.length + (shape === "privacy-partial" ? 1 : 0);
    const prefix = earlierPhase ? `${earlierPhase}\n${".".repeat(4000)}\n` : "";
    const drift = "pre-push: publication inputs changed during privacy checks; changed components: git config; gate failed";
    const start = "pre-push: privacy", pass = "PRIVACY GATE: PASS";
    const completed = `${start}\n${pass}`;
    const long = "benign diagnostic ".repeat(400);
    const cases: Record<string, string> = {
      completed: `${completed}\n${long}\n${drift}`,
      boundary: `${start}\n${".".repeat(4000)}\n${pass}\n${".".repeat(4000 - pass.length - drift.length - 2)}\n${drift}`,
      "partial-pass": `${completed}\n${".".repeat(4000 - pass.length - drift.length - 1)}\n${drift}`,
      "second-start": `${completed}\n${long}\n${start}\n${drift}`,
      "second-fail": `${completed}\n${start}\n${marker}\n${long}\n${drift}`,
      "second-pass": `${completed}\n${start}\n${pass}\n${long}\n${drift}`,
      "quoted-pass": `${start}\n> ${pass}\n${long}\n${drift}`,
      "quoted-start": `${completed}\n> ${start}\n${long}\n${drift}`,
      "many-phases": `${completed}\n${Array.from({ length: 20 }, (_, n) => `pre-push: check ${n}`).join("\n")}\n${long}\n${drift}`,
      "long-fail": `${completed}\n${start}\n${marker}\n${long}\npre-push: no verdict within the push budget of 1499 s: "types"`,
    };
    const output = cases[shape] ?? `${prefix}${passed ? "(pass) a case: " : "earlier hook output\n"}${marker}\n${".".repeat(padding)}${ending}`;
    const expectedPhase = cases[shape] ? publicationFailurePhase({ outputTail: output }) : passed ? "touched tests" : "privacy";
    f.pipeline.delivery = { target: { repository: "fixture", remote, branch: `refs/heads/${f.pipeline.branch}` },
      ownerId: f.pipeline.id, epoch: 1, active: true, disposition: "owner", publish: "enabled", journal: [] };
    f.pipeline.lastPassedCommit = f.pipeline.baseRef;
    savePipelines([f.pipeline]);
    const exec: ExecPort = (command, args, cwd, env, options) => command === "git" && args[0] === "push"
      ? realExec(process.execPath, ["-e", "process.stdout.write(process.env.PUBLICATION_FIXTURE_OUTPUT); process.exitCode = 1"], cwd,
        { ...env, PUBLICATION_FIXTURE_OUTPUT: output }, options)
      : realExec(command, args, cwd, env, options);
    const result = await publishPipelineBranch(f.pipeline, exec, { acceptedSha: f.pipeline.lastPassedCommit! });
    expect(result.ok).toBe(false);
    if (result.ok || !result.failure) throw new Error("expected captured publication refusal");
    const stored = JSON.parse(JSON.stringify(result));
    expect(stored.failure.changedFiles).toBe(0);
    expect(stored.failure.outputTail.length).toBeLessThanOrEqual(4000);
    expect(publicationFailurePhase(stored.failure)).toBe(expectedPhase);
    expect(recoverablePublication(stored)).toBe(cases[shape] ? expectedPhase !== "privacy" : passed);
    if (["completed", "boundary", "partial-pass", "second-pass", "quoted-start"].includes(shape)) {
      expect(stored.failure.outputTail).toContain(pass);
      expect(stored.failure.outputTail).toContain(drift);
    }
  } finally { savePipelines(previous); f.close(); }
}, 30_000);

test("App git 403 uses a persisted one-hour window with bounded backoff and a final deadline", () => {
  let { pipeline, attempt } = fixture();
  const start = Date.parse("2026-10-27T08:00:00.000Z");
  let clock = start;
  for (const [n, delay] of [60_000, 300_000, 900_000, 900_000, 900_000, 540_000, null].entries()) {
    pipeline.delivery!.operation!.id = `app-operation-${n}`;
    const input = { operationId: `app-operation-${n}`, epoch: 1, at: new Date(clock).toISOString(),
      cause: "app-git-403" as const, detail: "waiting for GitHub to accept the App push", recoverable: true };
    const record = recordPublicationFailure(pipeline, attempt, input, DELAYS);
    expect(record.retryAt).toBe(delay === null ? null : new Date(clock + delay).toISOString());
    expect(isPublicationRecovery(pipeline.publicationRecovery)).toBe(true);
    // Exercise JSON reload and loss of attempt-local counters on each pass.
    pipeline = JSON.parse(JSON.stringify(pipeline));
    attempt = pipeline.runs[0]!.attempts[0]!;
    delete attempt.publicationRetry;
    if (delay !== null) clock += delay;
  }
  expect(clock).toBe(start + APP_PUSH_RETRY_WINDOW_MS);
  expect(pipeline.publicationRecovery![SHA]!.app403Since).toBe(new Date(start).toISOString());
  const stale = structuredClone(pipeline.publicationRecovery);
  stale![SHA]!.app403Since = new Date(clock).toISOString();
  expect(mergePublicationRecovery(pipeline.publicationRecovery, stale)![SHA]!.app403Since).toBe(new Date(start).toISOString());
});
test.each(["settled", "executor", "journal"])("App refusal recovery retains its observation before history exists: %s", source => {
  const { pipeline, attempt } = fixture();
  const observedAt = "2026-10-27T08:00:00.000Z";
  const result = { ok: false as const, error: "App git access unavailable", failure: {
    step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 0,
    outputTail: "fatal: HTTP 403", retryableApp403: true, ...(source !== "journal" ? { observedAt } : {}) } };
  const operation = pipeline.delivery!.operation!;
  if (source === "executor") operation.executor = { pid: 1, identity: null, lock: "fixture.lock", result };
  else operation.result = result;
  if (source === "journal") pipeline.delivery!.journal.push({ at: observedAt, kind: "recovery", ownerId: pipeline.id,
    epoch: 1, conversationId: null, reason: `publication refused: ${result.error}` });
  const record = recordPublicationFailure(pipeline, attempt, { operationId: operation.id, epoch: 1,
    at: "2026-10-27T09:20:00.000Z", cause: "app-git-403", detail: "App git access unavailable", recoverable: true }, DELAYS);
  expect(record.retryAt).toBeNull();
  expect(pipeline.publicationRecovery![SHA]!.app403Since).toBe(observedAt);
  expect(isPublicationRecovery(JSON.parse(JSON.stringify(pipeline.publicationRecovery)))).toBe(true);
});

test("publication operation dates survive the store reader and reject malformed dates", () => {
  const { pipeline } = fixture();
  const operation = pipeline.delivery!.operation!;
  operation.app403Deadline = "2026-10-27T09:00:00.000Z";
  operation.result = { ok: false, error: "App git access unavailable", failure: { step: "publishing the pipeline branch",
    code: 1, signal: null, durationMs: 0, outputTail: "fatal: HTTP 403", retryableApp403: true, observedAt: "2026-10-27T08:00:00.000Z" } };
  expect(isStoredPipeline(JSON.parse(JSON.stringify(pipeline)))).toBe(true);
  operation.app403Deadline = "invalid";
  expect(isStoredPipeline(pipeline)).toBe(false);
  delete operation.app403Deadline;
  operation.result.failure!.observedAt = "invalid";
  expect(isStoredPipeline(pipeline)).toBe(false);
});

function fixture() {
  const pipeline = structuredClone(pipelineCorpus(1, 1)[0]!);
  pipeline.lastPassedCommit = SHA;
  pipeline.delivery = { target: { repository: "fixture", remote: "origin", branch: "refs/heads/fixture" },
    ownerId: pipeline.id, epoch: 1, active: true, disposition: "owner", publish: "enabled", journal: [],
    operation: { id: "operation-1", sha: SHA, epoch: 1, state: "settled" } };
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.publicationRetry;
  return { pipeline, attempt };
}

test("per-head failure history records causes, retry times and the terminal bound exactly once", () => {
  const { pipeline, attempt } = fixture();
  for (let n = 1; n <= 5; n++) {
    pipeline.delivery!.operation!.id = `operation-${n}`;
    const input = { operationId: `operation-${n}`, epoch: 1, at: "2026-10-16T10:00:00.000Z",
      cause: "infrastructure-deadline" as const, detail: "execution deadline", recoverable: true };
    const record = recordPublicationFailure(pipeline, attempt, input, DELAYS);
    expect(recordPublicationFailure(pipeline, attempt, input, DELAYS)).toEqual(record);
    expect(record.retryAt).toBe(n > 3 ? null : new Date(Date.parse(input.at) + DELAYS[n - 1]!).toISOString());
    expect(pipeline.publicationRecovery![SHA]!.failures).toBe(n);
  }
  expect(pipeline.publicationRecovery![SHA]!.history).toHaveLength(5);
  const recovery = pipeline.publicationRecovery![SHA]!;
  const compact = pipelineCompactRow(pipeline).publicationRecovery!;
  expect(compact).toEqual({ ...recovery, history: recovery.history.slice(-4) });
  compact.history[0]!.detail = "changed copy";
  expect(recovery.history[1]!.detail).toBe("execution deadline");
  expect(isPublicationRecovery(pipeline.publicationRecovery)).toBe(true);
});

test("assertion failures have a separate cause and no automatic retry of changed content", () => {
  const { pipeline, attempt } = fixture();
  expect(recordPublicationFailure(pipeline, attempt, { operationId: "operation-1", epoch: 1,
    at: "2026-10-16T10:00:00.000Z", cause: "check-failure", detail: "named assertion failed", recoverable: false }, DELAYS)).toMatchObject({
    cause: "check-failure", detail: "named assertion failed", retryAt: null });
  expect(pipeline.publicationRecovery![SHA]!.failures).toBe(0);
});

test("bounded history retains its total counter and each new head has its own allowance", () => {
  const { pipeline, attempt } = fixture();
  for (let n = 0; n < 70; n++) {
    const operationId = `operation-${n}`;
    pipeline.delivery!.operation!.id = operationId;
    recordPublicationFailure(pipeline, attempt, { operationId, epoch: 1, at: "2026-10-16T10:00:00.000Z",
      cause: "infrastructure-deadline", detail: "execution deadline", recoverable: true }, DELAYS);
  }
  expect(pipeline.publicationRecovery![SHA]).toMatchObject({ totalAttempts: 70, failures: 70 });
  expect(pipeline.publicationRecovery![SHA]!.history).toHaveLength(64);
  expect(pipelineCompactRow(pipeline).publicationRecovery!.history).toHaveLength(4);
  const next = "b".repeat(40);
  pipeline.delivery!.operation!.sha = next;
  pipeline.delivery!.operation!.id = "new-head-operation";
  expect(recordPublicationFailure(pipeline, attempt, { operationId: "new-head-operation", epoch: 1,
    at: "2026-10-16T10:00:00.000Z", cause: "interrupted", detail: "publisher stopped", recoverable: true }, DELAYS).retryAt).toBe("2026-10-16T10:01:00.000Z");
  expect(pipeline.publicationRecovery![SHA]!.failures).toBe(70);
  expect(isPublicationRecovery(pipeline.publicationRecovery)).toBe(true);
});

test("takeover merges stale copies without reducing counters or aliasing the prior owner", () => {
  const { pipeline, attempt } = fixture();
  const record = recordPublicationFailure(pipeline, attempt, { operationId: "operation-1", epoch: 1,
    at: "2026-10-16T10:00:00.000Z", cause: "interrupted", detail: "publisher stopped", recoverable: true }, DELAYS);
  const stale = structuredClone(pipeline.publicationRecovery);
  pipeline.delivery!.operation!.id = "operation-2";
  recordPublicationFailure(pipeline, attempt, { ...record, operationId: "operation-2", recoverable: true }, DELAYS);
  const merged = mergePublicationRecovery(pipeline.publicationRecovery, stale)!;
  expect(merged[SHA]!.failures).toBe(2);
  expect(merged[SHA]!.history).toHaveLength(2);
  merged[SHA]!.history[0]!.detail = "changed copy";
  expect(pipeline.publicationRecovery![SHA]!.history[0]!.detail).toBe("publisher stopped");
});

test("a legacy exhausted attempt keeps its consumed allowance when history is introduced", () => {
  const { pipeline, attempt } = fixture();
  attempt.publicationRetry = { sha: SHA, operationId: "operation-1", failures: 3,
    retryAt: "2026-10-16T10:21:00.000Z", exhausted: true };
  const input = { operationId: "operation-1", epoch: 1, at: "2026-10-16T10:21:00.000Z",
    cause: "infrastructure-deadline" as const, detail: "execution deadline", recoverable: true };
  expect(recordPublicationFailure(pipeline, attempt, input, DELAYS).retryAt).toBeNull();
  expect(pipeline.publicationRecovery![SHA]).toMatchObject({ failures: 4, totalAttempts: 4 });
  delete attempt.publicationRetry;
  pipeline.delivery!.operation!.id = "operation-2";
  expect(recordPublicationFailure(pipeline, attempt, { ...input, operationId: "operation-2" }, DELAYS).retryAt).toBeNull();
  expect(pipeline.publicationRecovery![SHA]).toMatchObject({ failures: 5, totalAttempts: 5 });
});

test.each(["negative", "time", "cause", "duplicate", "oversize"])("malformed publication history is refused: %s", kind => {
  const { pipeline, attempt } = fixture();
  recordPublicationFailure(pipeline, attempt, { operationId: "operation-1", epoch: 1,
    at: "2026-10-16T10:00:00.000Z", cause: "interrupted", detail: "publisher stopped", recoverable: true }, DELAYS);
  const history = pipeline.publicationRecovery![SHA]!;
  if (kind === "negative") history.failures = -1;
  if (kind === "time") history.history[0]!.retryAt = "invalid";
  if (kind === "cause") Object.assign(history.history[0]!, { cause: "unknown" });
  if (kind === "duplicate") { history.history.push({ ...history.history[0]! }); history.totalAttempts++; }
  if (kind === "oversize") history.history[0]!.detail = "x".repeat(401);
  expect(isPublicationRecovery(pipeline.publicationRecovery)).toBe(false);
});
