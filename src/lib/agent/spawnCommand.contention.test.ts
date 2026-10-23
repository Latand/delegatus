import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
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

test("generic spawn cannot create a curator receipt without the pass admission callback", async () => {
  const { claimPass } = await import("@/lib/memory/curation/store");
  const { roleMemoryCollection, newRuleId, roleScope } = await import("@/lib/memory/roleStore");
  const cwd = statePath("generic-curator-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const project = "generic-curator-fixture";
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    const at = new Date().toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Read the current scope before changing a stored rule.", why: "Preserve scoped guidance during review.",
      state: "active", hints: [], source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_curator_fixture" }, createdAt: at, changedAt: at });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: [id] });
  });
  const pass = claimPass({ project, repoDir: cwd, now: Date.now() });
  expect(pass).not.toBeNull();
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.resolveHealthySpawnAccount = async () => ({ engine: "codex", accountId: "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  dependencies.resolveSpawnAccount = (_engine, accountId) => ({ engine: "codex", accountId: accountId ?? "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = statePath("curator-codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
  fs.chmodSync(codexBinary, 0o755);
  process.env.LLV_CODEX_BINARY = codexBinary;
  let response: Response;
  try {
    response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: pass!.id, title: "Role memory curation", engine: "codex", model: "gpt-6.1-sol", cwd, prompt: "inspect",
        role: "curator", project, mcpServers: [] }),
    }), { ...dependencies, defer: () => {} });
  } finally {
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  }
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "curator_admission_refused" });
  expect(agentRegistry().spawnReceiptForClientAttempt(pass!.id)).toBeNull();
});

test("seat credential capture leaves neighboring spawn, resume and send admission available", async () => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const seats = await import("@/lib/orchestrator/seats");
  const { orchestratorSeatFor } = seats;
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { trackAccountLeases } = await import("@/lib/accounts/accountMutation.contention.fixture");
  const cwd = statePath("seat-credential-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const leases = trackAccountLeases();
  const observations: boolean[] = [];
  const captureMs: number[] = [];
  const commitMs: number[] = [];
  const commitHeld: boolean[] = [];
  const timeCommit = (commit: () => void) => {
    const started = performance.now();
    commitHeld.push(fs.existsSync(statePath("account-selection.lock")));
    try { commit(); }
    finally { commitMs.push(performance.now() - started); }
  };
  const prepare = seats.prepareOrchestratorSeatAuthCredentialBaseline;
  const record = seats.recordOrchestratorSeatAuthCredentialBaseline;
  // The retained direct facade also measures the reviewed code's inherited
  // callback when this same case runs against the captured commit.
  const commitSpy = typeof prepare === "function"
    ? spyOn(seats, "prepareOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => {
      const commit = prepare(...args); return () => timeCommit(commit);
    })
    : spyOn(seats, "recordOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => timeCommit(() => record(...args)));
  let neighbors: { exitCode: number; results: unknown; stderr: string } | undefined;
  const stamp = `1:file:${"a".repeat(64)}`;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    const started = performance.now();
    observations.push(fs.existsSync(statePath("account-selection.lock")));
    const child = Bun.spawnSync([process.execPath, "-e", `
      await import("./src/lib/testing/fixtureLifetime.ts");
      const { AgentRegistry } = await import("./src/lib/agent/registry");
      const { statePath } = await import("./src/lib/configDir");
      const { withAccountMutationLockAsync } = await import("./src/lib/accounts/accountMutation");
      const registry = new AgentRegistry(statePath("seat-neighbor-registry.json"), undefined, undefined, { sqliteMode: "off" });
      const conversation = registry.ensureConversation("codex", "/fixture/seat-neighbor.jsonl", "default");
      try {
        const results = await Promise.allSettled([
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Neighbor spawn" } }),
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", purpose: "resume-successor", conversationId: conversation.id, origin: { kind: "successor" }, launchProfile: { title: "Neighbor resume" } }),
          withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "Neighbor send", "seat-neighbor-send"), { caller: "send" }),
        ]);
        console.log(JSON.stringify(results.map(result => result.status === "fulfilled" ? { status: result.status, kind: result.value.kind ?? "delivery" } : { status: result.status, error: result.reason.message })));
      } finally { registry.close(); }
    `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    neighbors = { exitCode: child.exitCode, results: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
    captureMs.push(performance.now() - started);
    return stamp;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project: "seat-credential-contention", cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId: `seat_${crypto.randomUUID()}` }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(result.status).toBe(202);
    expect(orchestratorSeatFor("seat-credential-contention").active?.authCredentialBaseline).toMatchObject({ engine: "claude", accountId: "claude-test", stamp });
    expect(neighbors).toEqual({ exitCode: 0, stderr: "", results: [
      { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "delivery" },
    ] });
    expect(observations).toEqual([false]);
    expect(commitHeld).toEqual([true]);
    expect(leases.holds.length).toBeGreaterThan(0);
  } finally {
    capture.mockRestore(); commitSpy.mockRestore(); leases.stop(); Object.assign(productionSpawnCommandDependencies, original);
    console.info(JSON.stringify({ measurement: "seat spawn credential capture", maxHoldMs: Math.max(0, ...leases.holds), holdMs: leases.holds, captureMs, commitMs, commitHeld, observations, neighbors }));
  }
}, 10_000);

test.each(["catalog", "credentials"] as const)("seat spawn revalidates %s changed during credential capture before committing a baseline or receipt", async change => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const cwd = statePath(`seat-${change}-race-cwd`);
  fs.mkdirSync(path.join(cwd, "account"), { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const project = `seat-${change}-race`;
  const clientRequestId = `seat_${crypto.randomUUID()}`;
  let captures = 0;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    captures++;
    if (change === "catalog") createManagedCodexAccount("Concurrent catalog change");
    else fs.writeFileSync(path.join(cwd, "account", ".credentials.json"), JSON.stringify({ fixture: "x".repeat(captures) }), { mode: 0o600 });
    return `1:file:${"a".repeat(64)}`;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project, cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(captures).toBeGreaterThan(0);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("account_admission_changed");
    expect(agentRegistry().spawnReceiptForClientAttempt(clientRequestId)).toBeNull();
    const seat = orchestratorSeatFor(project);
    expect(seat.active).toBeNull();
    expect(seat.pending?.authCredentialBaseline).toBeUndefined();
    expect(result.body.seat).toMatchObject({ authCredentialBaseline: undefined });
  } finally { capture.mockRestore(); Object.assign(productionSpawnCommandDependencies, original); }
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
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: "The account changed while preparing the launch; try again shortly.",
    code: "account_admission_changed",
    retrySafe: true,
    retryable: true,
  });
  expect(agentRegistry().spawnReceiptForClientAttempt(clientAttemptId)).toBeNull();
});

