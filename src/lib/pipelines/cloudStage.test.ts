import { describe, expect, test } from "bun:test";
import { cloudPollDelay, cloudStageConfigurationError, cloudServiceTierError, cloudTransportError, isCloudStageAttempt,
  validCloudTaskReference, validCloudThreadReference, type CloudStageAttempt, type CloudStageClient } from "./cloudStage";
import type { PipelineStage } from "./types";

const stage: PipelineStage = { id: "review", kind: "run", runtime: "codex-cloud", model: "gpt-6.1-sol",
  "prompt": "Review", next: null, effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh",
    access: "read-only", roleId: "reviewer", promptScaffold: "Review" } };
const reserved: CloudStageAttempt = { phase: "reserved", environmentId: "fixture-env", branch: "lane/review",
  headSha: "a".repeat(40), deadlineAt: "2026-10-23T00:30:00.000Z", nextPollAt: "2026-10-23T00:00:00.000Z",
  polls: 0, taskId: null, taskUrl: null, model: null };
const reference = { taskId: "current-task-1", taskUrl: "https://example.com/cloud/current-task-1" };

test("only explicit cloud models and read-only reviewer/verifier stages are admitted", () => {
  expect(cloudStageConfigurationError(stage)).toBeNull();
  expect(cloudStageConfigurationError({ ...stage, effectiveRole: { ...stage.effectiveRole, roleId: "verifier" } })).toBeNull();
  expect(cloudStageConfigurationError({ ...stage, runtime: undefined, model: undefined })).toBeNull();
  for (const model of [undefined, null, "", " ", "different-model"]) {
    expect(cloudStageConfigurationError({ ...stage, model })).toContain("explicit stage model");
  }
  for (const effectiveRole of [{ ...stage.effectiveRole, roleId: "builder" as const },
    { ...stage.effectiveRole, engine: "claude" as const }, { ...stage.effectiveRole, access: "read-write" as const }]) {
    expect(cloudStageConfigurationError({ ...stage, effectiveRole })).toContain("read-only");
  }
  expect(cloudStageConfigurationError({ ...stage, outputs: ["review.md"] })).toContain("without worktree outputs");
});

test("a transport must explicitly honour model and effort; a missing adapter refuses execution", () => {
  const supported = { supportsModel: (model: string, effort: string | null) => model === "gpt-6.1-sol" && effort === "xhigh" } as CloudStageClient;
  expect(cloudTransportError(undefined, "gpt-6.1-sol", "xhigh")).toContain("not configured");
  expect(cloudTransportError(supported, "gpt-6.1-sol", "xhigh")).toBeNull();
  expect(cloudTransportError(supported, "gpt-6.1-sol", "low")).toContain("cannot honour");
  expect(cloudTransportError(supported, "different-model", "xhigh")).toContain("cannot honour");
});

test.each(["default", "priority", "ultrafast"])("explicit %s tiers are refused; role preferences and local runtimes keep their contract", serviceTier => {
  const effectiveRole = { ...stage.effectiveRole, serviceTier, serviceTierSource: "explicit" as const };
  expect(cloudServiceTierError(effectiveRole)).toContain("explicit service tier");
  expect(cloudServiceTierError({ ...effectiveRole, serviceTierSource: undefined })).toContain("explicit service tier");
  expect(cloudServiceTierError({ ...effectiveRole, serviceTierSource: "role-default" })).toBeNull();
  expect(cloudStageConfigurationError({ ...stage, effectiveRole })).toBeNull();
  expect(cloudStageConfigurationError({ ...stage, effectiveRole, runtime: undefined })).toBeNull();
});

