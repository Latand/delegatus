import { expect, harness, create as fixtureCreate, loadPipelines, savePipelines, tickPipelines, path } from "./engine.fixture";

import crypto from "node:crypto";

import { settlePipelineControllerJobs } from "./controllerJobs";

import { claudeCloudTaskFingerprint, setCodexCloudEnvironmentId, setClaudeCloudTasks } from "@/lib/projects/settings";
import { type CloudStageClient } from "./cloudStage";

import type { PipelineStageInput } from "./types";

export async function create(...args: Parameters<typeof fixtureCreate>) {
  const request = { ...args[2], inputContext: { handoffDigest: "Preserve the accepted scope and verification plan." } };
  const result = await fixtureCreate(args[0], args[1], request);
  const record = loadPipelines()[0]!;
  record.inputContext = { handoffDigest: "Preserve the accepted scope and verification plan." };
  savePipelines([record]);
  return result;
}

export const taskId = "current-review-1";

export const taskUrl = `https://example.com/cloud/${taskId}`;

export const stage: PipelineStageInput = { id: "review", kind: "run", runtime: "codex-cloud", role: { roleId: "reviewer" },
  engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", prompt: "Review {{task}}. {{prev.output}}", next: null };

export const pass = 'All checked.\n\n```json\n{"status":"pass","findings":[]}\n```';

export const lane = () => loadPipelines()[0]!;

export const attempt = () => lane().runs[0]!.attempts.at(-1)!;

export const privacyDigest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export async function fixture(options: { accountId?: string; enabled?: boolean; publication?: "internal" | "remote-branch"; stages?: PipelineStageInput[]; repoDir?: string; deliveryBranch?: string } = {}) {
  await settlePipelineControllerJobs();
  const h = harness();
  if (options.deliveryBranch) {
    const execute = h.ports.exec;
    h.ports.exec = async (command, args, cwd, env, execOptions) => {
      const result = await execute(command, args, cwd, env, execOptions);
      if (command === "git" && args[0] === "show-ref" && args.at(-1) === `refs/heads/${loadPipelines()[0]?.branch}`) {
        return { ...result, code: 1, stdout: "" };
      }
      return command === "git" && args[0] === "ls-remote"
        ? { ...result, stdout: result.stdout.replace(/refs\/heads\/[^\n]+/, options.deliveryBranch!) }
        : result;
    };
  }
  let clock = Date.UTC(2026, 9, 23);
  h.ports.now = () => new Date(clock).toISOString();
  h.advanceWallClock = milliseconds => { clock += milliseconds; };
  const submits: Parameters<CloudStageClient["submit"]>[0][] = [];
  const reads: Parameters<CloudStageClient["poll"]>[0][] = [];
  const runtime = options.stages?.[0]?.runtime ?? "codex-cloud";
  const model = runtime === "claude-cloud" ? "opus" : "gpt-6.1-sol";
  h.ports.resolveProjectSpawn = (engine, request) => ({ kind: "available", account: {
    engine, accountId: request.requestedId ?? options.accountId ?? "cloud-account", kind: "managed", home: path.resolve("fixture-account"), transcriptRoot: path.resolve("fixture-account"), env: { NODE_ENV: "test" },
  } });
  const client: CloudStageClient = {
    supportsModel: candidate => candidate === model,
    hasEnvironment: async () => true,
    submit: async input => { submits.push(input); return { taskId, taskUrl }; },
    poll: async input => { reads.push(input); return { state: "completed", model }; },
    readFinalMessage: async () => ({ message: pass, model }),
    readDiff: async () => { throw new Error("read-only stages must never read a diff"); },
  };
  if (runtime === "claude-cloud") {
    client.prepareEnvironment = async input => ({ state: "ready", environmentId: "task-fixture",
      selection: claudeCloudTaskFingerprint(input.project, input.account.accountId), revision: 1, principal: privacyDigest("fixture-principal") });
    h.ports.claudeCloudClient = client;
  }
  else h.ports.cloudClient = client;
  await create(h.ports, (options.stages ?? [stage]) as never, { publication: options.publication ?? "remote-branch",
    ...(options.repoDir ? { repoDir: options.repoDir } : {}),
    ...(options.deliveryBranch ? { delivery: { branch: options.deliveryBranch } } : {}) });
  if (runtime === "claude-cloud") {
    const record = lane();
    record.delivery!.target.remote = "https://github.com/sample/project.git";
    savePipelines([record]);
  }
  expect(runtime === "claude-cloud"
    ? setClaudeCloudTasks(lane().project, [{ accountId: options.accountId ?? "cloud-account", taskId: "task-fixture" }])
    : setCodexCloudEnvironmentId(lane().project, options.enabled === false ? "" : "env-fixture")).toBe(true);
  return { h, submits, reads, client };
}

export async function step(h: ReturnType<typeof harness>) {
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();
}

export async function submitted(h: ReturnType<typeof harness>, expectedTaskId = taskId) {
  for (let i = 0; i < 4 && !lane().runs[0]?.attempts.at(-1)?.cloud?.taskId && ["provisioning", "running"].includes(lane().state); i++) await step(h);
  if (!attempt()) throw new Error(`Cloud fixture has no attempt: ${lane().state}: ${lane().stateDetail}`);
  expect({ phase: attempt().cloud?.phase, error: attempt().error, cloudError: attempt().cloud?.error }).toEqual({ phase: "polling", error: null, cloudError: undefined });
  expect(attempt().cloud?.taskId).toBe(expectedTaskId);
}