test("automatic target admission refuses a changed pool after account evidence without reserving a launch", async () => {
  const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
  const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
  const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
  const cwd = statePath("automatic-target-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  let entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  dependencies.assertAccountAdmission = () => { accountProjectBindings(); };
  let dispatches = 0;
  dependencies.defer = () => { dispatches++; };
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
  const id = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: id, title: "Automatic target", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const pending = executeSpawnRequest(request(), dependencies);
  await Promise.race([collecting, pending.then(() => { throw new Error("spawn did not wait for evidence"); })]);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: "damaged" }); resume();
  const refused = await pending;
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain("account-project-bindings.json");
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull(); expect(dispatches).toBe(0);
  // Deliberate operator launches do not acquire the automatic pool restriction.
  delete dependencies.assertAccountAdmission;
  expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
  expect(dispatches).toBe(1);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
});

test.each(["dependency", "forwarded", "scheduled"] as const)("autonomous %s spawn rechecks update admission after account evidence, while manual and receipt replay remain allowed", async (source) => {
  const cwd = statePath("autonomous-admission-cwd"); fs.mkdirSync(cwd, { recursive: true });
  process.env.LLV_SPAWN_TRANSPORT = "structured"; process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1"; process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
  let held = false, entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const dependencies = structuredRouteDependencies(cwd) as SpawnCommandDependencies & { autonomousAdmissionHeld: () => boolean };
  if (source === "dependency") dependencies.autonomousAdmissionHeld = () => held;
  if (source === "scheduled") Object.assign(dependencies, (await import("@/lib/telegram/reportSpawn")).reportSpawnOverrides(() => true, "scheduled"));
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


test.each(["existing", "account-lock"] as const)("scheduled report launch respects %s drain and rechecks downstream admission", async (seam) => {
  const { launchReportConversation } = await import("@/lib/telegram/reportSpawn");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { procBackend } = await import("@/lib/proc");
  const cwd = statePath("report-lock-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const originalDependencies = { ...productionSpawnCommandDependencies };
  const oldCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = codexBinary;
  const fixture = structuredRouteDependencies(cwd);
  const resolveAccount = fixture.resolveSpawnAccount;
  fixture.resolveSpawnAccount = (...args) => ({ ...resolveAccount(...args), engine: "codex", accountId: "report-fixture" });
  fixture.resolveHealthySpawnAccount = async () => fixture.resolveSpawnAccount("codex", "report-fixture");
  let dispatches = 0;
  const dispatch = fixture.spawnStructuredConversation;
  fixture.spawnStructuredConversation = async input => { dispatches++; return dispatch(input); };
  Object.assign(productionSpawnCommandDependencies, fixture);
  const attempt = `attempt_${crypto.randomUUID()}`;
  const input = { trigger: "scheduled" as const, grantActive: () => true, body: { clientAttemptId: attempt, title: "Scheduled report fixture", engine: "codex", cwd, prompt: "inspect", mcpServers: [] } };
  const lock = statePath("account-selection.lock");
  const write = fs.writeFileSync;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  try {
    if (seam === "existing") {
      writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
      expect(await launchReportConversation(input)).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
      expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
      releaseDrain(drainFile(), "report-account-lock");
    }
    fs.writeFileSync = ((file, data, ...rest) => {
      write(file, data, ...rest);
      if (!blocked && typeof file === "string" && file.endsWith(".json") && typeof data === "string" && data.includes('"holder":"spawn admission"')) {
        blocked = true;
        write(lock, JSON.stringify({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), ns: fs.readlinkSync("/proc/self/ns/pid"), token: "report-lock-fixture", holder: "fixture hold", acquiredAt: Date.now() }));
        entered();
      }
    }) as typeof fs.writeFileSync;
    const pending = launchReportConversation(input);
    await Promise.race([waiting, pending.then(() => { throw new Error("launch never waited for account admission"); })]);
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    fs.rmSync(lock); fs.writeFileSync = write;
    expect(await pending).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
    releaseDrain(drainFile(), "report-account-lock");
    expect((await launchReportConversation(input)).status).toBe(202);
    for (let i = 0; i < 100 && dispatches === 0; i++) await Bun.sleep(10);
    expect(dispatches).toBe(1);
    const receipt = agentRegistry().spawnReceiptForClientAttempt(attempt)!;
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    expect((await launchReportConversation(input)).status).toBe(202);
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)?.launchId).toBe(receipt.launchId);
    expect((await launchReportConversation({ ...input, trigger: "manual", body: { ...input.body, clientAttemptId: `attempt_${crypto.randomUUID()}` } })).status).toBe(202);
  } finally {
    fs.writeFileSync = write;
    if (oldCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = oldCodexBinary;
    if (blocked && fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, "utf8")).token === "report-lock-fixture") fs.rmSync(lock);
    releaseDrain(drainFile(), "report-account-lock"); Object.assign(productionSpawnCommandDependencies, originalDependencies);
  }
});

