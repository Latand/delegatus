/** Render only; this command never starts a Cloud run.
 * Usage: LLV_STATE_DIR=... bun scripts/render-cloud-input.ts --task ID --role ROLE
 *   [--pipeline ID] [--repo DIR] [--digest FILE] [--skill REPO_RELATIVE_PATH ...]
 * Digest files contain a handoff summary, never a transcript.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (!process.env.LLV_STATE_DIR) throw Error("Set LLV_STATE_DIR to the board state directory before rendering.");
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw Error(`Missing value for ${name}`);
  return args[index + 1];
}
const taskId = option("--task");
const roleId = option("--role");
if (!taskId || !roleId) throw Error("Usage: render-cloud-input.ts --task ID --role ROLE [--pipeline ID] [--repo DIR] [--digest FILE] [--skill PATH]");
const { loadTasks } = await import("@/lib/tasks/store");
const { loadPipelines, buildPipeline } = await import("@/lib/pipelines/store");
const { resolvePipelineRole, pipelineRoleLookup, PIPELINE_ROLE_IDS } = await import("@/lib/pipelines/roles");
const { composeCloudStageInput } = await import("@/lib/pipelines/cloudStageInput");
const { shutdownTaskPageWorker } = await import("@/lib/links/taskPageWorker");
try {
  const requestedRole = PIPELINE_ROLE_IDS.find(id => id === roleId);
  if (!requestedRole) throw Error("Unknown pipeline role.");
  const task = loadTasks().find(task => task.id === taskId);
  if (!task) throw Error("Board task not found.");
  const candidates = loadPipelines().filter(pipeline => pipeline.taskIds?.includes(taskId)
    && (!option("--pipeline") || pipeline.id === option("--pipeline")));
  if (candidates.length > 1) throw Error("Several pipelines reference this task; select --pipeline.");
  let pipeline = candidates[0];
  let stage = pipeline?.stages.find(stage => stage.effectiveRole.roleId === roleId);
  if (!pipeline) {
    if (option("--pipeline")) throw Error("Pipeline not found for this task.");
    const { role, error } = resolvePipelineRole({ role: { roleId: requestedRole } }, "run", pipelineRoleLookup, task.project);
    if (!role) throw Error(error ?? "Role unavailable.");
    stage = { id: "render", kind: "run", prompt: "{{task}}", next: null, effectiveRole: role };
    pipeline = buildPipeline({ id: "cloud-preview", task: task.text, taskIds: [task.id], project: task.project,
      repoDir: path.resolve(option("--repo") ?? "."), stages: [stage], srcPath: null, srcConversationId: null, now: new Date().toISOString() });
  }
  if (!stage) throw Error("The selected pipeline has no stage with this role.");
  const skillPaths = args.flatMap((value, index) => value === "--skill" ? [args[index + 1] ?? ""] : []);
  for (const skill of skillPaths) {
    if (!skill || /^(?:[/\\]|[A-Za-z]:)/.test(skill) || skill.split(/[\\/]/).includes("..")) throw Error("Skill paths must be repository relative.");
    const tracked = spawnSync("git", ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", skill], { cwd: pipeline.repoDir, encoding: "utf8" });
    if (tracked.status !== 0) throw Error("Referenced skill is not tracked.");
  }
  const run = pipeline.runs.find(run => run.stageId === stage.id);
  const previous = run?.attempts.at(-1)?.input ?? (pipeline.cursor?.stageId === stage.id ? pipeline.cursor.input : "") ?? "";
  const digest = option("--digest");
  const turns = await composeCloudStageInput(pipeline, stage, stage.effectiveRole, previous, {
    ...(skillPaths.length ? { skillPaths } : {}),
    ...(digest ? { handoffDigest: fs.readFileSync(digest, "utf8") } : {}),
  });
  process.stdout.write(JSON.stringify({ turns }, null, 2) + "\n");
} finally {
  await shutdownTaskPageWorker();
}