test("backoff is deterministic and bounded", () => {
  expect(Array.from({ length: 8 }, (_, polls) => cloudPollDelay(polls))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  expect(cloudPollDelay(Number.MAX_SAFE_INTEGER)).toBe(30000);
});

describe("durable cloud attempts", () => {
  test("reserved, polling, completed and failed states round-trip", () => {
    for (const value of [reserved, { ...reserved, ...reference, phase: "polling", polls: 3 },
      { ...reserved, ...reference, phase: "completed", model: "gpt-6.1-sol", result: { output: "Checked", verdict: { status: "pass", findings: [] } } },
      { ...reserved, phase: "failed", error: "Cloud unavailable" }]) {
      expect(isCloudStageAttempt(JSON.parse(JSON.stringify(value)))).toBe(true);
    }
  });
  test("malformed receipts, deadlines and outcomes are rejected", () => {
    for (const change of [{ phase: "unknown" }, { phase: "polling" }, { phase: "completed", ...reference },
      { phase: "failed" }, { polls: -1 }, { polls: 0.5 }, { headSha: "bad" }, { deadlineAt: "bad" },
      { nextPollAt: "bad" }, { taskId: "id", taskUrl: null }, { model: 3 },
      { ...reference, taskUrl: "http://example.com/task" }, { result: { verdict: "pass" } }]) {
      expect(isCloudStageAttempt({ ...reserved, ...change })).toBe(false);
    }
  });
  test("task references are transport-independent HTTPS receipts", () => {
    expect(validCloudTaskReference(reference.taskId, reference.taskUrl)).toBe(true);
    for (const url of ["bad", "file:///task", "http://example.com/task"]) {
      expect(validCloudTaskReference(reference.taskId, url)).toBe(false);
    }
    const credentialUrl = new URL(reference.taskUrl);
    for (const field of ["username", "password"] as const) credentialUrl[field] = "fixture";
    expect(validCloudTaskReference(reference.taskId, String(credentialUrl))).toBe(false);
    expect(validCloudTaskReference(reference.taskId, reference.taskUrl + "?private=value")).toBe(false);
    expect(validCloudTaskReference(reference.taskId, reference.taskUrl + "#private")).toBe(false);
    for (const id of ["", "../task", "a".repeat(161), null]) expect(validCloudTaskReference(id, reference.taskUrl)).toBe(false);
  });
  test("current cloud links select the durable thread without arbitrary protocol actions", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const url = `codex://threads/${id}?hostId=durable`;
    expect(validCloudTaskReference(id, url)).toBe(true);
    expect(isCloudStageAttempt({ ...reserved, phase: "polling", taskId: id, taskUrl: url })).toBe(true);
    for (const bad of [url.replace("durable", "foreign"), url.replace(id, "other"), url + "&action=run", url + "#fragment", url.replace("threads", "settings")]) {
      expect(validCloudTaskReference(id, bad)).toBe(false);
    }
  });
});

test("hosted handles retain only a bounded thread and turn identity", () => {
  const thread = { threadId: "hosted-thread-1", turnId: "hosted-turn-1" };
  expect(validCloudThreadReference(thread)).toBe(true);
  const hosted = { environmentId: "ccarenv_fixture", cwd: "/workspace/project", model: "gpt-6.1-sol" };
  expect(validCloudThreadReference({ ...thread, hosted })).toBe(true);
  expect(validCloudThreadReference({ ...thread, hosted: { ...hosted, credential: "never-store" } })).toBe(false);
  expect(validCloudThreadReference({ ...thread, hosted: { ...hosted, cwd: "relative" } })).toBe(false);
  expect(isCloudStageAttempt({ ...reserved, ...reference, phase: "polling", thread })).toBe(true);
  for (const value of [{}, { threadId: "thread" }, { ...thread, turnId: "" }, { ...thread, turnId: "x".repeat(161) }, { ...thread, threadId: "../thread" }, { ...thread, credential: "never-store" }, Object.assign(Object.create(thread), { other: "value", credential: "never-store" })]) {
    expect(validCloudThreadReference(value)).toBe(false);
    expect(isCloudStageAttempt({ ...reserved, ...reference, phase: "polling", thread: value })).toBe(false);
  }
});