test.each(["recovered", "expired", "refused", "conflict", "revoked", "terminal", "superseded", "released"] as const)("direct spawn handover: %s", async (outcome) => {
  const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
  const cwd = statePath(`direct-handover-${outcome}`);
  fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  const spawn = dependencies.spawnStructuredConversation;
  const launches: string[] = [];
  let deferred: Promise<void> | undefined;
  let slept = 0;
  let authorized = true;
  dependencies.authorizeAutonomousLaunch = () => {
    if (!authorized) throw new Error("authorization revoked");
  };
  dependencies.defer = work => { deferred = work(); };
  dependencies.runtimeAdmissionRetry = {
    deadlineMs: 750,
    now: () => 0,
    sleep: async ms => {
      slept += ms;
      if (outcome === "revoked") authorized = false;
      if (outcome === "superseded" || outcome === "released") {
        const { AgentRegistry } = await import("./registry");
        const secondWriter = new AgentRegistry(agentRegistry().filename, undefined, undefined, { resolveBackendIdentity: true });
        try {
          if (outcome === "superseded") {
            expect((await secondWriter.failStructuredSpawnOffLoop(launches[0], "settled during handover")).claimed).toBe(true);
          } else {
            const receipt = secondWriter.spawnRecoverySnapshot(launches).receipts[launches[0]];
            expect(secondWriter.releaseStartingStructuredSpawn(receipt.launchId, receipt.admissionOwner!).released).toBe(true);
          }
        }
        finally { secondWriter.close(); }
      }
    },
  };
  dependencies.spawnStructuredConversation = async input => {
    launches.push(input.receipt.launchId);
    if (outcome === "refused") throw new RuntimeHostUnavailableError("authentication denied", "UNAUTHORIZED");
    if (outcome === "conflict") throw new RuntimeHostUnavailableError("idempotency key already belongs to another request", "conflict");
    if (outcome === "terminal") {
      await input.registry.failStructuredSpawnOffLoop(input.receipt.launchId, "launch already failed");
      throw new RuntimeHostUnavailableError("runtime host is unavailable");
    }
    if (outcome === "expired" || launches.length < 3) throw new RuntimeHostUnavailableError("runtime host is unavailable");
    return spawn(input);
  };
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: `attempt_direct_handover_${outcome}`, title: "Direct handover", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [] }),
  }), dependencies);
  expect(response.status).toBe(202);
  await deferred;
  const retried = outcome === "recovered" || outcome === "expired";
  expect(launches).toHaveLength(retried ? 3 : 1);
  expect(new Set(launches).size).toBe(1);
  expect(slept).toBe(retried ? 750 : ["revoked", "superseded", "released"].includes(outcome) ? 250 : 0);
  const receipt = agentRegistry().spawnRecoverySnapshot(launches).receipts[launches[0]];
  expect(receipt.state === "failed").toBe(outcome !== "recovered" && outcome !== "released");
});

