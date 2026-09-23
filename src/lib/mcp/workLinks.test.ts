import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* PR and issue links through the Viewer MCP tools (#2059): the real bindings
   over a throwaway state directory and an invented repository whose origin
   names an invented GitHub repository. No forge is called. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-work-links-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
const creatorPath = path.join(process.env.LLV_CODEX_HOME, "sessions", "creator.jsonl");
fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
fs.writeFileSync(creatorPath, "{}\n");

const repoDir = path.join(sandbox, "widgets");
fs.mkdirSync(repoDir);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
git("init", "-q", "-b", "main");
git("remote", "add", "origin", "https://github.com/acme/widgets.git");
fs.writeFileSync(path.join(repoDir, "README.md"), "widgets\n");
git("add", "README.md");
git("commit", "-q", "-m", "init");
const HEAD = git("rev-parse", "HEAD");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { viewerMcpBindings } = await import("./bindings");
const { agentRegistry } = await import("@/lib/agent/registry");
agentRegistry().ensureConversation("codex", creatorPath, null);

type Links = { links: Array<{ number: number; kind: string | null; source: string; via: string[]; url: string }>; noPr: boolean };

test("pipeline_action attach-link takes #2059, 2059 and a URL as one link, and get_pipeline resolves it", async () => {
  const bindings = viewerMcpBindings();
  const created = await bindings.create_pipeline({
    clientRequestId: "work-links-create", task: "Chips on cards", src: creatorPath, repoDir, baseRef: HEAD, autoStart: false,
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null }],
  }) as { pipelineId: string };
  const pipelineId = created.pipelineId;
  for (const [index, link] of ["#2059", "2059", "https://github.com/acme/widgets/pull/2059"].entries()) {
    const answer = await bindings.pipeline_action({ clientRequestId: `work-links-attach-${index}`, pipelineId, action: "attach-link", link }) as { workLinks: Links; unchanged?: boolean; changedFields: string[] };
    expect(answer.workLinks.links).toEqual([expect.objectContaining({ number: 2059, source: "manual", via: ["manual"] })]);
    if (index === 0) expect(answer.changedFields).toContain("workLinks");
  }
  const read = await bindings.get_pipeline({ clientRequestId: "work-links-read", pipelineId }) as { workLinks: Links; pipeline: { workLinks: unknown[] } };
  expect(read.pipeline.workLinks).toHaveLength(1);
  expect(read.workLinks.links[0]).toMatchObject({ kind: "pr", url: "https://github.com/acme/widgets/pull/2059" });
  const compact = await bindings.get_pipeline({ clientRequestId: "work-links-read-compact", pipelineId, compact: true }) as { pr?: string };
  expect(compact.pr).toBe("#2059");
  const listed = await bindings.list_pipelines({ clientRequestId: "work-links-list", ids: [pipelineId], state: "draft" }) as { pipelines: Array<{ pr?: string }> };
  expect(listed.pipelines.map((row) => row.pr)).toEqual(["#2059"]);

  await expect(bindings.pipeline_action({ clientRequestId: "work-links-bad", pipelineId, action: "attach-link", link: "https://example.com/acme/widgets/pull/1" }))
    .rejects.toThrow(/only github\.com/);
  const detached = await bindings.pipeline_action({ clientRequestId: "work-links-detach", pipelineId, action: "detach-link", link: "#2059" }) as { workLinks: Links };
  expect(detached.workLinks.links).toEqual([]);
});

test("update_task attachLinks and detachLinks edit the task's own links, and get_task resolves them", async () => {
  const bindings = viewerMcpBindings();
  const created = await bindings.create_task({ clientRequestId: "work-links-task", project: "widgets-board", text: "Chips on cards" }) as { taskId: string };
  const taskId = created.taskId;
  const attached = await bindings.update_task({ clientRequestId: "work-links-task-attach", taskId, attachLinks: ["https://github.com/acme/widgets/issues/7", "acme/widgets#8"], linkKind: "pr" }) as { changedFields: string[] };
  expect(attached.changedFields).toContain("workLinks");
  const read = await bindings.get_task({ clientRequestId: "work-links-task-read", taskId }) as { workLinks: Links; task: { workLinks: Array<{ number: number; kind: string }> } };
  /* linkKind overrides the guess, including the URL's. */
  expect(read.task.workLinks.map((link) => [link.number, link.kind])).toEqual([[7, "pr"], [8, "pr"]]);
  expect(read.workLinks.links.map((link) => link.number)).toEqual([8, 7]);
  /* A bare number on a task whose repository nobody recorded names nothing. */
  await expect(bindings.update_task({ clientRequestId: "work-links-task-bare", taskId, attachLinks: "#9" })).rejects.toThrow(/owner\/repo#9/);
  await bindings.update_task({ clientRequestId: "work-links-task-detach", taskId, detachLinks: ["acme/widgets#7", "https://github.com/acme/widgets/pull/8"] });
  const after = await bindings.get_task({ clientRequestId: "work-links-task-read-2", taskId }) as { task: Record<string, unknown> };
  expect("workLinks" in after.task).toBe(false);
});
