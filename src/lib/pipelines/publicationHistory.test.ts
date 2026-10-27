import { expect, test } from "bun:test";
import { pipelineCorpus } from "./fixtures/corpus";
import { APP_PUSH_RETRY_WINDOW_MS, isPublicationRecovery, mergePublicationRecovery, recordPublicationFailure } from "./publicationHistory";
import { pipelineCompactRow } from "./listProjection";

const SHA = "a".repeat(40);
const DELAYS = [60_000, 300_000, 900_000];

test("App git 403 uses a persisted one-hour window with bounded backoff and a final attempt", () => {
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
