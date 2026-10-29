import { afterAll, expect, test } from "bun:test";
import { composeCloudStageInput } from "./cloudStageInput";
import { composeStageInput } from "./stageInput";
import { buildPipeline } from "./store";
import type { PipelineStage } from "./types";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";

const stage: PipelineStage = { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review {{task}}", next: null,
  effectiveRole: { roleId: "reviewer", engine: "codex", model: null, effort: "high", access: "read-only", promptScaffold: "Check every acceptance criterion." } };
function fixture(spec = "Preserve every acceptance criterion.") {
  return buildPipeline({ id: "cloud-input", task: "Review the change", spec, project: "fixture", repoDir: process.cwd(), stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
}
afterAll(shutdownTaskPageWorker);

test("skill references use the accepted checkout in both composers and the CLI", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { composeStageText } = await import("./stageInput");
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const { loadPipelines, savePipelines } = await import("./store");
  const priorTasks = loadTasks(), priorPipelines = loadPipelines();
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "skill-checkouts-"));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  try {
    const parent = path.join(root, "parent");
    const pipeline = buildPipeline({ id: "cloud-skills", task: "Review the change", spec: "Preserve the API", project: "fixture", repoDir: parent, stages: [stage], srcPath: null, srcConversationId: null, now: "now", taskIds: ["skill-task"] });
    const accepted = pipeline.worktreeDir;
    const parentSkill = ".claude/skills/parent/SKILL.md", stageSkill = ".claude/skills/stage/SKILL.md";
    for (const [checkout, skill] of [[parent, parentSkill], [accepted, stageSkill]] as const) {
      fs.mkdirSync(path.dirname(path.join(checkout, skill)), { recursive: true });
      git(checkout, "init", "--initial-branch=main");
      git(checkout, "config", "user.name", "Fixture");
      git(checkout, "config", "user.email", "fixture");
      fs.writeFileSync(path.join(checkout, skill), "Fixture skill.\n");
      git(checkout, "add", skill);
      git(checkout, "-c", "commit.gpgSign=false", "commit", "-m", "Fixture skill");
    }
    saveTasks([{ id: "skill-task", project: pipeline.project, text: pipeline.task, status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }]);
    savePipelines([pipeline]);
    for (const skill of [stageSkill, `./${stageSkill}`, parentSkill]) {
      const context = { skillPaths: [skill] };
      const cli = spawnSync(process.execPath, ["scripts/render-cloud-input.ts", "--task", "skill-task", "--role", "reviewer", "--skill", skill], { env: process.env, encoding: "utf8" });
      if (skill !== parentSkill) {
        const local = await composeStageText(pipeline, stage, stage.effectiveRole, "", context);
        expect((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", context)).join("")).toBe(local);
        expect(await composeStageInput(pipeline, stage, stage.effectiveRole, "", accepted, undefined, 0, context)).toBe(local);
        expect({ status: cli.status, stderr: cli.stderr }).toMatchObject({ status: 0 });
        expect(JSON.parse(cli.stdout).turns.join("")).toBe(local);
      } else {
        await expect(composeStageText(pipeline, stage, stage.effectiveRole, "", context)).rejects.toThrow("Referenced skill is not tracked");
        await expect(composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", context)).rejects.toThrow("Referenced skill is not tracked");
        expect(cli.status).not.toBe(0);
      }
    }
    // The accepted commit, rather than an unrelated staged index edit, owns delivery.
    git(accepted, "rm", "--cached", stageSkill);
    await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", { skillPaths: [stageSkill] });
    savePipelines([]);
    const preview = spawnSync(process.execPath, ["scripts/render-cloud-input.ts", "--task", "skill-task", "--role", "reviewer", "--repo", parent, "--skill", parentSkill], { env: process.env, encoding: "utf8" });
    expect({ status: preview.status, stderr: preview.stderr }).toMatchObject({ status: 0 });
  } finally {
    saveTasks(priorTasks); savePipelines(priorPipelines);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cloud receives the local composed stage, including scaffold, spec and predecessor", async () => {
  const pipeline = fixture();
  const local = await composeStageInput(pipeline, stage, stage.effectiveRole, "Prior stage findings", ".", async () => ({ code: 0, stdout: "", stderr: "" }));
  const cloud = await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "Prior stage findings");
  expect(cloud.join("")).toBe(local);
});

test("Cloud splits oversized Unicode input into complete follow-up turns", async () => {
  const spec = "Acceptance criterion 界🙂\n".repeat(4000);
  const turns = await composeCloudStageInput(fixture(spec), stage, stage.effectiveRole, "Prior findings");
  expect(turns.length).toBeGreaterThan(1);
  expect(turns.every(turn => Buffer.byteLength(turn) <= 32_000)).toBe(true);
  expect(turns.join("")).toContain(spec);
  expect(turns.join("")).not.toContain("�");
});

test("shared composition scrubs learned text in task context but delivers the memory block", async () => {
  const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const { learnedRulesForLaunchProfile } = await import("@/lib/memory/roleLaunch");
  const { composeStageText } = await import("./stageInput");
  const rule = "Preserve fixture receipts until their owning operation completes";
  const collection = roleMemoryCollection(true)!;
  const previousScope = collection.get("s:machine");
  const previousRule = collection.get("r:r_cloud_fixture");
  collection.boundedPatch(2, tx => { tx.put({ kind: "scope", scope: "machine", revision: 1, active: ["r_cloud_fixture"], history: [] }); tx.put({ kind: "rule", id: "r_cloud_fixture", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z" }); });
  try {
    const role = { ...stage.effectiveRole, roleId: "builder" as const };
    const pipeline = fixture();
    const context = { taskDetails: rule, skillPaths: ["AGENTS.md"], handoffDigest: `Decided to retain receipts. ${rule}` };
    const local = await composeStageText(pipeline, stage, role, rule, context);
    expect(local).not.toContain(rule);
    expect(local).toContain("AGENTS.md");
    expect(local).toContain("Decided to retain receipts.");
    const memory = await learnedRulesForLaunchProfile({ learnedRules: { project: pipeline.project, roleId: "builder" } });
    expect(memory).toContain(rule);
    const { memoryDeliveries } = await import("@/lib/memory/deliveryLedger");
    const start = { engine: "codex" as const, conversationId: "cloud_delivery_fixture", cwd: process.cwd(), nativeMemoryEnabled: false };
    const delivered = (await composeCloudStageInput(pipeline, stage, role, rule, context, start)).join("");
    expect(delivered).toBe(`${memory}\n\n${local}`);
    const receipt = memoryDeliveries().find(row => row.delivery.conversationId === start.conversationId)!.delivery;
    expect(receipt.rules.map(row => row.id)).toContain("r_cloud_fixture");
    expect(receipt.engineMemory).toEqual([]);
    expect((await composeCloudStageInput(pipeline, stage, role, rule, context)).join("")).toBe(`${memory}\n\n${local}`);
    // Clean review roles retain the local memory policy.
    expect((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, rule, context)).join("")).not.toContain(rule);
  } finally { collection.boundedPatch(2, tx => {
    if (previousRule) tx.put(previousRule); else tx.delete("r:r_cloud_fixture");
    if (previousScope) tx.put(previousScope); else tx.delete("s:machine");
  }); }
});

test("handoff digest secrets are scrubbed by the shared server composer", async () => {
  const { composeStageText } = await import("./stageInput");
  const secret = "fixture".repeat(5);
  const context = { handoffDigest: `Decision: preserve the API.\nAuthorization: Bearer ${secret}` };
  const pipeline = fixture();
  const local = await composeStageText(pipeline, stage, stage.effectiveRole, "", context);
  expect(local).not.toContain(secret);
  expect(local).toContain("Decision: preserve the API.");
  expect((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", context)).join("")).toBe(local);
});

test("CLI renders a board task with its stored stage or a resolved role", async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const { savePipelines } = await import("./store");
  const { spawnSync } = await import("node:child_process");
  const pipeline = fixture();
  pipeline.taskIds = ["task_cloud_fixture"];
  saveTasks([{ id: "task_cloud_fixture", project: "fixture", text: "Board task", details: "Preserve board details.", status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }]);
  savePipelines([pipeline]);
  const result = spawnSync(process.execPath, ["scripts/render-cloud-input.ts", "--task", "task_cloud_fixture", "--role", "reviewer"], { encoding: "utf8", env: process.env });
  expect(result.status).toBe(0);
  const text = (JSON.parse(result.stdout) as { turns: string[] }).turns.join("");
  expect(text).toContain(pipeline.spec!);
  expect(text).toBe((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", { taskDetails: "Preserve board details." })).join(""));
  expect(text).toContain("Preserve board details.");
  savePipelines([]);
  const unbound = spawnSync(process.execPath, ["scripts/render-cloud-input.ts", "--task", "task_cloud_fixture", "--role", "reviewer"], { encoding: "utf8", env: process.env });
  expect(unbound.status).toBe(0);
  expect((JSON.parse(unbound.stdout) as { turns: string[] }).turns.join("")).toContain("Preserve board details.");
});

test("a referenced source conversation requires a handoff digest", async () => {
  const pipeline = fixture();
  pipeline.srcConversationId = "conversation_source";
  await expect(composeCloudStageInput(pipeline, stage, stage.effectiveRole, "")).rejects.toThrow("requires a handoff digest");
  const turns = await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "", { handoffDigest: "Keep the accepted scope and validation plan." });
  expect(turns.join("")).toBe(await (await import("./stageInput")).composeStageText(pipeline, stage, stage.effectiveRole, "", { handoffDigest: "Keep the accepted scope and validation plan." }));
});


test("stored context and same-project task details reach both runtimes; foreign details stay private", async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const { loadPipelines, savePipelines } = await import("./store");
  const { composeStageText } = await import("./stageInput");
  const pipeline = fixture();
  pipeline.srcConversationId = "conversation_source";
  pipeline.inputContext = { taskDetails: "Additional accepted context", handoffDigest: "Preserve API compatibility.", skillPaths: ["AGENTS.md"] };
  pipeline.taskIds = ["context-own", "context-second", "context-foreign"];
  const base = { status: "inbox" as const, placement: "unplaced" as const, assignments: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
  saveTasks([{ ...base, id: "context-own", project: pipeline.project, text: "Own task", details: "Accepted task details" },
    { ...base, id: "context-second", project: pipeline.project, text: "Second task", details: "Second accepted task details" },
    { ...base, id: "context-foreign", project: "other-project", text: "Foreign task", details: "Private foreign details" }]);
  savePipelines([pipeline]);
  const mutable = loadPipelines().find(row => row.id === pipeline.id)!;
  mutable.inputContext!.handoffDigest = "An unsaved edit";
  const restored = loadPipelines().find(row => row.id === pipeline.id)!;
  expect(restored.inputContext).toEqual(pipeline.inputContext);
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["scripts/render-cloud-input.ts", "--task", "context-own", "--role", "reviewer"], { env: process.env, encoding: "utf8" });
  expect({ status: child.status, error: child.stderr }).toMatchObject({ status: 0 });
  expect((JSON.parse(child.stdout) as { turns: string[] }).turns.join("")).toBe(await composeStageText(restored, stage, stage.effectiveRole, ""));
  const local = await composeStageText(restored, stage, stage.effectiveRole, "Prior output");
  expect(local).toContain("Accepted task details");
  expect(local).toContain("Second accepted task details");
  expect(local).toContain("Additional accepted context");
  expect(local).not.toContain("Private foreign details");
  expect((await composeCloudStageInput(restored, stage, stage.effectiveRole, "Prior output")).join("")).toBe(local);
});

for (const skill of ["../SKILL.md", "/skills/SKILL.md", "C:\\skills\\SKILL.md", "missing/SKILL.md", "*.md"]) {
  test(`both composers refuse untracked or escaping skill reference ${skill}`, async () => {
    const { composeStageText } = await import("./stageInput");
    const context = { skillPaths: [skill] };
    await expect(composeStageText(fixture(), stage, stage.effectiveRole, "", context)).rejects.toThrow();
    await expect(composeCloudStageInput(fixture(), stage, stage.effectiveRole, "", context)).rejects.toThrow();
  });
}

test("credential scrub covers task, specification, details and relay in both composers", async () => {
  const { composeStageText } = await import("./stageInput");
  const secret = "fixture".repeat(6);
  const value = `Authorization: Bearer ${secret}`;
  const pipeline = fixture(value);
  pipeline.task = value;
  const context = { taskDetails: value, handoffDigest: value };
  const local = await composeStageText(pipeline, stage, stage.effectiveRole, value, context);
  expect(local).not.toContain(secret);
  expect((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, value, context)).join("")).toBe(local);
});


test("oversized local artifact and Cloud follow-ups recover the same complete stage input", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "cloud-local-input-"));
  try {
    const pipeline = fixture("Specification 界🙂\n".repeat(4000));
    pipeline.worktreeDir = root;
    const local = await composeStageInput(pipeline, stage, stage.effectiveRole, "Prior output", root);
    // This prompt is too large even when part references replace its spec.
    stage.prompt = "Review context 界🙂\n".repeat(4000);
    const context = { taskDetails: "Accepted detail 界🙂. ".repeat(70_000) };
    const complete = await composeStageInput(pipeline, stage, stage.effectiveRole, "Prior output", root, undefined, 0, context);
    const file = complete.match(/Full stage prompt file: (.+)\n/)![1]!;
    expect(Buffer.byteLength(fs.readFileSync(file))).toBeGreaterThan(1024 * 1024);
    expect((await composeCloudStageInput(pipeline, stage, stage.effectiveRole, "Prior output", context)).join("")).toBe(fs.readFileSync(file, "utf8"));
    expect(Buffer.byteLength(local)).toBeLessThanOrEqual(32000);
  } finally {
    stage.prompt = "Review {{task}}";
    fs.rmSync(root, { recursive: true, force: true });
  }
});
