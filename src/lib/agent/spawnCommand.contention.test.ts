import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnCommandDependencies } from "./spawnCommand";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-contention-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { statePath } = await import("@/lib/configDir");
const { agentRegistry } = await import("./registry");
const { executeSpawnRequest } = await import("./spawnCommand");
const { measureContention } = await import("@/lib/accounts/accountMutation.contention.fixture");
beforeEach(() => {
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
});
function structuredRouteDependencies(cwd: string): SpawnCommandDependencies {
  return {
    registry: agentRegistry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => ({
      engine: "claude",
      accountId: "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnAccount: (_engine, accountId) => ({
      engine: "claude",
      accountId: accountId ?? "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolvePinnedSpawnAdmission: async () => ({
      kind: "admissible",
      basis: "current",
      stale: false,
      retryAt: null,
    }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { void work(); },
    storeImages: (images) => images.map((image) => ({
      sha256: crypto.createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex"),
      mime: image.mime as "image/png",
      bytes: Buffer.from(image.base64, "base64").byteLength,
    })),
    spawnStructuredConversation: async (input) => ({
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  };
}

test("a refused anonymous structured spawn preserves the real Git index and writes no handoffs", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const cwd = statePath("anonymous-private-prompt-cwd");
  const directory = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(directory, { recursive: true });
  const legacy = "PRIVATE_ANONYMOUS_SENTINEL\n";
  fs.writeFileSync(path.join(directory, "old.md"), legacy);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  const previousState = process.env.LLV_STATE_DIR;
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(sandbox, "anonymous-team-state");
  try {
    teamStore().insertMember({ id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Owner", role: "owner", status: "active", color: "teal",
      telegram: null, createdAt: new Date().toISOString(), createdBy: "claim", revokedAt: null });
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Anonymous structured launch", engine: "claude", cwd,
        ["prompt"]: "Synthetic oversized fixture\n" + "p".repeat(40_000), mcpServers: [] }),
    }), { ...structuredRouteDependencies(cwd), defer: () => {} });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("member_required");
    expect(git("diff", "--cached", "--name-only")).toBe(staged);
    expect(git("show", ":source.ts")).toBe("export const value = 2;");
    expect(fs.readdirSync(directory)).toEqual(["old.md"]);
    expect(fs.readFileSync(path.join(directory, "old.md"), "utf8")).toBe(legacy);
    expect(fs.existsSync(path.join(cwd, ".artifacts", ".gitignore"))).toBe(false);
  } finally {
    resetTeamStoreForTests();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

test("spawn catalog resolution leaves admission available", async () => {
  const cwd = statePath("spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  await measureContention("spawn-catalog", async (pause) => {
    const dependencies = structuredRouteDependencies(cwd);
    const resolve = dependencies.resolveSpawnAccount;
    dependencies.resolveSpawnAccount = ((...args: Parameters<typeof resolve>) => {
      void pause();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return resolve(...args);
    }) as typeof resolve;
    dependencies.defer = () => {};
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Exercise catalog admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
    }), dependencies);
    if (response.status !== 202) console.info(await response.clone().json());
    expect(response.status).toBe(202);
  });
});

test("an oversized structured spawn launches with its full prompt in a stable readable reference", async () => {
  const cwd = statePath("large-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const original = `Launch complete role brief\n${"界🙂".repeat(12_000)}`;
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Large structured launch", engine: "claude", cwd, prompt: original, mcpServers: [] }),
  });

  const first = await executeSpawnRequest(request(), dependencies);
  expect(first.status).toBe(202);
  expect(Buffer.byteLength(deliveredPrompt, "utf8")).toBeLessThanOrEqual(32_000);
  const file = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  const firstReference = deliveredPrompt;

  // Replaying the same request takes the durable receipt path and retains the
  // same request payload and content-addressed file reference.
  await executeSpawnRequest(request(), dependencies);
  expect(deliveredPrompt).toBe(firstReference);
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "ordinary worker change");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.ts");
  expect(git("show", "HEAD:source.ts")).toBe("export const value = 2;");
  expect(git("show", "--format=", "HEAD")).not.toContain("Launch complete role brief");
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
});

