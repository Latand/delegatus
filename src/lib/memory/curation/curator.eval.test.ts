import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { curatorBrief } from "./brief";
import { claimPass, patchPass, readPass } from "./store";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { newRuleId, roleMemoryCollection, roleScope, projectScope } from "../roleStore";
import type { RoleMemoryRule } from "../roleTypes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Model judgment is checked only by an explicitly requested fixture run. */
const evaluation = process.env.LLV_CURATOR_EVAL === "1" ? test : test.skip;
evaluation("real curator classifies the twelve level and currency cases in an isolated store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curator-eval-"));
  const oldState = process.env.LLV_STATE_DIR;
  const repo = path.join(root, "repository"), home = path.join(root, "codex"), state = path.join(root, "state");
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(state);
  process.env.LLV_STATE_DIR = state;
  const project = "curator-evaluation";
  const builder = roleScope(project, "builder"), critic = roleScope(project, "visual-critic"), globalBuilder = "role:*:builder", projectKey = projectScope(project);
  const cases = [
    ["task", builder, "The last lane repaired the orchard labels and added a screenshot to its report."],
    ["reader", builder, "During independent review, assess whether each finding rests on an observed failure."],
    ["builder", projectKey, "When implementing orchard labels, add the label's stable display name to orchard.catalog."],
    ["project", "machine", "Run ./orchard lint to check the label catalog before publishing work here."],
    ["global", builder, "Before implementing a unit conversion, list the dimensions at every boundary."],
    ["mixed", builder, "Run ./orchard links before publication; when implementing a parser, enumerate its input states first."],
    ["stale", builder, "Run scripts/old-orchard-labels.js before adding a catalog entry."],
    ["instructions", builder, "Run scripts/check-orchard.js before publishing changes to this repository."],
    ["code", builder, "For exported data snapshots, freeze the returned objects so callers cannot mutate them."],
    ["all-builder", builder, "Use a dry run to inspect the orchard publication plan before sending it."],
    ["all-critic", critic, "Inspect the orchard publication plan with a dry run before sending it."],
    ["some-builder", builder, "When changing orchard label contrast, compare the dim-room sample and the sunlit sample."],
    ["some-critic", critic, "When changing orchard label contrast, compare the dim-room sample and the sunlit sample."],
    ["opposite-keep", builder, "Build orchard labels with the normalized orchard name as their display text."],
    ["opposite-leave", builder, "Build orchard labels with the raw orchard name as their display text."],
  ];
  const ids: Record<string, string> = {};
  try {
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "Run scripts/check-orchard.js before publishing changes. All roles (builder, visual critic, architect) publish orchard work. Only the builder and visual critic change label contrast. Builders implement labels; orchard.catalog contains stable display names. The current product decision requires normalized orchard names as display text. orchard lint validates the label catalog; orchard links validates documentation links. These are distinct checks from scripts/check-orchard.js. The old orchard label script has been retired.\n");
    fs.writeFileSync(path.join(repo, "scripts/check-orchard.js"), "console.log('catalog checked');\n");
    fs.writeFileSync(path.join(repo, "orchard.catalog"), "apple = Apple orchard\npear = Pear orchard\n");
    fs.writeFileSync(path.join(repo, "orchard"), "#!/bin/sh\ncase \"$1\" in\n lint) test -s orchard.catalog ;;\n links) test -s documentation.links ;;\n *) exit 1 ;;\nesac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "documentation.links"), "orchard.catalog\n");
    fs.writeFileSync(path.join(repo, "labels.js"), "export const exportSnapshot = data => Object.freeze({ ...data });\n");
    fs.writeFileSync(path.join(repo, "labels.test.js"), "import { exportSnapshot } from './labels.js';\nfor (const data of [{ name: 'orchard' }, { total: 2 }]) {\n if (!Object.isFrozen(exportSnapshot(data))) throw Error('exported data must be frozen');\n}\n");
    roleMemoryCollection(true)!.boundedPatch(128, tx => {
      for (const [key, scope, rule] of cases) {
        const id = newRuleId(tx); ids[key] = id;
        tx.put({ kind: "rule", id, scope, rule, why: "A fixture attempts to place this guidance with its actual readers.", state: "active", hints: [], source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: scope === critic ? "visual-critic" : "builder", fixRound: false, conversationId: ["conversation", "fixture"].join("_") }, createdAt: new Date().toISOString(), changedAt: new Date().toISOString() });
        const held = tx.get(`s:${scope}`);
        tx.put({ kind: "scope", scope, revision: (held?.kind === "scope" ? held.revision : 0) + 1, history: [], active: [...(held?.kind === "scope" ? held.active : []), id] });
      }
    });
    const roles = ["builder", "visual-critic", "architect"] as const;
    const stamp = new Date().toISOString();
    const pipeline = buildPipeline({ id: "evaluation", task: "Fixture orchard work", project, repoDir: repo, srcPath: null, srcConversationId: null, now: stamp, stages: roles.map((role, index) => ({ id: role, kind: "run", prompt: "Work on the fixture orchard", role: { roleId: role }, effectiveRole: { roleId: role, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: "Fixture role" }, next: roles[index + 1] ?? null })) });
    pipeline.runs = pipeline.stages.map(stage => ({ stageId: stage.id, attempts: [{ n: 1, state: "passed", effectiveRole: stage.effectiveRole, launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: stamp, completedAt: stamp, input: "Fixture orchard work", activatedBy: null, output: "Fixture finished", verdict: { status: "pass" }, error: null }] }));
    pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = stamp;
    savePipelines([pipeline]);
    const pass = claimPass({ project, repoDir: repo, now: Date.now() })!;
    // Read-only engine; only its isolated MCP server writes the fixture memory.
    const authHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    fs.copyFileSync(path.join(authHome, "auth.json"), path.join(home, "auth.json"));
    const serverFile = path.resolve(import.meta.dir, "evalServer.fixture.ts");
    // This home contains only fixture configuration and the existing auth.
    fs.writeFileSync(path.join(home, "config.toml"), [
      'approval_policy = "never"', 'cli_auth_credentials_store = "file"',
      `[projects.${JSON.stringify(repo)}]`, 'trust_level = "trusted"',
      "[features]", "memories = false", "plugins = false", "apps = false",
      "[mcp_servers.curator]", `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([serverFile])}`, `cwd = ${JSON.stringify(process.cwd())}`, "enabled = true", "required = true", 'default_tools_approval_mode = "approve"',
      "[mcp_servers.curator.env]", ...Object.entries({ LLV_STATE_DIR: state, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, NODE_ENV: "test", LLV_CURATOR_EVAL: "1", LLV_CURATOR_EVAL_PASS: pass.id, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ].join("\n"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile], cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", LLV_STATE_DIR: state, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, NODE_ENV: "test", LLV_CURATOR_EVAL: "1", LLV_CURATOR_EVAL_PASS: pass.id, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stderr: "pipe" });
    const client = new Client({ name: "curator-fixture-preflight", version: "1" });
    let serverError = "";
    transport.stderr?.on("data", chunk => { serverError += chunk.toString(); });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("curate_rules");
    } catch (error) { throw Error(`Fixture MCP preflight failed: ${serverError || String(error)}`); }
    finally { await client.close(); }
    const child = Bun.spawn([process.env.LLV_CURATOR_EVAL_CODEX ?? "codex", "--no-daemon", "exec", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-c", "agents.enabled=false", "--cd", repo, "--json", "-"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CODEX_HOME: home, LLV_STATE_DIR: state, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", NODE_ENV: "test", DELEGATUS_TELEMETRY: "0", DO_NOT_TRACK: "1" }, stdin: "pipe", stdout: Bun.file(path.join(root, "engine.jsonl")), stderr: Bun.file(path.join(root, "engine.err")) });
    child.stdin.write(curatorBrief(project)); child.stdin.end();
    const exit = await child.exited;
    const out = path.resolve(".artifacts/role-memory-curation"); fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(root, "engine.jsonl"), path.join(out, "curator-eval.jsonl"));
    fs.copyFileSync(path.join(root, "engine.err"), path.join(out, "curator-eval.err"));
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(state, "eval-tool-started"))).toBe(true);
    const row = (key: string) => roleMemoryCollection()!.get(`r:${ids[key]}`) as RoleMemoryRule;
    const mixedParts = roleMemoryCollection()!.snapshot().filter((r): r is RoleMemoryRule => r.kind === "rule" && r.state === "active" && (r.id === ids.mixed || r.splitFrom === ids.mixed));
    const results = {
      task: row("task").reason === "task-specific", reader: row("reader").reason === "no-reader",
      builder: row("builder").scope === builder && row("builder").state === "active",
      project: row("project").scope === projectKey && row("project").state === "active",
      global: row("global").scope === globalBuilder && row("global").state === "active",
      mixed: !!row("mixed").versions?.length && mixedParts.some(r => r.scope === projectKey) && mixedParts.some(r => r.scope === builder || r.scope === globalBuilder),
      stale: row("stale").reason === "stale", instructions: row("instructions").reason === "in-instructions" && /^AGENTS\.md(?::\d+)?$/.test(row("instructions").where ?? ""),
      code: row("code").reason === "in-code" && /^labels(?:\.test)?\.js:\d+$/.test(row("code").where ?? ""),
      all: [row("all-builder"), row("all-critic")].some(r => r.state === "active" && r.scope === projectKey) && [row("all-builder"), row("all-critic")].some(r => r.state === "merged"),
      some: row("some-builder").state === "active" && row("some-builder").scope === builder && row("some-critic").state === "active" && row("some-critic").scope === critic,
      opposite: row("opposite-keep").state === "active" && row("opposite-leave").reason === "contradicted" && row("opposite-leave").against === ids["opposite-keep"],
    };
    fs.writeFileSync(path.join(out, "curator-eval-results.json"), JSON.stringify(results, null, 2));
    // Report each expected disposition, including failing cases, before asserting.
    for (const [key, passed] of Object.entries(results)) console.log(`curator fixture: ${key}: ${passed ? "pass" : "fail"}`);
    expect(Object.values(results).every(Boolean)).toBe(true);
    expect(readPass(pass.id)!.counts.calls).toBeGreaterThan(0);
    patchPass(pass.id, { state: "succeeded", endedAt: new Date().toISOString() });
  } finally {
    if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15 * 60_000);