test.each(["recovered", "expired"] as const)("direct spawn uses real runtime admission: %s", async outcome => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
  const { ADMISSION_RETRY_DEADLINE_MS, spawnStructuredConversation } = await import("@/lib/runtime/structuredSpawn");
  const { FakeEngineHost } = await import("@/lib/runtime/fixtures/fakeEngineHost");
  const { claudeTranscriptPath } = await import("./transcript");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { procBackend } = await import("@/lib/proc");
  const cwd = statePath(`real-direct-handover-${outcome}`);
  fs.mkdirSync(cwd, { recursive: true });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const dependencies = structuredRouteDependencies(cwd);
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({ ramTotal: 8 * 1024 ** 3, ramAvailable: 4 * 1024 ** 3, swapTotal: 0, swapUsed: 0 });
  let clock = 0;
  let starts = 0;
  let invocations = 0;
  let launchId = "";
  const operations: string[] = [];
  let deferred: Promise<void> | undefined;
  const client = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      if (!command.operationId) throw new Error("fixture admission requires an operation id");
      operations.push(command.operationId);
      if (outcome === "expired" || operations.length < 3) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      return journal.executeOperation(command);
    },
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => journal.append(...args),
  } as RuntimeHostClient;
  dependencies.runtimeHostClient = () => client;
  dependencies.defer = work => { deferred = work(); };
  dependencies.runtimeAdmissionRetry = { now: () => clock, sleep: async ms => { clock += ms; } };
  dependencies.spawnStructuredConversation = async input => {
    invocations++;
    launchId = input.receipt.launchId;
    return spawnStructuredConversation(input, {
      now: () => clock,
      sleep: async ms => { clock += ms; },
      startHost: async () => {
        starts++;
        const sessionId = input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl")
          : ["21500000", "0000", "4000", "8000", "000000000001"].join("-");
        const transcript = input.spec.transcript ?? claudeTranscriptPath(cwd, sessionId, input.account.transcriptRoot);
        fs.mkdirSync(path.dirname(transcript), { recursive: true });
        fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
        return Object.assign(new FakeEngineHost(), { identity: { sessionId }, onStateChange: () => () => {} });
      },
      bindHost: async (registry, key, host, owner, epoch) => {
        const state = await host.health();
        registry.setStructuredHostClaimed(key, {
          kind: "claude-broker", endpoint: state.endpoint, process: captureProcessIdentity(process.pid),
          eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: epoch, activeTurnRef: null,
          pendingAttention: [], activeFlags: [],
        }, "idle", owner, epoch);
        return () => {};
      },
      publishHost: async () => async () => {},
      deliverFirst: async () => {},
    });
  };
  try {
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_real_direct_${outcome}`, title: "Runtime handover", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [] }),
    }), dependencies);
    expect(response.status).toBe(202);
    await deferred;
    expect(invocations).toBe(1);
    expect(new Set(operations)).toEqual(new Set([launchId]));
    expect(starts).toBe(outcome === "recovered" ? 1 : 0);
    expect(clock).toBeLessThanOrEqual(ADMISSION_RETRY_DEADLINE_MS);
    expect(clock).toBeGreaterThan(0);
    const receipt = agentRegistry().spawnRecoverySnapshot([launchId]).receipts[launchId];
    expect(receipt.state).toBe(outcome === "recovered" ? "completed" : "failed");
    expect(operations.length).toBe(outcome === "recovered" ? 3 : 18);
    expect(journal.snapshot().sessions.filter(row => row.conversationId === receipt.conversationId)).toHaveLength(outcome === "recovered" ? 1 : 0);
  } finally {
    try { await deferred; }
    finally { journal.close(); memory.mockRestore(); }
  }
});