test("ordinary Git commits exclude private structured prompts under tracked inclusion rules", async () => {
  const envKeys = ["LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("private-prompt-runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const cwd = statePath("private-prompt-publication-cwd");
  const ignoreDir = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(ignoreDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(ignoreDir, ".gitignore"), "!*.md\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.com");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts", ".artifacts/pipeline-stage-inputs/.gitignore");
  git("commit", "--quiet", "-m", "fixture base");

  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const privatePrompt = `Private controller input\n${"Sensitive worker brief. ".repeat(2_000)}`.trim();
  try {
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Private structured launch", engine: "claude", cwd, prompt: privatePrompt, mcpServers: [] }),
    }), dependencies);

    expect(response.status).toBe(202);
    const privateFile = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
    expect(privateFile).toBeDefined();
    expect(fs.readFileSync(privateFile!, "utf8")).toBe(privatePrompt);
    const ignoreContents = fs.readFileSync(path.join(ignoreDir, ".gitignore"), "utf8");
    expect(ignoreContents.startsWith("!*.md\n")).toBe(true);
    expect(ignoreContents.trimEnd().endsWith("*")).toBe(true);
    git("restore", "--", ".artifacts/pipeline-stage-inputs/.gitignore");
    fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "ordinary worker commit");

    const committedFiles = git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    expect(committedFiles).toContain("source.ts");
    expect(committedFiles.filter((file) => file.startsWith(".artifacts/pipeline-stage-inputs/") && !file.endsWith("/.gitignore"))).toEqual([]);
    expect(committedFiles).not.toContain(path.relative(cwd, privateFile!).split(path.sep).join("/"));
    expect(git("show", "--format=", "HEAD")).not.toContain(privatePrompt);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("a catalog generation change cannot admit the previously selected home", async () => {
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const cwd = statePath("changed-catalog-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  const resolve = dependencies.resolveSpawnAccount;
  let reads = 0;
  dependencies.resolveSpawnAccount = (...args) => {
    const account = resolve(...args);
    reads++;
    if (reads === 1) {
      createManagedCodexAccount("Concurrent catalog mutation");
      return account;
    }
    return { ...account, home: path.join(cwd, "replacement") };
  };
  dependencies.defer = () => { throw new Error("stale catalog must not launch"); };
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Reject stale catalog", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  }), dependencies);
  expect(reads).toBe(2);
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "spawn account changed during admission" });
  expect(agentRegistry().spawnReceiptForClientAttempt(clientAttemptId)).toBeNull();
});

test.each(["dependency", "forwarded"] as const)("autonomous %s spawn rechecks update admission after account evidence, while manual and receipt replay remain allowed", async (source) => {
  const cwd = statePath("autonomous-admission-cwd"); fs.mkdirSync(cwd, { recursive: true });
  process.env.LLV_SPAWN_TRANSPORT = "structured"; process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1"; process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
  let held = false, entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const dependencies = structuredRouteDependencies(cwd) as SpawnCommandDependencies & { autonomousAdmissionHeld: () => boolean };
  if (source === "dependency") dependencies.autonomousAdmissionHeld = () => held;
  dependencies.defer = () => {};
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  const request = (id: string, autonomous = source === "forwarded") => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json", ...(autonomous ? { "x-llv-autonomous-spawn": "1" } : {}) },
    body: JSON.stringify({ clientAttemptId: id, title: "Autonomous admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const id = `attempt_${crypto.randomUUID()}`;
  const pending = executeSpawnRequest(request(id), dependencies);
  await Promise.race([collecting, pending.then(async response => { throw new Error(`spawn returned before account evidence: ${response.status} ${JSON.stringify(await response.clone().json())}`); })]); held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true }); resume();
  const refused = await pending;
  expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ code: "AUTO_UPDATE_DRAIN" });
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull();
  held = false; releaseDrain(drainFile(), "forwarded-admission");
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  const receipt = agentRegistry().spawnReceiptForClientAttempt(id)!;
  held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  expect(agentRegistry().spawnReceiptForClientAttempt(id)!.launchId).toBe(receipt.launchId);
  const manual = structuredRouteDependencies(cwd); manual.defer = () => {};
  expect((await executeSpawnRequest(request(`attempt_${crypto.randomUUID()}`, false), manual)).status).toBe(202);
  releaseDrain(drainFile(), "forwarded-admission");
});
